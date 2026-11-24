#!/usr/bin/env bash
set -euo pipefail

# One launcher for both targets. The web target runs server.js on a fixed port;
# the desktop target runs Electron, where the OS picks the port and the value is
# read back from the main process log.
#
#   ./start.sh [web|desktop] <command> [args]
#
# Omitting the target means `web`, so `./start.sh start` still works.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RUN_DIR="${LUMA_RUN_DIR:-$ROOT_DIR/.run}"
NODE_BIN=""
ELECTRON_BIN=""

TARGET="web"
COMMAND="start"
COMMAND_ARG=""

WEB_PORT="${PORT:-8787}"
export PORT="$WEB_PORT"
WEB_PID_FILE="$RUN_DIR/web.pid"
WEB_LOG_FILE="$RUN_DIR/web.log"

DESKTOP_PID_FILE="$RUN_DIR/desktop.pid"
DESKTOP_PORT_FILE="$RUN_DIR/desktop.port"
DESKTOP_LOG_FILE="$RUN_DIR/desktop.log"
DESKTOP_DEBUG_PORT="${LUMA_DEBUG_PORT:-9222}"

# Filled in by read_state for whichever target is active.
PID_FILE=""
PORT_FILE=""
LOG_FILE=""
SERVICE_PID=""
SERVICE_PORT=""
LOG_OFFSET=0

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法: ./start.sh [web|desktop] <命令> [参数]

省略目标时默认 web。

命令（web / desktop 都支持）:
  start        后台启动（默认命令）
  stop         停止
  restart      重启
  status       查看运行状态
  logs [N]     查看最近 N 行日志
  logs -f      持续查看日志
  run          前台启动，Ctrl+C 停止

仅 desktop:
  debug        带远程调试端口前台启动，用于自动化验证

环境变量:
  PORT              web 监听端口，默认 8787
  DATA_DIR          web 数据目录，默认 ./data
  LUMA_RUN_DIR      PID 和日志目录，默认 ./.run
  LUMA_DEBUG_PORT   desktop debug 端口，默认 9222
EOF
}

# ---- shared helpers ------------------------------------------------------

ensure_node() {
  command -v node >/dev/null 2>&1 || die "未找到 Node.js，请先安装 Node.js 22+。"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "当前 Node.js $(node -v)，本项目需要 Node.js 22+。"
  NODE_BIN="$(command -v node)"
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
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

show_log_tail() {
  if [ -f "$LOG_FILE" ]; then
    printf '%s\n' "--- 最近日志 ---" >&2
    tail -n 20 "$LOG_FILE" >&2
  fi
}

clear_state() {
  rm -f "$PID_FILE"
  [ -n "$PORT_FILE" ] && rm -f "$PORT_FILE"
  return 0
}

logs_service() {
  [ -f "$LOG_FILE" ] || die "暂无日志：${LOG_FILE}"
  if [ "${1:-}" = "-f" ]; then
    tail -n "${2:-100}" -f "$LOG_FILE"
  else
    tail -n "${1:-100}" "$LOG_FILE"
  fi
}

# ---- web target ----------------------------------------------------------

web_setup_paths() {
  PID_FILE="$WEB_PID_FILE"
  PORT_FILE=""
  LOG_FILE="$WEB_LOG_FILE"
}

web_read_state() {
  [ -f "$PID_FILE" ] || return 1
  SERVICE_PID=""
  SERVICE_PORT=""
  {
    IFS= read -r SERVICE_PID || true
    IFS= read -r SERVICE_PORT || true
  } < "$PID_FILE"
  [ -n "$SERVICE_PID" ] && [ -n "$SERVICE_PORT" ]
}

web_is_ours() {
  local pid="$1" cmd cwd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *server.js*) ;;
    *) return 1 ;;
  esac
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  [ "$cwd" = "$ROOT_DIR" ]
}

