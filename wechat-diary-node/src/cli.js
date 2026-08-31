"use strict";
// 命令行入口。
//   bind                    终端扫码绑定微信
//   claim <userId>          待认领状态下显式认领主人(服务端没有弹窗, 必须人工确认)
//   status                  运行状态: 绑定/游标/去重/今日流水/今日段数
//   doctor                  环境自检: Node/vault/路径/权限/附件落点/ob/锁
//   replay --date YYYY-MM-DD  按事件流水补写没写成的消息
//   dry-run                 连真实微信但只打印不落库(验证协议与解析)
//   print-config            打印生效配置(凭据一律脱敏)
//   unbind                  清除本机凭据与身份(危险操作, 需 --yes)

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const readline = require("readline");
const os = require("os");

const logger = require("./logger");
const cfg = require("./config");
const { WeChatDiaryService } = require("./service");
const { StateStore } = require("./state-store");
const { EventJournal } = require("./event-journal");
const { bindInteractive } = require("./ilink-client");
const { loadPluginModule } = require("./plugin-host");
const { probeAttachmentPath } = require("./media");

const MAIN_JS = path.resolve(__dirname, "..", "..", "main.js");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function ask(question, opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(String(ans || "").trim()); });
  });
}

// ── bind ─────────────────────────────────────────────────────────────────
async function cmdBind(args) {
  const { config } = cfg.loadConfig(args.config);
  const errs = cfg.validateConfig(config);
  if (errs.length) {
    console.error("配置有问题, 先修好再绑定:\n  - " + errs.join("\n  - "));
    console.error("\n配置文件: " + (args.config || cfg.CONFIG_PATH));
    process.exit(1);
  }
  const creds = cfg.loadCredentials();
  if (creds.botToken && !args.force) {
    console.log("本机已有凭据(" + creds.path + ")。");
    console.log("重新扫码通常会得到 binded_redirect(沿用现有登录)。确实要重新绑定请加 --force。");
    const st = new StateStore(cfg.STATE_PATH);
    await st.load();
    if (st.state.ilink.userId) {
      console.log("当前主人: " + cfg.maskId(st.state.ilink.userId));
      process.exit(0);
    }
    console.log("但没有主人身份(待认领)。继续扫码以补齐身份…\n");
  }

  // 加载 main.js 拿 ILinkClient(协议实现与 Mac 版共用)
  const Plugin = loadPluginModule(MAIN_JS);
  const { ILinkClient } = Plugin.__internals;

  console.log("正在获取二维码…\n");
  const tmpDir = path.join(os.tmpdir(), "wechat-diary-qr");
  await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });

  const res = await bindInteractive({
    ILinkClient,
    existingToken: creds.botToken || "",
    savePngDir: tmpDir,
    onQr: (pageUrl, ascii, imgPath) => {
      console.log("\n请用【手机微信】扫下面的二维码, 然后在打开的页面里点确认绑定:\n");
      if (ascii) console.log(ascii);
      else console.log("(终端二维码渲染失败)");
      console.log("\n扫不出来的话, 有两个备选:");
      if (imgPath) console.log("  · 图片已存到 " + imgPath + " —— 用 scp 拉到本地打开再扫");
      console.log("  · 直接在手机浏览器打开这个链接(它就是二维码的内容):");
      console.log("    " + pageUrl);
      console.log("");
    },
    onStatus: (s) => console.log("· " + s),
    askVerifyCode: async () => ask("输入手机微信上显示的验证码: "),
  });

  if (!res.ok) {
    console.error("\n绑定失败: " + res.reason);
    process.exit(1);
  }

  // 落凭据(0600) + 落身份
  const newCreds = {
    botToken: res.botToken || creds.botToken,
    aiKey: creds.aiKey,
    bindIdentity: { userId: res.userId || "", botId: res.botId || "", baseUrl: res.baseUrl || "" },
  };
  await cfg.saveCredentials(newCreds);

  // 状态: 换了 bot 就必须清游标与去重表 —— seq 是 bot 会话级计数器, 不是全局 id。
  // 保留旧 recentSeqs 会把新 bot 的前 N 条消息静默吞掉(main.js 注释里记的实测踩坑)。
  const st = new StateStore(cfg.STATE_PATH);
  await st.load();
  const il = st.state.ilink;
  const sameUser = il.userId === res.userId;
  const sameBot = sameUser && il.botId === res.botId;
  if (res.userId) il.userId = res.userId;
  if (res.botId) il.botId = res.botId;
  if (res.baseUrl) il.baseUrl = res.baseUrl;
  il.loginTime = new Date().toISOString();
  il.pauseUntil = 0;
  if (!sameBot) {
    il.buf = "";
    il.contextTokens = {};
    il.recentSeqs = [];
    console.log("(检测到新的 bot 会话: 已重置游标与去重表)");
  }
  if (!sameUser) {
    st.state.profile = { state: "unknown", name: null, nudge_count: 0, finalize_count: 0 };
  }
  il.skipBacklog = false;
  await st.save();

  console.log("\n绑定成功 ✅");
  if (res.alreadyBound) console.log("(服务端返回 binded_redirect: 这个 bot 之前已连过, 沿用现有凭据)");
  console.log("  用户: " + cfg.maskId(il.userId));
  console.log("  bot : " + cfg.maskId(il.botId));
  console.log("  凭据: " + cfg.CREDENTIALS_PATH + " (0600)");
  console.log("  状态: " + cfg.STATE_PATH);
  if (!il.userId) {
    console.log("\n⚠️ 服务端这次没有下发用户身份(待认领)。启动服务后给 bot 发一条消息,");
    console.log("   日志里会打出待认领的 id, 用 `node src/cli.js claim <id>` 确认。");
  }
  console.log("\n下一步: ./run.sh 启动服务(或用 tmux, 见 README)");
}

