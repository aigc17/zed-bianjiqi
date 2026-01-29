/**
 * [INPUT]: electron - Electron 框架
 * [INPUT]: AppleScript - macOS 窗口控制，通过 System Events 检测/激活 Zed 窗口
 * [INPUT]: Zed SQLite DB - 读取工作区路径信息
 * [OUTPUT]: 主进程，创建悬浮标签栏窗口，提供 IPC 接口
 * [POS]: 应用入口，管理窗口生命周期、IPC 通信、智能切换 Zed 窗口（已打开激活，未打开新建）
 *
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { exec, execSync } = require('child_process');
const fs = require('fs');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG_PATH = path.join(app.getPath('userData'), 'projects.json');
const ZED_DB_PATH = path.join(app.getPath('home'), 'Library/Application Support/Zed/db/0-stable/db.sqlite');
const BAR_HEIGHT = 36;

let mainWindow = null;

// ============================================================================
// WINDOW CREATION
// ============================================================================

function getWindowConfig() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width, height: BAR_HEIGHT, x: 0, y: 0,
    frame: false, transparent: false, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#1e1e1e',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  };
}

function createWindow() {
  mainWindow = new BrowserWindow(getWindowConfig());
  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(false);
}

// ============================================================================
// PROJECT DATA
// ============================================================================

function loadProjects() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let projects = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

      // 数据迁移：旧格式 { name } -> 新格式 { path, displayName }
      let needsMigration = false;
      const workspaces = getZedWorkspaces();

      projects = projects.map(p => {
        if (p.name && !p.path && !p.displayName) {
          // 旧格式，需要迁移
          needsMigration = true;
          const projectPath = workspaces[p.name] || null;
          return {
            path: projectPath,
            displayName: p.name,
            color: p.color
          };
        }
        // 已经是新格式或部分新格式
        return {
          path: p.path || null,
          displayName: p.displayName || p.name,
          color: p.color
        };
      });

      if (needsMigration) {
        saveProjects(projects);
        console.log('Migrated projects to new format');
      }

      return projects;
    }
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
  return [];
}

function saveProjects(projects) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(projects, null, 2));
  } catch (e) {
    console.error('Failed to save projects:', e);
  }
}

// ============================================================================
// ZED DATABASE - 读取工作区路径
// ============================================================================

function getZedWorkspaces() {
  // 从 Zed 数据库读取所有工作区路径，返回 { name -> path } 映射
  try {
    const result = execSync(`sqlite3 '${ZED_DB_PATH}' "SELECT paths FROM workspaces WHERE paths IS NOT NULL ORDER BY timestamp DESC;"`).toString();
    const mapping = {};
    result.trim().split('\n').forEach(p => {
      if (p) {
        const name = path.basename(p);
        // 如果有同名项目，保留最近使用的（先出现的）
        if (!mapping[name]) {
          mapping[name] = p;
        }
      }
    });
    return mapping;
  } catch (e) {
    console.error('Failed to read Zed database:', e);
    return {};
  }
}

// ============================================================================
// ZED CONTROL (AppleScript)
// ============================================================================

function adjustZedWindows() {
  // 获取工作区信息（workArea.y 是菜单栏高度）
  const display = screen.getPrimaryDisplay();
  const menuBarHeight = display.workArea.y;
  const { width, height } = display.workAreaSize;
  const topOffset = menuBarHeight + BAR_HEIGHT;

  const script = `tell application "System Events"
    if not (exists process "Zed") then return
    tell process "Zed"
      repeat with w in every window
        set position of w to {0, ${topOffset}}
        set size of w to {${width}, ${height - BAR_HEIGHT}}
      end repeat
    end tell
  end tell`;
  exec(`osascript -e '${script}'`);
}

function getZedWindows() {
  return new Promise((resolve) => {
    const script = `tell application "System Events"
      if not (exists process "Zed") then return ""
      tell process "Zed" to get name of every window
    end tell`;
    exec(`osascript -e '${script}'`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      // 获取 Zed 数据库中的路径映射
      const workspaces = getZedWorkspaces();

      let emptyCount = 0;
      const windows = stdout.trim().split(', ')
        .filter(name => name)
        .map(windowName => {
          // empty project 需要编号区分
          if (windowName === 'empty project') {
            return {
              windowName: `empty project (${++emptyCount})`,
              path: null,
              displayName: `empty project (${emptyCount})`
            };
          }

          // 提取项目名（去掉 " — 文件名" 部分）
          const projectName = windowName.includes(' — ')
            ? windowName.split(' — ')[0]
            : windowName;

          // 从数据库查找对应路径
          const projectPath = workspaces[projectName] || null;

          return {
            windowName,      // 完整窗口名（用于 AppleScript 匹配）
            path: projectPath,  // 项目路径（唯一标识）
            displayName: projectName  // 显示名（项目名）
          };
        });
      resolve(windows);
    });
  });
}

function activateZedWindowByName(windowName) {
  // 处理 empty project (N) 格式
  const match = windowName.match(/^empty project \((\d+)\)$/);
  if (match) {
    const index = parseInt(match[1]);
    const script = `tell application "System Events"
      tell process "Zed"
        set emptyCount to 0
        repeat with w in every window
          if name of w is "empty project" then
            set emptyCount to emptyCount + 1
            if emptyCount is ${index} then
              perform action "AXRaise" of w
              set frontmost to true
              return "activated"
            end if
          end if
        end repeat
      end tell
    end tell`;
    exec(`osascript -e '${script}'`);
    return;
  }
  
  const script = `tell application "System Events"
    tell process "Zed"
      repeat with w in every window
        if name of w is "${windowName}" or name of w starts with "${windowName} — " then
          perform action "AXRaise" of w
          set frontmost to true
          return "activated"
        end if
      end repeat
    end tell
  end tell`;
  exec(`osascript -e '${script}'`);
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('get-projects', () => loadProjects());

ipcMain.handle('save-projects', (_, projects) => {
  saveProjects(projects);
  return true;
});

ipcMain.handle('open-project', (_, pathOrName) => {
  // 如果是路径，先尝试用路径的 basename 匹配窗口
  if (pathOrName && pathOrName.startsWith('/')) {
    const projectName = path.basename(pathOrName);
    activateZedWindowByName(projectName);
  } else {
    activateZedWindowByName(pathOrName);
  }
  return true;
});

ipcMain.handle('get-zed-windows', () => getZedWindows());

ipcMain.handle('set-window-height', (_, height) => {
  if (mainWindow) mainWindow.setSize(mainWindow.getSize()[0], height);
});

ipcMain.handle('select-folder', async () => {
  const { dialog } = require('electron');

  // 临时取消 alwaysOnTop，避免对话框被遮挡或卡顿
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(false);
  }

  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  // 恢复 alwaysOnTop
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(true);
  }

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('open-folder-in-zed', (_, folderPath) => {
  // 使用 open -a Zed，因为 zed CLI 可能不在 Electron 的 PATH 里
  exec(`open -a Zed "${folderPath}"`);
  return path.basename(folderPath);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

function startHideCheck() {
  let lastFrontApp = '';

  setInterval(() => {
    exec(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null`, (err, stdout) => {
      if (err || !mainWindow) return;
      const frontApp = stdout.trim().toLowerCase();
      const shouldShow = frontApp === 'zed' || frontApp === 'electron';

      if (shouldShow && !mainWindow.isVisible()) {
        mainWindow.showInactive();
      } else if (!shouldShow && mainWindow.isVisible()) {
        mainWindow.hide();
      }

      // Zed 刚激活时，调整窗口位置到标签栏下方
      if (frontApp === 'zed' && lastFrontApp !== 'zed') {
        adjustZedWindows();
      }
      lastFrontApp = frontApp;
    });
  }, 1000);
}

app.whenReady().then(() => {
  createWindow();
  startHideCheck();
  
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, () => {
      const projects = loadProjects();
      const p = projects[i - 1];
      if (p) {
        // 用 path 的 basename 或 displayName 匹配窗口
        const name = p.path ? path.basename(p.path) : p.displayName;
        activateZedWindowByName(name);
      }
    });
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
