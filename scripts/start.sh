#!/bin/bash
# ============================================================================
# Zed Workspace Manager - 启动脚本
# 先清理残留进程，再启动新实例
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="zed-workspace-manager"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"
ELECTRON_BIN="$ELECTRON_APP/Contents/MacOS/Electron"
FALLBACK_LOG="/tmp/zed-workspace-manager.log"

# 杀掉残留的 Electron 进程（只匹配本项目）
pkill -f "$ELECTRON_BIN" 2>/dev/null

# 等待进程完全退出
sleep 0.5

# 优先使用 open 启动 GUI（比 nohup npm start 更稳定）
if [ -d "$ELECTRON_APP" ]; then
  open -a "$ELECTRON_APP" --args "$PROJECT_DIR"
else
  cd "$PROJECT_DIR"
  nohup npm start > "$FALLBACK_LOG" 2>&1 &
fi

sleep 0.8

if pgrep -f "$ELECTRON_BIN" >/dev/null 2>&1; then
  echo "✓ $APP_NAME 已启动"
else
  echo "✗ $APP_NAME 启动失败"
  if [ -f "$FALLBACK_LOG" ]; then
    echo "---- fallback log (tail) ----"
    tail -n 20 "$FALLBACK_LOG"
  fi
  exit 1
fi
