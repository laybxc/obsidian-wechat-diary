"use strict";
// 配置与路径解析。
//
// 三个文件, 三种寿命:
//   config.json       — 用户可读可改的设置(vault 路径、日记根目录、路径格式、节标题…)
//   credentials.json  — bot token / AI key / 绑定身份。0600, 永不进 Git, 永不打日志
//   state.json        — 游标(buf)、去重表(recentSeqs)、profile/session。服务自己维护
//
// 默认位置遵循 XDG:
//   ~/.config/wechat-diary/{config,credentials}.json
//   ~/.local/state/wechat-diary/state.json
// 可用 WECHAT_DIARY_CONFIG_DIR / WECHAT_DIARY_STATE_DIR 覆盖(测试用)。

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const CONFIG_DIR = process.env.WECHAT_DIARY_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "wechat-diary");
const STATE_DIR = process.env.WECHAT_DIARY_STATE_DIR
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wechat-diary");

const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const STATE_PATH = path.join(STATE_DIR, "state.json");

// 服务端默认值。settings 段的键名与插件 data.json 的 settings 一一对应——
// 名字故意不改: 两边共用 main.js 的同一份 DEFAULT_SETTINGS 语义, 改名就等于制造契约漂移。
const DEFAULT_CONFIG = {
  // vault 的绝对路径。必须先用 doctor 验证, 不猜。
  vaultPath: "",
  settings: {
    diaryFolder: "5.TDSQL",
    pathFormat: "YYYY/MM/YYYY-MM-DD",
    timezone: "Asia/Shanghai",
    dayStartHour: 0,              // 切日 00:00(用户要求; 插件默认 4)
    sharedDailyNote: true,        // 写进已有的每日笔记, 不独占文件
    managedSection: true,         // fork 扩展: 不可见边界隔离插件正文
    sectionHeading: "日常记录",    // 不创建「微信随手记」
    attachmentMode: "custom",     // 附件跟随笔记: 当天笔记目录下的 assets
    attachmentFolder: "",         // custom 模式下留空 = 由 attachmentFollowNote 接管
    attachmentSubFormat: "",
    attachmentFollowNote: true,   // 服务端扩展: 附件放当天笔记同级的 assets/
    templatePath: "",
    saveVoiceAudio: true,
    reminderEnabled: false,       // 服务端常驻, 默认不打扰; 想开自己改
    reminderTime: "21:30",
    nudgeNightHour: 22,
    aiApiUrl: "",
    aiModel: "",
  },
  service: {
    appendOnly: false,           // Opt-in compact lists; disables undo and sealing.
    // 崩溃重启由 run.sh 负责; 这里只控制服务内部行为
    logLevel: "info",             // debug | info | warn | error
    // 写完 Daily Note 后重新读一遍确认消息真的在里面(第六章要求)
    verifyAfterWrite: true,
    // 文件锁超时: 超过这个时间拿不到锁就放弃本次写入, 事件流水保留待重放
    lockTimeoutMs: 15000,
    // 事件流水目录(相对 vault)
    journalDir: ".wechat-diary/events",
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    const b = out[k], o = over[k];
    if (b && o && typeof b === "object" && typeof o === "object" && !Array.isArray(b) && !Array.isArray(o)) {
      out[k] = deepMerge(b, o);
    } else if (o !== undefined) {
      out[k] = o;
    }
  }
  return out;
}

function readJsonSync(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error("配置文件解析失败 " + p + ": " + e.message);
  }
}

// 加载配置(同步: 启动路径上就这一次, 简单胜过异步)。
// 返回 { config, configPath, exists }。
function loadConfig(explicitPath) {
  const p = explicitPath || CONFIG_PATH;
  const raw = readJsonSync(p);
  const config = deepMerge(DEFAULT_CONFIG, raw || {});
  return { config, configPath: p, exists: raw !== null };
}

// 凭据。缺文件 = 未绑定, 不是错误。
function loadCredentials(explicitPath) {
  const p = explicitPath || CREDENTIALS_PATH;
  const raw = readJsonSync(p);
  return {
    path: p,
    exists: raw !== null,
    botToken: (raw && raw.botToken) || "",
    aiKey: (raw && raw.aiKey) || "",
    // 绑定身份: data.json 丢了也能靠它恢复(对齐插件的 SECRET_BIND_ID)
    bindIdentity: (raw && raw.bindIdentity) || null,
  };
}

