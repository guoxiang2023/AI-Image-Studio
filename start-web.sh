#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"
export PORT

RUN_DIR="${LUMA_RUN_DIR:-$ROOT_DIR/.run}"
PID_FILE="$RUN_DIR/web.pid"
LOG_FILE="$RUN_DIR/web.log"
NODE_BIN=""
SERVICE_PID=""
SERVICE_PORT=""

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法: ./start-web.sh [命令]

命令:
  start        后台启动 Web 服务（默认）
  stop         停止 Web 服务
  restart      重启 Web 服务
  status       查看运行状态
  logs [N]     查看最近 N 行日志
  logs -f      持续查看日志
  run          前台启动，Ctrl+C 停止

可选环境变量:
  PORT         监听端口，默认 8787
  DATA_DIR     数据目录，默认 ./data
  LUMA_RUN_DIR PID 和日志目录，默认 ./.run
EOF
}

ensure_node() {
  command -v node >/dev/null 2>&1 || die "未找到 Node.js，请先安装 Node.js 22+。"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "当前 Node.js $(node -v)，本项目需要 Node.js 22+。"
  NODE_BIN="$(command -v node)"
}

read_state() {
  [ -f "$PID_FILE" ] || return 1
  SERVICE_PID=""
  SERVICE_PORT=""
  {
    IFS= read -r SERVICE_PID || true
    IFS= read -r SERVICE_PORT || true
  } < "$PID_FILE"
  [ -n "$SERVICE_PID" ] && [ -n "$SERVICE_PORT" ]
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

is_our_server() {
  local pid="$1" cmd cwd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *server.js*) ;;
    *) return 1 ;;
  esac
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  [ "$cwd" = "$ROOT_DIR" ]
}

port_pid_for() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

port_pid() {
  port_pid_for "$PORT"
}

