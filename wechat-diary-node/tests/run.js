"use strict";
// 统一测试入口: 先跑上游的 581 项, 再跑 standalone 的集成测试。
//
// 顺序是刻意的。上游那 581 项盯的是 Daily Note 的字节契约与协议纯函数, 服务端【原样复用】
// 那些代码, 所以它们同时也是服务端的回归网 —— 一旦上游测试挂了, 说明 main.js 被改动过,
// 服务端与 Mac 版的数据契约已经漂移, 此时再看集成测试的结果没有意义。

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const UPSTREAM = path.resolve(ROOT, "..", "tests", "bindtest.js");
const STANDALONE = path.join(__dirname, "standalone.test.js");

function run(label, file) {
  return new Promise((resolve) => {
    console.log("\n" + "═".repeat(60));
    console.log("  " + label);
    console.log("═".repeat(60));
    const p = spawn(process.execPath, [file], { stdio: "inherit" });
    p.on("close", (code) => resolve({ label, code }));
  });
}

(async () => {
  const results = [];
  results.push(await run("上游插件测试 (tests/bindtest.js) —— 字节契约与协议纯函数", UPSTREAM));
  results.push(await run("standalone 集成测试 —— 宿主适配层/流水/并发/信号", STANDALONE));
  results.push(await run("append-only 格式与手写保护测试", path.join(__dirname, "append-only.test.js")));

  console.log("\n" + "═".repeat(60));
  console.log("  汇总");
  console.log("═".repeat(60));
  let bad = 0;
  for (const r of results) {
    console.log((r.code === 0 ? "  ✓ " : "  ✗ ") + r.label + (r.code === 0 ? "" : "  (exit " + r.code + ")"));
    if (r.code !== 0) bad++;
  }
  console.log(bad === 0 ? "\n全部通过 ✅" : "\n有 " + bad + " 个套件失败 ❌");
  process.exit(bad === 0 ? 0 : 1);
})();
