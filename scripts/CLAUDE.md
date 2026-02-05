# Folder: scripts/

> L2 | 父级: ../CLAUDE.md

> 运维脚本目录，提供启动/关闭/重启命令，解决进程残留和卡死问题

## 成员清单

- `start.sh`: 启动脚本，先 pkill 清理残留 Electron 进程，再后台启动新实例
- `stop.sh`: 关闭脚本，杀掉所有相关进程，残留时强制 kill -9
- `restart.sh`: 重启脚本，调用 stop.sh + start.sh

**⚠️ 自指声明**：一旦本文件夹新增/删除/修改文件或职责变动，请立即更新本文档。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
