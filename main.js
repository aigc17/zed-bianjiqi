/**
 * [INPUT]: electron - Electron 框架
 * [OUTPUT]: 主进程，创建悬浮标签栏窗口
 * [POS]: 应用入口，管理窗口生命周期和 IPC 通信
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

function activateZedWindow(projectPath) {
  // 先尝试激活已有窗口，如果没有则打开新窗口
  const script = `
    tell application "System Events"
      set zedRunning to (name of processes) contains "Zed"
    end tell
    
    if zedRunning then
      tell application "Zed" to activate
    end if
    
    do shell script "zed -n '${projectPath.replace(/'/g, "'\\''")}';"
  `;
  
  exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, (err) => {
    if (err) {
      // fallback: 直接用 CLI
      exec(`zed -n "${projectPath}"`, (err2) => {
        if (err2) console.error('Failed to open Zed:', err2);
      });
    }
  });
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('get-projects', () => loadProjects());

ipcMain.handle('save-projects', (_, projects) => {
  saveProjects(projects);
  return true;
});

ipcMain.handle('open-project', (_, projectPath) => {
  activateZedWindow(projectPath);
  return true;
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

// ============================================================================
// APP LIFECYCLE
// ============================================================================

app.whenReady().then(() => {
  createWindow();
  
  // 注册全局快捷键 Cmd+1~9
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, () => {
      const projects = loadProjects();
      if (projects[i - 1]) {
        activateZedWindow(projects[i - 1].path);
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
