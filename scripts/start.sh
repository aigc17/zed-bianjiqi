#!/bin/bash
# ============================================================================
# Zed Workspace Manager - 启动脚本
# 先清理残留进程，再启动新实例
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="zed-workspace-manager"

# 杀掉残留的 Electron 进程（只匹配本项目）
pkill -f "$PROJECT_DIR/node_modules/electron" 2>/dev/null

# 等待进程完全退出
sleep 0.5

# 启动新实例（后台运行）
cd "$PROJECT_DIR"
nohup npm start > /dev/null 2>&1 &

echo "✓ $APP_NAME 已启动"
