/**
 * [INPUT]: electron - Electron 框架
 * [INPUT]: AppleScript - macOS 窗口控制，通过 System Events 检测/激活 Zed 窗口
 * [OUTPUT]: 主进程，创建悬浮标签栏窗口，提供 IPC 接口
 * [POS]: 应用入口，管理窗口生命周期、IPC 通信、智能切换 Zed 窗口（已打开激活，未打开新建）
 *
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG_PATH = path.join(app.getPath('userData'), 'projects.json');
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
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
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
// ZED CONTROL (AppleScript)
// ============================================================================

function getZedWindows() {
  return new Promise((resolve) => {
    const script = `tell application "System Events"
      if not (exists process "Zed") then return ""
      tell process "Zed" to get name of every window
    end tell`;
    exec(`osascript -e '${script}'`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      let emptyCount = 0;
      const windows = stdout.trim().split(', ')
        .filter(name => name)
        .map(name => {
          if (name === 'empty project') return `empty project (${++emptyCount})`;
          return name.includes(' — ') ? name.split(' — ')[0] : name;
        });
      resolve([...new Set(windows)]);
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
        if name of w is "${windowName}" or name of w starts with "${windowName} —" then
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

ipcMain.handle('open-project', (_, windowName) => {
  activateZedWindowByName(windowName);
  return true;
});

ipcMain.handle('get-zed-windows', () => getZedWindows());

ipcMain.handle('set-window-height', (_, height) => {
  if (mainWindow) mainWindow.setSize(mainWindow.getSize()[0], height);
});

ipcMain.handle('select-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
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
  // 监听系统活动应用变化
  const { systemPreferences } = require('electron');
  
  // 使用 NSWorkspace 通知监听应用切换（更轻量）
  setInterval(() => {
    exec(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null`, (err, stdout) => {
      if (err || !mainWindow) return;
      const frontApp = stdout.trim().toLowerCase();
      const shouldShow = frontApp === 'zed' || frontApp === 'electron';
      if (shouldShow && !mainWindow.isVisible()) {
        mainWindow.showInactive(); // 不抢焦点
      } else if (!shouldShow && mainWindow.isVisible()) {
        mainWindow.hide();
      }
    });
  }, 1000); // 降低频率到 1 秒
}

app.whenReady().then(() => {
  createWindow();
  startHideCheck();
  
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, () => {
      const projects = loadProjects();
      if (projects[i - 1]) {
        activateZedWindowByName(projects[i - 1].name);
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
