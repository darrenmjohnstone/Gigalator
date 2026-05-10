const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// ── Path resolution: dev vs packaged ──
//
// In dev (npx electron .) the layout is:
//   Gigalator/
//     manager-app/   ← __dirname
//     manager.html
//     api/
//     songs/, tracks/, sheets/  ← user data lives here too
//
// When packaged as a DMG and installed in /Applications, the bundled
// HTML + API live in process.resourcesPath. The USER DATA folder
// (songs/, tracks/, sheets/, .git) cannot be inside the .app — it's
// the user's local git repo on Desktop. We locate it by trying common
// paths first, falling back to a saved choice via the Open Folder dialog.
const isDev = !app.isPackaged;
const RESOURCES_PATH = isDev ? path.resolve(__dirname, '..') : process.resourcesPath;
const MANAGER_HTML = path.join(RESOURCES_PATH, 'manager.html');
const API_DIR = path.join(RESOURCES_PATH, 'api');
const API_PORT = 3111;

// The data folder (user's git repo). In dev this IS the same as RESOURCES_PATH;
// in packaged mode we look it up.
function findGigalatorDataDir() {
  if (isDev) return RESOURCES_PATH;
  const saved = (function () {
    try {
      const cfg = path.join(app.getPath('userData'), 'config.json');
      if (fs.existsSync(cfg)) return JSON.parse(fs.readFileSync(cfg, 'utf8')).dataDir;
    } catch (_) {}
    return null;
  })();
  const candidates = [
    saved,
    path.join(os.homedir(), 'Desktop', 'Gigalator'),
    path.join(os.homedir(), 'Documents', 'Gigalator'),
    path.join(os.homedir(), 'Gigalator'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'songs', 'songs.json'))) return p;
  }
  return null; // Will prompt user via dialog on first read
}

let GIGALATOR_ROOT = findGigalatorDataDir() || path.resolve(__dirname, '..');

function saveDataDirChoice(p) {
  try {
    const cfg = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ dataDir: p }, null, 2));
  } catch (_) {}
}

let mainWindow;
let apiProcess = null;

