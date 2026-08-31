"use strict";
// 状态存储: 游标(buf)、去重表(recentSeqs)、profile/session、附件 md5 表。
//
// 这份文件的唯一职责是"永不写坏, 写坏了能安全恢复"。它承载的是【幂等性】——
// recentSeqs 丢了会重复写日记, buf 丢了会重放整段积压。所以:
//
//   写: 临时文件 → fsync → rename → 目录 fsync。异常退出最坏是丢最后一次更新, 不会得到半截 JSON
//   读: JSON 坏了不当致命错误, 而是隔离到 state.json.corrupt-<时间戳> 并按"保守恢复"启动
//   保守恢复 = skipBacklog: true —— 宁可跳过离线期间的积压, 也不把历史按今天的日期重演一遍
//              (这正是插件 onload 里从 secret 恢复身份时的同一套逻辑, 原因见 main.js 的注释)
//
// state.json 的形状与插件 data.json 一致(settings/ilink/profile/session), 因为它就是喂给
// main.js 的 loadData() 的东西。settings 不落在这里(它归 config.json), 加载时现拼。

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const logger = require("./logger");

// 与插件 DEFAULT_DATA() 对齐的空状态
function emptyState() {
  return {
    ilink: {
      botId: "", userId: "", baseUrl: "",
      loginTime: "", pauseUntil: 0,
      buf: "",                    // 服务端游标
      contextTokens: {},
      recentSeqs: [],             // 去重表
      fileMd5s: [],               // 附件 md5 → 路径(重复文件复用)
      lastAliveTs: 0,
      skipBacklog: false,
      botTokenFallback: "",       // 服务端不用它(token 在 credentials.json), 留着占位
    },
    profile: { state: "unknown", name: null, nudge_count: 0, finalize_count: 0 },
    session: {
      entered_date: "", last_activity_ts: 0,
      reminded_date: "", reminder_streak: 0, reminder_idx: 0, reminder_last_result: "",
      nudged_date: "",
    },
    // 服务端自己的字段(插件没有): 最后一次成功处理的事件, 供 status/replay 使用
    service: { lastEventId: "", lastEventTs: 0, startedAt: 0, version: 1 },
  };
}

class StateStore {
  constructor(statePath) {
    this.path = statePath;
    this.state = emptyState();
    this._writing = null;      // 串行化写入: 同一时刻只有一个 rename 在飞
    this._dirty = false;
    this.recoveredFromCorruption = false;
  }

  // 加载。三种结果:
  //   文件不存在      → 空状态(首次启动)
  //   文件正常        → 合并进空状态(缺字段用默认值补齐, 兼容老版本)
  //   文件坏了        → 隔离备份 + 空状态 + skipBacklog(保守恢复)
  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") {
        logger.info("状态文件不存在, 按首次启动处理:", this.path);
        return this.state;
      }
      throw e;
    }
    let parsed = null;
    let problem = "";
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problem = "顶层不是对象";
    } catch (e) {
      problem = e.message;
    }
    if (problem) {
      const backup = this.path + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "");
      try {
        await fsp.rename(this.path, backup);
        logger.error("状态文件损坏(" + problem + "), 已隔离到 " + backup);
      } catch (e) {
        logger.error("状态文件损坏(" + problem + ")且无法隔离: " + e.message);
      }
      // 保守恢复: 游标与去重表都没了 —— 服务端对空游标可能回吐大段积压, 而去重表是空的。
      // 照写就会把历史按【今天】的日期重演一遍。先跳过积压, 等流量安静下来再落笔。
      this.state = emptyState();
      this.state.ilink.skipBacklog = true;
      this.recoveredFromCorruption = true;
      logger.warn("已启用保守恢复: 跳过服务端积压, 等长轮询空转一轮后开始记录");
      return this.state;
    }
    // 逐段合并: 只认识的字段进来, 形状不对的退回默认值
    const s = emptyState();
    const src = parsed;
    if (src.ilink && typeof src.ilink === "object") {
      const il = src.ilink;
      Object.assign(s.ilink, {
        botId: str(il.botId), userId: str(il.userId), baseUrl: str(il.baseUrl),
        loginTime: str(il.loginTime),
        pauseUntil: num(il.pauseUntil),
        buf: str(il.buf),
        contextTokens: (il.contextTokens && typeof il.contextTokens === "object" && !Array.isArray(il.contextTokens)) ? il.contextTokens : {},
        recentSeqs: Array.isArray(il.recentSeqs) ? il.recentSeqs.filter((x) => typeof x === "string") : [],
        fileMd5s: Array.isArray(il.fileMd5s) ? il.fileMd5s.filter((x) => x && typeof x.md5 === "string" && typeof x.path === "string") : [],
        lastAliveTs: num(il.lastAliveTs),
        skipBacklog: !!il.skipBacklog,
        botTokenFallback: "",     // 永不从 state 读 token: 凭据只住 credentials.json
      });
      // recentSeqs 形状坏了但 buf 还在: 去重能力没了, 保守跳过一轮
      if (!Array.isArray(il.recentSeqs) && il.buf) {
        s.ilink.skipBacklog = true;
        logger.warn("去重表形状异常, 已启用保守恢复");
        this.recoveredFromCorruption = true;
      }
    }
    if (src.profile && typeof src.profile === "object") {
      Object.assign(s.profile, src.profile);
      if (s.profile.state === "awaiting_name") s.profile.state = "active";  // 插件 D11 的同款迁移
      if (s.profile.state !== "active" && s.profile.state !== "unknown") s.profile.state = "unknown";
    }
    if (src.session && typeof src.session === "object") Object.assign(s.session, src.session);
    if (src.service && typeof src.service === "object") Object.assign(s.service, src.service);
    this.state = s;
    return this.state;
  }

  markDirty() { this._dirty = true; }

  // 保存。串行化 + 原子替换。
  // 并发调用会被折叠: 排队中已有一次待写就直接复用它的 promise(状态是共享对象,
  // 后写的那次自然带上先写的内容, 写两遍纯属浪费 fsync)。
  async save() {
    if (this._writing) {
      this._pending = this._pending || this._writing.then(() => this._doSave());
      return this._pending;
    }
    this._writing = this._doSave().finally(() => {
      this._writing = this._pending || null;
      this._pending = null;
    });
    return this._writing;
  }

  async _doSave() {
    const body = JSON.stringify(this.state, null, 2) + "\n";
    await fsp.mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = this.path + ".tmp." + process.pid;
    let fh;
    try {
      fh = await fsp.open(tmp, "w", 0o600);
      await fh.writeFile(body);
      await fh.sync();                 // 内容落盘
    } finally {
      if (fh) await fh.close();
    }
    await fsp.rename(tmp, this.path);  // 原子替换
    let dh;
    try {                              // rename 本身持久化
      dh = await fsp.open(path.dirname(this.path), "r");
      await dh.sync();
    } catch (e) { /* 部分文件系统不支持目录 fsync, 忽略 */ }
    finally { if (dh) await dh.close().catch(() => {}); }
    this._dirty = false;
  }

  // 同步版保存: 只给退出路径兜底(SIGINT 处理里 await 不一定跑完)。
  saveSync() {
    try {
      const body = JSON.stringify(this.state, null, 2) + "\n";
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = this.path + ".tmp." + process.pid + ".sync";
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.path);
      this._dirty = false;
      return true;
    } catch (e) {
      logger.error("同步保存状态失败:", e.message);
      return false;
    }
  }
}

function str(v) { return typeof v === "string" ? v : ""; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

module.exports = { StateStore, emptyState };
