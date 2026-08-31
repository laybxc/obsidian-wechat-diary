"use strict";
// obsidian 模块的服务端替身 + 宿主全局环境。
//
// 这是整个方案的支点: require("obsidian") 被拦截后指向这里, 于是【未经修改的 main.js】
// 可以直接在 Node 里跑。好处是 Daily Note 的字节契约、iLink 协议、意图识别、
// managed section 边界处理全部与 Mac 版共用同一份源码 —— 不存在"两边漂移"这回事。
//
// 需要顶掉的宿主依赖(逐个对齐语义, 不做假装):
//   Plugin           → 提供 loadData/saveData(接到 state-store) 与几个 no-op 注册钩子
//   Notice           → 转成日志(服务端没有弹窗)
//   normalizePath    → vault.js 的同名实现
//   Platform         → isDesktop: true(Node 就是桌面端, 走 https/crypto 分支)
//   moment           → moment-lite
//   requestUrl       → fetch 包装(main.js 只在 AiClient 里用)
//   window.setTimeout 等 → 直接映射到 Node 的全局定时器
//   SecretStorage    → credentials.json(0600)
//   DOM/Electron     → 语音气泡渲染在服务端不跑, 用惰性桩挡住

const logger = require("./logger");
const { normalizePath } = require("./vault");
const momentLite = require("./moment-lite");

// ── 全局环境: main.js 顶层就在用 window.setTimeout / btoa ────────────────
function installGlobals() {
  if (!global.window) {
    global.window = {
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (...a) => clearTimeout(...a),
      setInterval: (...a) => setInterval(...a),
      clearInterval: (...a) => clearInterval(...a),
    };
  }
  if (typeof global.btoa !== "function") {
    global.btoa = (s) => Buffer.from(String(s), "binary").toString("base64");
  }
  if (typeof global.atob !== "function") {
    global.atob = (s) => Buffer.from(String(s), "base64").toString("binary");
  }
  // main.js 的语音气泡渲染会摸 document / MutationObserver / Audio。
  // 服务端不注册这些渲染钩子(见下面的 Plugin 桩), 所以它们不会被调用;
  // 但 onLayoutReady 里的 `typeof MutationObserver === "undefined"` 检查需要它【不存在】才会跳过 ——
  // 故意不提供, 让 main.js 自己走 early return。这一行留作说明, 不要手贱补上。
}

// ── Notice: 弹窗 → 日志 ──────────────────────────────────────────────────
// 插件用 Notice 提醒用户"模板没找到""被别的插件覆盖已补回"等。服务端这些信息
// 同样重要(它们是数据完整性信号), 所以升到 warn 级别而不是丢掉。
const _notices = [];
class Notice {
  constructor(message) {
    const msg = String(message);
    _notices.push({ ts: Date.now(), message: msg });
    if (_notices.length > 200) _notices.shift();
    logger.warn("[notice]", msg);
  }
  setMessage(m) { logger.warn("[notice]", String(m)); return this; }
  hide() {}
}
function recentNotices() { return _notices.slice(); }

// ── Plugin: 只提供 main.js 真正调用的那几个成员 ──────────────────────────
// 关键是 loadData/saveData —— 插件的全部持久化都走它, 服务端把它接到 state-store。
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || {};
    this._intervals = [];
    this._unregisters = [];
  }
  async loadData() { return null; }        // 由 plugin-host 覆盖
  async saveData() {}                      // 由 plugin-host 覆盖
  addCommand() {}                          // 无 UI
  addSettingTab() {}                       // 无 UI
  addStatusBarItem() {
    // main.js 会 _setStatus() 写状态栏文本。服务端把它变成可查询的状态字段(status 命令要用)。
    const self = this;
    return {
      setText(t) { self._statusText = String(t); },
      remove() {},
    };
  }
  registerInterval(id) { this._intervals.push(id); return id; }
  registerMarkdownPostProcessor() {}       // 渲染是 UI 增强, 服务端不跑
  registerEvent() {}
  register(fn) { if (typeof fn === "function") this._unregisters.push(fn); }
  // 服务端退出时要把 main.js 注册的定时器清掉, 否则 Node 不肯退出
  _teardownHostRegistrations() {
    for (const id of this._intervals) { try { clearInterval(id); } catch (e) {} }
    this._intervals = [];
    for (const fn of this._unregisters) { try { fn(); } catch (e) {} }
    this._unregisters = [];
  }
}

// ── 设置页相关: 纯 UI, 给个不会炸的链式桩 ────────────────────────────────
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { childElementCount: 0, empty() {}, createEl: () => ({}) }; }
  display() {}
  hide() {}
}
const _chain = new Proxy({}, { get: () => () => _chain });
class Setting { constructor() { return _chain; } }
class AbstractInputSuggest {}
class Modal {
  constructor(app) {
    this.app = app;
    this.titleEl = { setText() {} };
    this.contentEl = { createEl: () => ({}), createDiv: () => ({}), empty() {}, addClass() {} };
  }
  open() { logger.debug("Modal.open() 在服务端是空操作(绑定走 cli.js bind)"); }
  close() {}
}

// ── requestUrl: main.js 只在 AiClient 里用它调 OpenAI 兼容接口 ───────────
async function requestUrl(opts) {
  const o = typeof opts === "string" ? { url: opts } : (opts || {});
  const res = await fetch(o.url, {
    method: o.method || "GET",
    headers: o.headers || {},
    body: o.body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  const out = { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
  // Obsidian 的 requestUrl 对非 2xx 抛错(throw: true 是默认行为)
  if ((res.status < 200 || res.status >= 300) && o.throw !== false) {
    const err = new Error("requestUrl 失败 HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  return out;
}

const Platform = {
  isDesktop: true,      // Node = 桌面端: main.js 据此放行 require("https") / require("crypto")
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isLinux: process.platform === "linux",
  isMacOS: process.platform === "darwin",
  isWin: process.platform === "win32",
};

// 组装 require("obsidian") 的返回值
function makeObsidianModule() {
  return {
    Plugin, PluginSettingTab, Setting, Modal, Notice, AbstractInputSuggest,
    normalizePath,
    requestUrl,
    Platform,
    moment: momentLite,
    // 下面这些 main.js 没用到, 但列出来避免将来 upstream 加了 import 就炸
    TFile: require("./vault").TFile,
    TFolder: require("./vault").TFolder,
    Component: class Component { load() {} unload() {} },
    MarkdownRenderer: { render: async () => {} },
  };
}

module.exports = { installGlobals, makeObsidianModule, Notice, recentNotices, Plugin, Platform };