wait_for_http() {
  local port="$1" pid="$2" i=0
  while [ "$i" -lt 30 ]; do
    if curl --max-time 1 -fsS -o /dev/null "http://127.0.0.1:${port}/" 2>/dev/null; then
      return 0
    fi
    if ! is_pid_alive "$pid"; then
      return 1
    fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

show_log_tail() {
  if [ -f "$LOG_FILE" ]; then
    printf '%s\n' "--- 最近日志 ---" >&2
    tail -n 20 "$LOG_FILE" >&2
  fi
}

stop_pid() {
  local pid="$1" i=0
  if ! is_pid_alive "$pid"; then
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  while is_pid_alive "$pid" && [ "$i" -lt 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  if is_pid_alive "$pid"; then
    printf '%s\n' "进程 ${pid} 未在 10 秒内退出，发送 SIGKILL。" >&2
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

start_service() {
  ensure_node

  if read_state; then
    if is_pid_alive "$SERVICE_PID" && is_our_server "$SERVICE_PID"; then
      printf '%s\n' "Luma Web 已在运行：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  local occupied
  occupied="$(port_pid)"
  if [ -n "$occupied" ]; then
    if is_our_server "$occupied"; then
      printf '%s\n' "端口 ${PORT} 已被本服务的旧进程占用（pid ${occupied}）。请先执行：./start-web.sh stop" >&2
    else
      printf '%s\n' "端口 ${PORT} 已被其他进程占用（pid ${occupied}）。" >&2
    fi
    return 1
  fi

  mkdir -p "$RUN_DIR"
  printf '\n[%s] start port=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$PORT" >> "$LOG_FILE"

  (
    cd "$ROOT_DIR"
    exec nohup "$NODE_BIN" --disable-warning=ExperimentalWarning server.js </dev/null >>"$LOG_FILE" 2>&1
  ) &
  SERVICE_PID=$!
  SERVICE_PORT="$PORT"
  printf '%s\n%s\n' "$SERVICE_PID" "$SERVICE_PORT" > "$PID_FILE"

  if ! wait_for_http "$SERVICE_PORT" "$SERVICE_PID"; then
    printf '%s\n' "Luma Web 启动失败。" >&2
    stop_pid "$SERVICE_PID"
    rm -f "$PID_FILE"
    show_log_tail
    return 1
  fi

  printf '%s\n' "Luma Web 已启动：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
  printf '%s\n' "日志：${LOG_FILE}"
  printf '%s\n' "停止：./start-web.sh stop"
}

stop_service() {
  local stopped=0
  local pid=""

  if read_state; then
    if is_pid_alive "$SERVICE_PID" && is_our_server "$SERVICE_PID"; then
      stop_pid "$SERVICE_PID"
      stopped=1
    elif is_pid_alive "$SERVICE_PID"; then
      printf '%s\n' "PID ${SERVICE_PID} 存在但不是本项目的 Web 服务，跳过。" >&2
    fi
    rm -f "$PID_FILE"
  fi

  if [ "$stopped" -eq 0 ]; then
    pid="$(port_pid)"
    if [ -n "$pid" ]; then
      if is_our_server "$pid"; then
        printf '%s\n' "未找到运行记录，按端口 ${PORT} 停止进程 ${pid}。" >&2
        stop_pid "$pid"
        stopped=1
      else
        printf '%s\n' "端口 ${PORT} 被其他进程占用（pid ${pid}），未处理。" >&2
        return 1
      fi
    fi
  fi

  if [ "$stopped" -eq 1 ]; then
    printf '%s\n' "Luma Web 已停止。"
  else
    printf '%s\n' "Luma Web 未运行。"
  fi
}

status_service() {
  if read_state; then
    if is_pid_alive "$SERVICE_PID" && is_our_server "$SERVICE_PID"; then
      printf '%s\n' "Luma Web 运行中：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
      if curl --max-time 1 -fsS -o /dev/null "http://127.0.0.1:${SERVICE_PORT}/" 2>/dev/null; then
        printf '%s\n' "HTTP：正常"
      else
        printf '%s\n' "HTTP：进程存在，但暂时无法访问"
      fi
      printf '%s\n' "日志：${LOG_FILE}"
      return 0
    fi
    printf '%s\n' "状态文件存在，但进程已退出。"
    rm -f "$PID_FILE"
    return 1
  fi

  local pid=""
  pid="$(port_pid)"
  if [ -n "$pid" ]; then
    if is_our_server "$pid"; then
      printf '%s\n' "端口 ${PORT} 上有本服务进程（pid ${pid}），但不是本脚本启动的。"
    else
      printf '%s\n' "端口 ${PORT} 被其他进程占用（pid ${pid}）。"
    fi
    return 1
  fi

  printf '%s\n' "Luma Web 未运行。"
  return 1
}

restart_service() {
  stop_service || return 1
  start_service
}

logs_service() {
  [ -f "$LOG_FILE" ] || die "暂无日志：${LOG_FILE}"
  if [ "${1:-}" = "-f" ]; then
    tail -n "${2:-100}" -f "$LOG_FILE"
  else
    tail -n "${1:-100}" "$LOG_FILE"
  fi
}

run_foreground() {
  ensure_node

  if read_state; then
    if is_pid_alive "$SERVICE_PID" && is_our_server "$SERVICE_PID"; then
      die "Luma Web 已在后台运行（pid ${SERVICE_PID}）。先执行 ./start-web.sh stop。"
    fi
    rm -f "$PID_FILE"
  fi

  local occupied
  occupied="$(port_pid)"
  if [ -n "$occupied" ]; then
    if is_our_server "$occupied"; then
      die "端口 ${PORT} 已被本服务进程占用（pid ${occupied}）。先执行 ./start-web.sh stop。"
    fi
    die "端口 ${PORT} 已被其他进程占用（pid ${occupied}）。"
  fi

  printf '%s\n' "Luma Web（前台）：http://127.0.0.1:${PORT}"
  printf '%s\n' "按 Ctrl+C 停止。"
  exec "$NODE_BIN" --disable-warning=ExperimentalWarning server.js
}

COMMAND="${1:-start}"
case "$COMMAND" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    status_service
    ;;
  logs)
    logs_service "${2:-}"
    ;;
  run|foreground)
    run_foreground
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