// ── claim ────────────────────────────────────────────────────────────────
async function cmdClaim(args) {
  const userId = args._[1];
  if (!userId) { console.error("用法: node src/cli.js claim <userId>"); process.exit(1); }
  const st = new StateStore(cfg.STATE_PATH);
  await st.load();
  if (st.state.ilink.userId) {
    console.error("已经有主人了: " + cfg.maskId(st.state.ilink.userId) + "。要换人请先 unbind。");
    process.exit(1);
  }
  st.state.ilink.userId = userId;
  st.state.ilink.loginTime = st.state.ilink.loginTime || new Date().toISOString();
  // 认领时游标必然是空的(不然身份不会丢), 服务端可能还在回吐积压: 先跳过一轮
  st.state.ilink.skipBacklog = true;
  await st.save();
  const creds = cfg.loadCredentials();
  await cfg.saveCredentials({
    botToken: creds.botToken, aiKey: creds.aiKey,
    bindIdentity: { userId, botId: st.state.ilink.botId, baseUrl: st.state.ilink.baseUrl },
  });
  console.log("已认领主人: " + cfg.maskId(userId));
  console.log("(已启用跳过积压: 追平后开始正常记录)");
}

// ── status ───────────────────────────────────────────────────────────────
async function cmdStatus(args) {
  const svc = new WeChatDiaryService({ configPath: args.config });
  await svc.init();
  const s = await svc.status();
  console.log(JSON.stringify(s, null, 2));
  svc.plugin._teardownHostRegistrations();
}

