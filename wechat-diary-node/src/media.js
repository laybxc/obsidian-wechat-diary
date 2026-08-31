"use strict";
// 媒体处理适配层。
//
// 下载/解密/格式识别全部复用 main.js:
//   downloadMedia(item, requireKey) — CDN URL 拼装、302 跟随、100MB 上限、AES-128-ECB
//   parseImageAesKey               — aeskey(hex) 与 media.aes_key(两种 base64 编码)分流
//   sniffImageExt / sniffAudioExt  — magic bytes 识别, 兼职解密校验
//   silkToWav / pcmToWav           — 微信语音 SILK v3 → 可播 WAV(内嵌 silk-wasm)
//   md5Hex                         — 解密校验 + 重复文件复用(绕微信 #193 重复密钥坑)
//
// 这一层只做两件事:
//   ① 给事件流水提供【不含凭据】的媒体元数据 —— aeskey/full_url/encrypt_query_param
//      都是能拿去下载别人内容的凭据, 绝不进 NDJSON, 也绝不进日志
//   ② 附件路径落点: 服务端要求"附件跟随笔记, 放当天笔记目录下的 assets"。
//      这由 plugin-host 的 fileManager + attachmentMode=obsidian 实现, 这里只做断言与说明。

const logger = require("./logger");

// 从 item 里抽出可安全记录的元数据。
// 白名单式(只取列出的字段), 不是黑名单式 —— 协议加了新字段也不会意外泄露密钥。
function mediaMeta(item, kind) {
  const it = item || {};
  const media = it.media || {};
  const out = { kind };
  // 尺寸/时长/文件名/md5: 诊断与去重需要, 都不是凭据
  if (it.file_name != null) out.fileName = String(it.file_name).slice(0, 200);
  if (it.md5 != null) out.md5 = String(it.md5).toLowerCase();
  if (it.video_md5 != null) out.videoMd5 = String(it.video_md5).toLowerCase();
  if (it.len != null) out.len = Number(it.len) || 0;
  if (it.video_size != null) out.videoSize = Number(it.video_size) || 0;
  if (it.encode_type != null) out.encodeType = it.encode_type;
  if (it.voice_time != null) out.voiceTimeMs = Number(it.voice_time) || 0;
  if (media.size != null) out.mediaSize = Number(media.size) || 0;
  // 有没有下载地址/密钥: 只记布尔, 不记内容 —— 排障要知道"是不是缺 key", 但不需要 key 本身
  out.hasUrl = !!(media.full_url || media.encrypt_query_param);
  out.hasKey = !!(it.aeskey || media.aes_key);
  return out;
}

// 一条消息的媒体清单摘要(给事件流水)
function mediaSummary({ images, voices, files, videos, voiceAudio }) {
  const out = [];
  for (const x of images || []) out.push(mediaMeta(x, "image"));
  for (const x of voices || []) out.push(mediaMeta(x, "voice"));
  for (const x of files || []) out.push(mediaMeta(x, "file"));
  for (const x of videos || []) out.push(mediaMeta(x, "video"));
  if (voiceAudio) out.push(mediaMeta(voiceAudio, "voiceAudio"));
  return out.length ? out : null;
}

// 消息类型标签(事件流水的 msgType)
function classifyMessage({ hasText, hasVoice, images, voices, files, videos }) {
  const kinds = [];
  if (hasText && !hasVoice) kinds.push("text");
  if (hasVoice) kinds.push("voice");
  if (images && images.length) kinds.push("image");
  if (files && files.length) kinds.push("file");
  if (videos && videos.length) kinds.push("video");
  if (!kinds.length) return "unknown";
  return kinds.length === 1 ? kinds[0] : "mixed";
}

// 附件落点自检: 确认 fileManager 真的把附件算到笔记旁的 assets/。
// 在 doctor 里跑, 免得配置写错却要等到第一张图才发现。
async function probeAttachmentPath(plugin, logicalDate) {
  const notePath = plugin.writer.diaryPath(logicalDate);
  const fm = plugin.app.fileManager;
  if (!fm || typeof fm.getAvailablePathForAttachment !== "function") {
    return { ok: false, reason: "app.fileManager 缺失" };
  }
  const resolved = await fm.getAvailablePathForAttachment("测试.jpg", notePath);
  const expectedDir = notePath.split("/").slice(0, -1).concat("assets").join("/");
  const ok = String(resolved || "").startsWith(expectedDir + "/");
  return { ok, resolved, expectedDir, notePath };
}

module.exports = { mediaMeta, mediaSummary, classifyMessage, probeAttachmentPath };
