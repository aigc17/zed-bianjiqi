#!/bin/bash
# ============================================================================
# Zed Workspace Manager - 关闭脚本
# 杀掉所有相关进程
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="zed-workspace-manager"

# 杀掉所有相关 Electron 进程
pkill -f "$PROJECT_DIR/node_modules/electron" 2>/dev/null

# 确认是否还有残留
sleep 0.3
if pgrep -f "$PROJECT_DIR/node_modules/electron" > /dev/null 2>&1; then
    # 强制杀掉
    pkill -9 -f "$PROJECT_DIR/node_modules/electron" 2>/dev/null
    echo "✓ $APP_NAME 已强制关闭"
else
    echo "✓ $APP_NAME 已关闭"
fi
