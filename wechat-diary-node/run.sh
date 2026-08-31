#!/usr/bin/env bash
# WeChat Diary 独立服务的启动包装。
#
# 设计要点(第七章):
#   · 不做无限高速重启。异常退出等 5 秒起步, 连续失败逐步退避到 60 秒。
#   · 区分正常退出与异常退出: exit 0 / SIGINT / SIGTERM 一律不重启(那是人为停的)。
#   · 日志由调用方 tee(见下面注释), 这里只管进程生命周期。
#
# 用法:
#   ./run.sh                     前台跑(调试用)
#   tmux new-session -d -s wechat-diary './run.sh 2>&1 | tee -a logs/service.log'
#
# 环境变量:
#   WECHAT_DIARY_NO_RESTART=1    崩溃后不重启(测试用)
#   WECHAT_DIARY_MAX_RESTARTS=n  最多重启 n 次后放弃(默认无限)

set -uo pipefail

cd "$(dirname "$0")"

mkdir -p logs

NODE_BIN="${NODE_BIN:-node}"
BACKOFF_MIN=5
BACKOFF_MAX=60
backoff=$BACKOFF_MIN
restarts=0

log() { printf '[%s] [run.sh] %s\n' "$(date -Is)" "$*"; }

# 转发信号给 node, 让它走 SIGINT/SIGTERM 的优雅退出(保存游标)
child=""
forward() {
  local sig="$1"
  log "收到 $sig, 转发给服务 (pid ${child:-none})"
  if [ -n "$child" ]; then
    kill -"$sig" "$child" 2>/dev/null || true
    # 给它时间保存状态; 超时才强杀
    for _ in $(seq 1 20); do
      kill -0 "$child" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$child" 2>/dev/null && { log "服务未在 10 秒内退出, 强制结束"; kill -9 "$child" 2>/dev/null || true; }
  fi
  exit 0
}
trap 'forward SIGTERM' TERM
trap 'forward SIGINT' INT

log "启动 WeChat Diary 服务 (node $($NODE_BIN -v))"

# 启动前自检一次: 配置错了就没必要进重启循环
if ! "$NODE_BIN" src/cli.js doctor >/dev/null 2>&1; then
  log "doctor 有阻塞性问题, 打印详情后退出:"
  "$NODE_BIN" src/cli.js doctor || true
  exit 1
fi
log "doctor 通过"

while true; do
  start_ts=$(date +%s)
  "$NODE_BIN" src/service.js &
  child=$!
  wait "$child"
  code=$?
  child=""
  run_secs=$(( $(date +%s) - start_ts ))

  # 128+N = 被信号杀死。SIGINT(130)/SIGTERM(143) 是人为停止, 不重启。
  if [ "$code" -eq 0 ]; then
    log "服务正常退出 (exit 0), 不重启"
    exit 0
  fi
  if [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    log "服务被信号停止 (exit $code), 不重启"
    exit 0
  fi
  # 78 = EX_CONFIG: 配置缺失或错误(比如还没绑定微信)。重启一万次也还是错的, 等人来修。
  if [ "$code" -eq 78 ]; then
    log '配置问题导致退出 (exit 78), 不重启。请修好配置, 或先运行: node src/cli.js bind'
    exit 78
  fi

  if [ "${WECHAT_DIARY_NO_RESTART:-}" = "1" ]; then
    log "服务异常退出 (exit $code), WECHAT_DIARY_NO_RESTART=1, 不重启"
    exit "$code"
  fi

  restarts=$((restarts + 1))
  if [ -n "${WECHAT_DIARY_MAX_RESTARTS:-}" ] && [ "$restarts" -gt "${WECHAT_DIARY_MAX_RESTARTS}" ]; then
    log "已重启 $((restarts - 1)) 次, 达到上限, 放弃"
    exit "$code"
  fi

  # 跑够 5 分钟才崩 = 偶发故障, 退避重置; 起步就崩 = 配置/环境问题, 逐步拉长间隔
  if [ "$run_secs" -ge 300 ]; then
    backoff=$BACKOFF_MIN
  else
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff=$BACKOFF_MAX
  fi

  log "服务异常退出 (exit $code, 运行了 ${run_secs}s), 第 $restarts 次重启, 等待 ${backoff}s"
  sleep "$backoff"
done
