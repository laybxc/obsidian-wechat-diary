"use strict";
// 文件系统版 Vault: 把 Obsidian 的 vault API 换成本地 fs, 语义逐条对齐。
//
// 为什么是"替换宿主"而不是"重写写入逻辑":
//   Daily Note 的字节级契约(段头合并、managed 边界、封存行、计数、撤回)全都长在 main.js 里,
//   由上游 581 项测试盯着。复制一份等于制造第二个真相源, 迟早与 Mac 版漂移。
//   所以这里只提供 main.js 需要的那 12 个 vault 方法, 让同一份代码跑在服务器上。
//
// 三个与 Obsidian 不同、必须自己兜住的点(第六章并发要求):
//   ① process() 每次都从磁盘重读最新内容 —— ob 同步或 Mac 可能刚改过这个文件
//   ② 写入走 lockfile + 临时文件 + rename, 崩溃不留半截文件
//   ③ 只改 fn 返回的字节; 节外内容由 main.js 保证, 这里绝不自己"顺手格式化"

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const logger = require("./logger");

// ── 路径工具 ────────────────────────────────────────────────────────────
// Obsidian 的 normalizePath: 统一斜杠、去首尾斜杠、折叠重复斜杠。
// vault 内相对路径一律用 "/" 分隔(即使在 Windows), 这是 wikilink 的书写形式。
function normalizePath(p) {
  let s = String(p == null ? "" : p).split("\\").join("/");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  // NFC: macOS 上创建的文件名是 NFD, 与 Linux 侧的 NFC 字符串比较会不相等 ——
  // Mac 建的「日常记录」目录在服务器上查不到就会重复建文件。统一到 NFC。
  try { s = s.normalize("NFC"); } catch (e) { /* 非法代理对: 原样 */ }
  return s;
}

// vault 内相对路径 → 绝对路径, 并挡住越界(.. 逃出 vault)
function resolveInVault(vaultRoot, rel) {
  const clean = normalizePath(rel);
  const abs = path.resolve(vaultRoot, clean);
  const rootWithSep = vaultRoot.endsWith(path.sep) ? vaultRoot : vaultRoot + path.sep;
  if (abs !== vaultRoot && !abs.startsWith(rootWithSep)) {
    throw new Error("路径越出 vault: " + rel);
  }
  return abs;
}

// ── 文件/文件夹句柄(TFile / TFolder 的最小形态)────────────────────────
class TFile {
  constructor(vaultPath, stat) {
    this.path = vaultPath;
    this.name = vaultPath.split("/").pop();
    this.extension = (this.name.includes(".") ? this.name.split(".").pop() : "");
    this.basename = this.name.replace(/\.[^.]*$/, "");
    this.stat = stat || null;
  }
}
class TFolder {
  constructor(vaultPath) {
    this.path = vaultPath;
    this.name = vaultPath.split("/").pop() || vaultPath;
    this.children = [];
  }
}

// ── 文件锁 ──────────────────────────────────────────────────────────────
// 同一台机器上可能有: 服务本体、replay 命令、dry-run。锁必须跨进程。
// 用 O_EXCL 建 <file>.lock —— POSIX 下原子, 不需要额外依赖。
// 锁里写 pid+时间戳: 服务被 kill -9 留下的死锁能被下一个进程识别并接管。
const LOCK_STALE_MS = 60000;

