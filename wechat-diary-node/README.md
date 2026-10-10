# WeChat Diary — 独立 Node.js 服务

把微信消息写进服务器本地 Obsidian vault 的常驻服务。不依赖 Obsidian 运行，
由官方 `ob`（Obsidian Headless）负责把 vault 同步到其它设备。

```
微信 → 腾讯 iLink 长轮询 → 本服务(tmux 常驻) → 服务器本地 Vault → ob Headless Sync → Mac/手机
```

## 核心设计: 复用而非重写

这个服务**不重新实现**协议与写入逻辑。它拦截 `require("obsidian")`，把宿主 API 换成
本地文件系统，然后加载**未经修改的 `../main.js`**。

```
src/obsidian-shim.js   ← require("obsidian") 指到这里
src/vault.js           ← Vault API → fs (原子写 + 跨进程文件锁)
src/plugin-host.js     ← 组装 app 对象, 把 loadData/saveData 接到 state-store
        ↓
    ../main.js         ← 一个字节都没改
```

这样做的理由很具体：Daily Note 的字节契约（段头合并、`managed` 边界、封存行、计数、
撤回规则）和腾讯 iLink 协议细节都长在 `main.js` 里，由上游 **581 项测试**盯着。
复制一份到服务端就等于制造第二个真相源，迟早与 Mac 版漂移，届时两边写出的日记格式会断层。

验证：`git diff 1b74f23 -- main.js` 为空。

## 快速开始

```bash
# 1. 配置
mkdir -p ~/.config/wechat-diary
cp config.example.json ~/.config/wechat-diary/config.json
chmod 700 ~/.config/wechat-diary
vim ~/.config/wechat-diary/config.json      # 至少要填 vaultPath

# 2. 自检(不联网, 不写日记)
node src/cli.js doctor

# 3. 扫码绑定
node src/cli.js bind

# 4. 启动
tmux new-session -d -s wechat-diary './run.sh 2>&1 | tee -a logs/service.log'
```

## 命令

### 紧凑列表与仅追加模式

在服务配置的 `service` 中设置 `"appendOnly": true`，微信内容会追加为紧凑列表：

```markdown
- 16:22 记录一下今天
- 16:23 多行消息第一行
  第二行
- 16:24 ![[assets/图片.jpg]]
- 16:25 [[assets/报告.pdf|报告.pdf]]
```

新条目紧跟已有条目，不在条目之间添加空行，也不写入 `wechat-diary:managed` 标记。语音文字保留 `🎤` 前缀；保留原声时，音频链接与缩进转写文字属于同一条记录。图片、音频和视频使用嵌入链接，普通附件使用文件链接。

该模式停用撤回和封存，相关命令会说明已停用。写入过程只插入新内容，保留手写条目、已有空白和后续章节；计数使用已有事件流水中的成功写入计数，不解析手写列表。正常消息仍按微信序号去重。若笔记已写入而成功流水尚未落盘就崩溃，补写可能出现重复；补写会保留这条消息，不会根据相同的手写文字跳过。原有的标记模式默认配置与测试继续保留。

| 命令 | 说明 |
|---|---|
| `node src/cli.js doctor` | 环境/配置/权限/路径/附件落点/ob 自检 |
| `node src/cli.js bind` | 终端扫码绑定（ASCII 二维码，`--force` 强制重绑） |
| `node src/cli.js claim <userId>` | 待认领时确认主人身份 |
| `node src/cli.js status` | 运行状态 JSON（游标长度、去重表、今日流水与段数） |
| `node src/cli.js replay --date 2026-08-31` | 按事件流水补写没写成的消息（`--all` 全部日期） |
| `node src/cli.js dry-run` | 连真实微信长轮询，但不落库、不回消息 |
| `node src/cli.js print-config` | 打印生效配置（凭据一律脱敏） |
| `node src/cli.js unbind --yes` | 清除本机凭据与身份（危险） |

## tmux 运行

```bash
# 启动
tmux new-session -d -s wechat-diary './run.sh 2>&1 | tee -a logs/service.log'

# 查看
tmux attach -t wechat-diary          # Ctrl-B D 脱离
tmux ls
tail -f logs/service.log

# 停止(优雅: 会保存游标)
tmux send-keys -t wechat-diary C-c
# 或
pkill -TERM -f 'node src/service.js'

# 彻底关掉 session
tmux kill-session -t wechat-diary
```

`run.sh` 的重启策略：异常退出等 **5 秒**起步，反复起步就崩则退避到最长 60 秒；
`exit 0` / SIGINT / SIGTERM 一律**不重启**（那是人为停的）。启动前先跑一次 `doctor`，
配置错了就不进重启循环。

## ob Headless Sync（单独的 tmux session）

`ob` 只做同步，**不加载任何 Obsidian 社区插件** —— 微信接收、长轮询、Markdown 写入
全部由本服务完成，两者职责不重叠。

```bash
ob sync-status --path /path/to/vault     # 先确认配置
tmux new-session -d -s ob-sync 'ob sync --path /path/to/vault --watch 2>&1 | tee -a logs/ob-sync.log'
```

以本机实测为准：`ob help` / `ob sync --help` 才是当前版本支持的真实参数，不要照抄别处的写法。

## 配置与凭据位置

| 内容 | 路径 | 权限 |
|---|---|---|
| 配置 | `~/.config/wechat-diary/config.json` | 建议 0600，目录 0700 |
| 凭据（bot token / AI key / 绑定身份） | `~/.config/wechat-diary/credentials.json` | **强制 0600** |
| 状态（游标 / 去重表 / profile） | `~/.local/state/wechat-diary/state.json` | 0600 |
| 事件流水 | `<vault>/.wechat-diary/events/YYYY-MM-DD.ndjson` | 0600 |
| 服务日志 | `wechat-diary-node/logs/service.log` | — |

覆盖位置（测试用）：`WECHAT_DIARY_CONFIG_DIR` / `WECHAT_DIARY_STATE_DIR`。

**仓库里只有 `config.example.json`，不含任何真实密钥。** `.gitignore` 挡住了
`config.json` / `credentials.json` / `state.json`。

### 日志脱敏

不是"记得脱敏"，而是让泄露在结构上做不到（`src/logger.js`）：

1. 启动时把 botToken / aiKey 注册进 logger，之后任何日志里出现它们都变 `<redacted>`
2. 每条日志过一遍形状匹配：长 base64/hex 串、`Bearer`、`aeskey`、`encrypt_query_param` 一律打码
3. **消息正文永不打印**，只打摘要：`<12 字, 起于CJK>`

## 数据流与防丢失

每条消息严格按七步走（`src/service.js` 的 `handleMessage`）：

```
1 收到消息
2 验证用户与消息 ID       ← 陌生人静默丢弃(不回复=不确认 bot 存活), 无 seq/message_id 的丢弃
3 检查幂等               ← recentSeqs
4 追加 NDJSON 并 fsync   ← 到这一步为止, 消息永不丢
5 更新 Daily Note        ← 失败 → failed 事件 → 可 replay → 回微信明确失败提示
6 更新游标与去重状态       ← 只在 5 成功后
7 回微信确认
```

崩溃安全的两头：第 4 步之后崩溃，`replay` 能从流水补写；第 4 步之前崩溃，服务端游标
未推进，腾讯会重发。两头都不丢，中间靠 `recentSeqs` + 流水双重去重不重复。

服务启动时会自动 `replay` 昨天与今天的 pending，不用等下次发消息才发现上次写失败。

## 并发与 Sync 风险

**服务端是唯一的微信接收端，但不是 Daily Note 的唯一编辑端** —— `ob` 在同步，Mac 也可能在编辑。

- 每次改文件前**重新从磁盘读取**（不用内存缓存，那只会带来"读到旧内容然后覆盖"）
- 跨进程 `lockfile`（`O_EXCL`，死锁按 mtime 接管）
- 原子替换：临时文件 → `fsync` → `rename` → 目录 `fsync`
- 只改 `## 日常记录` 内 `managed` 边界之后的字节，节外内容逐字节不动
- **写后校验**：写完重读磁盘确认内容真在里面；校验不过就不回"记下来啦"，而是回失败提示并保留流水

## 与 Mac 插件的关系

⚠️ **两端不能同时运行长轮询** —— 会重复消费、竞争游标、重复写入。

正式切换后 Mac 上的 WeChat Diary 插件必须停用，服务器成为唯一接收端。
切换前备份 vault 与插件 `data.json`，并选一段不发微信消息的窗口。

## 测试

```bash
node tests/run.js          # 上游 581 项 + standalone 170 项
```

上游那 581 项同时也是服务端的回归网：服务端复用同一份 `main.js`，一旦它们挂了说明
契约已漂移，此时集成测试的结果没有意义（所以 `run.js` 先跑它）。

standalone 的 170 项盯宿主适配层——真实文件系统、事件流水、状态损坏恢复、并发与信号，
这些在 Obsidian 里不存在，上游测不到。

## 支持的消息类型

| 类型 | 状态 |
|---|---|
| 文本 | ✅ |
| 语音（微信转写文字 + 可选原声 wav） | ✅ |
| 图片（CDN + AES-128-ECB 解密，magic bytes 识别） | ✅ |
| 文件（原名保留，md5 校验 + 重复文件复用） | ✅ |
| 视频 | ✅ |
| 撤回 / 晚安封存 / 在吗探活 / 帮助 / `记：` 逃生口 | ✅ |
| 转发消息、链接卡片、位置、名片、表情包 | ❌ 协议天花板（见 `docs/protocol-notes.md` §8） |

## 已知边界

- **纯媒体消息无法 replay**：流水刻意不保存 CDN 密钥与链接（存了等于把凭据写进 vault），
  而 CDN 链接是短时效的。纯媒体写失败会留 `failed` 事件，需要在微信里重发。
- **补拉窗口约 24 小时**：服务离线超过一天，更早的消息腾讯可能不再补发。
- **`-14` 冷却 1 小时**：会话过期时不清 token 不重登，用同一 token 同一游标等冷却结束。
- **`seq` 是 bot 会话级计数器，不是全局 ID**：换 bot 必须清游标与去重表（`bind` 已自动处理）。
- 腾讯服务端**不下发用户昵称/头像**，也**没有 allowlist**（陌生人可直达 bot，靠本服务白名单挡）。
