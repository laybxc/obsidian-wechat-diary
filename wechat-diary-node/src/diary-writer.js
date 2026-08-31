"use strict";
// Daily Note 写入适配层。
//
// 写入的字节语义全部由 main.js 的 DiaryWriter 负责(段头合并、managed 边界、封存、
// 计数、撤回、附件 wikilink), 与 Mac 版共用。这一层在它外面加两圈保险, 对应第六章:
//
//   ① 写后校验(verifyAfterWrite): 写完重新【从磁盘】读一遍, 确认这条消息真的在
//      「## 日常记录」的 managed 正文里。ob 同步或 Mac 编辑器可能在写入与确认之间
//      把文件换掉; 没校验就回微信"记下来啦"是在撒谎。
//   ② 失败不确认: 校验不过 → 抛错 → service.js 记 failed 事件 → 回微信明确的失败提示。
//      事件流水保留, 可 replay。
//
// 另外提供 verifyContains(): 给 replay 用的"这条是不是已经在里面了"判断, 避免重复写入。

const logger = require("./logger");

class DiaryWriterAdapter {
  // plugin: main.js 的 WechatDiaryPlugin 实例(已 onload)
  // internals: main.js 的 __internals(拿纯函数)
  constructor(plugin, internals, opts) {
    this.plugin = plugin;
    this.writer = plugin.writer;
    this.I = internals;
    this.verifyAfterWrite = !(opts && opts.verifyAfterWrite === false);
  }

  // 当天笔记的 vault 相对路径
  diaryPath(logicalDate) { return this.writer.diaryPath(logicalDate); }

  logicalToday() { return this.I.logicalTodayStr(); }

  // 读出 managed 正文(即"插件那部分"), 文件/节不存在返回 null。
  // 这是所有校验的基准: 用户手写的部分不在里面, 所以校验永远不会把手写内容误当成微信记录。
  async readManagedBody(logicalDate) {
    const path = this.diaryPath(logicalDate);
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!file) return null;
    const content = await this.plugin.app.vault.cachedRead(file);
    const heading = this.writer._heading();
    const loc = this.writer._managed()
      ? this.I.locateManagedBody(content, heading)
      : this.I.locateSection(content, heading);
    if (!loc) return null;
    return this.I.normalizeNewlines(content.slice(loc.bodyStart, loc.bodyEnd));
  }

  // 这段文本是否已在 managed 正文里(重放幂等判断)
  async verifyContains(logicalDate, needle) {
    const body = await this.readManagedBody(logicalDate);
    if (body == null) return false;
    return body.includes(String(needle).trim());
  }

  // 写一条文本。返回 { reply, n, sealed, path, verified }。
  // 失败抛错(而不是返回失败态): 调用方必须显式处理"没写成"这件事。
  async writeText(text, isVoice, logicalDate) {
    const day = logicalDate || this.logicalToday();
    const res = await this.writer.write(text, isVoice, day);
    if (!res.n) {
      // main.js 的 write() 内部吞了异常并给出失败回执 —— 这里把它升级成异常,
      // 好让 service.js 走 failed 事件而不是把失败文案当成功回执发出去
      const err = new Error("Daily Note 写入失败: " + res.reply);
      err.userReply = res.reply;
      throw err;
    }
    const verified = await this._verify(day, text, isVoice);
    return { reply: res.reply, n: res.n, sealed: !!res.sealed, path: this.diaryPath(day), verified };
  }

  // 写后校验: 重读磁盘, 确认内容在 managed 正文里。
  // 校验用的 needle 与 main.js 落库时的清洗规则一致(空行收敛 + trim + 语音前缀),
  // 否则多行消息会因为空行归一化而"找不到自己"。
  async _verify(day, text, isVoice) {
    if (!this.verifyAfterWrite) return null;
    const cleaned = this._needleFor(text, isVoice);
    if (!cleaned) return null;
    const ok = await this.verifyContains(day, cleaned);
    if (!ok) {
      const err = new Error("写入校验失败: 重读文件后在「" + this.writer._heading() + "」里找不到刚写的内容(可能被同步或其它编辑端覆盖)");
      err.verifyFailed = true;
      throw err;
    }
    return true;
  }

  // 复刻 main.js write() 的清洗: \r\n → \n, 空行收敛, trim, 语音加 🎤, 首行冲突转义。
  // 这段逻辑与 main.js 重复是【必要的】: 校验必须知道落库后的确切形态。
  // 它不参与写入, 只参与查找 —— 即使某天两边细节漂移, 后果是"校验偏保守"而不是写错。
  _needleFor(text, isVoice) {
    const NORMALIZE_BLANK_RE = /\n\s*\n+/g;
    let s = String(text || "").trim();
    if (!s) return "";
    s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(NORMALIZE_BLANK_RE, "\n").trim();
    if (isVoice) s = "🎤 " + s;
    else if (s.startsWith("# ") || s.startsWith("---") || s.startsWith("_(")) s = "\\" + s;
    // 共用模式还会对块内的 #/``` 行加转义(escapeHeadingLines/escapeFenceLines)
    if (this.writer._shared()) s = this.I.escapeFenceLines(this.I.escapeHeadingLines(s));
    return s;
  }

  // 计数: 只数微信记录(managed 正文里的块), 用户手写内容不计入
  async countDay(logicalDate) {
    return this.writer.countDay(logicalDate || this.logicalToday());
  }

  // 撤回最后一条微信记录。手写内容不在 managed 正文里, 撤不到。
  async undoLast(logicalDate) {
    return this.writer.undoLastBlock(logicalDate || this.logicalToday());
  }

  // 封存
  async finalize(logicalDate) {
    return this.writer.finalizeDay(logicalDate || this.logicalToday());
  }
}

module.exports = { DiaryWriterAdapter };
