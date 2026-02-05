# Zed Workspace Manager

> L1 项目宪法 | Electron + JavaScript

一个轻量的 Zed 编辑器多项目标签管理器，在屏幕顶部显示悬浮标签栏。

---

## 目录结构

```
11-zed多标签编辑器/
├── CLAUDE.md       ← 项目宪法
├── package.json    ← 项目配置
├── main.js         ← Electron 主进程，窗口管理 + IPC + AppleScript 控制
├── index.html      ← 渲染进程，标签栏 UI
└── scripts/        ← 运维脚本
    ├── start.sh    ← 启动（自动清理残留进程）
    ├── stop.sh     ← 关闭（杀掉所有相关进程）
    └── restart.sh  ← 重启（卡死时使用）
```

---

## 功能

- 顶部悬浮标签栏显示所有项目
- **智能切换**：点击标签时，已打开的项目激活窗口，未打开的新建窗口
- `Cmd+Alt+1~9` 快捷键切换项目
- 拖拽排序标签
- 项目列表持久化存储
- 文件夹选择默认路径缓存，避开云盘/网络盘慢路径
- 工作区路径异步缓存，避免主线程阻塞

---

## 使用

```bash
./scripts/start.sh    # 启动（推荐，自动清理残留）
./scripts/stop.sh     # 关闭
./scripts/restart.sh  # 重启（卡死时使用）
npm start             # 直接启动
```

---

## 技术栈

- **Electron**: 跨平台桌面应用框架
- **AppleScript**: macOS 窗口控制
- **Zed CLI**: `zed -n <path>` 打开项目

---

[PROTOCOL]: 变更时更新此文件