// ── doctor ───────────────────────────────────────────────────────────────
async function cmdDoctor(args) {
  const problems = [];
  const notes = [];
  const ok = (m) => console.log("  ✓ " + m);
  const bad = (m) => { console.log("  ✗ " + m); problems.push(m); };
  const warn = (m) => { console.log("  ! " + m); notes.push(m); };

  console.log("== 环境 ==");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 22) ok("Node " + process.versions.node);
  else bad("Node " + process.versions.node + " 太旧, 需要 22+");

  try {
    const { execFileSync } = require("child_process");
    const v = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
    ok("tmux " + v);
  } catch (e) { warn("tmux 不可用(不影响服务本身, 但 run.sh 的常驻方式需要它)"); }
  try {
    const { execFileSync } = require("child_process");
    execFileSync("ob", ["--version"], { encoding: "utf8" });
    ok("ob (Obsidian headless) 可用");
  } catch (e) { warn("ob 不可用: Headless Sync 需要它"); }

  console.log("\n== 配置 ==");
  const { config, configPath, exists } = cfg.loadConfig(args.config);
  if (exists) ok("配置文件 " + configPath);
  else bad("配置文件不存在: " + configPath + " (从 config.example.json 复制一份)");
  const errs = cfg.validateConfig(config);
  if (errs.length) for (const e of errs) bad(e);
  else ok("配置校验通过");

  console.log("\n== 凭据与状态 ==");
  const creds = cfg.loadCredentials();
  if (creds.botToken) ok("已有 bot token (" + creds.path + ")");
  else warn("还没有 bot token: 跑 `node src/cli.js bind`");
  const perm = cfg.checkPermissions(creds.path);
  if (perm.length) for (const p of perm) bad(p);
  else if (creds.exists) ok("凭据文件权限 0600");
  // state 目录可写?
  try {
    await fsp.mkdir(path.dirname(cfg.STATE_PATH), { recursive: true, mode: 0o700 });
    await fsp.access(path.dirname(cfg.STATE_PATH), fs.constants.W_OK);
    ok("状态目录可写 " + path.dirname(cfg.STATE_PATH));
  } catch (e) { bad("状态目录不可写: " + e.message); }

  if (errs.length) {
    console.log("\n配置有错, 跳过 vault 相关检查。");
    finish(problems, notes);
    return;
  }

  console.log("\n== Vault ==");
  const vp = config.vaultPath;
  try {
    await fsp.access(vp, fs.constants.R_OK | fs.constants.W_OK);
    ok("vault 可读写 " + vp);
  } catch (e) { bad("vault 不可读写: " + e.message); }
  // 磁盘空间
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("df", ["-h", vp], { encoding: "utf8" }).trim().split("\n").pop();
    const parts = out.split(/\s+/);
    const usePct = Number(String(parts[4] || "0").replace("%", ""));
    if (usePct >= 95) bad("磁盘使用率 " + usePct + "% —— 写入随时可能 ENOSPC");
    else ok("磁盘剩余 " + parts[3] + " (使用 " + parts[4] + ")");
  } catch (e) { warn("无法检查磁盘空间: " + e.message); }

  // 启动一个服务实例(不跑循环)做路径与写入面的检查
  const svc = new WeChatDiaryService({ configPath: args.config });
  try {
    await svc.init();
  } catch (e) {
    bad("服务初始化失败: " + e.message);
    finish(problems, notes);
    return;
  }
  const today = svc.I.logicalTodayStr();
  const notePath = svc.writer.diaryPath(today);
  console.log("\n== 日记路径 ==");
  ok("逻辑日 " + today + " (时区 " + config.settings.timezone + ", 切日 " + config.settings.dayStartHour + ":00)");
  ok("当天笔记 " + notePath);
  // 双年目录 bug 的守门: 2026 应该只出现一次
  const yearCount = (notePath.match(/\/2\d{3}\//g) || []).length;
  if (/\/(2\d{3})\/\1\//.test(notePath)) bad("路径里出现重复年份目录: " + notePath);
  else ok("路径无重复年份目录");
  const existing = svc.vault.getFileByPath(notePath);
  if (existing) {
    ok("当天笔记已存在(服务会写进已有文件)");
    const body = await svc.writer.readManagedBody(today);
    if (body == null) notes.push("当天笔记里还没有 managed 边界: 第一条微信记录会在「## " + config.settings.sectionHeading + "」内建立它");
    else ok("已有 managed 边界, 当前微信记录 " + await svc.writer.countDay(today) + " 条");
    // 有没有「## 日常记录」这一节?
    const content = await svc.vault.cachedRead(existing);
    if (svc.I.locateSection(content, config.settings.sectionHeading)) ok("已有「## " + config.settings.sectionHeading + "」节");
    else warn("当天笔记里没有「## " + config.settings.sectionHeading + "」节: 服务会在文件末尾追加这一节");
  } else {
    notes.push("当天笔记还不存在: 第一条消息会创建它(父目录自动建)");
  }

  console.log("\n== 附件落点 ==");
  const probe = await probeAttachmentPath(svc.plugin, today);
  if (probe.ok) ok("附件将写入 " + probe.expectedDir + "/ (跟随当天笔记)");
  else bad("附件落点不符合预期: 算出 " + probe.resolved + ", 期望 " + probe.expectedDir + "/");

  console.log("\n== 事件流水 ==");
  const dates = await svc.journal.listDates();
  ok("流水目录 " + path.join(vp, config.service.journalDir) + " (" + dates.length + " 天)");
  let pendingTotal = 0;
  for (const d of dates.slice(-7)) {
    const sum = await svc.journal.summary(d);
    if (sum.pending) { warn(d + ": 有 " + sum.pending + " 条待补写 → node src/cli.js replay --date " + d); pendingTotal += sum.pending; }
    if (sum.badLines) warn(d + ": 有 " + sum.badLines + " 行无法解析的流水");
  }
  if (!pendingTotal) ok("没有待补写的消息");

  console.log("\n== 写入面(真实读写测试, 不碰日记) ==");
  try {
    const probeRel = path.posix.join(config.service.journalDir, ".doctor-probe");
    const abs = path.join(vp, probeRel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const { atomicWrite, acquireLock } = require("./vault");
    await atomicWrite(abs, "doctor " + new Date().toISOString() + "\n");
    const lock = await acquireLock(abs, 3000);
    await lock.release();
    await fsp.unlink(abs);
    ok("原子写 + 文件锁工作正常");
  } catch (e) { bad("写入面测试失败: " + e.message); }

  console.log("\n== ob 同步 ==");
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("ob", ["sync-status", "--path", vp], { encoding: "utf8", timeout: 20000 });
    const line = out.split("\n").find((l) => l.includes("Sync mode")) || "";
    ok("ob 已配置这个 vault" + (line ? " (" + line.trim() + ")" : ""));
    if (/Excluded folders:.*\b5\.TDSQL\b/.test(out)) bad("5.TDSQL 在 ob 的排除目录里 —— 记录不会同步到其它设备");
  } catch (e) { warn("ob sync-status 查不到这个 vault: " + String(e.message).split("\n")[0]); }

  svc.plugin._teardownHostRegistrations();
  finish(problems, notes);
}

function finish(problems, notes) {
  console.log("\n" + "=".repeat(40));
  if (problems.length) {
    console.log("发现 " + problems.length + " 个问题:");
    for (const p of problems) console.log("  ✗ " + p);
  } else {
    console.log("没有阻塞性问题 ✅");
  }
  if (notes.length) {
    console.log("\n提示 " + notes.length + " 条:");
    for (const n of notes) console.log("  ! " + n);
  }
  process.exit(problems.length ? 1 : 0);
}

// ── replay ───────────────────────────────────────────────────────────────
async function cmdReplay(args) {
  const svc = new WeChatDiaryService({ configPath: args.config });
  await svc.init();
  let dates;
  if (args.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) { console.error("--date 要 YYYY-MM-DD 格式"); process.exit(1); }
    dates = [args.date];
  } else if (args.all) {
    dates = await svc.journal.listDates();
  } else {
    dates = [svc.I.yesterdayStr(), svc.I.logicalTodayStr()];
  }
  const results = [];
  for (const d of dates) results.push(await svc.replayDate(d));
  console.log(JSON.stringify(results.filter((r) => r.pending), null, 2));
  const totalFailed = results.reduce((a, r) => a + r.failed, 0);
  svc.plugin._teardownHostRegistrations();
  process.exit(totalFailed ? 1 : 0);
}

// ── dry-run ──────────────────────────────────────────────────────────────
async function cmdDryRun(args) {
  console.log("dry-run: 会连真实微信长轮询, 但【不写】Daily Note、【不写】流水、【不回】消息。");
  console.log("用来验证协议连通性与消息解析。Ctrl-C 退出。\n");
  const svc = new WeChatDiaryService({ configPath: args.config, dryRun: true });
  await svc.init();
  const onSignal = (sig) => { svc.shutdown(sig).then(() => process.exit(0)); };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  await svc.run();
}

// ── print-config ─────────────────────────────────────────────────────────
async function cmdPrintConfig(args) {
  const { config, configPath, exists } = cfg.loadConfig(args.config);
  const creds = cfg.loadCredentials();
  const st = new StateStore(cfg.STATE_PATH);
  await st.load();
  const out = {
    configPath, configExists: exists,
    config,
    credentialsPath: creds.path,
    credentials: cfg.redactCredentials(creds),
    statePath: cfg.STATE_PATH,
    state: {
      userId: cfg.maskId(st.state.ilink.userId),
      botId: cfg.maskId(st.state.ilink.botId),
      baseUrl: st.state.ilink.baseUrl,
      cursorLength: (st.state.ilink.buf || "").length,     // 游标本身是服务端凭据, 只报长度
      recentSeqs: st.state.ilink.recentSeqs.length,
      skipBacklog: st.state.ilink.skipBacklog,
      profileState: st.state.profile.state,
      enteredDate: st.state.session.entered_date,
      fileMd5s: st.state.ilink.fileMd5s.length,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

// ── unbind ───────────────────────────────────────────────────────────────
async function cmdUnbind(args) {
  if (!args.yes) {
    console.log("unbind 会删除本机的 bot token 与绑定身份。");
    console.log("⚠️ 服务端【不会补发】凭据: 解绑后必须重新扫码, 且同一微信号可能返回 binded_redirect。");
    console.log("确认请加 --yes。只想换主人不删凭据: --keep-token --yes");
    process.exit(1);
  }
  const creds = cfg.loadCredentials();
  const keep = !!args["keep-token"];
  await cfg.saveCredentials({ botToken: keep ? creds.botToken : "", aiKey: creds.aiKey, bindIdentity: null });
  const st = new StateStore(cfg.STATE_PATH);
  await st.load();
  const { emptyState } = require("./state-store");
  const fresh = emptyState();
  if (keep) { fresh.ilink.botId = st.state.ilink.botId; fresh.ilink.baseUrl = st.state.ilink.baseUrl; }
  st.state = fresh;
  await st.save();
  console.log(keep ? "已清除主人身份, 保留 token(待认领状态)" : "已清除凭据与状态");
}

// ── main ─────────────────────────────────────────────────────────────────
const USAGE = `WeChat Diary 独立服务 —— 命令行

  node src/cli.js <命令> [选项]

命令:
  bind                        终端扫码绑定微信 (--force 强制重新绑定)
  claim <userId>              待认领状态下确认主人身份
  status                      运行状态 (JSON)
  doctor                      环境与配置自检
  replay [--date YYYY-MM-DD]  按事件流水补写没写成的消息 (--all 全部日期)
  dry-run                     连真实微信但不落库不回消息
  print-config                打印生效配置 (凭据脱敏)
  unbind --yes                清除凭据与身份 (--keep-token 只清主人)

选项:
  --config <path>             指定配置文件 (默认 ${cfg.CONFIG_PATH})

启动服务: node src/service.js  或  ./run.sh
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const table = {
    bind: cmdBind, claim: cmdClaim, status: cmdStatus, doctor: cmdDoctor,
    replay: cmdReplay, "dry-run": cmdDryRun, dryrun: cmdDryRun,
    "print-config": cmdPrintConfig, printconfig: cmdPrintConfig,
    unbind: cmdUnbind,
  };
  if (!cmd || cmd === "help" || args.help) { console.log(USAGE); process.exit(cmd ? 0 : 1); }
  const fn = table[cmd];
  if (!fn) { console.error("未知命令: " + cmd + "\n"); console.log(USAGE); process.exit(1); }
  try {
    await fn(args);
  } catch (e) {
    console.error("\n出错: " + e.message);
    if (process.env.WECHAT_DIARY_DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseArgs };
