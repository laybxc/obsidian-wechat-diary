"use strict";
// 插件宿主: 拦截 require("obsidian") → 加载未经修改的 main.js → 注入 fs 后端。
//
// 这是"复用而非重写"的落点。main.js 里的 WechatDiaryPlugin 期望一个 app 对象
// (app.vault / app.workspace / app.secretStorage …) 和 loadData/saveData。
// 这里把它们分别接到 FsVault、StateStore、credentials.json 上。
//
// 明确不启用的部分(服务端无意义, 且会拖住进程不退出):
//   · onLayoutReady 里的语音气泡 MutationObserver —— 全局无 MutationObserver, main.js 自己 early return
//   · 每日提醒 / 心跳 registerInterval —— 由 Plugin 桩收集, 退出时统一清掉
//   · 长轮询管道 —— 服务端【自己】驱动(见 service.js), 不用插件的 startPipeline:
//     插件的 _loop 是"先处理再推游标", 但没有事件流水; 服务端要在两者之间插入 NDJSON 落盘,
//     所以复用 _handleIncoming 之下的所有语义(agent/writer/意图/媒体), 自己写外层循环。

const Module = require("module");
const path = require("path");
const fsp = require("fs/promises");
const logger = require("./logger");
const { FsVault, normalizePath } = require("./vault");
const shim = require("./obsidian-shim");
const momentLite = require("./moment-lite");

let _mainModule = null;

// 加载 main.js(进程内只做一次: 它是有顶层状态的单文件模块)
function loadPluginModule(mainJsPath) {
  if (_mainModule) return _mainModule;
  shim.installGlobals();
  const obsidian = shim.makeObsidianModule();
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === "obsidian") return obsidian;
    return orig.call(this, req, ...rest);
  };
  try {
    _mainModule = require(mainJsPath);
  } finally {
    Module._load = orig;
  }
  return _mainModule;
}

// ── 附件跟随笔记: 服务端扩展 ──────────────────────────────────────────────
// 需求是"附件放当天笔记目录下的 assets", 例如
//   笔记  5.TDSQL/2026/08/2026-08-31.md
//   附件  5.TDSQL/2026/08/assets/2026-08-31-2130-xxxx.jpg
// 插件的三种 attachmentMode 都做不到这个(diary 是根目录下 attachments/YYYY,
// custom 是固定文件夹, obsidian 要 fileManager)。做法不是改 main.js 的分支,
// 而是用 app.fileManager.getAvailablePathForAttachment —— 它正是 obsidian 模式的接口,
// 语义就是"按用户设置为某篇笔记算出附件路径", 与我们的需求同形。
// 于是 config 里 attachmentMode 设 "obsidian", 这个 fileManager 由服务端提供。
function makeFileManager(vault, followNote) {
  return {
    // notePath: 附件所属笔记的 vault 路径; fileName: 期望文件名
    async getAvailablePathForAttachment(fileName, notePath) {
      const name = String(fileName || "file.bin").split("/").pop();
      let dir;
      if (followNote && notePath) {
        dir = normalizePath(path.posix.join(path.posix.dirname(normalizePath(notePath)), "assets"));
      } else {
        dir = "assets";
      }
      // 撞名去重: Obsidian 的接口保证返回可用路径, 这里同样保证
      let candidate = normalizePath(dir + "/" + name);
      if (!vault.getAbstractFileByPath(candidate)) return candidate;
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      for (let i = 1; i < 1000; i++) {
        candidate = normalizePath(dir + "/" + base + " " + i + ext);
        if (!vault.getAbstractFileByPath(candidate)) return candidate;
      }
      return normalizePath(dir + "/" + base + "-" + Date.now() + ext);
    },
  };
}

// ── app 对象 ─────────────────────────────────────────────────────────────
function makeApp(vault, credentialsAccessor, opts) {
  const followNote = !!(opts && opts.attachmentFollowNote);
  return {
    vault,
    fileManager: makeFileManager(vault, followNote),
    // secretStorage: 插件用它存 token / AI key / 绑定身份。服务端后端是 credentials.json(0600)。
    // 注意 main.js 调用它是【同步】的(getSecret/setSecret 不 await), 所以这里也必须同步 ——
    // 写入落盘由 credentialsAccessor 内部排队做, setSecret 只更新内存并标脏。
    secretStorage: {
      getSecret: (k) => credentialsAccessor.get(k),
      setSecret: (k, v) => credentialsAccessor.set(k, v),
    },
    workspace: {
      // 服务端没有布局: 回调立即执行会启动插件自己的管道, 这不是我们要的 ——
      // 收集起来但不执行, 长轮询由 service.js 驱动。
      onLayoutReady: (cb) => { (opts && opts.layoutCallbacks || []).push(cb); },
      openLinkText: () => {},
      getActiveFile: () => null,
    },
    metadataCache: {
      getFirstLinkpathDest: (linkpath) => vault.getFileByPath(linkpath),
    },
    internalPlugins: { getPluginById: () => null },
    plugins: { getPlugin: () => null },
  };
}

// 凭据访问器: 把 main.js 的三个 secret key 映射到 credentials.json 的字段。
// main.js 用的 key 名(SECRET_BOT_TOKEN 等)在这里以字符串出现, 与 main.js 常量保持一致。
const SECRET_BOT_TOKEN = "wechat-diary-ilink-bot-token";
const SECRET_AI_KEY = "wechat-diary-ai-api-key";
const SECRET_BIND_ID = "wechat-diary-bind-identity";

