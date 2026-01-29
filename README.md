# Zed Workspace Manager

macOS 专用的 Zed 编辑器多项目标签栏管理工具。

## 功能

- **标签栏** - 屏幕顶部悬浮标签栏，快速切换 Zed 项目窗口
- **快捷键** - `⌥1` ~ `⌥9` 快速切换前 9 个项目
- **拖拽排序** - 拖动标签调整顺序
- **右键菜单** - 重命名、颜色标记、关闭标签
- **智能显示** - 仅在 Zed 激活时显示，其他应用自动隐藏
- **文件夹新建** - 从下拉菜单选择文件夹，自动用 Zed 打开

## 安装

```bash
# 克隆项目
git clone https://github.com/aigc17/zed-bianjiqi.git
cd zed-bianjiqi

# 安装依赖
npm install

# 启动
npm start
```

## 系统要求

- macOS（使用 AppleScript 控制窗口）
- Node.js 18+
- Zed 编辑器已安装

## 使用

1. 启动后，标签栏出现在屏幕顶部
2. 点击 `+` 按钮添加项目（从已打开的 Zed 窗口选择，或选择文件夹新建）
3. 点击标签切换项目
4. 右键标签可重命名、设置颜色、关闭
5. 拖拽标签调整顺序

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌥1` ~ `⌥9` | 切换到第 1-9 个项目 |

## 数据存储

项目列表保存在 `~/Library/Application Support/zed-workspace-manager/projects.json`

## License

MIT
