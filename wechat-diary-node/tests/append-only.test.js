"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const runtime = path.resolve(__dirname, "../../.agent/compact-diary-format/test-runtime");
fs.mkdirSync(runtime, { recursive: true });

async function setup(t, content) {
  const root = fs.mkdtempSync(path.join(runtime, "case-"));
  t.after(() => { assert.ok(root.startsWith(runtime + path.sep)); fs.rmSync(root, { recursive: true }); });
  for (const dir of ["config", "state", "vault"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  process.env.WECHAT_DIARY_CONFIG_DIR = path.join(root, "config");
  process.env.WECHAT_DIARY_STATE_DIR = path.join(root, "state");
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(config|service)\.js$/.test(key)) delete require.cache[key];
  }
  const { DEFAULT_CONFIG, deepMerge } = require("../src/config");
  const config = deepMerge(DEFAULT_CONFIG, { vaultPath: path.join(root, "vault"), service: { appendOnly: true } });
  const configPath = path.join(root, "config/config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(root, "config/credentials.json"), JSON.stringify({ botToken: "TEST_TOKEN" }), { mode: 0o600 });
  const { WeChatDiaryService } = require("../src/service");
  const svc = new WeChatDiaryService({ configPath });
  await svc.init();
  t.after(() => svc.plugin._teardownHostRegistrations());
  const day = svc.I.logicalTodayStr();
  const note = path.join(root, "vault", svc.writer.diaryPath(day));
  fs.mkdirSync(path.dirname(note), { recursive: true });
  if (content !== undefined) fs.writeFileSync(note, content);
  return { svc, day, note, root, configPath, read: () => fs.readFileSync(note, "utf8") };
}

test("single-line append preserves handwritten bytes and following sections", async t => {
  const before = "## 日常记录\n\n- 16:04 手写一 \n- 16:17 手写二  \n\n## 日报总结\n原有总结\n";
  const { svc, day, read } = await setup(t, before);
  const res = await svc.writer.writeText("记录一下今天", false, day);
  assert.equal(res.n, 1);
  assert.match(read(), /手写二  \n- \d\d:\d\d 记录一下今天\n\n## 日报总结/);
  assert.equal(read().replace(/- \d\d:\d\d 记录一下今天\n/, ""), before);
  assert.ok(!read().includes("wechat-diary:managed"));
  assert.ok(!res.reply.includes("撤回"));
});

test("multiline messages use indented continuation with no blank entries", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n- 16:04 手写\n");
  await svc.writer.writeText("第一行\r\n\r\n第二行\n## 消息内标题\n```js", false, day);
  assert.match(read(), /- \d\d:\d\d 第一行\n  第二行\n  \\## 消息内标题\n  \\```js/);
  const res = await svc.writer.writeText("下一条", false, day);
  assert.equal(res.n, 2);
  assert.match(read(), /\\```js\n- \d\d:\d\d 下一条/);
});

test("voice text keeps its voice prefix in a list", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n");
  await svc.writer.writeText("语音文字\n下一行", true, day);
  assert.match(read(), /- \d\d:\d\d 🎤 语音文字\n  下一行/);
});

test("literal attachment links receive the same normalization during verification", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n");
  await svc.writer.writeText("附件 ![[assets/file.pdf]]\n补充说明", false, day);
  assert.match(read(), /附件 \[\[assets\/file\.pdf\|file\.pdf\]\]\n  补充说明/);
});

test("images, files, audio and existing attachment references use compact lists", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n- 16:04 手写\n\n## 后续\n保留\n");
  const writer = svc.plugin.writer;
  assert.equal((await writer.writeImage(Buffer.from("image"), "jpg", day)).n, 1);
  assert.equal((await writer.writeAttachment(Buffer.from("pdf"), "assets/report.pdf", day)).n, 2);
  assert.equal((await writer.writeAttachment(Buffer.from("audio"), "assets/voice.wav", day, "🎤", "语音转写\n第二行")).n, 3);
  assert.equal((await writer.appendLinkBlock("assets/report.pdf", day)).n, 4);
  assert.match(read(), /- \d\d:\d\d !\[\[.*\.jpg\]\]/);
  assert.match(read(), /- \d\d:\d\d \[\[.*report\.pdf\|report\.pdf\]\]/);
  assert.match(read(), /- \d\d:\d\d 🎤 !\[\[.*voice\.wav\]\]\n  语音转写\n  第二行/);
  assert.ok(read().endsWith("\n## 后续\n保留\n"));
});

test("undo, finalize and help cannot rewrite a note", async t => {
  const before = "## 日常记录\n- 16:04 手写一\n- 16:17 手写二\n- 16:22 微信记录\n";
  const { svc, read } = await setup(t, before);
  for (const command of ["撤回", "结束", "晚安"]) {
    const reply = await svc.plugin.agent.onMessage("TEST", command, false, [], {});
    assert.match(reply, /撤回和封存已停用/);
    assert.equal(read(), before);
  }
  assert.equal((await svc.writer.undoLast()).ok, false);
  assert.equal((await svc.writer.finalize()).status, "disabled");
  assert.match(await svc.plugin.agent.onMessage("TEST", "帮助", false, [], {}), /撤回和封存已停用/);
  assert.equal(read(), before);
});

test("counts survive restart through existing written journal events", async t => {
  const { svc, day, configPath } = await setup(t, "## 日常记录\n- 16:04 手写\n");
  await svc.writer.writeText("微信记录", false, day);
  await svc.journal.append({ type: "written", eventId: "test:1", logicalDate: day, count: 1 });
  const { WeChatDiaryService } = require("../src/service");
  const restarted = new WeChatDiaryService({ configPath });
  await restarted.init();
  t.after(() => restarted.plugin._teardownHostRegistrations());
  assert.equal(await restarted.writer.countDay(day), 1);
  assert.equal((await restarted.writer.writeText("重启后记录", false, day)).n, 2);
});

test("replay never treats identical handwritten text as a completed message", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n- 16:04 相同文字\n");
  await svc.journal.append({ type: "received", eventId: "test:pending", logicalDate: day, text: "相同文字", msgType: "text" });
  assert.equal((await svc.replayDate(day)).replayed, 1);
  assert.equal(read().split("相同文字").length - 1, 2);
  assert.equal((await svc.replayDate(day)).pending, 0);
});

test("pending commands are skipped during replay", async t => {
  const before = "## 日常记录\n- 16:04 手写\n";
  const { svc, day, read } = await setup(t, before);
  for (const text of ["撤回", "结束", "帮助", "开始记录"]) {
    await svc.journal.append({ type: "received", eventId: "test:" + text, logicalDate: day, text, msgType: "text" });
  }
  const result = await svc.replayDate(day);
  assert.equal(result.replayed, 0);
  assert.equal(result.skipped, 4);
  assert.equal(read(), before);
});

test("write failures cannot be acknowledged as success", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n- 16:04 手写\n");
  const before = read();
  svc.vault.process = async () => { throw new Error("test write failure"); };
  await assert.rejects(svc.writer.writeText("未写成的记录", false, day));
  assert.equal(read(), before);
  assert.equal(await svc.writer.countDay(day), 0);
});

test("media disk failures stay visible to message dispatch", async t => {
  const { svc, day, read } = await setup(t, "## 日常记录\n- 16:04 手写\n");
  const before = read();
  svc.vault.createBinary = async () => { throw new Error("test media disk failure"); };
  await assert.rejects(svc.plugin.writer.writeImage(Buffer.from("image"), "jpg", day));
  assert.ok(svc.plugin.writer.appendOnlyError);
  assert.equal(read(), before);
});

test("readback detects loss even when an identical old entry remains", async t => {
  const { svc, day, note, read } = await setup(t, "## 日常记录\n");
  await svc.writer.writeText("同样内容", false, day);
  const before = read();
  const process = svc.vault.process.bind(svc.vault);
  svc.vault.process = async (...args) => {
    const expected = await process(...args);
    fs.writeFileSync(note, before);
    return expected;
  };
  await assert.rejects(svc.writer.writeText("同样内容", false, day));
  assert.equal(read(), before);
});

test("CRLF and trailing spaces are preserved", async t => {
  const before = "## 日常记录\r\n- 16:04 手写  \r\n\r\n## 后续\r\n原文\r\n";
  const { svc, day, read } = await setup(t, before);
  await svc.writer.writeText("新记录", false, day);
  assert.equal(read().replace(/- \d\d:\d\d 新记录\r\n/, ""), before);
});

test("missing notes and missing sections can be created without ownership markers", async t => {
  const { svc, day, note, read } = await setup(t);
  await svc.writer.writeText("新笔记", false, day);
  assert.match(read(), /## 日常记录\n- \d\d:\d\d 新笔记/);
  assert.ok(!read().includes("wechat-diary:managed"));
  fs.writeFileSync(note, "## 日报总结\n原文");
  await svc.writer.writeText("新节", false, day);
  assert.ok(read().startsWith("## 日报总结\n原文\n## 日常记录\n"));
});

test("real message dispatch retains sequence deduplication and forced literal commands", async t => {
  const { svc, read } = await setup(t, "## 日常记录\n- 16:04 手写\n");
  Object.assign(svc.ilink, { userId: "USER_TEST", botId: "BOT_TEST", skipBacklog: false });
  svc.plugin.data.profile.state = "active";
  svc._reply = async () => true;
  const message = { from_user_id: "USER_TEST", seq: 123, message_id: "test123", message_state: 2,
    item_list: [{ type: 1, text_item: { text: "记：撤回" } }] };
  await svc.handleMessage(message);
  const first = read();
  assert.match(first, /- \d\d:\d\d 撤回\n/);
  await svc.handleMessage(message);
  assert.equal(read(), first);
  assert.equal(svc._stats.written, 1);
});

test("dispatch records failure when handwritten text masks a failed append", async t => {
  const before = "## 日常记录\n- 16:04 相同文字\n";
  const { svc, day, read } = await setup(t, before);
  Object.assign(svc.ilink, { userId: "USER_TEST", botId: "BOT_TEST", skipBacklog: false });
  svc.plugin.data.profile.state = "active";
  svc._reply = async () => true;
  svc.vault.process = async () => { throw new Error("test disk write failure"); };
  await svc.handleMessage({ from_user_id: "USER_TEST", seq: 124, message_id: "test124", message_state: 2,
    item_list: [{ type: 1, text_item: { text: "相同文字" } }] });
  assert.equal(read(), before);
  assert.equal(svc._stats.written, 0);
  assert.equal((await svc.journal.summary(day)).counts.failed, 1);
  assert.ok(!svc.ilink.recentSeqs.includes("s124"));
});