web_port_pid() {
  lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

web_wait_for_http() {
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

web_start() {
  ensure_node

  if web_read_state; then
    if is_pid_alive "$SERVICE_PID" && web_is_ours "$SERVICE_PID"; then
      printf '%s\n' "Luma Web 已在运行：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
      return 0
    fi
    clear_state
  fi

  local occupied
  occupied="$(web_port_pid)"
  if [ -n "$occupied" ]; then
    if web_is_ours "$occupied"; then
      printf '%s\n' "端口 ${WEB_PORT} 已被本服务的旧进程占用（pid ${occupied}）。请先执行：./start.sh web stop" >&2
    else
      printf '%s\n' "端口 ${WEB_PORT} 已被其他进程占用（pid ${occupied}）。" >&2
    fi
    return 1
  fi

  mkdir -p "$RUN_DIR"
  printf '\n[%s] start web port=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$WEB_PORT" >> "$LOG_FILE"

  (
    cd "$ROOT_DIR"
    exec nohup "$NODE_BIN" --disable-warning=ExperimentalWarning server.js </dev/null >>"$LOG_FILE" 2>&1
  ) &
  SERVICE_PID=$!
  SERVICE_PORT="$WEB_PORT"
  printf '%s\n%s\n' "$SERVICE_PID" "$SERVICE_PORT" > "$PID_FILE"

  if ! web_wait_for_http "$SERVICE_PORT" "$SERVICE_PID"; then
    printf '%s\n' "Luma Web 启动失败。" >&2
    stop_pid "$SERVICE_PID"
    clear_state
    show_log_tail
    return 1
  fi

  printf '%s\n' "Luma Web 已启动：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
  printf '%s\n' "日志：${LOG_FILE}"
  printf '%s\n' "停止：./start.sh web stop"
}

web_stop() {
  local stopped=0 pid=""

  if web_read_state; then
    if is_pid_alive "$SERVICE_PID" && web_is_ours "$SERVICE_PID"; then
      stop_pid "$SERVICE_PID"
      stopped=1
    elif is_pid_alive "$SERVICE_PID"; then
      printf '%s\n' "PID ${SERVICE_PID} 存在但不是本项目的 Web 服务，跳过。" >&2
    fi
    clear_state
  fi

  if [ "$stopped" -eq 0 ]; then
    pid="$(web_port_pid)"
    if [ -n "$pid" ]; then
      if web_is_ours "$pid"; then
        printf '%s\n' "未找到运行记录，按端口 ${WEB_PORT} 停止进程 ${pid}。" >&2
        stop_pid "$pid"
        stopped=1
      else
        printf '%s\n' "端口 ${WEB_PORT} 被其他进程占用（pid ${pid}），未处理。" >&2
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

web_status() {
  if web_read_state && is_pid_alive "$SERVICE_PID" && web_is_ours "$SERVICE_PID"; then
    printf '%s\n' "Luma Web 运行中：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
    if curl --max-time 1 -fsS -o /dev/null "http://127.0.0.1:${SERVICE_PORT}/" 2>/dev/null; then
      printf '%s\n' "HTTP：正常"
    else
      printf '%s\n' "HTTP：进程存在，但暂时无法访问"
    fi
    printf '%s\n' "日志：${LOG_FILE}"
    return 0
  fi

  if web_read_state; then
    printf '%s\n' "状态文件存在，但进程已退出。"
    clear_state
  fi

  local pid=""
  pid="$(web_port_pid)"
  if [ -n "$pid" ]; then
    if web_is_ours "$pid"; then
      printf '%s\n' "端口 ${WEB_PORT} 上有本服务进程（pid ${pid}），但不是本脚本启动的。"
    else
      printf '%s\n' "端口 ${WEB_PORT} 被其他进程占用（pid ${pid}）。"
    fi
    return 1
  fi

  printf '%s\n' "Luma Web 未运行。"
  return 1
}

web_run() {
  ensure_node

  if web_read_state && is_pid_alive "$SERVICE_PID" && web_is_ours "$SERVICE_PID"; then
    die "Luma Web 已在后台运行（pid ${SERVICE_PID}）。先执行 ./start.sh web stop。"
  fi
  clear_state

  local occupied
  occupied="$(web_port_pid)"
  if [ -n "$occupied" ]; then
    if web_is_ours "$occupied"; then
      die "端口 ${WEB_PORT} 已被本服务进程占用（pid ${occupied}）。先执行 ./start.sh web stop。"
    fi
    die "端口 ${WEB_PORT} 被其他进程占用（pid ${occupied}）。"
  fi

  printf '%s\n' "Luma Web（前台）：http://127.0.0.1:${WEB_PORT}"
  printf '%s\n' "按 Ctrl+C 停止。"
  exec "$NODE_BIN" --disable-warning=ExperimentalWarning server.js
}

# ---- desktop target ------------------------------------------------------

desktop_setup_paths() {
  PID_FILE="$DESKTOP_PID_FILE"
  PORT_FILE="$DESKTOP_PORT_FILE"
  LOG_FILE="$DESKTOP_LOG_FILE"
}

resolve_electron() {
  [ -n "$ELECTRON_BIN" ] && return 0
  local resolved
  # The .bin wrapper spawns the real binary and exits, which would make the
  # recorded PID useless; launch the app binary directly.
  resolved="$(node -p "require('electron')" 2>/dev/null || true)"
  [ -n "$resolved" ] && [ -x "$resolved" ] || die "未找到 Electron 可执行文件，请先执行 npm install。"
  ELECTRON_BIN="$resolved"
}

ensure_electron() {
  ensure_node
  resolve_electron
}

desktop_read_state() {
  [ -f "$PID_FILE" ] || return 1
  SERVICE_PID=""
  SERVICE_PORT=""
  IFS= read -r SERVICE_PID < "$PID_FILE" || true
  [ -n "$SERVICE_PID" ] || return 1
  # The port is only known after the main process binds one, so it lives in its
  # own file rather than alongside the pid.
  if [ -f "$PORT_FILE" ]; then
    SERVICE_PORT="$(tr -d '[:space:]' < "$PORT_FILE" 2>/dev/null || true)"
  fi
  return 0
}

desktop_is_ours() {
  local pid="$1" cmd cwd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$ROOT_DIR"/node_modules/electron/*|*"$ROOT_DIR/node_modules/electron"*|*"Electron.app/Contents/MacOS/Electron"*) ;;
    *) return 1 ;;
  esac
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  [ "$cwd" = "$ROOT_DIR" ]
}

# Foreground starts record nothing, so a live window from this checkout is
# identified by its working directory instead.
desktop_stray_pids() {
  local pid
  for pid in $(pgrep -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true); do
    desktop_is_ours "$pid" && printf '%s\n' "$pid"
  done
}

stop_helpers() {
  local pid cwd
  for pid in $(pgrep -f "Electron Helper" 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
    [ "$cwd" = "$ROOT_DIR" ] && kill -TERM "$pid" 2>/dev/null || true
  done
}

# The main process logs its bound port once the HTTP listener is up. Only bytes
# written after this launch are considered: the log still holds the previous
# instance's line, which would otherwise be mistaken for the new port.
desktop_capture_port() {
  local i=0 line
  while [ "$i" -lt 40 ]; do
    line="$(tail -c "+$((LOG_OFFSET + 1))" "$LOG_FILE" 2>/dev/null \
      | sed -n 's/.*Luma desktop ready: http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' \
      | tail -n 1 || true)"
    if [ -n "$line" ]; then
      printf '%s' "$line" > "$PORT_FILE"
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
}

desktop_wait_for_ready() {
  local pid="$1" i=0 port=""
  while [ "$i" -lt 60 ]; do
    if [ -f "$PORT_FILE" ]; then
      port="$(cat "$PORT_FILE" 2>/dev/null || true)"
      if [ -n "$port" ] && curl --max-time 1 -fsS -o /dev/null \
        "http://127.0.0.1:${port}/api/health" 2>/dev/null; then
        SERVICE_PORT="$port"
        return 0
      fi
    fi
    if ! is_pid_alive "$pid"; then
      return 1
    fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

desktop_start() {
  ensure_electron

  if desktop_read_state && is_pid_alive "$SERVICE_PID" && desktop_is_ours "$SERVICE_PID"; then
    printf '%s\n' "Luma 桌面端已在运行：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
    return 0
  fi
  clear_state

  local existing
  existing="$(desktop_stray_pids | head -n 1)"
  if [ -n "$existing" ]; then
    printf '%s\n' "Luma 桌面端已在运行（前台/调试实例，pid ${existing}）。"
    printf '%s\n' "如需重启，先执行：./start.sh desktop stop"
    return 0
  fi

  mkdir -p "$RUN_DIR"
  rm -f "$PORT_FILE"
  printf '\n[%s] start desktop\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
  LOG_OFFSET="$(wc -c < "$LOG_FILE" | tr -d ' ')"

  (
    cd "$ROOT_DIR"
    exec nohup "$ELECTRON_BIN" . </dev/null >>"$LOG_FILE" 2>&1
  ) &
  SERVICE_PID=$!
  printf '%s\n' "$SERVICE_PID" > "$PID_FILE"

  if ! desktop_capture_port; then
    if ! is_pid_alive "$SERVICE_PID"; then
      printf '%s\n' "桌面端启动失败：进程已退出，且没有读到监听端口。" >&2
      printf '%s\n' "若已有 Luma 窗口在运行，Electron 的单实例锁会让本次启动直接退出。" >&2
      clear_state
      show_log_tail
      return 1
    fi
    printf '%s\n' "桌面端启动失败：没有读到监听端口。" >&2
    stop_pid "$SERVICE_PID"
    clear_state
    show_log_tail
    return 1
  fi
  SERVICE_PORT="$(cat "$PORT_FILE")"

  if ! desktop_wait_for_ready "$SERVICE_PID"; then
    printf '%s\n' "桌面端启动失败。" >&2
    stop_pid "$SERVICE_PID"
    stop_helpers
    clear_state
    show_log_tail
    return 1
  fi

  printf '%s\n' "Luma 桌面端已启动：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
  printf '%s\n' "工作目录按钮应在输入框上方工具栏可见。"
  printf '%s\n' "日志：${LOG_FILE}"
  printf '%s\n' "停止：./start.sh desktop stop"
}

desktop_stop() {
  local stopped=0 pid
  if desktop_read_state; then
    if is_pid_alive "$SERVICE_PID" && desktop_is_ours "$SERVICE_PID"; then
      stop_pid "$SERVICE_PID"
      stopped=1
    elif is_pid_alive "$SERVICE_PID"; then
      printf '%s\n' "PID ${SERVICE_PID} 存在但不是本项目的桌面端，跳过。" >&2
    fi
    clear_state
  fi

  for pid in $(desktop_stray_pids); do
    printf '%s\n' "停止未登记的桌面端进程 ${pid}。" >&2
    stop_pid "$pid"
    stopped=1
  done
  stop_helpers

  if [ "$stopped" -eq 1 ]; then
    printf '%s\n' "Luma 桌面端已停止。"
  else
    printf '%s\n' "Luma 桌面端未运行。"
  fi
}

desktop_status() {
  if desktop_read_state && is_pid_alive "$SERVICE_PID" && desktop_is_ours "$SERVICE_PID"; then
    printf '%s\n' "Luma 桌面端运行中：http://127.0.0.1:${SERVICE_PORT}（pid ${SERVICE_PID}）"
    if curl --max-time 1 -fsS -o /dev/null \
      "http://127.0.0.1:${SERVICE_PORT}/api/health" 2>/dev/null; then
      printf '%s\n' "HTTP：正常"
    else
      printf '%s\n' "HTTP：进程存在，但暂时无法访问"
    fi
    printf '%s\n' "日志：${LOG_FILE}"
    return 0
  fi

  if desktop_read_state; then
    printf '%s\n' "状态文件存在，但进程已退出。"
    clear_state
  fi

  local stray
  stray="$(desktop_stray_pids | head -n 1)"
  if [ -n "$stray" ]; then
    printf '%s\n' "Luma 桌面端运行中（前台/调试实例，未登记 pid ${stray}）"
    # The log keeps every past ready line, so only show a port that answers now.
    local logged
    logged="$(tail -n 200 "$LOG_FILE" 2>/dev/null \
      | sed -n 's/.*Luma desktop ready: http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' \
      | tail -n 1 || true)"
    if [ -n "$logged" ] && curl --max-time 1 -fsS -o /dev/null \
      "http://127.0.0.1:${logged}/api/health" 2>/dev/null; then
      printf '%s\n' "端口：http://127.0.0.1:${logged}"
    else
      printf '%s\n' "端口：前台启动，脚本未记录（日志里的旧端口已失效）"
    fi
    printf '%s\n' "日志：${LOG_FILE}"
    printf '%s\n' "停止：./start.sh desktop stop"
    return 0
  fi

  printf '%s\n' "Luma 桌面端未运行。"
  return 1
}

desktop_run() {
  ensure_electron
  if desktop_read_state && is_pid_alive "$SERVICE_PID" && desktop_is_ours "$SERVICE_PID"; then
    die "桌面端已在后台运行（pid ${SERVICE_PID}）。先执行 ./start.sh desktop stop。"
  fi
  clear_state
  printf '%s\n' "Luma 桌面端（前台），按 Ctrl+C 停止。"
  exec "$ELECTRON_BIN" .
}

desktop_debug() {
  ensure_electron
  if desktop_read_state && is_pid_alive "$SERVICE_PID" && desktop_is_ours "$SERVICE_PID"; then
    die "桌面端已在运行（pid ${SERVICE_PID}）。先执行 ./start.sh desktop stop。"
  fi
  clear_state
  printf '%s\n' "Luma 桌面端（调试）：http://127.0.0.1:${DESKTOP_DEBUG_PORT}"
  printf '%s\n' "按 Ctrl+C 停止。"
  exec "$ELECTRON_BIN" . --remote-debugging-port="$DESKTOP_DEBUG_PORT"
}

# ---- dispatch ------------------------------------------------------------

if [ $# -gt 0 ]; then
  case "$1" in
    web|server) TARGET="web"; shift ;;
    desktop|app) TARGET="desktop"; shift ;;
  esac
fi

COMMAND="${1:-start}"
if [ $# -gt 0 ]; then
  shift
fi
COMMAND_ARG="${1:-}"

case "$TARGET" in
  web) web_setup_paths ;;
  desktop) desktop_setup_paths ;;
  *) usage >&2; exit 1 ;;
esac

case "$COMMAND" in
  start)
    if [ "$TARGET" = "web" ]; then web_start; else desktop_start; fi
    ;;
  stop)
    if [ "$TARGET" = "web" ]; then web_stop; else desktop_stop; fi
    ;;
  restart)
    if [ "$TARGET" = "web" ]; then
      web_stop || true
      web_start
    else
      desktop_stop || true
      desktop_start
    fi
    ;;
  status)
    if [ "$TARGET" = "web" ]; then web_status; else desktop_status; fi
    ;;
  logs)
    logs_service "$COMMAND_ARG"
    ;;
  run|foreground)
    if [ "$TARGET" = "web" ]; then web_run; else desktop_run; fi
    ;;
  debug)
    if [ "$TARGET" = "desktop" ]; then
      desktop_debug
    else
      usage >&2
      exit 1
    fi
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac