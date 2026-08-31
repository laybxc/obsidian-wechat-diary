"use strict";
// 服务本体: 长轮询 → 事件流水 → Daily Note → 游标 → 回微信。
//
// 为什么不直接用 main.js 的 startPipeline/_loop:
//   插件的循环是"整批处理完才推游标, 崩了就靠 recentSeqs 去重重放"。这在 Obsidian 里够用,
//   但服务端多了一条硬要求(第五章): 每条消息必须【先】落不可变流水【再】动 Daily Note。
//   所以外层循环自己写, 内层的一切(意图识别、写入、媒体、封存、撤回、回执文案)复用
//   main.js 的 agent/writer —— 语义与 Mac 版一致, 只是多了一层流水。
//
// 严格执行的顺序(第五章):
//   1 收到消息
//   2 验证用户与消息 ID          ← 陌生人静默丢弃; 缺 from/seq 的畸形包丢弃
//   3 检查幂等                   ← recentSeqs + 流水已 written
//   4 追加 NDJSON 并落盘(fsync)  ← 到这一步, 消息永不丢
//   5 更新 Daily Note            ← 失败 → failed 事件 → 可重放 → 回微信明确失败
//   6 更新游标与去重状态          ← 只在 5 成功后
//   7 回微信确认
//
// 崩溃安全: 4 之后任何位置崩溃, 重启时 replay 能从流水补写; 4 之前崩溃, 服务端游标未推进,
// 腾讯会重发。两头都不丢, 中间靠 recentSeqs + 流水双重去重不重复。

const path = require("path");
const fsp = require("fs/promises");
const logger = require("./logger");
const { loadConfig, loadCredentials, validateConfig, checkPermissions, maskId } = require("./config");
const { StateStore } = require("./state-store");
const { EventJournal, EV, receivedEvent } = require("./event-journal");
const { bootPlugin } = require("./plugin-host");
const { DiaryWriterAdapter } = require("./diary-writer");
const { mediaSummary, classifyMessage } = require("./media");

const LONG_POLL_TIMEOUT_MS = 35000;
const STALE_TOKEN_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000;
const MAX_RECENT_SEQS = 200;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class WeChatDiaryService {
  constructor(opts) {
    const o = opts || {};
    this.configPath = o.configPath;
    this.mainJsPath = o.mainJsPath || path.resolve(__dirname, "..", "..", "main.js");
    this.dryRun = !!o.dryRun;
    this._running = false;
    this._stopping = false;
    this._sleepCancels = new Set();
    this._stats = { polls: 0, received: 0, written: 0, failed: 0, skipped: 0, replied: 0, startedAt: 0 };
  }

  // ── 启动 ──
  async init() {
    const { config, configPath, exists } = loadConfig(this.configPath);
    this.config = config;
    this.configPathResolved = configPath;
    if (!exists) logger.warn("配置文件不存在, 用默认值:", configPath);

    logger.setLevel(config.service.logLevel);

    const errs = validateConfig(config);
    if (errs.length) {
      const e = new Error("配置有问题:\n  - " + errs.join("\n  - "));
      e.configErrors = errs;
      throw e;
    }

    this.credentials = loadCredentials();
    if (this.credentials.botToken) logger.registerSecret(this.credentials.botToken);
    if (this.credentials.aiKey) logger.registerSecret(this.credentials.aiKey);

    for (const p of checkPermissions(this.credentials.path)) logger.warn("权限:", p);

    const { STATE_PATH } = require("./config");
    this.stateStore = new StateStore(STATE_PATH);
    await this.stateStore.load();

    // attachmentMode 必须是 obsidian 才会走我们的 fileManager(附件跟随笔记)。
    // 配置里写 custom 会落到日记根目录下, 与"当天笔记旁的 assets"这个要求不符 —— 直接纠正并说明。
    if (this.config.settings.attachmentFollowNote && this.config.settings.attachmentMode !== "obsidian") {
      logger.info("attachmentFollowNote=true: 把 attachmentMode 由 " + this.config.settings.attachmentMode + " 改为 obsidian(附件走当天笔记旁的 assets/)");
      this.config.settings.attachmentMode = "obsidian";
    }

    const boot = await bootPlugin({
      mainJsPath: this.mainJsPath,
      config: this.config,
      credentials: this.credentials,
      stateStore: this.stateStore,
    });
    this.plugin = boot.plugin;
    this.vault = boot.vault;
    this.I = boot.internals;
    this.credAccessor = boot.credentials;

    this.writer = new DiaryWriterAdapter(this.plugin, this.I, {
      verifyAfterWrite: this.config.service.verifyAfterWrite,
    });
    this.journal = new EventJournal(this.config.vaultPath, this.config.service.journalDir);

    // 时区/切日: main.js 的模块级状态, onload 已按 settings 设过, 这里复述一次便于日志核对
    logger.info("时区 " + this.config.settings.timezone + ", 切日 " + this.config.settings.dayStartHour + ":00, 逻辑日 " + this.I.logicalTodayStr());
    logger.info("Vault " + this.config.vaultPath);
    logger.info("当天笔记 " + this.writer.diaryPath(this.I.logicalTodayStr()));
    logger.info("节标题 「## " + this.plugin.writer._heading() + "」, managed=" + this.plugin.writer._managed());
    return this;
  }

  get ilink() { return this.stateStore.state.ilink; }

  // ── 主循环 ──
  async run() {
    if (!this.credentials.botToken) {
      // exit 78 (EX_CONFIG): 这不是崩溃, 是配置缺失。run.sh 据此【不重启】——
      // 没绑定的服务重启一万次也还是没绑定, 只会刷满日志。
      const e = new Error("还没有绑定微信: 先跑 `node src/cli.js bind`");
      e.exitCode = 78;
      throw e;
    }
    const { ILinkClient } = this.I;
    this.client = new ILinkClient();
    this.client.token = this.credentials.botToken;
    this.client.baseUrl = this.ilink.baseUrl || "";
    // 插件用 plugin._client 拿客户端下载媒体; 服务端也要挂上, 否则图片/语音收不了
    this.plugin._client = this.client;
    this._running = true;
    this._stats.startedAt = Date.now();
    this.stateStore.state.service.startedAt = Date.now();

    // 启动时先把上次没写成的补上: 崩溃/Sync 冲突留下的 pending 不该等到用户下次发消息才发现
    await this.replayPending();

    if (!this._isPaused()) this.client.notify("notifystart");
    logger.info("服务已启动: 用户 " + maskId(this.ilink.userId) + ", bot " + maskId(this.ilink.botId) + (this._skipBacklog() ? " [跳过积压模式]" : ""));

    let pollTimeout = LONG_POLL_TIMEOUT_MS;
    let failCount = 0;

    while (this._running) {
      const il = this.ilink;

      // -14 冷却: 不清 token 不重登, 同 token 同 buf 等冷却结束
      if (this._isPaused()) {
        const left = il.pauseUntil - Date.now();
        logger.warn("会话冷却中, " + Math.ceil(left / 60000) + " 分钟后恢复");
        await this._interruptibleSleep(Math.min(left, 60000));
        continue;
      }

      let r;
      try {
        r = await this.client.getUpdates(il.buf, pollTimeout);
        this._stats.polls += 1;
      } catch (e) {
        if (!this._running) break;
        failCount += 1;
        logger.warn("长轮询失败(" + failCount + "):", e.message);
        if (failCount >= 3) { failCount = 0; await this._interruptibleSleep(30000); }
        else await this._interruptibleSleep(2000);
        continue;
      }
      if (!this._running) break;

      // 长轮询正常心跳 = 服务端没东西给了 = 积压追平
      if (r.__timeout) { await this._clearSkipBacklog(); continue; }

      const code = this.I.respCode(r.json);
      if (code === STALE_TOKEN_ERRCODE) {
        il.pauseUntil = Date.now() + SESSION_PAUSE_MS;
        logger.warn("会话过期(-14), 冷却 1 小时后用同一 token 继续");
        await this.stateStore.save();
        continue;
      }
      if (code !== 0) {
        failCount += 1;
        logger.warn("getupdates 返回 ret=" + code);
        if (failCount >= 3) { failCount = 0; await this._interruptibleSleep(30000); }
        else await this._interruptibleSleep(2000);
        continue;
      }

      failCount = 0;
      il.lastAliveTs = Date.now();
      if (typeof r.json.longpolling_timeout_ms === "number" && r.json.longpolling_timeout_ms > 0) {
        pollTimeout = r.json.longpolling_timeout_ms;
      }

      const msgs = Array.isArray(r.json.msgs) ? r.json.msgs : [];
      if (msgs.length === 0) await this._clearSkipBacklog();

      // 整批处理完才推游标(与插件同策略): 中途退出就重放这一批, 靠 recentSeqs + 流水去重
      let batchDone = true;
      for (const msg of msgs) {
        if (!this._running) { batchDone = false; break; }
        try {
          await this.handleMessage(msg);
        } catch (e) {
          logger.error("处理消息失败(游标不推进, 下轮重放):", e.message);
          batchDone = false;
          break;
        }
      }
      if (batchDone && this._running && r.json.get_updates_buf) {
        il.buf = r.json.get_updates_buf;
        await this.stateStore.save();
      }
    }
    logger.info("主循环退出");
  }

  // ── 单条消息处理: 严格按第五章七步 ──
  async handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.message_type === 2) return;      // BOT 自己发的
    if (msg.message_state === 1) return;     // GENERATING 半成品

    const il = this.ilink;
    const from = msg.from_user_id || "";

    // 【步骤 2】验证用户与消息 ID
    if (!from) { logger.debug("丢弃: 没有 from_user_id"); return; }
    if (!il.userId) {
      // 待认领: 有 token 但没有主人。服务端没有 GUI 弹窗, 靠 cli claim 显式认领 ——
      // 不自动认领: 协议层没有 allowlist, 谁先发消息谁当主人是安全漏洞。
      logger.warn("收到消息但服务未绑定主人(userId 为空)。确认这是你本人后运行: node src/cli.js claim " + maskId(from));
      this._pendingClaim = from;
      return;
    }
    if (from !== il.userId) {
      // 陌生人静默丢弃: 不回复(回复等于确认 bot 存活), 不落库, 不进流水(避免被撑大)
      logger.warn("丢弃非白名单来源的消息:", maskId(from));
      return;
    }

    const seqKey = msg.seq != null ? "s" + msg.seq : (msg.message_id != null ? "m" + msg.message_id : "");
    if (!seqKey) { logger.warn("丢弃: 消息既没有 seq 也没有 message_id, 无法去重"); return; }

    // 恢复身份/状态损坏后的第一波: 只推游标不落笔。
    // 原因见 state-store 的注释: 游标空 + 去重表空时, 服务端可能回吐大段积压,
    // 照写会把历史按今天的日期重演一遍, 连"撤回""结束"都会被重放。
    if (this._skipBacklog()) {
      this._skippedCount = (this._skippedCount || 0) + 1;
      logger.debug("跳过积压消息 " + seqKey);
      return;
    }

    // 【步骤 3】幂等
    if (il.recentSeqs.includes(seqKey)) {
      logger.info("幂等命中, 跳过重复消息 " + seqKey);
      return;
    }

    if (msg.context_token) il.contextTokens[from] = msg.context_token;

    // 解析 item_list —— 与 main.js _handleIncoming 同一套分流
    let text = "", hasText = false, hasVoice = false;
    const images = [], voices = [], files = [], videos = [];
    let voiceAudio = null;
    for (const item of msg.item_list || []) {
      if (item.type === 1 && item.text_item) { text += item.text_item.text || ""; hasText = true; }
      else if (item.type === 3 && item.voice_item) {
        hasVoice = true;
        const vt = item.voice_item.text || "";
        if (vt) {
          text += vt;
          if (this.config.settings.saveVoiceAudio && item.voice_item.media) voiceAudio = item.voice_item;
        } else if (item.voice_item.media) voices.push(item.voice_item);
      }
      else if (item.type === 2 && item.image_item) images.push(item.image_item);
      else if (item.type === 4 && item.file_item) files.push(item.file_item);
      else if (item.type === 5 && item.video_item) videos.push(item.video_item);
    }
    if (!hasText && !hasVoice && !images.length && !files.length && !videos.length) {
      logger.info("忽略暂不支持的消息类型(item 里没有可识别内容)");
      return;
    }
    const isVoice = hasVoice && !hasText;
    const logicalDate = this.I.logicalTodayStr();
    const eventId = (il.botId || "nobot") + ":" + seqKey;

    // 【步骤 4】追加 NDJSON 并落盘 —— 到这里为止, 消息永不丢
    const ev = receivedEvent({
      eventId, seqKey,
      messageId: msg.message_id, seq: msg.seq,
      botId: il.botId, userId: il.userId,
      logicalDate,
      msgType: classifyMessage({ hasText, hasVoice, images, voices, files, videos }),
      text: hasText || hasVoice ? text : null,
      media: mediaSummary({ images, voices, files, videos, voiceAudio }),
      targetPath: this.writer.diaryPath(logicalDate),
    });
    if (this.dryRun) {
      logger.info("[dry-run] 将写入流水:", { eventId, msgType: ev.msgType, logicalDate, target: ev.targetPath, text: logger.summarize(text) });
      return;
    }
    await this.journal.append(ev);
    this._stats.received += 1;
    logger.info("收到消息 " + seqKey + " (" + ev.msgType + ", " + logger.summarize(text) + ") → " + ev.targetPath);

    // 【步骤 5】更新 Daily Note —— 复用 main.js 的 agent(意图识别/媒体/封存/撤回/回执文案)
    let reply = null;
    let writeOk = false;
    let failReason = "";
    try {
      reply = await this.plugin.agent.onMessage(from, text, isVoice, images, { voices, files, videos, voiceAudio });
      // 文本类记录做写后校验: 意图是命令(撤回/封存/探活/帮助)时没有新内容可校验, 跳过
      if (hasText || hasVoice) {
        const det = this.I.detectIntent(text);
        const isRecord = det.intent === this.I.INTENT.DIARY || (det.intent === this.I.INTENT.START_DIARY && det.suspect);
        if (isRecord && this.config.service.verifyAfterWrite) {
          const needle = this.writer._needleFor(det.forced ? String(text).trim().replace(/^记[：:]\s*/, "") : text, isVoice);
          // 语音原声块的正文在 wikilink 下一行, 同样能被 includes 命中
          if (needle && !(await this.writer.verifyContains(logicalDate, needle))) {
            throw Object.assign(new Error("写入校验失败: 重读文件后找不到刚写的内容"), { verifyFailed: true });
          }
        }
      }
      writeOk = true;
    } catch (e) {
      failReason = e.message;
      logger.error("写入 Daily Note 失败:", e.message);
    }

    if (!writeOk) {
      // 【失败路径】流水留 failed, 不推进去重表 —— 事件可重放。
      // 回微信明确的失败提示: 绝不能让用户以为记上了。
      await this.journal.append({
        type: EV.FAILED, eventId, seqKey, botId: il.botId, logicalDate,
        targetPath: ev.targetPath, status: "failed", error: String(failReason).slice(0, 500),
      });
      this._stats.failed += 1;
      await this._reply(from, "⚠️ 这条没记上! 写入或校验出了问题, 服务已保留这条消息, 稍后会自动补写。也可以等一会儿重发一次。");
      return;
    }

    // 【写入成功】流水记 written
    await this.journal.append({
      type: EV.WRITTEN, eventId, seqKey, botId: il.botId, logicalDate,
      targetPath: ev.targetPath, status: "written",
      count: await this.writer.countDay(logicalDate).catch(() => null),
    });
    this._stats.written += 1;

    // 【步骤 6】更新游标与去重状态(游标由批次末尾统一推进; 这里推去重表)
    il.recentSeqs.push(seqKey);
    if (il.recentSeqs.length > MAX_RECENT_SEQS) il.recentSeqs.splice(0, il.recentSeqs.length - MAX_RECENT_SEQS);
    this.stateStore.state.service.lastEventId = eventId;
    this.stateStore.state.service.lastEventTs = Date.now();
    await this.stateStore.save();

    // 【步骤 7】回微信确认
    if (reply) {
      const sent = await this._reply(from, reply);
      if (sent) {
        await this.journal.append({
          type: EV.REPLIED, eventId, seqKey, botId: il.botId, logicalDate, status: "replied",
        });
        this._stats.replied += 1;
        if (this.plugin.agent.commitNudge()) await this.stateStore.save();
      }
    }
  }

  async _reply(to, text) {
    if (this._isPaused() || !this.client) {
      logger.warn("冷却中或客户端已关, 回执发不出(日记已写入)");
      return false;
    }
    try {
      await this.client.sendText(to, text, this.ilink.contextTokens[to]);
      return true;
    } catch (e) {
      if (e && e.ilinkCode === STALE_TOKEN_ERRCODE) {
        this.ilink.pauseUntil = Date.now() + SESSION_PAUSE_MS;
        await this.stateStore.save();
      }
      logger.error("回复失败:", e.message);
      return false;
    }
  }

  // ── 重放 ──────────────────────────────────────────────────────────────
  // 从流水补写"收到了但没写成"的消息。幂等: 补写前先看内容是否已在 managed 正文里。
  // 只重放文本(含语音转写文字): 媒体的 CDN 链接与密钥都是短时效的, 事后重放下不下来,
  // 而流水刻意不存密钥(存了就等于把凭据写进 vault)。媒体失败以 failed 事件留痕, 由用户重发。
  async replayDate(logicalDate) {
    const pending = await this.journal.pendingFor(logicalDate);
    if (!pending.length) return { date: logicalDate, pending: 0, replayed: 0, skipped: 0, failed: 0, details: [] };
    logger.info("重放 " + logicalDate + ": " + pending.length + " 条待补写");
    let replayed = 0, skipped = 0, failed = 0;
    const details = [];
    for (const ev of pending) {
      const hasBody = ev.text != null && String(ev.text).trim() !== "";
      if (!hasBody) {
        // 纯媒体: 无法重放(密钥不在流水里, 且 CDN 链接已过期)
        await this.journal.append({
          type: EV.SKIPPED, eventId: ev.eventId, seqKey: ev.seqKey, botId: ev.botId,
          logicalDate, status: "skipped", reason: "纯媒体消息无法重放(流水不保存 CDN 密钥), 请在微信里重发",
        });
        skipped += 1;
        details.push({ eventId: ev.eventId, result: "skipped-media" });
        continue;
      }
      const isVoice = ev.msgType === "voice";
      const needle = this.writer._needleFor(ev.text, isVoice);
      if (needle && await this.writer.verifyContains(logicalDate, needle)) {
        // 已经在里面了: 上次其实写成了, 只是 written 事件没落盘(在 5 和 written 之间崩溃)
        await this.journal.append({
          type: EV.SKIPPED, eventId: ev.eventId, seqKey: ev.seqKey, botId: ev.botId,
          logicalDate, status: "skipped", reason: "内容已在笔记中(幂等)",
        });
        skipped += 1;
        details.push({ eventId: ev.eventId, result: "already-present" });
        continue;
      }
      try {
        // 直接走 writer.writeText 而不是 agent: 重放不该再触发意图识别 ——
        // 一条"撤回"被重放两次会删掉两条记录。流水里的 text 是【已被判定为记录】的内容才走到这里,
        // 命令类消息不产生 Daily Note 变更, 因此不会出现在 pending 里(它们的 written 事件正常落盘)。
        const res = await this.writer.writeText(ev.text, isVoice, logicalDate);
        await this.journal.append({
          type: EV.REPLAYED, eventId: ev.eventId, seqKey: ev.seqKey, botId: ev.botId,
          logicalDate, status: "replayed", targetPath: res.path, count: res.n,
        });
        replayed += 1;
        details.push({ eventId: ev.eventId, result: "replayed", n: res.n });
      } catch (e) {
        await this.journal.append({
          type: EV.FAILED, eventId: ev.eventId, seqKey: ev.seqKey, botId: ev.botId,
          logicalDate, status: "failed", error: "重放失败: " + String(e.message).slice(0, 400),
        });
        failed += 1;
        details.push({ eventId: ev.eventId, result: "failed", error: e.message });
      }
    }
    logger.info("重放完成: 补写 " + replayed + ", 跳过 " + skipped + ", 失败 " + failed);
    return { date: logicalDate, pending: pending.length, replayed, skipped, failed, details };
  }

  // 启动时的自动补写: 只看今天和昨天(更早的由用户显式 replay --date)
  async replayPending() {
    const today = this.I.logicalTodayStr();
    const yest = this.I.yesterdayStr();
    const out = [];
    for (const d of [yest, today]) {
      const r = await this.replayDate(d);
      if (r.pending) out.push(r);
    }
    return out;
  }

  // ── 状态 ──
  _isPaused() {
    const p = this.ilink.pauseUntil;
    return Boolean(p && Date.now() < p);
  }
  _skipBacklog() { return !!this.ilink.skipBacklog; }

  async _clearSkipBacklog() {
    if (!this._skipBacklog()) return;
    this.ilink.skipBacklog = false;
    const n = this._skippedCount || 0;
    this._skippedCount = 0;
    await this.stateStore.save();
    logger.info("已追平服务端积压" + (n ? "(跳过 " + n + " 条历史消息)" : "") + ", 开始正常记录");
  }

  _interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const cancel = () => { clearTimeout(t); this._sleepCancels.delete(cancel); resolve(); };
      const t = setTimeout(() => { this._sleepCancels.delete(cancel); resolve(); }, ms);
      this._sleepCancels.add(cancel);
    });
  }

  // ── 优雅退出: 保存游标并退出(第四章要求)──────────────────────────────
  // 幂等且可 await: 并发调用返回同一个 promise, 大家一起等到真正落盘完成。
  // (早期版本这里是 `if (this._stopping) return;` —— 第二个调用者立刻拿到已 resolve 的
  //  promise, 于是外层 process.exit 抢在落盘之前跑掉了。)
  shutdown(signal) {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shutdownPromise = this._doShutdown(signal);
    return this._shutdownPromise;
  }

  async _doShutdown(signal) {
    this._stopping = true;
    this._running = false;
    logger.info("收到 " + signal + ", 正在保存状态并退出…");
    for (const c of [...this._sleepCancels]) c();
    if (this.client) {
      try { this.client.notify("notifystop"); } catch (e) {}
      // 给 notifystop 半秒发出去, 再掐断在途连接(35s 的长轮询不等它自然结束)
      await sleep(500);
      try { this.client.destroyAll(); } catch (e) {}
      this.client = null;
    }
    if (this.stateStore) {
      this.ilink.lastAliveTs = Date.now();
      try { await this.stateStore.save(); }
      catch (e) { this.stateStore.saveSync(); }   // 异步失败就同步再来一次: 游标不能丢
    }
    if (this.plugin && this.plugin._teardownHostRegistrations) this.plugin._teardownHostRegistrations();
    logger.info("状态已落盘, 退出。统计: " + JSON.stringify(this._stats));
  }

  async status() {
    const today = this.I.logicalTodayStr();
    const dates = await this.journal.listDates();
    const todaySummary = await this.journal.summary(today);
    return {
      vaultPath: this.config.vaultPath,
      todayNote: this.writer.diaryPath(today),
      logicalDate: today,
      heading: "## " + this.plugin.writer._heading(),
      managedSection: this.plugin.writer._managed(),
      bound: !!this.credentials.botToken,
      userId: maskId(this.ilink.userId),
      botId: maskId(this.ilink.botId),
      cursorLength: (this.ilink.buf || "").length,
      recentSeqs: this.ilink.recentSeqs.length,
      skipBacklog: this._skipBacklog(),
      paused: this._isPaused(),
      pauseUntil: this.ilink.pauseUntil ? new Date(this.ilink.pauseUntil).toISOString() : null,
      lastAlive: this.ilink.lastAliveTs ? new Date(this.ilink.lastAliveTs).toISOString() : null,
      recoveredFromCorruption: this.stateStore.recoveredFromCorruption,
      messagesToday: await this.writer.countDay(today).catch(() => null),
      journalDates: dates.length,
      journalToday: todaySummary,
      stats: this._stats,
    };
  }
}