async function acquireLock(absPath, timeoutMs) {
  const lockPath = absPath + ".wechat-diary.lock";
  const deadline = Date.now() + (timeoutMs || 15000);
  let warned = false;
  for (;;) {
    try {
      const fh = await fsp.open(lockPath, "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
        await fh.sync();
      } finally {
        await fh.close();
      }
      return {
        path: lockPath,
        async release() {
          try { await fsp.unlink(lockPath); } catch (e) { /* 已被接管 */ }
        },
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 已有锁: 看是不是死锁
      let stale = false;
      try {
        const st = await fsp.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
      } catch (e2) {
        continue; // 锁刚被释放, 立刻重试
      }
      if (stale) {
        logger.warn("接管超时的文件锁(上一个持有者可能被强杀):", lockPath);
        try { await fsp.unlink(lockPath); } catch (e2) { /* 竞争: 下一轮再抢 */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("等锁超时(" + (timeoutMs || 15000) + "ms), 另一个进程正在写 " + path.basename(absPath));
      }
      if (!warned) { warned = true; logger.debug("等待文件锁:", path.basename(absPath)); }
      await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
    }
  }
}

// ── 原子写 ──────────────────────────────────────────────────────────────
// 临时文件同目录(跨设备 rename 会失败) → fsync 内容 → rename → fsync 目录。
// 目录 fsync 是"rename 本身也要持久"的那一步: 少了它, 掉电后可能文件内容在、目录项还是旧的。
async function atomicWrite(absPath, data) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, "." + path.basename(absPath) + ".tmp." + process.pid + "." + Date.now());
  let fh;
  try {
    fh = await fsp.open(tmp, "wx", 0o644);
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    if (fh) await fh.close();
  }
  await fsp.rename(tmp, absPath);
  // 目录项持久化: 失败不致命(内容已在), 只记一笔
  let dh;
  try {
    dh = await fsp.open(dir, "r");
    await dh.sync();
  } catch (e) {
    logger.debug("目录 fsync 跳过:", e.code || e.message);
  } finally {
    if (dh) await dh.close().catch(() => {});
  }
}

// ── Vault ───────────────────────────────────────────────────────────────
class FsVault {
  constructor(vaultRoot, opts) {
    this.root = path.resolve(vaultRoot);
    this.lockTimeoutMs = (opts && opts.lockTimeoutMs) || 15000;
    // 本进程串行化: 同一文件的并发 process 在进程内先排队, 再去抢跨进程锁。
    // 少了它, 同一批消息的连续写入会互相等 lockfile, 白白抖动。
    this._chains = new Map();
  }

  _abs(p) { return resolveInVault(this.root, p); }