// Spawn the local Claude API server so the AI Format button works without
// the user having to remember to launch it manually. We try a few node
// binaries because Electron's bundled node isn't always on PATH and the
// system node may live in different places (Homebrew, nvm, system).
function startApiServer() {
  if (apiProcess) return;
  if (!fs.existsSync(path.join(API_DIR, 'server.js'))) {
    console.warn('[Manager] api/server.js not found — AI Format will fail');
    return;
  }
  if (!fs.existsSync(path.join(API_DIR, 'node_modules'))) {
    console.warn('[Manager] api/node_modules missing — run "npm install" in /api');
  }

  // Find a usable node binary. PATH often misses Homebrew on launchd-spawned apps.
  const candidates = [
    process.env.NODE_BIN,
    'node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);

  function trySpawn(idx) {
    if (idx >= candidates.length) {
      console.error('[Manager] No node binary found — API server NOT started');
      return;
    }
    const bin = candidates[idx];
    try {
      const proc = spawn(bin, ['server.js'], {
        cwd: API_DIR,
        env: { ...process.env, PORT: String(API_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('error', (err) => {
        console.warn('[Manager] node candidate "' + bin + '" failed: ' + err.message);
        if (apiProcess === proc) apiProcess = null;
        trySpawn(idx + 1);
      });
      proc.stdout.on('data', (chunk) => process.stdout.write('[api] ' + chunk));
      proc.stderr.on('data', (chunk) => process.stderr.write('[api] ' + chunk));
      proc.on('exit', (code, signal) => {
        console.log(`[Manager] API server exited (code=${code} signal=${signal})`);
        if (apiProcess === proc) apiProcess = null;
      });
      apiProcess = proc;
      console.log('[Manager] API server started via "' + bin + '" (PID ' + proc.pid + ')');
    } catch (e) {
      console.warn('[Manager] spawn failed for "' + bin + '": ' + e.message);
      trySpawn(idx + 1);
    }
  }

  trySpawn(0);
}

function stopApiServer() {
  if (!apiProcess) return;
  try {
    apiProcess.kill('SIGTERM');
    // Hard kill if it doesn't go quietly
    setTimeout(() => {
      if (apiProcess && !apiProcess.killed) {
        try { apiProcess.kill('SIGKILL'); } catch (_) {}
      }
    }, 2000);
  } catch (e) {
    console.warn('[Manager] failed to stop API server: ' + e.message);
  }
  apiProcess = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Gigalator Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load manager.html — from project root in dev, from packaged resources otherwise
  mainWindow.loadFile(MANAGER_HTML);

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  startApiServer();
  createWindow();
});

app.on('window-all-closed', () => {
  stopApiServer();
  app.quit();
});

// Belt-and-suspenders: also stop the API server on hard quits + crashes
app.on('before-quit', stopApiServer);
process.on('exit', stopApiServer);
process.on('SIGINT', () => { stopApiServer(); process.exit(0); });
process.on('SIGTERM', () => { stopApiServer(); process.exit(0); });

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC Handlers ──

// Resolve a relative path to absolute within the Gigalator root
function resolvePath(relPath) {
  const resolved = path.resolve(GIGALATOR_ROOT, relPath);
  // Security: ensure it stays within the Gigalator root
  if (!resolved.startsWith(GIGALATOR_ROOT)) {
    throw new Error('Path escapes project root');
  }
  return resolved;
}

ipcMain.handle('fs:getGigalatorPath', () => {
  return GIGALATOR_ROOT;
});

ipcMain.handle('fs:readTextFile', async (event, relPath) => {
  const fullPath = resolvePath(relPath);
  return fs.readFileSync(fullPath, 'utf8');
});

ipcMain.handle('fs:writeTextFile', async (event, relPath, text) => {
  const fullPath = resolvePath(relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, text, 'utf8');
});

ipcMain.handle('fs:readBinaryFile', async (event, relPath) => {
  const fullPath = resolvePath(relPath);
  const buffer = fs.readFileSync(fullPath);
  return buffer; // Electron serializes Buffer via structured clone
});

ipcMain.handle('fs:writeBinaryFile', async (event, relPath, data) => {
  const fullPath = resolvePath(relPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // data comes as ArrayBuffer or Buffer from renderer
  fs.writeFileSync(fullPath, Buffer.from(data));
});

ipcMain.handle('fs:deleteFile', async (event, relPath) => {
  const fullPath = resolvePath(relPath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
});

ipcMain.handle('fs:fileExists', async (event, relPath) => {
  const fullPath = resolvePath(relPath);
  return fs.existsSync(fullPath);
});

ipcMain.handle('fs:ensureDir', async (event, relPath) => {
  const fullPath = resolvePath(relPath);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

ipcMain.handle('dialog:pickFile', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const name = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);

  return {
    name: name,
    data: buffer, // Buffer is serialized via structured clone
  };
});

// ── Git Deploy ──
function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: GIGALATOR_ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ── API key management ──
// Reads/writes ANTHROPIC_API_KEY to api/.env. After a write, restarts
// the API server child process so the new key takes effect immediately.
const ENV_PATH = path.join(API_DIR, '.env');

function readApiKey() {
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const m = content.match(/ANTHROPIC_API_KEY\s*=\s*(.+)/);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

function writeApiKey(key) {
  let content = '';
  try {
    if (fs.existsSync(ENV_PATH)) content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (_) {}
  // Replace existing line or append
  if (/ANTHROPIC_API_KEY\s*=/.test(content)) {
    content = content.replace(/ANTHROPIC_API_KEY\s*=.*/g, 'ANTHROPIC_API_KEY=' + key);
  } else {
    if (content && !content.endsWith('\n')) content += '\n';
    content += 'ANTHROPIC_API_KEY=' + key + '\n';
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

ipcMain.handle('settings:getApiKey', () => readApiKey());

ipcMain.handle('settings:setApiKey', async (event, key) => {
  writeApiKey((key || '').trim());
  // Bounce the API server so it picks up the new key
  stopApiServer();
  // Brief gap so the port is fully released
  await new Promise(r => setTimeout(r, 300));
  startApiServer();
  return { ok: true };
});

ipcMain.handle('git:deploy', async () => {
  const MAX_RETRIES = 3;

  // Stage all changes (songs, tracks, sheets, etc.)
  await runGit(['add', '-A']);

  // Check if there are changes to commit
  const status = await runGit(['status', '--porcelain']);
  if (!status) {
    return { success: true, message: 'Nothing to deploy — already up to date' };
  }

  // Commit
  const date = new Date().toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  await runGit(['commit', '-m', `Update songs — ${date}`]);

  // Push with retries (handles remote conflicts, network hiccups)
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Pull rebase first to handle any remote changes
      try {
        await runGit(['pull', '--rebase']);
      } catch (e) {
        // If rebase conflicts, abort and retry fresh
        try { await runGit(['rebase', '--abort']); } catch (_) {}
        if (attempt < MAX_RETRIES) {
          console.warn(`Pull rebase failed (attempt ${attempt}), retrying...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }

      await runGit(['push']);
      return { success: true, message: 'Deployed to iPad app' };
    } catch (e) {
      lastError = e;
      console.warn(`Push failed (attempt ${attempt}/${MAX_RETRIES}):`, e.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw lastError || new Error('Deploy failed after ' + MAX_RETRIES + ' attempts');
});