// 凭据落盘: 先 0600 建临时文件再 rename, 全程不让文件在 0644 下存在过一瞬间。
async function saveCredentials(creds, explicitPath) {
  const p = explicitPath || CREDENTIALS_PATH;
  await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    botToken: creds.botToken || "",
    aiKey: creds.aiKey || "",
    bindIdentity: creds.bindIdentity || null,
  }, null, 2) + "\n";
  const tmp = p + ".tmp." + process.pid;
  // mode 传给 open(2), 文件从诞生就是 0600
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);   // umask 可能削弱 mode, 显式再来一次
  await fsp.rename(tmp, p);
  await fsp.chmod(p, 0o600);
}

// 权限自检: 凭据文件必须是 0600(第四章硬要求)。返回问题描述数组。
function checkPermissions(credPath) {
  const problems = [];
  const p = credPath || CREDENTIALS_PATH;
  try {
    const st = fs.statSync(p);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      problems.push("凭据文件权限是 0" + mode.toString(8) + ", 必须是 0600: chmod 600 " + p);
    }
  } catch (e) {
    if (e.code !== "ENOENT") problems.push("凭据文件无法读取: " + e.message);
  }
  try {
    const st = fs.statSync(path.dirname(p));
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      problems.push("配置目录 " + path.dirname(p) + " 权限是 0" + mode.toString(8) + ", 建议 0700");
    }
  } catch (e) { /* 目录不存在: 由 doctor 的其它检查报告 */ }
  return problems;
}

// 打印用的脱敏视图: token/key 一律只留长度与指纹, 绝不出原文。
function redactCredentials(creds) {
  const mask = (v) => {
    if (!v) return null;
    const crypto = require("crypto");
    const fp = crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 8);
    return "<" + String(v).length + " 字符, sha256:" + fp + ">";
  };
  return {
    botToken: mask(creds.botToken),
    aiKey: mask(creds.aiKey),
    bindIdentity: creds.bindIdentity
      ? { userId: maskId(creds.bindIdentity.userId), botId: maskId(creds.bindIdentity.botId), baseUrl: creds.bindIdentity.baseUrl || "" }
      : null,
  };
}

// 用户 id / bot id 也是身份凭据: 日志里只留头尾(定位问题够用, 泄露了也不能冒用)
function maskId(id) {
  const s = String(id || "");
  if (!s) return "";
  if (s.length <= 8) return s.slice(0, 2) + "***";
  return s.slice(0, 4) + "***" + s.slice(-4);
}

// 校验配置的必填项与形状。返回错误数组(空 = 通过)。
function validateConfig(config) {
  const errs = [];
  const vp = String(config.vaultPath || "").trim();
  if (!vp) errs.push("vaultPath 未配置: 填 Obsidian vault 的绝对路径");
  else if (!path.isAbsolute(vp)) errs.push("vaultPath 必须是绝对路径: " + vp);
  else {
    try {
      const st = fs.statSync(vp);
      if (!st.isDirectory()) errs.push("vaultPath 不是目录: " + vp);
    } catch (e) {
      errs.push("vaultPath 不存在或不可读: " + vp + " (" + e.code + ")");
    }
  }
  const s = config.settings || {};
  if (!String(s.sectionHeading || "").trim()) errs.push("settings.sectionHeading 不能为空");
  if (/[\r\n]/.test(String(s.sectionHeading || ""))) errs.push("settings.sectionHeading 不能换行");
  const dsh = Number(s.dayStartHour);
  if (!Number.isFinite(dsh) || dsh < 0 || dsh > 12) errs.push("settings.dayStartHour 必须在 0..12");
  try {
    new Intl.DateTimeFormat("en", { timeZone: s.timezone });
  } catch (e) {
    errs.push("settings.timezone 不是有效时区: " + s.timezone);
  }
  return errs;
}

module.exports = {
  CONFIG_DIR, STATE_DIR, CONFIG_PATH, CREDENTIALS_PATH, STATE_PATH,
  DEFAULT_CONFIG,
  loadConfig, loadCredentials, saveCredentials,
  checkPermissions, redactCredentials, maskId, validateConfig,
  deepMerge,
};
