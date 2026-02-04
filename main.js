/**
 * [INPUT]: electron - Electron 框架
 * [INPUT]: AppleScript - macOS 窗口控制，通过 System Events 检测/激活 Zed 窗口
 * [INPUT]: Zed SQLite DB - 异步读取并缓存工作区路径信息
 * [INPUT]: dialog_state.json - 记录上次选择的目录，用于系统对话框 defaultPath（避开慢路径）
 * [OUTPUT]: 主进程，创建悬浮标签栏窗口，提供 IPC 接口（含系统对话框前置处理与默认路径优化）
 * [POS]: 应用入口，管理窗口生命周期、IPC 通信、智能切换 Zed 窗口（已打开激活，未打开新建）
 *
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');

// ============================================================================
// SINGLE INSTANCE LOCK - 防止多开僵尸进程
// ============================================================================

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例运行，直接退出
  app.quit();
} else {
  app.on('second-instance', () => {
    // 有人尝试启动第二个实例，聚焦现有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG_PATH = path.join(app.getPath('userData'), 'projects.json');
const DIALOG_STATE_PATH = path.join(app.getPath('userData'), 'dialog_state.json');
const ZED_DB_PATH = path.join(app.getPath('home'), 'Library/Application Support/Zed/db/0-stable/db.sqlite');
const BAR_HEIGHT = 36;
const ZED_WORKSPACE_CACHE_TTL_MS = 60 * 1000;
const OSASCRIPT_TIMEOUT_MS = 3000;

let mainWindow = null;
let isSystemDialogOpen = false;
let dialogState = { lastFolderPath: null };
let zedWorkspaceCache = { mapping: {}, lastUpdated: 0 };
let zedWorkspaceRefreshPromise = null;

// ============================================================================
// APPLESCRIPT EXECUTOR - 统一执行器，防止进程堆积
// ============================================================================

const scriptQueue = [];
let isScriptRunning = false;

function runAppleScript(script, callback) {
  scriptQueue.push({ script, callback });
  processScriptQueue();
}

function processScriptQueue() {
  if (isScriptRunning || scriptQueue.length === 0) return;

  isScriptRunning = true;
  const { script, callback } = scriptQueue.shift();

  const child = spawn('osascript', ['-e', script]);
  let stdout = '';
  let stderr = '';
  let killed = false;

  const timeout = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, OSASCRIPT_TIMEOUT_MS);

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    clearTimeout(timeout);
    isScriptRunning = false;

    if (killed) {
      callback && callback(new Error('timeout'), '');
    } else if (code !== 0) {
      callback && callback(new Error(stderr), '');
    } else {
      callback && callback(null, stdout);
    }

    // 处理下一个
    setImmediate(processScriptQueue);
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    isScriptRunning = false;
    callback && callback(err, '');
    setImmediate(processScriptQueue);
  });
}

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
  // 设置更高的窗口层级，确保在其他 alwaysOnTop 窗口之上
  mainWindow.setAlwaysOnTop(true, 'floating', 1);
}

// ============================================================================
// PROJECT DATA
// ============================================================================

async function loadProjects() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      let projects = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

      // 数据迁移：旧格式 { name } -> 新格式 { path, displayName }
      let needsMigration = false;
      const workspaces = await getZedWorkspacesFresh();

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
// DIALOG STATE
// ============================================================================

function loadDialogState() {
  try {
    if (fs.existsSync(DIALOG_STATE_PATH)) {
      const state = JSON.parse(fs.readFileSync(DIALOG_STATE_PATH, 'utf-8'));
      return {
        lastFolderPath: state.lastFolderPath || null,
      };
    }
  } catch (e) {
    console.error('Failed to load dialog state:', e);
  }
  return { lastFolderPath: null };
}

function saveDialogState(state) {
  try {
    fs.writeFileSync(DIALOG_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save dialog state:', e);
  }
}

function isSlowDialogPath(folderPath) {
  if (!folderPath) return true;
  const normalized = path.normalize(folderPath);

  // 云盘/网络卷常触发首次枚举卡顿
  if (normalized.includes('/Library/CloudStorage/')) return true;
  if (normalized.includes('/Library/Mobile Documents/')) return true;
  if (normalized.startsWith('/Volumes/')) return true;
  if (normalized.startsWith('/Network/')) return true;

  return false;
}

function resolveDialogDefaultPath() {
  const lastFolderPath = dialogState.lastFolderPath;
  // 先检查是否慢路径，避免 fs.existsSync 在网络/云盘路径上阻塞
  if (lastFolderPath && !isSlowDialogPath(lastFolderPath) && fs.existsSync(lastFolderPath)) {
    return lastFolderPath;
  }

  const downloadsPath = app.getPath('downloads');
  if (downloadsPath && fs.existsSync(downloadsPath)) {
    return downloadsPath;
  }

  return app.getPath('home');
}

// ============================================================================
// ZED DATABASE - 读取工作区路径
// ============================================================================

function parseZedWorkspaces(raw) {
  const mapping = {};
  raw.trim().split('\n').forEach(p => {
    if (!p) return;
    const name = path.basename(p);
    // 如果有同名项目，保留最近使用的（先出现的）
    if (!mapping[name]) {
      mapping[name] = p;
    }
  });
  return mapping;
}

function refreshZedWorkspaces() {
  if (zedWorkspaceRefreshPromise) return zedWorkspaceRefreshPromise;

  zedWorkspaceRefreshPromise = new Promise((resolve) => {
    const sql = 'SELECT paths FROM workspaces WHERE paths IS NOT NULL ORDER BY timestamp DESC;';
    exec(`sqlite3 '${ZED_DB_PATH}' "${sql}"`, (err, stdout) => {
      if (err) {
        console.error('Failed to read Zed database:', err);
        zedWorkspaceRefreshPromise = null;
        return resolve(zedWorkspaceCache.mapping);
      }

      const output = stdout ? stdout.trim() : '';
      const mapping = output ? parseZedWorkspaces(output) : {};
      zedWorkspaceCache = {
        mapping,
        lastUpdated: Date.now(),
      };
      zedWorkspaceRefreshPromise = null;
      resolve(mapping);
    });
  });

  return zedWorkspaceRefreshPromise;
}

function getZedWorkspacesCached() {
  // 返回缓存映射并触发后台刷新，避免阻塞 UI
  const now = Date.now();
  const isStale = !zedWorkspaceCache.lastUpdated
    || (now - zedWorkspaceCache.lastUpdated > ZED_WORKSPACE_CACHE_TTL_MS);

  if (isStale) {
    refreshZedWorkspaces();
  }
  return zedWorkspaceCache.mapping;
}

async function getZedWorkspacesFresh() {
  // 需要可靠映射时使用，等待刷新完成
  const now = Date.now();
  const isStale = !zedWorkspaceCache.lastUpdated
    || (now - zedWorkspaceCache.lastUpdated > ZED_WORKSPACE_CACHE_TTL_MS);

  if (isStale) {
    return await refreshZedWorkspaces();
  }
  return zedWorkspaceCache.mapping;
}

// ============================================================================
// ZED CONTROL (AppleScript)
// ============================================================================

function adjustZedWindows() {
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
  runAppleScript(script);
}

function getZedWindows() {
  return new Promise((resolve) => {
    const script = `tell application "System Events"
      if not (exists process "Zed") then return ""
      tell process "Zed" to get name of every window
    end tell`;
    runAppleScript(script, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      const workspaces = getZedWorkspacesCached();

      let emptyCount = 0;
      const windows = stdout.trim().split(', ')
        .filter(name => name)
        .map(windowName => {
          if (windowName === 'empty project') {
            return {
              windowName: `empty project (${++emptyCount})`,
              path: null,
              displayName: `empty project (${emptyCount})`
            };
          }

          const projectName = windowName.includes(' — ')
            ? windowName.split(' — ')[0]
            : windowName;

          const projectPath = workspaces[projectName] || null;

          return {
            windowName,
            path: projectPath,
            displayName: projectName
          };
        });
      resolve(windows);
    });
  });
}

function activateZedWindowByName(windowName) {
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
    runAppleScript(script);
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
  runAppleScript(script);
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('get-projects', async () => loadProjects());

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

ipcMain.handle('select-folder', async (event) => {
  const t0 = Date.now();
  console.log(`[select-folder] ▶ IPC 收到请求 t=0ms`);

  const { dialog } = require('electron');
  const targetWindow = (event && BrowserWindow.fromWebContents(event.sender)) || mainWindow;
  const previousAlwaysOnTop = targetWindow ? targetWindow.isAlwaysOnTop() : false;

  const defaultPath = resolveDialogDefaultPath();
  console.log(`[select-folder] defaultPath=${defaultPath}`);

  isSystemDialogOpen = true;

  if (targetWindow) {
    targetWindow.setAlwaysOnTop(false);
    targetWindow.show();
    targetWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
  }

  const dialogOptions = {
    properties: ['openDirectory'],
    defaultPath,
    dontAddToRecent: true,
  };

  try {
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    console.log(`[select-folder] 返回 canceled=${result.canceled}`);

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      dialogState = { ...dialogState, lastFolderPath: selectedPath };
      saveDialogState(dialogState);
      return selectedPath;
    }
    return null;
  } finally {
    console.log(`[select-folder] finally 执行`);
    if (targetWindow && !targetWindow.isDestroyed()) {
      targetWindow.setAlwaysOnTop(previousAlwaysOnTop);
    }
    isSystemDialogOpen = false;
  }
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
    if (isSystemDialogOpen) return;

    const script = 'tell application "System Events" to get name of first process whose frontmost is true';
    runAppleScript(script, (err, stdout) => {
      const win = mainWindow;
      if (err || !win || win.isDestroyed()) return;

      const frontApp = stdout.trim().toLowerCase();
      const shouldShow = frontApp === 'zed' || frontApp === 'electron';

      try {
        if (shouldShow && !win.isVisible()) {
          win.showInactive();
          // 设置更高的窗口层级
          win.setAlwaysOnTop(true, 'floating', 1);
          win.setIgnoreMouseEvents(false);
        } else if (!shouldShow && win.isVisible()) {
          win.hide();
        }
      } catch (e) {
        return;
      }

      if (frontApp === 'zed' && lastFrontApp !== 'zed') {
        adjustZedWindows();
      }
      lastFrontApp = frontApp;
    });
  }, 1000);
}

app.whenReady().then(() => {
  createWindow();
  dialogState = loadDialogState();
  startHideCheck();

  // 调试快捷键：Cmd+Shift+D 打开 DevTools
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, async () => {
      const projects = await loadProjects();
      const p = projects[i - 1];
      if (p) {
        const name = p.path ? path.basename(p.path) : p.displayName;
        activateZedWindowByName(name);
      }
    });
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  // 工具类应用：关窗即退出，不留僵尸进程
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
