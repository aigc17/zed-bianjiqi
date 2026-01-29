# Zed Workspace Manager

macOS 专用的 Zed 编辑器多项目标签栏管理工具。

## 功能

- **标签栏** - 屏幕顶部悬浮标签栏，快速切换 Zed 项目窗口
- **快捷键** - `⌥1` ~ `⌥9` 快速切换前 9 个项目
- **拖拽排序** - 拖动标签调整顺序
- **右键菜单** - 重命名、颜色标记、关闭标签
- **智能显示** - 仅在 Zed 激活时显示，其他应用自动隐藏
- **文件夹新建** - 从下拉菜单选择文件夹，自动用 Zed 打开

## 系统要求

- macOS（使用 AppleScript 控制窗口）
- Node.js 18+
- Zed 编辑器已安装

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

## 开机自启（可选）

### 方法一：LaunchAgent（推荐）

```bash
# 创建启动配置（注意修改路径）
cat > ~/Library/LaunchAgents/com.zed.workspace-manager.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.zed.workspace-manager</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npm</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/你的用户名/zed-bianjiqi</string>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

# 加载启动项
launchctl load ~/Library/LaunchAgents/com.zed.workspace-manager.plist

# 卸载启动项（如需关闭自启）
# launchctl unload ~/Library/LaunchAgents/com.zed.workspace-manager.plist
```

### 方法二：登录项

1. 创建启动脚本 `start.command`：
   ```bash
   cd /path/to/zed-bianjiqi && npm start
   ```
2. 给脚本执行权限：`chmod +x start.command`
3. 系统偏好设置 → 用户与群组 → 登录项 → 添加该脚本

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
