"use strict";

// The standalone service can append compact lists without owning a note section.
// Counts come from successful journal events, never from handwritten list items.
function compactBody(block) {
  return String(block).replace(/\r\n?/g, "\n").trim()
    .replace(/\n\s*\n+/g, "\n")
    .replace(/!\[\[([^\]\n]+)\]\]/g, (link, target) => {
      if (/\.(jpg|jpeg|png|gif|webp|bmp|heic|avif|wav|mp3|ogg|m4a|mp4|mov|webm)$/i.test(target)) return link;
      return "[[" + target + "|" + target.split("/").pop() + "]]";
    }).split("\n").map((line, i) => (i ? "  " : "") + line).join("\n");
}

function appendEntry(content, heading, entry, internals) {
  const loc = internals.locateSection(content, heading);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  entry = entry.replace(/\n/g, eol);
  if (!loc) {
    const separator = !content || content.endsWith(eol) ? "" : eol;
    return content + separator + "## " + heading + eol + entry + eol;
  }
  // Insert before the existing blank separator; keep every existing byte.
  const body = content.slice(loc.bodyStart, loc.bodyEnd);
  const nonblank = body.match(/[\s\S]*\S[ \t]*(?:\r?\n)?/);
  const at = loc.bodyStart + (nonblank ? nonblank[0].length : 0);
  const prefix = content.slice(0, at);
  const separator = prefix.endsWith(eol) ? "" : eol;
  return prefix + separator + entry + eol + content.slice(at);
}

function enableAppendOnly(plugin, internals, journal) {
  const writer = plugin.writer;
  const counts = new Map();
  let lastDay = internals.logicalTodayStr();
  plugin.settings.managedSection = false;

  async function countDay(day) {
    day = day || internals.logicalTodayStr();
    if (!counts.has(day)) {
      const { events } = await journal.read(day);
      const count = events.reduce((n, ev) =>
        ["written", "replayed"].includes(ev.type) && Number.isInteger(ev.count)
          ? Math.max(n, ev.count) : n, 0);
      counts.set(day, count);
    }
    return counts.get(day);
  }

  const appendBlock = async function (day, timestamp, block) {
    const beforeCount = await countDay(day);
    block = internals.escapeFenceLines(internals.escapeHeadingLines(block));
    const entry = "- " + timestamp + " " + compactBody(block);
    const vault = plugin.app.vault;
    const note = writer.diaryPath(day);
    let file = vault.getFileByPath(note);
    if (!file) {
      await writer._ensureParents(note);
      try { await writer._createDayFile(day, ""); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      file = vault.getFileByPath(note);
      if (!file) throw new Error("Daily Note was not created: " + note);
    }
    const expected = await vault.process(file, content => appendEntry(content, writer._heading(), entry, internals));
    const written = await vault.cachedRead(file);
    if (written !== expected) {
      throw new Error("Append-only entry did not survive the write verification");
    }
    counts.set(day, beforeCount + 1);
    lastDay = day;
    return entry;
  };
  writer._appendBlock = async (...args) => {
    try { return await appendBlock(...args); }
    catch (error) { writer.appendOnlyError = error; throw error; }
  };
  writer._count = () => counts.get(lastDay) || 0;
  writer.countDay = countDay;
  writer.undoLastBlock = async () => ({ ok: false, disabled: true });
  writer.finalizeDay = async () => ({ status: "disabled", n: 0 });

  const write = writer.write.bind(writer);
  writer.write = async (...args) => {
    const result = await write(...args);
    if (!result.n) throw new Error("Append-only Daily Note write failed: " + result.reply);
    if (result.n) result.reply = "记下来啦 ✍️";
    result.sealed = false;
    return result;
  };
  for (const method of ["writeImage", "writeAttachment", "appendLinkBlock"]) {
    const original = writer[method].bind(writer);
    writer[method] = async (...args) => {
      const result = await original(...args);
      if (!result.n) {
        const error = new Error("Append-only media write failed: " + method);
        writer.appendOnlyError = error;
        throw error;
      }
      result.sealed = false;
      return result;
    };
  }
  const onMessage = plugin.agent.onMessage.bind(plugin.agent);
  plugin.agent.onMessage = async (from, text, ...args) => {
    writer.appendOnlyError = null;
    const detected = internals.detectIntent(text || "");
    const intent = detected.intent;
    if (intent === internals.INTENT.UNDO || intent === internals.INTENT.FINALIZE) {
      return "当前仅追加记录，撤回和封存已停用；如需修改，请直接编辑 Obsidian 笔记。";
    }
    if (intent === internals.INTENT.HELP) {
      return "直接发送文字、语音、图片或附件，会追加到今天的日常记录。多行文字使用缩进续行。撤回和封存已停用。";
    }
    if (intent === internals.INTENT.START_DIARY && !detected.suspect) return "直接发就行，我会继续追加记录 ✍️";
    const reply = await onMessage(from, text, ...args);
    // Existing media replies may decorate a first entry with legacy undo tips.
    return typeof reply === "string" ? reply.split("\n").filter(line =>
      !line.includes("说错了发「撤回」") && !(line.includes("晚安") && line.includes("收尾"))).join("\n") : reply;
  };
}

module.exports = { compactBody, appendEntry, enableAppendOnly };
