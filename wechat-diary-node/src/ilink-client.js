"use strict";
// iLink 协议客户端(适配层)。
//
// 协议实现【不在这里】——它在 main.js 的 ILinkClient 里, 与 Mac 版共用同一份:
// 扫码绑定、长轮询、getupdates 游标、sendmessage 分片、CDN 下载与 AES-128-ECB 解密、
// -14 冷却、302 跟随、keepAlive 连接复用, 全部照用。腾讯的协议细节靠实测换来,
// 在服务端重新猜一遍毫无收益, 只会引入两套 bug。
//
// 这一层只做三件 main.js 做不了的事:
//   ① 把扫码流程从 Modal(GUI)搬到终端 —— QrLoginModal 依赖 DOM, 服务端要 ASCII 二维码
//   ② 提供退出时的干净关闭(destroyAll + notifystop)
//   ③ 二维码渲染: 复用 main.js 内嵌的 qrcode-generator, 但输出到 TTY 而不是 <img>

const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const logger = require("./logger");

// main.js 里的协议常量(同值; 拿不到导出的就用这份)
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_LOCAL_TTL_MS = 5 * 60 * 1000;
const LOGIN_TOTAL_TIMEOUT_MS = 480000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── 终端二维码 ───────────────────────────────────────────────────────────
// 复用 main.js 内嵌的 qrcode-generator(与插件同一个库、同一版本), 只换输出后端。
// 半块字符(▀▄█)一行画两行模块: 终端字符是高瘦的, 一模块一字符会拉成长方形, 微信扫不动。
function renderQrToTerminal(text) {
  let qrcode;
  try {
    // main.js 的 UMD 段把 qrcode 挂到 module.exports 上, 但文件末尾又被 WechatDiaryPlugin 覆盖了。
    // 所以不能从 main.js 拿 —— 用同款算法的独立实现: 从 main.js 源码里切出 UMD 段单独 eval。
    qrcode = loadEmbeddedQrcode();
  } catch (e) {
    logger.warn("二维码渲染器加载失败:", e.message);
    return null;
  }
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const size = n + quiet * 2;
  const dark = (r, c) => {
    if (r < quiet || c < quiet || r >= n + quiet || c >= n + quiet) return false;
    return qr.isDark(r - quiet, c - quiet);
  };
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = "";
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bot = r + 1 < size ? dark(r + 1, c) : false;
      // 反色: 终端多为深色背景, "亮=白"才扫得出。dark 模块画成空格(亮), 空白画成实块。
      if (top && bot) line += " ";
      else if (top) line += "▄";
      else if (bot) line += "▀";
      else line += "█";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

let _qrcodeCache = null;
function loadEmbeddedQrcode() {
  if (_qrcodeCache) return _qrcodeCache;
  const fs = require("fs");
  const mainPath = path.resolve(__dirname, "..", "..", "main.js");
  const src = fs.readFileSync(mainPath, "utf8");
  // UMD 段 = 文件开头到"以上为内嵌的 qrcode-generator"那条分隔注释
  const marker = "// 以上为内嵌的 qrcode-generator";
  const cut = src.indexOf(marker);
  if (cut < 0) throw new Error("main.js 里找不到内嵌 qrcode 段的分隔注释");
  const umd = src.slice(0, cut);
  const m = { exports: {} };
  // UMD 尾部会 module.exports = factory(); 这里给它一个干净的 module
  const fn = new Function("module", "exports", umd + "\nreturn module.exports;");
  _qrcodeCache = fn(m, m.exports);
  if (typeof _qrcodeCache !== "function") throw new Error("内嵌 qrcode 段没有导出函数");
  return _qrcodeCache;
}

// ── 终端扫码绑定 ─────────────────────────────────────────────────────────
// 与 main.js 的 QrLoginModal._run 同一套状态机(confirmed / binded_redirect / expired /
// scaned_but_redirect / need_verifycode / verify_code_blocked / scaned / wait),
// 逐条对齐, 只把 UI 从 Modal 换成 stdout + readline。
//
// onQr(pageUrl, asciiQr, pngPath): 展示二维码
// askVerifyCode(): 返回用户输入的验证码
// 返回 { ok, botToken, botId, userId, baseUrl, reason }
async function bindInteractive({ ILinkClient, existingToken, onQr, askVerifyCode, onStatus, savePngDir }) {
  const client = new ILinkClient();
  const say = (s) => { if (onStatus) onStatus(s); };
  const startTs = Date.now();
  let refreshes = 0;
  let verifyCode = null;
  try {
    let { qrcode: ticket, qrPageUrl } = await client.getQrcode(existingToken ? [existingToken] : []);
    await showQr(qrPageUrl, onQr, savePngDir);
    say("等待扫码…");
    let pollBase = FIXED_BASE_URL;
    let qrIssuedAt = Date.now();

    const refreshQr = async (statusText) => {
      refreshes += 1;
      if (refreshes > 3) return false;
      const fresh = await client.getQrcode(existingToken ? [existingToken] : []);
      ticket = fresh.qrcode;
      verifyCode = null;              // 新码不携带旧验证码
      qrIssuedAt = Date.now();
      await showQr(fresh.qrPageUrl, onQr, savePngDir);
      say(statusText);
      return true;
    };

    for (;;) {
      if (Date.now() - startTs > LOGIN_TOTAL_TIMEOUT_MS) return { ok: false, reason: "登录超时(8 分钟), 重新运行 bind 再试" };
      if (Date.now() - qrIssuedAt > QR_LOCAL_TTL_MS) {
        try {
          if (!(await refreshQr("二维码到期, 换了一张, 重新扫一下"))) return { ok: false, reason: "二维码多次失效, 稍后再试" };
        } catch (e) {
          await sleep(2000);   // 主动换码撞上网络抖动: 重试, 别把登录判死(refreshes 天然封顶)
        }
        continue;
      }
      let r;
      try {
        r = await client.pollQrStatus(pollBase, ticket, verifyCode);
      } catch (e) {
        await sleep(1000);     // 网关抖动(5xx/524)视为 wait
        continue;
      }
      if (r.__timeout) continue;      // 长轮询正常心跳
      const st = r.json && r.json.status;

      if (st === "confirmed") {
        const j = r.json;
        if (!j.ilink_bot_id) return { ok: false, reason: "登录响应缺 bot_id, 重新运行 bind" };
        return {
          ok: true,
          botToken: j.bot_token, botId: j.ilink_bot_id,
          userId: j.ilink_user_id, baseUrl: (j.baseurl || "").trim(),
        };
      }
      if (st === "binded_redirect") {
        // 官方语义是【成功】: 这个 bot 已绑到本实例, 不再下发新凭据, 现有凭据仍有效
        const uid = (r.json && r.json.ilink_user_id) || "";
        if (existingToken) {
          return { ok: true, alreadyBound: true, botToken: existingToken, userId: uid, botId: "", baseUrl: "" };
        }
        return { ok: false, reason: "这个微信号已经连过一个 bot, 但本机没有凭据, 服务端不会补发。换个微信号扫可以立刻用上。" };
      }
      if (st === "expired") {
        if (!(await refreshQr("二维码过期, 换了一张, 重新扫一下"))) return { ok: false, reason: "二维码多次失效, 稍后再试" };
        continue;
      }
      if (st === "scaned_but_redirect") {
        if (r.json.redirect_host) pollBase = "https://" + r.json.redirect_host;
        continue;
      }
      if (st === "need_verifycode") {
        say(verifyCode ? "验证码不对, 再输一次" : "微信要求输入验证码(看手机上显示的数字)");
        verifyCode = await askVerifyCode();
        if (!verifyCode) return { ok: false, reason: "未输入验证码, 已取消" };
        continue;                     // 提交后立刻轮询, 不 sleep
      }
      if (st === "verify_code_blocked") {
        verifyCode = null;
        if (!(await refreshQr("验证码多次输错, 换了张新码, 重新扫"))) return { ok: false, reason: "验证码多次输错被限制, 过一会儿再试" };
        continue;
      }
      if (st === "scaned") { verifyCode = null; say("已扫码, 在手机上确认一下…"); }
      await sleep(1000);              // wait 及未知状态: 继续轮询
    }
  } finally {
    client.destroyAll();
  }
}

async function showQr(pageUrl, onQr, savePngDir) {
  const ascii = renderQrToTerminal(pageUrl);
  let pngPath = "";
  if (savePngDir) {
    // 终端渲染不出来时的兜底: 存一张 PNG(qrcode-generator 的 createDataURL 是 GIF, 这里存它)
    try {
      const qrcode = loadEmbeddedQrcode();
      const qr = qrcode(0, "M");
      qr.addData(pageUrl);
      qr.make();
      const dataUrl = qr.createDataURL(8, 16);
      const b64 = String(dataUrl).split(",")[1] || "";
      pngPath = path.join(savePngDir, "wechat-diary-qr-" + Date.now() + ".gif");
      await fsp.writeFile(pngPath, Buffer.from(b64, "base64"), { mode: 0o600 });
    } catch (e) {
      logger.debug("二维码图片保存失败(不影响终端扫码):", e.message);
      pngPath = "";
    }
  }
  if (onQr) onQr(pageUrl, ascii, pngPath);
}

module.exports = { bindInteractive, renderQrToTerminal, loadEmbeddedQrcode, FIXED_BASE_URL, sleep };
