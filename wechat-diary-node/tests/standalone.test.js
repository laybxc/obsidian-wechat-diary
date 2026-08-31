"use strict";
// standalone adapter 的集成测试。
//
// 分工:
//   tests/bindtest.js (上游 581 项) 盯的是【纯函数与写入字节契约】—— 意图识别、
//     段头合并、managed 边界、计数、撤回、封存、路径渲染。那些逻辑服务端原样复用,
//     所以它们同时也是服务端的回归网(run.js 会先跑它)。
//   本文件盯的是【宿主适配层】—— 真实文件系统、事件流水、状态存储、并发与信号,
//     这些在 Obsidian 里不存在, 上游测不到。
//
// 覆盖用户第八章列的 17 条(编号标在每组前)。
// 全程真实读写临时目录, 不碰任何真实 vault。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const MAIN_JS = path.resolve(ROOT, "..", "main.js");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else {
    fail++; failures.push(name);
    console.log("  ✗ " + name + (extra !== undefined ? "\n      → " + String(extra).slice(0, 600) : ""));
  }
}
function eq(name, actual, expected) {
  const ok = actual === expected;
  check(name, ok, ok ? "" : "实际: " + JSON.stringify(actual) + "\n      期望: " + JSON.stringify(expected));
}

// ── 测试沙箱 ─────────────────────────────────────────────────────────────
let SANDBOX;
function freshSandbox(tag) {
  SANDBOX = path.join(os.tmpdir(), "wd-node-test-" + tag + "-" + process.pid + "-" + Date.now());
  fs.mkdirSync(path.join(SANDBOX, "config"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(SANDBOX, "state"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(SANDBOX, "vault", "5.TDSQL", "2026", "08"), { recursive: true });
  process.env.WECHAT_DIARY_CONFIG_DIR = path.join(SANDBOX, "config");
  process.env.WECHAT_DIARY_STATE_DIR = path.join(SANDBOX, "state");
  // config 模块缓存了路径常量: 每个沙箱都要清缓存重载
  for (const k of Object.keys(require.cache)) {
    if (k.includes("/wechat-diary-node/src/config.js")) delete require.cache[k];
  }
  return SANDBOX;
}
function vaultPath() { return path.join(SANDBOX, "vault"); }
function notePath(day) {
  return path.join(vaultPath(), "5.TDSQL", (day || "2026-08-31").slice(0, 4), (day || "2026-08-31").slice(5, 7), (day || "2026-08-31") + ".md");
}
function writeNote(day, content) {
  const p = notePath(day);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function readNote(day) { return fs.readFileSync(notePath(day), "utf8"); }

function makeConfig(over) {
  const { deepMerge, DEFAULT_CONFIG } = require(path.join(ROOT, "src", "config.js"));
  return deepMerge(DEFAULT_CONFIG, Object.assign({ vaultPath: vaultPath() }, over || {}));
}

// 启一个可用的 service 实例(不跑长轮询)。返回 svc。
async function bootService(over, opts) {
  const { WeChatDiaryService } = require(path.join(ROOT, "src", "service.js"));
  const configPath = path.join(SANDBOX, "config", "config.json");
  fs.writeFileSync(configPath, JSON.stringify(makeConfig(over), null, 2));
  const svc = new WeChatDiaryService({ configPath, mainJsPath: MAIN_JS, dryRun: !!(opts && opts.dryRun) });
  await svc.init();
  // 让服务处于"已绑定"状态, 免得每个用例都要走扫码
  const il = svc.stateStore.state.ilink;
  il.userId = (opts && opts.userId) || "USER_TEST_1";
  il.botId = (opts && opts.botId) || "BOT_TEST_1";
  if (opts && opts.skipBacklog !== undefined) il.skipBacklog = opts.skipBacklog;
  svc.credentials.botToken = "TOKEN_FOR_TEST";
  await svc.stateStore.save();
  return svc;
}
function teardown(svc) {
  if (svc && svc.plugin && svc.plugin._teardownHostRegistrations) svc.plugin._teardownHostRegistrations();
}

// 构造一条 iLink 文本消息报文
let _seq = 1000;
function textMsg(text, over) {
  return Object.assign({
    from_user_id: "USER_TEST_1",
    seq: _seq++,
    message_id: "mid-" + _seq,
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  }, over || {});
}

// 让 service 的回执发送变成可观测的无操作(测试里不连真实微信)
function stubReply(svc) {
  const sent = [];
  svc._reply = async (to, text) => { sent.push({ to, text }); return true; };
  svc.client = { notify() {}, destroyAll() {} };
  return sent;
}

// ── 用户手写内容的样板: 与真实 vault 里的形态一致 ────────────────────────
const HANDWRITTEN = [
  "## 日常记录",
  "- 10:48 [微信发语音记录](https://example.com/a)：",
  "  - **精炼总结**：手写的嵌套要点, 不能被当成微信消息。",
  "- 12:16 多 agent, 尽量多用司内产品",
  "- 14:53 慢就是快",
  "",
  "## 日报总结",
  "- 前夜：1 点出头早睡",
  "- 早上：agent 相关方案调研",
  "- 收获：",
  "",
  "",
  "## 日记感想",
  "",
].join("\n");

// ════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n=== standalone adapter 集成测试 ===\n");

  // ── 【1】【2】路径生成 ────────────────────────────────────────────────
  console.log("— 【1】【2】Daily Note 路径");
  {
    freshSandbox("path");
    const svc = await bootService();
    eq("【1】5.TDSQL/YYYY/MM/YYYY-MM-DD.md 路径正确",
      svc.writer.diaryPath("2026-08-31"), "5.TDSQL/2026/08/2026-08-31.md");
    eq("【1】跨年月同样正确", svc.writer.diaryPath("2027-01-05"), "5.TDSQL/2027/01/2027-01-05.md");
    const p = svc.writer.diaryPath("2026-08-31");
    check("【2】不生成 5.TDSQL/2026/2026/... (无重复年份目录)", !/\/(2\d{3})\/\1\//.test(p) && p === "5.TDSQL/2026/08/2026-08-31.md", p);
    // 全年逐日扫一遍: 任何一天都不该渲染出重复年份或缺月份
    let bad = null;
    for (let d = 0; d < 366; d++) {
      const day = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);
      const r = svc.writer.diaryPath(day);
      const expect = "5.TDSQL/" + day.slice(0, 4) + "/" + day.slice(5, 7) + "/" + day + ".md";
      if (r !== expect) { bad = day + " → " + r; break; }
    }
    check("【2】2026 全年 366 天路径逐日正确", bad === null, bad);
    teardown(svc);
  }

  // ── 【3】【4】【5】【6】【7】写入位置与用户内容保全 ─────────────────────
  console.log("\n— 【3】【4】【5】【6】【7】写入位置与手写内容保全");
  {
    freshSandbox("write");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    const before = readNote("2026-08-31");

    await svc.handleMessage(textMsg("服务器写入的第一条"));
    const after1 = readNote("2026-08-31");

    check("【3】微信记录落在 ## 日常记录 内",
      /## 日常记录[\s\S]*服务器写入的第一条[\s\S]*## 日报总结/.test(after1), after1);
    check("【4】不生成 ## 微信随手记", !after1.includes("## 微信随手记"), after1);
    check("【4】用了不可见 managed 边界", after1.includes("<!-- wechat-diary:managed -->"));

    // 手写条目逐字保留
    for (const line of ["- 10:48 [微信发语音记录](https://example.com/a)：",
      "  - **精炼总结**：手写的嵌套要点, 不能被当成微信消息。",
      "- 12:16 多 agent, 尽量多用司内产品", "- 14:53 慢就是快"]) {
      check("【5】手写条目逐字保留: " + line.slice(0, 22), after1.includes(line));
    }
    // 后续标题及内容逐字保留 —— 用字节切片比对, 不靠 includes 碰运气
    const tailBefore = before.slice(before.indexOf("## 日报总结"));
    const tailAfter = after1.slice(after1.indexOf("## 日报总结"));
    eq("【6】## 日报总结 及其后所有内容逐字节不变", tailAfter, tailBefore);

    eq("【7】计数只统计微信记录(手写 4 条不计入)", await svc.writer.countDay("2026-08-31"), 1);
    await svc.handleMessage(textMsg("第二条"));
    eq("【7】再写一条 → 2", await svc.writer.countDay("2026-08-31"), 2);
    const after2 = readNote("2026-08-31");
    eq("【6】两次写入后, 后续标题区仍逐字节不变", after2.slice(after2.indexOf("## 日报总结")), tailBefore);
    teardown(svc);
  }

  // ── 【8】撤回 ─────────────────────────────────────────────────────────
  console.log("\n— 【8】撤回只删最后一条微信记录");
  {
    freshSandbox("undo");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    await svc.handleMessage(textMsg("微信第一条"));
    await svc.handleMessage(textMsg("微信第二条"));
    eq("撤回前计数 2", await svc.writer.countDay("2026-08-31"), 2);

    await svc.handleMessage(textMsg("撤回"));
    const afterUndo = readNote("2026-08-31");
    eq("【8】撤回后计数 1", await svc.writer.countDay("2026-08-31"), 1);
    check("【8】删掉的是最后一条微信记录", !afterUndo.includes("微信第二条") && afterUndo.includes("微信第一条"), afterUndo);
    check("【8】手写内容一条都没少",
      afterUndo.includes("- 10:48 [微信发语音记录](https://example.com/a)：") &&
      afterUndo.includes("- 12:16 多 agent, 尽量多用司内产品") &&
      afterUndo.includes("- 14:53 慢就是快"), afterUndo);

    // 撤到空: 手写内容与节标题都必须留着
    await svc.handleMessage(textMsg("撤回"));
    const empty = readNote("2026-08-31");
    eq("【8】撤到空后计数 0", await svc.writer.countDay("2026-08-31"), 0);
    check("【8】撤到空仍保留 ## 日常记录 标题与全部手写内容",
      empty.includes("## 日常记录") && empty.includes("- 14:53 慢就是快") && empty.includes("## 日报总结"), empty);
    // 再撤: 不能去动手写内容
    const beforeExtra = readNote("2026-08-31");
    await svc.handleMessage(textMsg("撤回"));
    eq("【8】没有微信记录时再撤回, 文件逐字节不变", readNote("2026-08-31"), beforeExtra);
    teardown(svc);
  }

  // ── 【9】【10】重启去重与状态损坏恢复 ──────────────────────────────────
  console.log("\n— 【9】重启后同一消息不重复");
  {
    freshSandbox("dedup");
    writeNote("2026-08-31", HANDWRITTEN);
    const msg = textMsg("只应出现一次的消息");

    const svc1 = await bootService();
    stubReply(svc1);
    await svc1.handleMessage(msg);
    eq("首次处理: 计数 1", await svc1.writer.countDay("2026-08-31"), 1);
    await svc1.shutdown("TEST");
    teardown(svc1);

    // 模拟重启: 新实例读同一个 state.json, 重放同一条消息(腾讯游标未推进时会重发)
    const svc2 = await bootService();
    stubReply(svc2);
    check("【9】重启后去重表已从 state.json 恢复", svc2.stateStore.state.ilink.recentSeqs.length >= 1,
      JSON.stringify(svc2.stateStore.state.ilink.recentSeqs));
    await svc2.handleMessage(msg);
    eq("【9】同一消息重放后计数仍是 1(幂等)", await svc2.writer.countDay("2026-08-31"), 1);
    const body = readNote("2026-08-31");
    eq("【9】正文里该消息只出现一次", body.split("只应出现一次的消息").length - 1, 1);
    teardown(svc2);
  }

  console.log("\n— 【10】游标状态损坏的安全恢复");
  {
    freshSandbox("corrupt");
    const { StateStore } = require(path.join(ROOT, "src", "state-store.js"));
    const sp = path.join(SANDBOX, "state", "state.json");

    // 半截 JSON(异常退出的典型形态)
    fs.writeFileSync(sp, '{"ilink":{"buf":"abc","recentSeq');
    const st = new StateStore(sp);
    await st.load();
    check("【10】损坏的 JSON 不抛错, 服务能启动", true);
    check("【10】已启用保守恢复(skipBacklog): 不把积压按今天重演", st.state.ilink.skipBacklog === true);
    check("【10】损坏文件被隔离备份, 不是静默删除",
      fs.readdirSync(path.dirname(sp)).some((f) => f.startsWith("state.json.corrupt-")),
      fs.readdirSync(path.dirname(sp)).join(","));
    eq("【10】游标重置为空(不敢沿用坏值)", st.state.ilink.buf, "");
    check("【10】recoveredFromCorruption 标记已置位", st.recoveredFromCorruption === true);

    // 顶层不是对象
    fs.writeFileSync(sp, '"just a string"');
    const st2 = new StateStore(sp);
    await st2.load();
    check("【10】顶层不是对象时同样安全恢复", st2.state.ilink.skipBacklog === true);

    // 去重表形状坏了(但 buf 还在): 去重能力没了, 必须保守
    fs.writeFileSync(sp, JSON.stringify({ ilink: { buf: "CURSOR", recentSeqs: "not-an-array" } }));
    const st3 = new StateStore(sp);
    await st3.load();
    check("【10】去重表形状异常 + 有游标 → 保守跳过一轮", st3.state.ilink.skipBacklog === true);
    check("【10】recentSeqs 退回空数组", Array.isArray(st3.state.ilink.recentSeqs) && st3.state.ilink.recentSeqs.length === 0);

    // skipBacklog 生效: 消息只推游标不落笔
    freshSandbox("skipbacklog");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService({}, { skipBacklog: true });
    stubReply(svc);
    await svc.handleMessage(textMsg("积压里的历史消息"));
    eq("【10】跳过积压模式下不写日记", await svc.writer.countDay("2026-08-31"), 0);
    check("【10】也不写事件流水(它不是新消息)",
      (await svc.journal.read("2026-08-31")).events.length === 0);
    await svc._clearSkipBacklog();
    await svc.handleMessage(textMsg("追平后的第一条"));
    eq("【10】追平后恢复正常记录", await svc.writer.countDay("2026-08-31"), 1);
    teardown(svc);
  }

  // ── 【11】【12】事件流水先行与重放 ─────────────────────────────────────
  console.log("\n— 【11】写 Daily Note 前事件已进 NDJSON");
  {
    freshSandbox("journal");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);

    // 在写 Daily Note 的那一刻检查流水是否已落盘 —— 用 writer 的钩子截获时序
    let journalAtWriteTime = null;
    const origWrite = svc.plugin.writer.write.bind(svc.plugin.writer);
    svc.plugin.writer.write = async (...a) => {
      const r = await svc.journal.read("2026-08-31");
      journalAtWriteTime = r.events.map((e) => e.type);
      return origWrite(...a);
    };
    await svc.handleMessage(textMsg("时序验证消息"));

    check("【11】动 Daily Note 之前, received 事件已经在 NDJSON 里",
      Array.isArray(journalAtWriteTime) && journalAtWriteTime.includes("received"), JSON.stringify(journalAtWriteTime));
    const jf = path.join(vaultPath(), ".wechat-diary", "events", "2026-08-31.ndjson");
    check("【11】流水文件在 vault 内的 .wechat-diary/events/", fs.existsSync(jf), jf);
    const lines = fs.readFileSync(jf, "utf8").trim().split("\n").map(JSON.parse);
    const rec = lines.find((l) => l.type === "received");
    check("【11】事件含 message ID / sequence", rec.messageId != null && rec.seq != null, JSON.stringify(rec.seq));
    check("【11】事件含 bot ID", rec.botId === "BOT_TEST_1");
    check("【11】事件含接收时间", typeof rec.receivedAt === "string" && rec.receivedAt.includes("T"));
    eq("【11】事件含逻辑日期", rec.logicalDate, "2026-08-31");
    eq("【11】事件含消息类型", rec.msgType, "text");
    eq("【11】事件含原始文本", rec.text, "时序验证消息");
    eq("【11】事件含处理状态", rec.status, "received");
    eq("【11】事件含写入目标路径", rec.targetPath, "5.TDSQL/2026/08/2026-08-31.md");
    check("【11】写入成功后追加 written 事件", lines.some((l) => l.type === "written"));
    check("【11】流水是追加式的(received 在 written 之前)",
      lines.findIndex((l) => l.type === "received") < lines.findIndex((l) => l.type === "written"));
    check("【11】流水文件权限 0600", (fs.statSync(jf).mode & 0o777) === 0o600, (fs.statSync(jf).mode & 0o777).toString(8));
    teardown(svc);
  }

  console.log("\n— 【12】Daily Note 写入失败时可以重放");
  {
    freshSandbox("replay");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    const sent = stubReply(svc);

    // 让写入失败(模拟 Sync 冲突/磁盘问题): 直接让 writer.write 抛错
    const origWrite = svc.plugin.writer.write.bind(svc.plugin.writer);
    svc.plugin.writer.write = async () => { throw new Error("模拟的写入失败(Sync 冲突)"); };
    await svc.handleMessage(textMsg("写失败但不能丢的消息"));

    eq("【12】写入失败时 Daily Note 没有这条", await svc.writer.countDay("2026-08-31"), 0);
    const j1 = await svc.journal.read("2026-08-31");
    check("【12】流水里有 received", j1.events.some((e) => e.type === "received"));
    check("【12】流水里有 failed", j1.events.some((e) => e.type === "failed"));
    check("【12】没有 written(不能谎报成功)", !j1.events.some((e) => e.type === "written"));
    check("【12】回微信的是明确的失败提示, 不是「记下来啦」",
      sent.length === 1 && sent[0].text.includes("没记上") && !sent[0].text.includes("记下来啦~"), JSON.stringify(sent));
    check("【12】去重表没有推进(消息还没落地, 允许重发)",
      !svc.stateStore.state.ilink.recentSeqs.length, JSON.stringify(svc.stateStore.state.ilink.recentSeqs));

    const pending = await svc.journal.pendingFor("2026-08-31");
    eq("【12】pendingFor 找出 1 条待补写", pending.length, 1);

    // 修复"故障"后重放
    svc.plugin.writer.write = origWrite;
    const r = await svc.replayDate("2026-08-31");
    eq("【12】重放补写 1 条", r.replayed, 1);
    eq("【12】重放后 Daily Note 有了这条", await svc.writer.countDay("2026-08-31"), 1);
    check("【12】内容正确落在 ## 日常记录 内",
      /## 日常记录[\s\S]*写失败但不能丢的消息[\s\S]*## 日报总结/.test(readNote("2026-08-31")), readNote("2026-08-31"));
    check("【12】手写内容仍然完好", readNote("2026-08-31").includes("- 14:53 慢就是快"));

    // 重放的幂等: 再跑一次不能写第二遍
    const r2 = await svc.replayDate("2026-08-31");
    eq("【12】重放已完成的日期: pending 归零", r2.pending, 0);
    eq("【12】重复重放不产生第二条", await svc.writer.countDay("2026-08-31"), 1);

    // "写成了但 written 事件没落盘"的崩溃窗口: 重放要能识别出内容已在
    await svc.journal.append({ type: "received", eventId: "BOT_TEST_1:s9999", seqKey: "s9999",
      botId: "BOT_TEST_1", logicalDate: "2026-08-31", msgType: "text",
      text: "写失败但不能丢的消息", targetPath: "5.TDSQL/2026/08/2026-08-31.md", status: "received" });
    const r3 = await svc.replayDate("2026-08-31");
    eq("【12】内容已在笔记里 → 跳过而不是写第二遍", r3.skipped, 1);
    eq("【12】计数仍是 1", await svc.writer.countDay("2026-08-31"), 1);
    teardown(svc);
  }

  // ── 【13】同分钟多条消息 ──────────────────────────────────────────────
  console.log("\n— 【13】同分钟多条消息行为与原插件一致");
  {
    freshSandbox("sameminute");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    // 固定时钟到同一分钟
    const RealDate = Date;
    const fixed = new RealDate("2026-08-31T14:32:10+08:00").getTime();
    global.Date = class extends RealDate {
      constructor(...a) { if (!a.length) return new RealDate(fixed); return new RealDate(...a); }
      static now() { return fixed; }
    };
    try {
      await svc.handleMessage(textMsg("同分钟第一条"));
      await svc.handleMessage(textMsg("同分钟第二条"));
      await svc.handleMessage(textMsg("同分钟第三条"));
    } finally { global.Date = RealDate; }

    const body = await svc.writer.readManagedBody("2026-08-31");
    const headers = (body || "").match(/\*\*\d{2}:\d{2}\*\*/g) || [];
    eq("【13】同一分钟共用一个时间戳段头", headers.length, 1);
    eq("【13】段头是 **14:32**", headers[0], "**14:32**");
    eq("【13】三条各自成块, 计数 3", await svc.writer.countDay("2026-08-31"), 3);
    check("【13】块之间用空行分隔(契约规则 6)",
      (body || "").includes("同分钟第一条\n\n同分钟第二条\n\n同分钟第三条"), JSON.stringify(body));
    teardown(svc);
  }

  // ── 【14】媒体附件路径 ───────────────────────────────────────────────
  console.log("\n— 【14】图片、语音、附件路径正确(跟随当天笔记的 assets/)");
  {
    freshSandbox("media");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    const W = svc.plugin.writer;

    // 图片: 用真实 JPEG magic bytes 走 writeImage 全程
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    const ir = await W.writeImage(jpg, "jpg", "2026-08-31");
    check("【14】图片写入成功", ir.n >= 1, JSON.stringify(ir));
    const body1 = await svc.writer.readManagedBody("2026-08-31");
    const link = (body1.match(/!\[\[([^\]]+)\]\]/) || [])[1] || "";
    check("【14】图片路径在当天笔记同级的 assets/ 下",
      link.startsWith("5.TDSQL/2026/08/assets/") && link.endsWith(".jpg"), link);
    check("【14】图片文件真的落盘了", fs.existsSync(path.join(vaultPath(), link)), link);
    check("【14】落盘字节与源 Buffer 一致",
      Buffer.compare(fs.readFileSync(path.join(vaultPath(), link)), jpg) === 0);
    check("【14】wikilink 用 vault 全路径(重名附件不会指错)", link.startsWith("5.TDSQL/"));

    // 带原名的附件(文件/视频走这条)
    const pdf = Buffer.from("%PDF-1.7\n測試附件內容");
    const ap = W.attachmentPathNamed("2026-08-31", "检查报告.pdf");
    check("【14】附件命名保留原名并加日期时间前缀",
      /2026-08-31-\d{4}-检查报告\.pdf$/.test(ap), ap);
    const ar = await W.writeAttachment(pdf, ap, "2026-08-31", "");
    check("【14】附件写入成功", ar.n >= 1, JSON.stringify(ar));
    check("【14】附件最终落在 assets/ 且保留原文件名",
      ar.path.startsWith("5.TDSQL/2026/08/assets/") && ar.path.includes("检查报告.pdf"), ar.path);
    check("【14】附件字节一致", Buffer.compare(fs.readFileSync(path.join(vaultPath(), ar.path)), pdf) === 0);

    // 语音: 🎤 前缀 + 音频 + 转写文字同块 = 一条消息
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
    const vp = W.attachmentPathNamed("2026-08-31", "语音.wav");
    const vr = await W.writeAttachment(wav, vp, "2026-08-31", "🎤", "这是语音的转写文字");
    check("【14】语音块写入成功", vr.n >= 1, JSON.stringify(vr));
    const body2 = await svc.writer.readManagedBody("2026-08-31");
    check("【14】语音块 = 🎤 + wikilink + 换行 + 转写文字(同一块)",
      /🎤 !\[\[5\.TDSQL\/2026\/08\/assets\/[^\]]*语音\.wav\]\]\n这是语音的转写文字/.test(body2), body2.slice(-300));
    eq("【14】三个附件各计一条消息, 共 3", await svc.writer.countDay("2026-08-31"), 3);

    // 手写内容与后续标题依然完好
    check("【14】写了 3 个附件后手写内容与后续标题仍完好",
      readNote("2026-08-31").includes("- 14:53 慢就是快") && readNote("2026-08-31").includes("## 日报总结"));
    // assets 目录真实存在且在正确位置
    check("【14】assets 目录建在 5.TDSQL/2026/08/ 下",
      fs.existsSync(path.join(vaultPath(), "5.TDSQL", "2026", "08", "assets")));
    teardown(svc);
  }

  // ── 【15】模拟 Sync 并发修改 ─────────────────────────────────────────
  console.log("\n— 【15】模拟 Sync 并发修改时不会整篇覆盖用户内容");
  {
    freshSandbox("concurrent");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    await svc.handleMessage(textMsg("并发前的记录"));

    // 场景 A: 服务读到内容之后、写回之前, 另一端(ob 同步 / Mac 编辑器)改了同一个文件。
    // 正确行为: process() 在拿到锁后【重新从磁盘读取】, 因此另一端的新内容不会被旧快照吞掉。
    fs.writeFileSync(notePath("2026-08-31"),
      readNote("2026-08-31").replace("## 日报总结", "## 日报总结\n- 来自 Mac 的新内容"));
    await svc.handleMessage(textMsg("并发后的记录"));

    const final = readNote("2026-08-31");
    check("【15】另一端(Mac/ob)写入的内容没有被覆盖", final.includes("- 来自 Mac 的新内容"), final);
    check("【15】服务自己两条记录都在", final.includes("并发前的记录") && final.includes("并发后的记录"));
    check("【15】用户手写内容仍然完好", final.includes("- 14:53 慢就是快") && final.includes("- 12:16 多 agent, 尽量多用司内产品"));
    check("【15】后续标题结构完好", final.includes("## 日报总结") && final.includes("## 日记感想"));
    eq("【15】计数仍只数微信记录", await svc.writer.countDay("2026-08-31"), 2);

    // 场景 B: 并发写入同一文件 —— 20 个并发写不能丢任何一条(文件锁 + 串行化)
    freshSandbox("concurrent2");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc2 = await bootService();
    stubReply(svc2);
    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) =>
      svc2.plugin.writer.write("并发消息-" + i, false, "2026-08-31")));
    const body = await svc2.writer.readManagedBody("2026-08-31");
    let missing = [];
    for (let i = 0; i < N; i++) if (!body.includes("并发消息-" + i)) missing.push(i);
    check("【15】" + N + " 条并发写入无一丢失(文件锁生效)", missing.length === 0, "丢失: " + missing.join(","));
    eq("【15】并发写入后计数 = " + N, await svc2.writer.countDay("2026-08-31"), N);
    check("【15】并发写入后手写内容与后续标题仍完好",
      readNote("2026-08-31").includes("- 14:53 慢就是快") && readNote("2026-08-31").includes("## 日记感想"));

    // 场景 C: 跨进程锁真的互斥
    const { acquireLock } = require(path.join(ROOT, "src", "vault.js"));
    const target = notePath("2026-08-31");
    const l1 = await acquireLock(target, 2000);
    let blocked = false;
    try { await acquireLock(target, 300); }
    catch (e) { blocked = /等锁超时/.test(e.message); }
    await l1.release();
    check("【15】文件锁互斥: 第二个持有者拿不到锁会超时报错", blocked);
    const l2 = await acquireLock(target, 2000);
    await l2.release();
    check("【15】锁释放后可以重新获取", true);
    teardown(svc); teardown(svc2);
  }

  // ── 【16】SIGINT 后状态完整落盘 ──────────────────────────────────────
  console.log("\n— 【16】SIGINT 后状态完整落盘");
  {
    freshSandbox("sigint");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);
    await svc.handleMessage(textMsg("退出前的消息"));
    svc.stateStore.state.ilink.buf = "CURSOR-BEFORE-EXIT";
    await svc.shutdown("SIGINT");

    const sp = path.join(SANDBOX, "state", "state.json");
    const raw = fs.readFileSync(sp, "utf8");
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(raw); } catch (e) { parseErr = e.message; }
    check("【16】state.json 是完整合法的 JSON(不是半截)", parsed !== null, parseErr);
    eq("【16】游标已保存", parsed.ilink.buf, "CURSOR-BEFORE-EXIT");
    check("【16】去重表已保存", parsed.ilink.recentSeqs.length >= 1, JSON.stringify(parsed.ilink.recentSeqs));
    check("【16】lastAliveTs 已更新(离线时长判断的依据)", parsed.ilink.lastAliveTs > 0);
    check("【16】state.json 权限 0600", (fs.statSync(sp).mode & 0o777) === 0o600, (fs.statSync(sp).mode & 0o777).toString(8));
    check("【16】没有残留 .tmp 文件", !fs.readdirSync(path.dirname(sp)).some((f) => f.includes(".tmp")),
      fs.readdirSync(path.dirname(sp)).join(","));

    // 重启后状态可用
    const svc2 = await bootService();
    eq("【16】重启后游标读回", svc2.stateStore.state.ilink.buf, "CURSOR-BEFORE-EXIT");
    teardown(svc); teardown(svc2);

    // 同步保存兜底(信号处理里 await 跑不完时用)
    freshSandbox("sigint2");
    const { StateStore } = require(path.join(ROOT, "src", "state-store.js"));
    const st = new StateStore(path.join(SANDBOX, "state", "state.json"));
    await st.load();
    st.state.ilink.buf = "SYNC-SAVED";
    check("【16】saveSync 成功", st.saveSync() === true);
    eq("【16】saveSync 写出的内容正确",
      JSON.parse(fs.readFileSync(path.join(SANDBOX, "state", "state.json"), "utf8")).ilink.buf, "SYNC-SAVED");

    // shutdown 的幂等与可 await 性 —— 这是实测踩出来的竞态(见 service.js 里的注释):
    // 信号处理器调 shutdown() 的同时 run() 也返回了, 外层若拿到一个"立刻 resolve"的
    // promise 就会在落盘完成前 process.exit, 游标丢一次。
    freshSandbox("sigint3");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc3 = await bootService();
    stubReply(svc3);
    svc3.stateStore.state.ilink.buf = "CURSOR-CONCURRENT-SHUTDOWN";
    let saves = 0;
    const origSave = svc3.stateStore.save.bind(svc3.stateStore);
    svc3.stateStore.save = async () => { saves++; await new Promise((r) => setTimeout(r, 30)); return origSave(); };
    // 并发调三次 shutdown: 必须都等到真正落盘完成
    const [a, b, c] = [svc3.shutdown("SIGTERM"), svc3.shutdown("normal"), svc3.shutdown("SIGINT")];
    check("【16】并发 shutdown 返回同一个 promise(幂等)", a === b && b === c);
    await Promise.all([a, b, c]);
    const persisted = JSON.parse(fs.readFileSync(path.join(SANDBOX, "state", "state.json"), "utf8"));
    eq("【16】并发 shutdown 后游标确实落了盘(不是竞态里丢掉)", persisted.ilink.buf, "CURSOR-CONCURRENT-SHUTDOWN");
    check("【16】shutdown 只真正执行一次(save 没被调三遍)", saves === 1, "saves=" + saves);
    check("【16】await shutdown 返回时 lastAliveTs 已写入", persisted.ilink.lastAliveTs > 0);
    teardown(svc3);
  }

  // ── 【17】配置与凭据权限 ─────────────────────────────────────────────
  console.log("\n— 【17】配置和凭据权限正确");
  {
    freshSandbox("perms");
    const cfg = require(path.join(ROOT, "src", "config.js"));
    const cp = path.join(SANDBOX, "config", "credentials.json");
    await cfg.saveCredentials({ botToken: "SECRET_TOKEN_VALUE_12345678", aiKey: "AI_KEY_9876543210", bindIdentity: { userId: "U1", botId: "B1", baseUrl: "" } }, cp);
    const mode = fs.statSync(cp).mode & 0o777;
    eq("【17】凭据文件权限是 0600", mode.toString(8), "600");
    eq("【17】checkPermissions 对 0600 无抱怨", cfg.checkPermissions(cp).length, 0);

    fs.chmodSync(cp, 0o644);
    const probs = cfg.checkPermissions(cp);
    check("【17】权限被放宽到 0644 时能检出", probs.some((p) => p.includes("0644") || p.includes("必须是 0600")), JSON.stringify(probs));
    fs.chmodSync(cp, 0o600);

    check("【17】凭据能正确读回", cfg.loadCredentials(cp).botToken === "SECRET_TOKEN_VALUE_12345678");
    check("【17】没有残留 .tmp 凭据文件",
      !fs.readdirSync(path.dirname(cp)).some((f) => f.includes(".tmp")), fs.readdirSync(path.dirname(cp)).join(","));

    // 脱敏视图不含原文
    const red = JSON.stringify(cfg.redactCredentials(cfg.loadCredentials(cp)));
    check("【17】redactCredentials 不含 token 原文", !red.includes("SECRET_TOKEN_VALUE_12345678"), red);
    check("【17】redactCredentials 不含 AI key 原文", !red.includes("AI_KEY_9876543210"), red);
    check("【17】脱敏后仍能核对(长度 + 指纹)", red.includes("sha256:"), red);

    // 日志脱敏: 注册过的凭据不会出现在日志里
    const logger = require(path.join(ROOT, "src", "logger.js"));
    logger.clearSecrets();
    logger.registerSecret("SECRET_TOKEN_VALUE_12345678");
    const scrubbed = logger.scrub("Authorization: Bearer SECRET_TOKEN_VALUE_12345678 done");
    check("【17】日志脱敏: token 原文被替换", !scrubbed.includes("SECRET_TOKEN_VALUE_12345678"), scrubbed);
    const scrubbed2 = logger.scrub('aeskey: "0123456789abcdef0123456789abcdef"');
    check("【17】日志脱敏: AES key 形状被替换", !scrubbed2.includes("0123456789abcdef0123456789abcdef"), scrubbed2);
    const scrubbed3 = logger.scrub("cursor buf=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaaaaaa");
    check("【17】日志脱敏: 长 base64 串(游标/token 形状)被替换",
      !scrubbed3.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaaaaaaaaaa"), scrubbed3);
    check("【17】消息正文摘要不含正文", (() => {
      const s = logger.summarize("这是一条很私密的日记内容");
      return !s.includes("私密") && s.includes("12 字");
    })(), logger.summarize("这是一条很私密的日记内容"));
  }

  // ── 补充: 媒体元数据不含凭据 ─────────────────────────────────────────
  console.log("\n— 补充: 事件流水不写入 CDN 凭据");
  {
    const { mediaMeta, mediaSummary, classifyMessage } = require(path.join(ROOT, "src", "media.js"));
    const item = {
      aeskey: "0123456789abcdef0123456789abcdef",
      file_name: "报告.pdf", md5: "AABBCC", len: 1234,
      media: { full_url: "https://cdn.example.com/x?token=SECRET", aes_key: "BASE64KEY==", encrypt_query_param: "ENCRYPTED_PARAM", size: 1234 },
    };
    const meta = mediaMeta(item, "file");
    const s = JSON.stringify(meta);
    check("媒体元数据不含 aeskey", !s.includes("0123456789abcdef"), s);
    check("媒体元数据不含 full_url", !s.includes("cdn.example.com") && !s.includes("SECRET"), s);
    check("媒体元数据不含 encrypt_query_param", !s.includes("ENCRYPTED_PARAM"), s);
    check("媒体元数据不含 aes_key", !s.includes("BASE64KEY"), s);
    check("媒体元数据保留可诊断字段(文件名/md5/大小)",
      meta.fileName === "报告.pdf" && meta.md5 === "aabbcc" && meta.len === 1234, s);
    check("媒体元数据用布尔记录有无密钥", meta.hasKey === true && meta.hasUrl === true);
    eq("消息类型分类: 纯文本", classifyMessage({ hasText: true, images: [], files: [], videos: [] }), "text");
    eq("消息类型分类: 图文混合", classifyMessage({ hasText: true, images: [{}], files: [], videos: [] }), "mixed");
    eq("消息类型分类: 纯图片", classifyMessage({ hasText: false, images: [{}], files: [], videos: [] }), "image");
  }

  // ── 补充: 非白名单来源与畸形报文 ─────────────────────────────────────
  console.log("\n— 补充: 白名单与畸形报文");
  {
    freshSandbox("guard");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    const sent = stubReply(svc);
    const before = readNote("2026-08-31");

    await svc.handleMessage(textMsg("陌生人的消息", { from_user_id: "STRANGER_9" }));
    eq("陌生人的消息不落库", readNote("2026-08-31"), before);
    eq("陌生人的消息不回复(回复=确认 bot 存活)", sent.length, 0);
    eq("陌生人的消息不进流水(避免被撑大)", (await svc.journal.read("2026-08-31")).events.length, 0);

    await svc.handleMessage(textMsg("bot 自己的消息", { message_type: 2 }));
    eq("BOT 自己的消息被忽略", readNote("2026-08-31"), before);
    await svc.handleMessage(textMsg("半成品", { message_state: 1 }));
    eq("GENERATING 半成品被忽略", readNote("2026-08-31"), before);
    await svc.handleMessage({ from_user_id: "USER_TEST_1", seq: 1, item_list: [], message_state: 2 });
    eq("空 item_list 被忽略", readNote("2026-08-31"), before);
    await svc.handleMessage({ from_user_id: "USER_TEST_1", item_list: [{ type: 1, text_item: { text: "无 seq" } }], message_state: 2 });
    eq("既无 seq 又无 message_id 的报文被丢弃(无法去重)", readNote("2026-08-31"), before);
    await svc.handleMessage({ from_user_id: "USER_TEST_1", seq: 77, message_state: 2,
      item_list: [{ type: 99, unknown_item: { x: 1 } }] });
    eq("未知 item 类型被忽略", readNote("2026-08-31"), before);
    teardown(svc);
  }

  // ── 补充: 探活/帮助/封存 不污染日记 ─────────────────────────────────
  console.log("\n— 补充: 命令类消息的语义(与插件一致)");
  {
    freshSandbox("intent");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    const sent = stubReply(svc);

    await svc.handleMessage(textMsg("在吗"));
    eq("探活「在吗」不落库", await svc.writer.countDay("2026-08-31"), 0);
    check("探活有回执", sent.length === 1 && sent[0].text.length > 0, JSON.stringify(sent));

    await svc.handleMessage(textMsg("帮助"));
    eq("「帮助」不落库", await svc.writer.countDay("2026-08-31"), 0);
    check("帮助回执提到节标题(共用模式)", sent[sent.length - 1].text.includes("日常记录"), sent[sent.length - 1].text.slice(-120));

    await svc.handleMessage(textMsg("今天很充实"));
    eq("普通日记落库", await svc.writer.countDay("2026-08-31"), 1);

    await svc.handleMessage(textMsg("晚安"));
    const body = await svc.writer.readManagedBody("2026-08-31");
    check("「晚安」写入封存标记", body.includes("_(今日封存于"), body);
    eq("封存不增加消息计数", await svc.writer.countDay("2026-08-31"), 1);
    check("封存后手写内容仍完好", readNote("2026-08-31").includes("- 14:53 慢就是快"));

    // 「记：」逃生口: 命令词原样落库
    await svc.handleMessage(textMsg("记：晚安"));
    const body2 = await svc.writer.readManagedBody("2026-08-31");
    check("「记：晚安」把命令词当内容落库", body2.includes("晚安") && await svc.writer.countDay("2026-08-31") === 2);
    teardown(svc);
  }

  // ── 补充: 当天笔记不存在 / 没有该节 ─────────────────────────────────
  console.log("\n— 补充: 文件或节不存在时的建立");
  {
    freshSandbox("create");
    const svc = await bootService();
    stubReply(svc);
    check("起始状态: 当天笔记不存在", !fs.existsSync(notePath("2026-08-31")));
    await svc.handleMessage(textMsg("第一条, 文件还不存在"));
    check("自动创建当天笔记(含父目录)", fs.existsSync(notePath("2026-08-31")));
    const c = readNote("2026-08-31");
    check("新建文件里有 ## 日常记录 节", c.includes("## 日常记录"), c);
    check("新建文件里没有 ## 微信随手记", !c.includes("## 微信随手记"), c);
    check("新建文件里有 managed 边界", c.includes("<!-- wechat-diary:managed -->"), c);
    eq("计数 1", await svc.writer.countDay("2026-08-31"), 1);

    // 文件存在但没有「## 日常记录」节
    freshSandbox("create2");
    writeNote("2026-08-31", "# 我的笔记\n\n## 别的节\n- 内容\n");
    const svc2 = await bootService();
    stubReply(svc2);
    await svc2.handleMessage(textMsg("追加到没有该节的文件"));
    const c2 = readNote("2026-08-31");
    check("在文件末尾追加 ## 日常记录 节", c2.includes("## 日常记录"), c2);
    check("原有内容逐字保留", c2.includes("# 我的笔记") && c2.includes("## 别的节\n- 内容"), c2);
    eq("计数 1", await svc2.writer.countDay("2026-08-31"), 1);
    teardown(svc); teardown(svc2);
  }

  // ── 补充: 危险内容不破坏节边界 ──────────────────────────────────────
  console.log("\n— 补充: 消息内容不能破坏节边界");
  {
    freshSandbox("escape");
    writeNote("2026-08-31", HANDWRITTEN);
    const svc = await bootService();
    stubReply(svc);

    await svc.handleMessage(textMsg("## 这是用户发的二级标题"));
    const body = await svc.writer.readManagedBody("2026-08-31");
    check("消息里的 ## 行被转义, 不会变成真标题", body.includes("\\## 这是用户发的二级标题"), body);
    check("后续标题结构没被吞掉", readNote("2026-08-31").includes("## 日报总结"));

    await svc.handleMessage(textMsg("```js\nconst a = 1;\n```"));
    const body2 = await svc.writer.readManagedBody("2026-08-31");
    check("消息里的代码围栏被转义(否则节的扫描会跑飞)", body2.includes("\\```"), body2);
    eq("两条都计数", await svc.writer.countDay("2026-08-31"), 2);
    check("手写内容与后续标题依然完好",
      readNote("2026-08-31").includes("- 14:53 慢就是快") && readNote("2026-08-31").includes("## 日记感想"));

    // 撤回带 ## 的整块
    await svc.handleMessage(textMsg("撤回"));
    eq("撤回后计数 1", await svc.writer.countDay("2026-08-31"), 1);
    check("撤回没有误删手写内容", readNote("2026-08-31").includes("- 14:53 慢就是快"));
    teardown(svc);
  }

  // ── 补充: moment-lite 与测试桩一致 ──────────────────────────────────
  console.log("\n— 补充: moment-lite 的路径渲染与上游一致");
  {
    const moment = require(path.join(ROOT, "src", "moment-lite.js"));
    const Plugin = (() => {
      const shim = require(path.join(ROOT, "src", "obsidian-shim.js"));
      shim.installGlobals();
      const Module = require("module");
      const obs = shim.makeObsidianModule();
      const orig = Module._load;
      Module._load = function (r, ...a) { return r === "obsidian" ? obs : orig.call(this, r, ...a); };
      try { return require(MAIN_JS); } finally { Module._load = orig; }
    })();
    const I = Plugin.__internals;
    eq("默认格式 YYYY/YYYY-MM-DD", I.renderPath("YYYY/YYYY-MM-DD", "2026-08-31", moment), "2026/2026-08-31");
    eq("本部署格式 YYYY/MM/YYYY-MM-DD", I.renderPath("YYYY/MM/YYYY-MM-DD", "2026-08-31", moment), "2026/08/2026-08-31");
    eq("方括号字面量", I.renderPath("[daily]/YYYY/MM", "2026-08-31", moment), "daily/2026/08");
    eq("闰日", I.renderPath("YYYY/MM/YYYY-MM-DD", "2024-02-29", moment), "2024/02/2024-02-29");
    eq("跨年边界 1/1", I.renderPath("YYYY/MM/YYYY-MM-DD", "2027-01-01", moment), "2027/01/2027-01-01");
    eq("跨年边界 12/31", I.renderPath("YYYY/MM/YYYY-MM-DD", "2026-12-31", moment), "2026/12/2026-12-31");
    const v = I.validatePathFormat("YYYY/MM/YYYY-MM-DD", { requireDaily: true, momentLib: moment });
    check("validatePathFormat 认可本部署的格式", v.ok === true, JSON.stringify(v));
    const v2 = I.validatePathFormat("YYYY/MM", { requireDaily: true, momentLib: moment });
    check("validatePathFormat 拒绝会撞文件的格式(YYYY/MM)", v2.ok === false, JSON.stringify(v2));
    const v3 = I.validatePathFormat("assets/YYYY-MM-DD", { requireDaily: true, momentLib: moment });
    check("validatePathFormat 拒绝没加方括号的英文文件夹名", v3.ok === false, JSON.stringify(v3));

    // ── managed 边界建立时的一次性 rstrip: 这是【上游行为】, Mac 版同款 ──
    // appendManagedBody 里 `content.slice(0, bodyEnd).replace(/\s+$/, "")` 会吃掉节末尾的
    // 尾随空白(包括用户最后一行的行尾空格)。这条测试把它钉住: 若哪天上游改了这个行为,
    // 服务端与 Mac 版会同时改变, 但至少我们会在这里看到红灯, 而不是在真实日记里发现。
    const withTrail = "## 日常记录\n- 19:52 一个 TODO：writing style \n\n## 日报总结\n- 收获：\n";
    const appended = I.appendManagedBody(withTrail, "日常记录", "**20:34**\n\n新消息\n");
    check("上游行为: 建立 managed 边界时吃掉节末尾的行尾空格(一次性)",
      appended.includes("writing style\n") && !appended.includes("writing style \n"), JSON.stringify(appended));
    eq("上游行为: 节之后的内容逐字节不变",
      appended.slice(appended.indexOf("## 日报总结")), withTrail.slice(withTrail.indexOf("## 日报总结")));
    const loc2 = I.locateManagedBody(appended, "日常记录");
    const spliced = I.spliceManagedBody(appended, loc2, "**20:34**\n\n新消息\n\n第二条\n");
    const cut = appended.indexOf("<!-- wechat-diary:managed -->");
    eq("上游行为: 之后每次写入都只动 marker 之后的字节(用户内容再也不被碰)",
      spliced.slice(0, cut), appended.slice(0, cut));
  }

  // ── 补充: 逻辑日与切日 00:00 ────────────────────────────────────────
  console.log("\n— 补充: 切日 00:00 的逻辑日计算");
  {
    freshSandbox("logicalday");
    const svc = await bootService();
    const RealDate = Date;
    const at = (iso) => {
      const t = new RealDate(iso).getTime();
      global.Date = class extends RealDate {
        constructor(...a) { if (!a.length) return new RealDate(t); return new RealDate(...a); }
        static now() { return t; }
      };
      try { return svc.I.logicalTodayStr(); } finally { global.Date = RealDate; }
    };
    eq("23:59 属于当天", at("2026-08-31T23:59:00+08:00"), "2026-08-31");
    eq("00:00 已经是新的一天(切日 0 点)", at("2026-09-01T00:00:30+08:00"), "2026-09-01");
    eq("02:30 属于新的一天(不是前一天)", at("2026-09-01T02:30:00+08:00"), "2026-09-01");
    eq("12:00 正常", at("2026-08-31T12:00:00+08:00"), "2026-08-31");
    // 时区: 服务器即使在 UTC 下跑, 也必须按 Asia/Shanghai 算日期
    eq("UTC 16:30 = 北京次日 00:30 → 算次日", at("2026-08-31T16:30:00Z"), "2026-09-01");
    teardown(svc);
  }

  // ── 收尾 ────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(50));
  if (fail === 0) console.log("standalone 集成测试全部通过 (" + pass + ")");
  else {
    console.log(pass + " 通过, " + fail + " 失败");
    console.log("失败项:\n  - " + failures.join("\n  - "));
  }
  // 清理沙箱
  try {
    for (const d of fs.readdirSync(os.tmpdir())) {
      if (d.startsWith("wd-node-test-" + process.pid + "-") || d.startsWith("wd-node-test-")) {
        const p = path.join(os.tmpdir(), d);
        if (d.includes("-" + process.pid + "-")) fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch (e) { /* 清理失败无关紧要 */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("测试 harness 崩了:", e); process.exit(2); });
