"use strict";
// 日志。硬要求(第四章): 不得输出完整 token、Cookie、AES key 或隐私消息正文。
//
// 做法不是"记得脱敏", 而是让泄露在结构上做不到:
//   ① 每条日志过一遍 scrub(): 命中 token 形状的串一律替换
//   ② 注册进来的敏感值(启动时把 botToken/aiKey 注册一次)按值全局替换
//   ③ 消息正文永不直接打印, 只打 summarize(): 长度 + 首字符类别
//
// 输出到 stdout/stderr, 由 run.sh 的 tee 落到 logs/service.log。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let _level = LEVELS.info;
const _secrets = new Set();

function setLevel(name) {
  const v = LEVELS[String(name || "").toLowerCase()];
  if (v) _level = v;
}

// 启动时把真实凭据注册进来: 之后任何日志里出现它都会变成 <redacted>
function registerSecret(value) {
  const s = String(value || "");
  if (s.length >= 8) _secrets.add(s);
}

function clearSecrets() { _secrets.clear(); }

// token 形状: 长 base64/hex 串。宁可多打码也不能漏
const TOKEN_SHAPE_RE = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;
const AESKEY_SHAPE_RE = /\b[0-9a-fA-F]{32}\b/g;
const BEARER_RE = /(Bearer|Authorization|token|aeskey|aes_key|encrypted_query_param|encrypt_query_param)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;

function scrub(text) {
  let s = String(text);
  for (const secret of _secrets) {
    if (secret && s.includes(secret)) s = s.split(secret).join("<redacted>");
  }
  s = s.replace(BEARER_RE, (m, k, sep) => k + sep + "<redacted>");
  s = s.replace(AESKEY_SHAPE_RE, "<redacted:aeskey>");
  s = s.replace(TOKEN_SHAPE_RE, "<redacted:long>");
  return s;
}

// 消息正文摘要: 只留可诊断的形状, 不留内容。
// "12 字, 起于 CJK" —— 足够判断"收到了什么样的东西", 不足以复原用户写了什么。
function summarize(text) {
  const s = String(text == null ? "" : text);
  if (!s) return "<空>";
  const n = [...s].length;
  const first = s.trim().charAt(0);
  let kind = "其它";
  if (!first) kind = "空白";
  else if (/[\u4e00-\u9fff]/.test(first)) kind = "CJK";
  else if (/[a-zA-Z]/.test(first)) kind = "拉丁";
  else if (/[0-9]/.test(first)) kind = "数字";
  else if (/[\p{Extended_Pictographic}]/u.test(first)) kind = "emoji";
  else kind = "符号";
  return "<" + n + " 字, 起于" + kind + ">";
}

function ts() {
  return new Date().toISOString();
}

function emit(levelName, args) {
  if (LEVELS[levelName] < _level) return;
  const line = "[" + ts() + "] [" + levelName.toUpperCase() + "] " + args.map((a) => {
    if (a instanceof Error) return a.message + (a.stack ? "\n" + a.stack : "");
    if (typeof a === "object") { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }).join(" ");
  const out = scrub(line);
  if (levelName === "error" || levelName === "warn") process.stderr.write(out + "\n");
  else process.stdout.write(out + "\n");
}

module.exports = {
  setLevel, registerSecret, clearSecrets, scrub, summarize, LEVELS,
  debug: (...a) => emit("debug", a),
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};