module.exports = { WeChatDiaryService };

// 直接 node src/service.js 就是启动服务
if (require.main === module) {
  (async () => {
    const svc = new WeChatDiaryService({});
    // 退出必须【只有一条路】: shutdown() 完成后才 process.exit。
    // 踩过的坑: 信号处理器里调 shutdown(), 同时 run() 的 while 循环也因 _running=false 返回,
    // 外层紧跟着 process.exit(0) —— 结果 shutdown 的 await save() 还没落盘进程就没了,
    // 游标丢一次(实测: "状态已落盘"那行日志压根没打出来, state.json 的 mtime 也没变)。
    let exiting = null;
    const exitVia = (sig, code) => {
      if (exiting) return exiting;
      exiting = svc.shutdown(sig).then(
        () => process.exit(code || 0),
        (e) => { logger.error("退出时出错:", e.message); process.exit(1); }
      );
      return exiting;
    };
    process.on("SIGINT", () => exitVia("SIGINT", 0));
    process.on("SIGTERM", () => exitVia("SIGTERM", 0));
    process.on("unhandledRejection", (e) => logger.error("未处理的 Promise 拒绝:", e && e.message));
    try {
      await svc.init();
      await svc.run();
      // run() 自然返回(循环被 _running=false 停下)。若是信号触发的, exitVia 已在跑,
      // await 它以确保落盘完成; 否则自己走一遍退出流程。
      await exitVia("normal", 0);
    } catch (e) {
      logger.error("服务启动失败:", e.message);
      // 配置类错误用 78(EX_CONFIG): run.sh 不会重启它 —— 人不去修配置, 重启是徒劳
      process.exit(e.exitCode || (e.configErrors ? 78 : 1));
    }
  })();
}
