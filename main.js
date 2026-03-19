/**
 * [INPUT]: electron - Electron 框架
 * [INPUT]: AppleScript + lsappinfo - macOS 窗口控制与真实前台应用探测
 * [INPUT]: Zed SQLite DB - 异步读取并缓存工作区路径信息
 * [INPUT]: dialog_state.json - 记录上次选择的目录，用于系统对话框 defaultPath（避开慢路径）
 * [OUTPUT]: 主进程，创建悬浮标签栏窗口，提供 IPC 接口与当前激活项目同步（含系统对话框前置处理、默认路径优化与真实前台应用判定）
 * [POS]: 应用入口，管理窗口生命周期、IPC 通信、智能切换 Zed 窗口，并把真实前台项目状态同步给渲染层，规避 Electron 悬浮窗误报前台
 *
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
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
const SQLITE_TIMEOUT_MS = 2000;
const HIDE_CHECK_INTERVAL_MS = 1000;
const ZED_ADJUST_DEBOUNCE_MS = 1500;
const FRONT_STATE_SEPARATOR = '||';
const LSAPPINFO_FRONT_COMMAND = 'lsappinfo info "$(lsappinfo front | tr -d \'\\n\')"';
const ZED_FRONT_WINDOW_NAME_SCRIPT = `tell application "System Events"\ntell process "Zed"\nif (count of windows) > 0 then return name of front window\nend tell\nend tell`;
let mainWindow = null;
let isSystemDialogOpen = false;
let dialogState = { lastFolderPath: null };
let zedWorkspaceCache = { mapping: {}, lastUpdated: 0 };
let zedWorkspaceRefreshPromise = null;
let projectsMemoryCache = null;
let hideCheckTimer = null;
let activeProject = null;
// ============================================================================
// APPLESCRIPT EXECUTOR - 双通道队列，用户操作优先，轮询可丢弃
// ============================================================================
const userQueue = [];   // 用户操作：不可丢弃，优先执行
const pollQueue = [];   // 轮询任务：可丢弃，新任务替换旧任务
let isScriptRunning = false;
function removeQueuedScriptsByTag(tag) {
  if (!tag) return;
  for (let i = userQueue.length - 1; i >= 0; i--) {
    if (userQueue[i].tag === tag) userQueue.splice(i, 1);
  }
  for (let i = pollQueue.length - 1; i >= 0; i--) {
    if (pollQueue[i].tag === tag) pollQueue.splice(i, 1);
  }
}
function runAppleScript(script, callback, options = {}) {
  const { priority = 'user', droppable = false, prepend = false, tag = null, replaceTag = false } = options;
  if (replaceTag && tag) removeQueuedScriptsByTag(tag);
  const entry = { script, callback, tag };
  if (priority === 'poll') {
    if (droppable) pollQueue.length = 0;
    pollQueue.push(entry);
  } else if (prepend) {
    userQueue.unshift(entry);
  } else {
    userQueue.push(entry);
  }
  processScriptQueue();
}
function runAppleScriptPromise(script, options = {}) {
  return new Promise((resolve, reject) => {
    runAppleScript(script, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    }, options);
  });
}
function processScriptQueue() {
  if (isScriptRunning) return;
  // 用户队列优先
  const task = userQueue.shift() || pollQueue.shift();
  if (!task) return;
  isScriptRunning = true;
  const { script, callback } = task;
  const child = spawn('osascript', ['-e', script]);
  let stdout = '';
  let stderr = '';
  let killed = false;
  let callbackCalled = false;
  // 安全回调：close + error 都可能触发，只调用一次
  function safeCallback(err, result) {
    if (callbackCalled) return;
    callbackCalled = true;
    clearTimeout(timeout);
    isScriptRunning = false;
    callback && callback(err, result);
    setImmediate(processScriptQueue);
  }
  const timeout = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, OSASCRIPT_TIMEOUT_MS);
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('close', (code) => {
    if (killed) return safeCallback(new Error('timeout'), '');
    if (code !== 0) return safeCallback(new Error(stderr), '');
    safeCallback(null, stdout);
  });
  child.on('error', (err) => {
    safeCallback(err, '');
  });
}
function getFrontState(callback) {
  const child = spawn('sh', ['-lc', LSAPPINFO_FRONT_COMMAND]);
  let stdout = '';
  let stderr = '';
  let killed = false;
  let callbackCalled = false;
  const safeCallback = (err, result) => {
    if (callbackCalled) return;
    callbackCalled = true;
    clearTimeout(timeout);
    callback(err, result);
  };
  const timeout = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, OSASCRIPT_TIMEOUT_MS);
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('close', (code) => {
    if (killed) return safeCallback(new Error('timeout'));
    if (code !== 0) return safeCallback(new Error(stderr || 'lsappinfo failed'));
    const match = stdout.match(/^"([^"]+)".*?\bpid = (\d+)/ms);
    if (!match) return safeCallback(new Error('invalid lsappinfo output'));
    const frontApp = match[1];
    const frontPid = Number(match[2]);
    if (frontApp !== 'Zed') return safeCallback(null, { frontApp, frontPid, frontWindowName: '' });
    runAppleScript(ZED_FRONT_WINDOW_NAME_SCRIPT, (err, output) => {
      safeCallback(err, { frontApp, frontPid, frontWindowName: (output || '').trim() });
    }, { priority: 'poll', droppable: true, tag: 'front-zed-window', replaceTag: true });
  });
  child.on('error', (err) => {
    safeCallback(err);
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
  if (projectsMemoryCache) return projectsMemoryCache;

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const rawProjects = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const sourceProjects = Array.isArray(rawProjects) ? rawProjects : [];

      // 数据迁移：旧格式 { name } -> 新格式 { path, displayName }
      const needsMigration = sourceProjects.some(p => (
        p && p.name && !p.path && !p.displayName
      ));
      const workspaces = needsMigration ? await getZedWorkspacesFresh() : null;

      const projects = sourceProjects.map(p => {
        if (p.name && !p.path && !p.displayName) {
          // 旧格式，需要迁移
          const projectPath = workspaces ? (workspaces[p.name] || null) : null;
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

      projectsMemoryCache = projects;
      return projects;
    }
  } catch (e) {
    console.error('Failed to load projects:', e);
  }
  projectsMemoryCache = [];
  return projectsMemoryCache;
}

function saveProjects(projects) {
  projectsMemoryCache = Array.isArray(projects) ? projects : [];
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(projectsMemoryCache, null, 2));
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

function readZedWorkspaceRowsWithTimeout(timeoutMs = SQLITE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sql = 'SELECT paths FROM workspaces WHERE paths IS NOT NULL ORDER BY timestamp DESC;';
    const child = spawn('sqlite3', [ZED_DB_PATH, sql]);
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('sqlite timeout'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || `sqlite exit code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function refreshZedWorkspaces() {
  if (zedWorkspaceRefreshPromise) return zedWorkspaceRefreshPromise;

  zedWorkspaceRefreshPromise = new Promise((resolve) => {
    readZedWorkspaceRowsWithTimeout()
      .then((stdout) => {
        const output = stdout ? stdout.trim() : '';
        const mapping = output ? parseZedWorkspaces(output) : {};
        zedWorkspaceCache = {
          mapping,
          lastUpdated: Date.now(),
        };
        resolve(mapping);
      })
      .catch((err) => {
        console.error('Failed to read Zed database:', err);
        resolve(zedWorkspaceCache.mapping);
      })
      .finally(() => {
        zedWorkspaceRefreshPromise = null;
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
  runAppleScript(script, null, { tag: 'adjust-zed-windows', replaceTag: true });
}

function toAppleScriptString(value) {
  const normalized = String(value || '');
  const escaped = normalized
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function openProjectPathInZed(projectPath) {
  return new Promise((resolve) => {
    if (!projectPath) return resolve(false);

    const child = spawn('open', ['-a', 'Zed', projectPath]);
    child.on('error', (err) => {
      console.error('Failed to open project in Zed:', err);
      resolve(false);
    });
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

function getActiveProjectFromWindowName(windowName) {
  if (!windowName) return null;
  if (windowName === 'empty project') return { path: null, displayName: 'empty project' };
  const displayName = windowName.includes(' — ') ? windowName.split(' — ')[0] : windowName;
  return { path: getZedWorkspacesCached()[displayName] || null, displayName };
}

function syncActiveProject(project) {
  const nextProject = project || null;
  if (
    (activeProject && nextProject &&
      activeProject.path === nextProject.path &&
      activeProject.displayName === nextProject.displayName) ||
    (!activeProject && !nextProject)
  ) return;
  activeProject = nextProject;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('active-project-changed', activeProject);
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

async function activateZedWindowByName(windowName) {
  if (!windowName) return false;

  const match = windowName.match(/^empty project \((\d+)\)$/);
  if (match) {
    const index = parseInt(match[1], 10);
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
    try {
      const output = await runAppleScriptPromise(script, {
        prepend: true,
        tag: 'activate-zed-window',
        replaceTag: true
      });
      return output.trim() === 'activated';
    } catch (err) {
      return false;
    }
  }

  const exactName = toAppleScriptString(windowName);
  const prefixName = toAppleScriptString(`${windowName} — `);
  const script = `tell application "System Events"
    tell process "Zed"
      repeat with w in every window
        if name of w is ${exactName} or name of w starts with ${prefixName} then
          perform action "AXRaise" of w
          set frontmost to true
          return "activated"
        end if
      end repeat
    end tell
  end tell`;
  try {
    const output = await runAppleScriptPromise(script, {
      prepend: true,
      tag: 'activate-zed-window',
      replaceTag: true
    });
    return output.trim() === 'activated';
  } catch (err) {
    return false;
  }
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

ipcMain.handle('get-projects', async () => loadProjects());

ipcMain.handle('save-projects', (_, projects) => {
  saveProjects(projects);
  return true;
});

ipcMain.handle('open-project', async (_, pathOrName) => {
  if (!pathOrName) {
    return {
      ok: false,
      activated: false,
      opened: false,
      message: '项目信息为空，无法打开'
    };
  }

  // 有路径：先激活同名已打开窗口；如果没有匹配到，则自动打开该路径
  if (pathOrName.startsWith('/')) {
    const projectPath = pathOrName;
    const projectName = path.basename(projectPath);
    const activated = await activateZedWindowByName(projectName);

    if (activated) {
      return { ok: true, activated: true, opened: false, message: '' };
    }

    const opened = await openProjectPathInZed(projectPath);
    if (opened) {
      return { ok: true, activated: false, opened: true, message: '' };
    }
    return {
      ok: false,
      activated: false,
      opened: false,
      message: `未找到已打开窗口，且新开项目失败：${projectName}`
    };
  }

  // 无路径：只能按窗口名激活
  const activated = await activateZedWindowByName(pathOrName);
  if (activated) {
    return { ok: true, activated: true, opened: false, message: '' };
  }
  return {
    ok: false,
    activated: false,
    opened: false,
    message: `未找到已打开窗口：${pathOrName}`
  };
});

ipcMain.handle('get-zed-windows', () => getZedWindows());
ipcMain.handle('get-active-project', () => activeProject);

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

ipcMain.handle('open-folder-in-zed', async (_, folderPath) => {
  await openProjectPathInZed(folderPath);
  return path.basename(folderPath);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

function startHideCheck() {
  let lastFrontApp = '';
  let isPollInFlight = false;
  let lastAdjustAt = 0;

  hideCheckTimer = setInterval(() => {
    if (isSystemDialogOpen) return;
    // 上次轮询还没返回，跳过本次
    if (isPollInFlight) return;

    isPollInFlight = true;
    getFrontState((err, frontState) => {
      isPollInFlight = false;
      const win = mainWindow;
      if (err || !win || win.isDestroyed()) return;

      const frontApp = String(frontState.frontApp || '').trim().toLowerCase();
      const frontPid = Number(frontState.frontPid);
      const frontWindowName = String(frontState.frontWindowName || '');
      const shouldShow = frontApp === 'zed' || frontPid === process.pid;

      if (frontApp === 'zed') {
        syncActiveProject(getActiveProjectFromWindowName(frontWindowName.trim()));
      }

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
        const now = Date.now();
        if (now - lastAdjustAt >= ZED_ADJUST_DEBOUNCE_MS) {
          lastAdjustAt = now;
          adjustZedWindows();
        }
      }
      lastFrontApp = frontApp;
    });
  }, HIDE_CHECK_INTERVAL_MS);
}

function stopHideCheck() {
  if (hideCheckTimer) {
    clearInterval(hideCheckTimer);
    hideCheckTimer = null;
  }
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
        const activated = await activateZedWindowByName(name);
        if (!activated && p.path) {
          await openProjectPathInZed(p.path);
        }
      }
    });
  }
});

app.on('window-all-closed', () => {
  stopHideCheck();
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
  stopHideCheck();
  globalShortcut.unregisterAll();
});