  // ── 查询 ──
  getFileByPath(p) {
    const rel = normalizePath(p);
    try {
      const st = fs.statSync(this._abs(rel));
      if (!st.isFile()) return null;
      return new TFile(rel, { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
    } catch (e) { return null; }
  }

  getFolderByPath(p) {
    const rel = normalizePath(p);
    if (rel === "") return new TFolder("");
    try {
      const st = fs.statSync(this._abs(rel));
      return st.isDirectory() ? new TFolder(rel) : null;
    } catch (e) { return null; }
  }

  // Obsidian 语义: 文件或文件夹都返回
  getAbstractFileByPath(p) {
    return this.getFileByPath(p) || this.getFolderByPath(p);
  }

  // ── 读 ──
  // Obsidian 的 cachedRead 走内存缓存; 服务端故意每次读磁盘 ——
  // ob 同步/Mac 编辑随时可能改文件, 缓存在这里只会带来"读到旧内容然后覆盖"的风险。
  async cachedRead(file) {
    return fsp.readFile(this._abs(file.path), "utf8");
  }
  async read(file) { return this.cachedRead(file); }
  async readBinary(file) {
    const buf = await fsp.readFile(this._abs(file.path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  // ── 写 ──
  // create: 文件已存在必须抛错(main.js 的 TOCTOU 分支依赖这个语义 → 转走 process)
  async create(p, content) {
    const rel = normalizePath(p);
    const abs = this._abs(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    let fh;
    try {
      fh = await fsp.open(abs, "wx", 0o644);   // wx = O_CREAT|O_EXCL, 已存在则 EEXIST
      await fh.writeFile(String(content));
      await fh.sync();
    } finally {
      if (fh) await fh.close();
    }
    return new TFile(rel, null);
  }

  async createBinary(p, arrayBuffer) {
    const rel = normalizePath(p);
    const abs = this._abs(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const buf = Buffer.isBuffer(arrayBuffer) ? arrayBuffer : Buffer.from(arrayBuffer);
    let fh;
    try {
      fh = await fsp.open(abs, "wx", 0o644);
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      if (fh) await fh.close();
    }
    return new TFile(rel, null);
  }

  async createFolder(p) {
    const rel = normalizePath(p);
    await fsp.mkdir(this._abs(rel), { recursive: true });
    return new TFolder(rel);
  }

  // process(file, fn): 原子读-改-写。这是整个服务的写入咽喉。
  //   1. 进程内排队(同一路径)
  //   2. 跨进程 lockfile
  //   3. 拿到锁后【重读磁盘】—— 保证 fn 看到的是 ob/Mac 改完之后的最新字节
  //   4. fn 返回新全文; 与旧内容相同则不写(不惊动同步盘的 mtime)
  //   5. 临时文件 + fsync + rename
  // 返回 fn 的结果字符串(与 Obsidian 的 process 一致)。
  async process(file, fn) {
    const rel = normalizePath(file.path);
    const prev = this._chains.get(rel) || Promise.resolve();
    const run = prev.then(() => this._processLocked(rel, fn));
    // 链上存的是"轮到下一个了"的信号, 吞掉异常: 否则一次写入失败会毒死这个文件后续所有写入
    const gate = run.then(() => {}, () => {});
    this._chains.set(rel, gate);
    // 队列排空后清理 Map, 避免长期运行下无限增长(每天一个新文件名)
    gate.then(() => { if (this._chains.get(rel) === gate) this._chains.delete(rel); });
    return run;
  }

  async _processLocked(rel, fn) {
    const abs = this._abs(rel);
    const lock = await acquireLock(abs, this.lockTimeoutMs);
    try {
      let before;
      try {
        before = await fsp.readFile(abs, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        before = "";     // 文件在拿锁期间被删: 按空内容处理, fn 会重建
      }
      const after = fn(before);
      const out = after == null ? "" : String(after);
      if (out === before) return out;   // 无变化: 一个字节都不写
      await atomicWrite(abs, out);
      return out;
    } finally {
      await lock.release();
    }
  }

  async modify(file, content) {
    return this.process(file, () => content);
  }

  async delete(file) { await fsp.unlink(this._abs(file.path)); }
  async trash(file) { return this.delete(file); }

  // ── 枚举(设置页的文件夹建议用; 服务端只有 doctor 会用到)──
  getAllFolders(includeRoot) {
    const out = includeRoot ? [new TFolder("")] : [];
    const walk = (relDir) => {
      let ents;
      try { ents = fs.readdirSync(this._abs(relDir) || this.root, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name === ".git" || ent.name === ".obsidian" || ent.name === ".trash") continue;
        const rel = relDir ? relDir + "/" + ent.name : ent.name;
        out.push(new TFolder(rel));
        walk(rel);
      }
    };
    walk("");
    return out;
  }

  getMarkdownFiles() {
    const out = [];
    const walk = (relDir) => {
      let ents;
      try { ents = fs.readdirSync(relDir ? this._abs(relDir) : this.root, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of ents) {
        const rel = relDir ? relDir + "/" + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (ent.name === ".git" || ent.name === ".obsidian" || ent.name === ".trash") continue;
          walk(rel);
        } else if (ent.name.endsWith(".md")) {
          out.push(new TFile(rel, null));
        }
      }
    };
    walk("");
    return out;
  }

  getAllLoadedFiles() { return [...this.getAllFolders(true), ...this.getMarkdownFiles()]; }

  // 无头环境没有 app:// 协议, 给 file:// 便于日志排查(语音气泡渲染不在服务端跑)
  getResourcePath(file) { return "file://" + this._abs(file.path); }
}

module.exports = { FsVault, TFile, TFolder, normalizePath, resolveInVault, atomicWrite, acquireLock };
