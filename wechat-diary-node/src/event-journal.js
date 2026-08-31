"use strict";
// 事件流水: 每条微信消息在动 Daily Note 之前, 先落一条不可变 NDJSON。
//
// 为什么必须先落盘(第五章):
//   Daily Note 是"可能失败、可能被别人覆盖、可能正被 ob 同步"的共享资源。
//   如果消息只存在于内存里, 那么"写 Daily Note 失败"就等于用户的话彻底消失 ——
//   而微信那边可能已经收到确认。流水的存在把"消息收到了"和"日记写成了"解耦:
//   前者一旦落盘就永不丢, 后者失败可以按流水重放。
//
// 顺序契约(service.js 严格照此执行):
//   1 收到消息 → 2 验证用户与消息 ID → 3 检查幂等 → 4 追加 NDJSON 并 fsync
//   → 5 更新 Daily Note → 6 更新游标与去重 → 7 回微信确认
//
// 文件: <vault>/.wechat-diary/events/YYYY-MM-DD.ndjson (按【逻辑日】分文件)
//   放在 vault 里是刻意的: 它跟着 ob 一起被同步/备份, 换机器也能重放。
//   .wechat-diary 以点开头, Obsidian 不索引它, 不会污染搜索结果。
//
// 一条事件只追加、永不改写。处理结果用【第二条事件】记录(status: written/failed),
// 而不是回头修改第一条 —— 追加是原子的, 原地改写不是。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const logger = require("./logger");

const EVENT_VERSION = 1;

// 事件类型
const EV = {
  RECEIVED: "received",   // 消息已接收并通过校验(写 Daily Note 之前)
  WRITTEN: "written",     // Daily Note 写入成功(含校验通过)
  FAILED: "failed",       // Daily Note 写入失败 —— 可重放
  SKIPPED: "skipped",     // 幂等命中/积压跳过/非白名单
  REPLIED: "replied",     // 微信确认已发出
  REPLAYED: "replayed",   // 重放补写成功
};

class EventJournal {
  // vaultRoot: vault 绝对路径; journalDir: 相对 vault 的目录
  constructor(vaultRoot, journalDir) {
    this.root = vaultRoot;
    this.dir = path.join(vaultRoot, journalDir || ".wechat-diary/events");
    this._chain = Promise.resolve();   // 追加串行化: NDJSON 的"一行一条"不能被交错写破坏
  }

  filePathFor(logicalDate) {
    return path.join(this.dir, String(logicalDate) + ".ndjson");
  }

  // 追加一条并 fsync。返回落盘后的事件对象。
  // fsync 是这里的重点: 不 fsync 的"写入"只是进了 page cache, 掉电就没了,
  // 而整章设计的前提是"流水一旦返回就永不丢"。每条消息一次 fsync, 代价可接受。
  async append(event) {
    const ev = Object.assign({
      v: EVENT_VERSION,
      ts: new Date().toISOString(),
    }, event);
    const line = JSON.stringify(ev) + "\n";
    const file = this.filePathFor(ev.logicalDate);
    const run = this._chain.then(async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      let fh;
      try {
        fh = await fsp.open(file, "a", 0o600);
        await fh.writeFile(line);
        await fh.sync();
      } finally {
        if (fh) await fh.close();
      }
    });
    this._chain = run.then(() => {}, () => {});
    await run;
    return ev;
  }

  // 读一天的全部事件。文件不存在 → []。
  // 坏行(半截 JSON: 理论上 fsync + 单行追加不会产生, 但磁盘满时可能)单独收集,
  // 不让一行坏的挡住整天的重放。
  async read(logicalDate) {
    const file = this.filePathFor(logicalDate);
    let raw;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { events: [], badLines: [] };
      throw e;
    }
    const events = [];
    const badLines = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        events.push(JSON.parse(l));
      } catch (e) {
        badLines.push({ line: i + 1, snippet: l.slice(0, 80) });
      }
    }
    if (badLines.length) logger.warn("事件流水有 " + badLines.length + " 行无法解析:", file);
    return { events, badLines };
  }

  // 列出有流水的日期(status/doctor 用)
  async listDates() {
    try {
      const ents = await fsp.readdir(this.dir);
      return ents.filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
        .map((f) => f.replace(/\.ndjson$/, "")).sort();
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  // 找出"收到了但没写成"的事件 —— 重放的输入。
  // 判据: 有 received, 且同一 eventId 之后没有 written / replayed / skipped。
  // 用 eventId(而非 seq)串联: 同一条微信消息的 received/written/failed 共享它。
  async pendingFor(logicalDate) {
    const { events } = await this.read(logicalDate);
    const received = new Map();
    const settled = new Set();
    for (const ev of events) {
      if (!ev || !ev.eventId) continue;
      if (ev.type === EV.RECEIVED) received.set(ev.eventId, ev);
      else if (ev.type === EV.WRITTEN || ev.type === EV.REPLAYED || ev.type === EV.SKIPPED) settled.add(ev.eventId);
    }
    const out = [];
    for (const [id, ev] of received) if (!settled.has(id)) out.push(ev);
    // 按接收顺序重放: 顺序错了同分钟合并/撤回语义就变了
    out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return out;
  }

  // 汇总一天的处理情况(status 命令用)
  async summary(logicalDate) {
    const { events, badLines } = await this.read(logicalDate);
    const counts = {};
    for (const ev of events) counts[ev.type] = (counts[ev.type] || 0) + 1;
    const pending = await this.pendingFor(logicalDate);
    return { date: logicalDate, total: events.length, counts, pending: pending.length, badLines: badLines.length };
  }
}

// 构造一条 received 事件的 payload。
// 刻意不存消息正文明文之外的东西 —— 但正文【必须】存: 重放需要它, 这是流水的意义。
// 流水文件权限 0600, 且在 vault 内的隐藏目录; 它与 Daily Note 同等敏感, 不多也不少。
function receivedEvent({ eventId, seqKey, messageId, seq, botId, userId, logicalDate, msgType, text, media, targetPath }) {
  return {
    type: EV.RECEIVED,
    eventId,                       // 本服务给的稳定 id: botId + seqKey
    seqKey,                        // 去重键(与 main.js 的 recentSeqs 同一形态)
    messageId: messageId == null ? null : String(messageId),
    seq: seq == null ? null : seq,
    botId: botId || "",
    userId: userId || "",
    receivedAt: new Date().toISOString(),
    logicalDate,                   // 逻辑日: 决定写进哪个 Daily Note
    msgType,                       // text | voice | image | file | video | mixed
    text: text == null ? null : String(text),
    media: media || null,          // 媒体元数据(不含 aeskey/url: 那些是凭据)
    targetPath: targetPath || "",  // 预期写入的 Daily Note 路径
    status: "received",
  };
}

module.exports = { EventJournal, EV, receivedEvent, EVENT_VERSION };