class CredentialsAccessor {
  constructor(credPath, initial) {
    this.path = credPath;
    this.creds = {
      botToken: (initial && initial.botToken) || "",
      aiKey: (initial && initial.aiKey) || "",
      bindIdentity: (initial && initial.bindIdentity) || null,
    };
    this._chain = Promise.resolve();
  }

  get(key) {
    if (key === SECRET_BOT_TOKEN) return this.creds.botToken || null;
    if (key === SECRET_AI_KEY) return this.creds.aiKey || null;
    if (key === SECRET_BIND_ID) return this.creds.bindIdentity ? JSON.stringify(this.creds.bindIdentity) : null;
    return null;
  }

  set(key, value) {
    const v = value == null ? "" : String(value);
    if (key === SECRET_BOT_TOKEN) this.creds.botToken = v;
    else if (key === SECRET_AI_KEY) this.creds.aiKey = v;
    else if (key === SECRET_BIND_ID) {
      if (!v) this.creds.bindIdentity = null;
      else { try { this.creds.bindIdentity = JSON.parse(v); } catch (e) { this.creds.bindIdentity = null; } }
    } else return;
    if (v) logger.registerSecret(v);
    // main.js 是同步调用, 落盘异步排队(失败只记日志: 内存里已是新值, 下次 flush 还会写)
    this._chain = this._chain.then(() => this.flush()).catch((e) => logger.error("凭据落盘失败:", e.message));
  }

  async flush() {
    const { saveCredentials } = require("./config");
    await saveCredentials(this.creds, this.path);
  }
}

// ── 启动插件实例 ─────────────────────────────────────────────────────────
// 返回 { plugin, vault, app, internals, credentials }
// plugin 已跑完 onload(): settings/writer/agent/data 都就绪, 但【管道没起】。
async function bootPlugin({ mainJsPath, config, credentials, stateStore, statePath }) {
  const WechatDiaryPlugin = loadPluginModule(mainJsPath);
  const internals = WechatDiaryPlugin.__internals;
  if (!internals) throw new Error("main.js 没有导出 __internals: 版本不匹配");

  momentLite.setTimezone(config.settings.timezone);

  const vault = new FsVault(config.vaultPath, { lockTimeoutMs: config.service.lockTimeoutMs });
  const credAccessor = new CredentialsAccessor(credentials.path, credentials);
  const layoutCallbacks = [];
  const app = makeApp(vault, credAccessor, {
    attachmentFollowNote: config.settings.attachmentFollowNote,
    layoutCallbacks,
  });

  const plugin = new WechatDiaryPlugin(app, { id: "wechat-diary", version: "standalone" });

  // loadData/saveData → StateStore。settings 现拼: 它归 config.json, 不落 state.json。
  plugin.loadData = async () => {
    const st = stateStore.state;
    return {
      settings: Object.assign({}, config.settings),
      ilink: st.ilink,
      profile: st.profile,
      session: st.session,
    };
  };
  plugin.saveData = async (data) => {
    // 只回收运行态; settings 由 config.json 单向供给, 服务端不反写用户配置文件。
    // 这里【不能】用 stateStore.state.ilink = data.ilink 之外的写法去"合并": 一旦换成
    // Object.assign 到旧对象, 又会退回两份对象的老问题(见 bootPlugin 里的注释)。
    // 正常路径下 data.ilink 就是 plugin.data.ilink, 也就是 stateStore.state.ilink, 赋值是幂等的。
    if (data && data.ilink) stateStore.state.ilink = data.ilink;
    if (data && data.profile) stateStore.state.profile = data.profile;
    if (data && data.session) stateStore.state.session = data.session;
    await stateStore.save();
  };

  await plugin.onload();

  // ⚠️ 状态对象身份统一(踩过的坑):
  // main.js 的 onload 里是 `Object.assign(base.ilink, stored.ilink)` —— 它把值【复制】进一个
  // 新对象, 所以 plugin.data.ilink 与 stateStore.state.ilink 是两个不同的对象。
  // 于是"服务端改游标/去重表"与"插件读 userId 做白名单判断"看的是两份数据, 直到下一次
  // saveData 才偶然对齐。这会让白名单误判(消息被当成陌生人丢弃)、去重表看起来没生效。
  // 修法是把 stateStore 的引用指向插件那份, 从此只有一个真相源。
  stateStore.state.ilink = plugin.data.ilink;
  stateStore.state.profile = plugin.data.profile;
  stateStore.state.session = plugin.data.session;

  // onload 里的 onLayoutReady 回调被收集而非执行 —— 那里面是 startPipeline 和气泡渲染。
  // 服务端自己驱动长轮询, 不跑它们。
  logger.debug("插件 onload 完成, 收集到 " + layoutCallbacks.length + " 个 layout 回调(不执行)");

  return { plugin, vault, app, internals, credentials: credAccessor, layoutCallbacks };
}

module.exports = {
  bootPlugin, loadPluginModule, CredentialsAccessor, makeApp, makeFileManager,
  SECRET_BOT_TOKEN, SECRET_AI_KEY, SECRET_BIND_ID,
};
