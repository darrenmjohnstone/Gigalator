const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// Pin the app name so dev (npx electron .) and packaged DMG use the SAME
// userData folder. Without this, dev reads from "gigalator-manager" and
// packaged reads from "Gigalator Manager" — the API key set in one
// doesn't appear in the other.
app.setName('Gigalator Manager');

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

function readConfig() {
  try {
    const cfg = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(cfg)) return JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch (_) {}
  return {};
}

function writeConfig(patch) {
  try {
    const cfg = path.join(app.getPath('userData'), 'config.json');
    const current = readConfig();
    const merged = { ...current, ...patch };
    fs.writeFileSync(cfg, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.warn('[Manager] writeConfig failed: ' + e.message);
  }
}

function saveDataDirChoice(p) {
  writeConfig({ dataDir: p });
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
      // Pass the API key directly via env so the server doesn't have to
      // depend on the .env file (which is unreliable inside the packaged
      // .app bundle — gets blown away on updates, may be read-only).
      const storedKey = readConfig().anthropicApiKey || readApiKeyFromEnv() || '';
      const proc = spawn(bin, ['server.js'], {
        cwd: API_DIR,
        env: {
          ...process.env,
          PORT: String(API_PORT),
          ANTHROPIC_API_KEY: storedKey,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('error', (err) => {
        console.warn('[Manager] node candidate "' + bin + '" failed: ' + err.message);
        if (apiProcess === proc) apiProcess = null;
        trySpawn(idx + 1);
      });
      // Mirror stdout/stderr to both the parent console AND a log file in
      // userData. The log file is the only way to diagnose startup failures
      // when the Manager is launched from Finder (no Terminal attached).
      let apiLogStream = null;
      try {
        const logPath = path.join(app.getPath('userData'), 'api-server.log');
        apiLogStream = fs.createWriteStream(logPath, { flags: 'a' });
        apiLogStream.write('\n=== API server start ' + new Date().toISOString() + ' (' + bin + ') ===\n');
      } catch (_) {}
      proc.stdout.on('data', (chunk) => {
        process.stdout.write('[api] ' + chunk);
        if (apiLogStream) try { apiLogStream.write(chunk); } catch (_) {}
      });
      proc.stderr.on('data', (chunk) => {
        process.stderr.write('[api] ' + chunk);
        if (apiLogStream) try { apiLogStream.write(chunk); } catch (_) {}
      });
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
  migrateLegacyKey();
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
// Primary storage: Electron's userData/config.json (survives DMG updates,
// always writable, isolated per-user). The api/.env file is only read as
// a one-time migration source for users who set their key under the old
// scheme — and in dev mode, written so `node server.js` standalone works.
const ENV_PATH = path.join(API_DIR, '.env');

function readApiKeyFromEnv() {
  // Probe both the bundled api/.env (next to server.js — useful in dev)
  // and the user's actual repo at GIGALATOR_ROOT/api/.env (where keys
  // from before this rework still live). First non-empty match wins.
  const probes = [
    ENV_PATH,
    GIGALATOR_ROOT ? path.join(GIGALATOR_ROOT, 'api', '.env') : null,
  ].filter(Boolean);
  for (const p of probes) {
    try {
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      const m = content.match(/ANTHROPIC_API_KEY\s*=\s*(.+)/);
      const key = m ? m[1].trim() : '';
      if (key) return key;
    } catch (_) { /* try next */ }
  }
  return '';
}

// One-time migration: if our config is empty, look for a key that was
// saved under the OLD dev-mode userData folder name ("gigalator-manager")
// before we pinned app.setName(). Copy it forward so the user doesn't
// have to retype it after installing the DMG.
function migrateLegacyKey() {
  try {
    if (readConfig().anthropicApiKey) return; // already have one

    // Source 1: legacy userData folder (dev-mode app name before pinning)
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    const legacyPath = path.join(appSupport, 'gigalator-manager', 'config.json');
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (legacy && legacy.anthropicApiKey) {
        writeConfig({ anthropicApiKey: legacy.anthropicApiKey });
        console.log('[Manager] migrated API key from legacy userData folder');
        return;
      }
    }

    // Source 2: api/.env in the user's actual repo. This catches keys
    // that were set the old way (before we moved storage to userData) —
    // packaged builds don't see api/.env at all, so without this migration
    // the user has to retype the key after installing the DMG.
    const repoEnv = readApiKeyFromEnv();
    if (repoEnv) {
      writeConfig({ anthropicApiKey: repoEnv });
      console.log('[Manager] migrated API key from api/.env');
    }
  } catch (e) {
    console.warn('[Manager] legacy migration failed: ' + e.message);
  }
}

function readApiKey() {
  // Prefer userData config; fall back to api/.env (migration / dev convenience)
  const fromConfig = readConfig().anthropicApiKey;
  if (fromConfig) return fromConfig;
  return readApiKeyFromEnv();
}

function writeApiKey(key) {
  // Primary store: userData config — persists across app updates
  writeConfig({ anthropicApiKey: key });
  // Secondary: api/.env so a standalone `node server.js` (dev fallback) still works.
  // Best-effort — failing here is non-fatal because the spawned server gets the
  // key via env var directly.
  try {
    let content = '';
    if (fs.existsSync(ENV_PATH)) content = fs.readFileSync(ENV_PATH, 'utf8');
    if (/ANTHROPIC_API_KEY\s*=/.test(content)) {
      content = content.replace(/ANTHROPIC_API_KEY\s*=.*/g, 'ANTHROPIC_API_KEY=' + key);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += 'ANTHROPIC_API_KEY=' + key + '\n';
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  } catch (e) {
    console.warn('[Manager] could not mirror key to api/.env (ok — using env var): ' + e.message);
  }
}

ipcMain.handle('settings:getApiKey', () => readApiKey());
ipcMain.handle('settings:hasApiKey', () => Boolean(readApiKey()));

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

// ── Audio processing (Mono Songs / Normalise Songs) ──
//
// Both operations walk every track referenced in songs.json, skip already-
// processed files (state recorded in audio-state.json at repo root), and
// re-encode through ffmpeg with the safe pattern from fix-ios16-track.sh:
//   1. Back up original to tracks/_original_stereo/ or tracks/_pre_normalise/
//   2. Encode to a .tmp file
//   3. Only `mv` over the original if ffmpeg succeeded AND output is non-zero
//   4. On any failure, leave the original untouched
//
// Progress is streamed to the renderer via 'audio:progress' webContents events.

// v2: switched away from loudnorm pass-2 (whose envelope-follower causes an
// audible ramp at the start of quiet songs when linear mode silently falls
// back to dynamic). Now uses measure→single-gain→limiter, which is ramp-free.
// Bumping the version reprocesses every track on the next Normalise run.
const NORMALISE_VERSION = 'v3'; // algorithm version — bump if filter chain changes structurally

// Normalisation parameters — defaults can be overridden by the user from the
// Settings modal and are persisted in userData/config.json under "normaliseParams".
// Each track's stamp records the exact params it was processed with, so the
// status check can detect "params changed → needs re-normalise".
// Defaults tuned for live-gig backing tracks through a column PA (e.g. EV
// Evolve 50) at moderate-volume venues. Goal: consistent song-to-song level
// without audibly compressed-sounding material. The PA has its own limiter
// so we leave headroom (-12 LUFS not -10) and use gentle compression that
// only touches the loud chorus peaks (threshold -18, ratio 1.5).
const DEFAULT_NORMALISE_PARAMS = {
  I: -12,         // target loudness (LUFS) — -16 (quiet) to -6 (loud)
  ratio: 1.5,     // compressor ratio (1 = none, 6 = heavy)
  threshold: -18, // compressor threshold (dB) — only signal above this gets compressed
};

function getNormaliseParams() {
  const saved = readConfig().normaliseParams || {};
  // Merge defaults with saved so newly-added fields don't break old configs
  return { ...DEFAULT_NORMALISE_PARAMS, ...saved };
}

function paramsMatch(a, b) {
  if (!a || !b) return false;
  return a.I === b.I && a.ratio === b.ratio && a.threshold === b.threshold;
}
const AUDIO_STATE_FILE = 'audio-state.json'; // at GIGALATOR_ROOT, tracked in git
const MONO_BACKUP_DIR = 'tracks/_original_stereo';
const NORM_BACKUP_DIR = 'tracks/_pre_normalise';

// Bundled binaries via ffmpeg-static / ffprobe-static. When the app is
// packaged with asar, these paths point INTO the asar archive and can't
// be exec'd directly — Electron's asarUnpack rewrites the path at runtime
// so we just patch ".asar/" → ".asar.unpacked/" if needed.
function resolveBundled(rawPath) {
  if (!rawPath) return null;
  const unpacked = rawPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  if (fs.existsSync(unpacked)) return unpacked;
  if (fs.existsSync(rawPath)) return rawPath;
  return null;
}

let _ffmpegBundled = null, _ffprobeBundled = null;
try { _ffmpegBundled = resolveBundled(require('ffmpeg-static')); } catch (_) {}
try { _ffprobeBundled = resolveBundled(require('ffprobe-static').path); } catch (_) {}

function findBinary(name) {
  // 1) Bundled static binary (always preferred — works on machines without Homebrew)
  if (name === 'ffmpeg' && _ffmpegBundled) return _ffmpegBundled;
  if (name === 'ffprobe' && _ffprobeBundled) return _ffprobeBundled;

  // 2) Env-var override (dev escape hatch)
  const envOverride = process.env[name.toUpperCase() + '_BIN'];
  if (envOverride && fs.existsSync(envOverride)) return envOverride;

  // 3) Common system locations (Homebrew, MacPorts, system)
  const absoluteCandidates = [
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/opt/local/bin/' + name,
    '/usr/bin/' + name,
  ];
  for (const p of absoluteCandidates) {
    if (fs.existsSync(p)) return p;
  }
  return name; // last resort — relies on PATH
}

function audioStatePath() {
  return path.join(GIGALATOR_ROOT, AUDIO_STATE_FILE);
}

function readAudioState() {
  try {
    const p = audioStatePath();
    if (!fs.existsSync(p)) return { version: 1, tracks: {} };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed.tracks) parsed.tracks = {};
    return parsed;
  } catch (e) {
    console.warn('[audio] state file unreadable, starting fresh: ' + e.message);
    return { version: 1, tracks: {} };
  }
}

function writeAudioState(state) {
  fs.writeFileSync(audioStatePath(), JSON.stringify(state, null, 2));
}

// Track-fingerprint: if the file's size+mtime differs from what we stamped,
// it's been replaced and prior stamps are invalid. This guards against
// "I re-uploaded a track and now it's stale".
function fingerprint(absPath) {
  const st = fs.statSync(absPath);
  return { size: st.size, mtime: Math.floor(st.mtimeMs) };
}

function stampMatches(stamp, fp) {
  if (!stamp) return false;
  return stamp.size === fp.size && stamp.mtime === fp.mtime;
}

// Run ffmpeg/ffprobe with stdio captured. Resolves with stdout; rejects
// with stderr on non-zero exit.
// Distil ffmpeg/ffprobe stderr down to the first useful error line —
// the full output is hundreds of lines of banner + library versions and
// blows up dialogs in the UI. We pick the first line that looks like an
// actual error message, then truncate.
function distilFfError(stderr, fallback) {
  if (!stderr) return fallback || 'unknown ffmpeg error';
  const lines = String(stderr).split('\n');
  const signal = lines.find((l) =>
    /error|invalid|unable to|failed|no such|not found|denied|refus/i.test(l) &&
    !/^ffmpeg version|^\s*built with|^\s*configuration:|^\s*lib(av|sw)/i.test(l)
  );
  const pick = (signal || lines[lines.length - 1] || '').trim();
  return pick.length > 200 ? pick.slice(0, 200) + '…' : (pick || (fallback || 'ffmpeg failed'));
}

function runFfBinary(binPath, args) {
  return new Promise((resolve, reject) => {
    execFile(binPath, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(distilFfError(stderr, err.message)));
      else resolve(stdout);
    });
  });
}

async function getChannelCount(ffprobeBin, absPath) {
  const out = await runFfBinary(ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=channels',
    '-of', 'csv=p=0',
    absPath,
  ]);
  return parseInt(out.trim(), 10) || 0;
}

// Auto-rename a non-mp3 track to .mp3 across the whole project:
//   - the file in tracks/
//   - every reference in songs.json (preserves the rest of the JSON verbatim)
//   - the key in audio-state.json
//   - any sibling file in tracks/_original_stereo/ and tracks/_pre_normalise/
// Returns the new relPath (or the original if no rename was needed).
// Throws if a destination collision would occur — caller decides what to do.
function ensureMp3Extension(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.mp3' || ext === '') return relPath;

  const absPath = path.join(GIGALATOR_ROOT, relPath);
  if (!fs.existsSync(absPath)) return relPath; // missing file — caller will surface a useful error

  const newRelPath = relPath.slice(0, -ext.length) + '.mp3';
  const newAbsPath = path.join(GIGALATOR_ROOT, newRelPath);
  if (fs.existsSync(newAbsPath)) {
    throw new Error('cannot auto-rename to ' + newRelPath + ' — destination already exists');
  }

  // 1) Rename the file
  fs.renameSync(absPath, newAbsPath);

  // 2) Update songs.json (string replace inside quotes — preserves field order, comments-style, etc.)
  const songsJsonPath = path.join(GIGALATOR_ROOT, 'songs', 'songs.json');
  if (fs.existsSync(songsJsonPath)) {
    const before = fs.readFileSync(songsJsonPath, 'utf8');
    const after = before.split('"' + relPath + '"').join('"' + newRelPath + '"');
    if (after !== before) fs.writeFileSync(songsJsonPath, after, 'utf8');
  }

  // 3) Update audio-state.json key
  const state = readAudioState();
  if (state.tracks[relPath]) {
    state.tracks[newRelPath] = state.tracks[relPath];
    delete state.tracks[relPath];
    writeAudioState(state);
  }

  // 4) Rename backups so future Remove operations still find them
  for (const subdir of [MONO_BACKUP_DIR, NORM_BACKUP_DIR]) {
    const oldBackup = path.join(GIGALATOR_ROOT, subdir, path.basename(relPath));
    const newBackup = path.join(GIGALATOR_ROOT, subdir, path.basename(newRelPath));
    if (fs.existsSync(oldBackup) && !fs.existsSync(newBackup)) {
      try { fs.renameSync(oldBackup, newBackup); } catch (_) {}
    }
  }

  console.log('[audio] auto-renamed ' + relPath + ' → ' + newRelPath);
  return newRelPath;
}

// Pre-pass: bulk-rename any non-mp3 tracks before processing. Emits its
// progress through the same channel so the user sees "Renaming X..." rather
// than a confusing silent gap before the first track starts processing.
function autoRenameNonMp3(event, allTracks) {
  const renames = [];
  for (const relPath of allTracks) {
    const ext = path.extname(relPath).toLowerCase();
    if (ext === '.mp3' || ext === '') continue;
    try {
      emitProgress(event, { phase: 'rename', name: path.basename(relPath) });
      const newPath = ensureMp3Extension(relPath);
      if (newPath !== relPath) renames.push({ old: relPath, new: newPath });
    } catch (e) {
      console.warn('[audio] skip rename for ' + relPath + ': ' + e.message);
    }
  }
  if (renames.length) {
    console.log('[audio] auto-renamed ' + renames.length + ' non-mp3 tracks before processing');
  }
  return renames;
}

// Collect every unique relative track path from songs.json
function getAllTrackRelPaths() {
  const songsJsonPath = path.join(GIGALATOR_ROOT, 'songs', 'songs.json');
  const data = JSON.parse(fs.readFileSync(songsJsonPath, 'utf8'));
  const seen = new Set();
  Object.values(data.songs || {}).forEach((s) => {
    if (s && s.track && typeof s.track === 'string') seen.add(s.track);
  });
  return Array.from(seen).sort();
}

function emitProgress(event, payload) {
  try { event.sender.send('audio:progress', payload); } catch (_) {}
}

// Safe re-encode helper. Backs up to backupDir, encodes via ffmpeg args,
// only swaps the original on success.
async function safeReencode(ffmpegBin, absPath, backupDir, ffmpegArgs) {
  const name = path.basename(absPath);
  const backupAbs = path.join(GIGALATOR_ROOT, backupDir, name);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });

  if (!fs.existsSync(backupAbs)) fs.copyFileSync(absPath, backupAbs);

  // Refuse to operate on a corrupt backup
  if (fs.statSync(backupAbs).size === 0) {
    throw new Error('backup is zero bytes — refusing to encode');
  }

  // Keep the .mp3 extension on the temp file so ffmpeg can infer the output
  // format from the filename — without this it errors with "Unable to choose
  // an output format".
  const tmpPath = absPath + '.reencode.tmp.mp3';
  try { fs.unlinkSync(tmpPath); } catch (_) {}

  try {
    // Always read from the backup (the canonical original) so successive
    // ops don't compound losses, e.g. mono then normalise.
    const args = ['-y', '-i', backupAbs, ...ffmpegArgs, tmpPath];
    await runFfBinary(ffmpegBin, args);
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      throw new Error('ffmpeg produced zero-byte output');
    }
    fs.renameSync(tmpPath, absPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

// ── Mono ──
ipcMain.handle('audio:monoAll', async (event) => {
  const ffmpegBin = findBinary('ffmpeg');
  const ffprobeBin = findBinary('ffprobe');
  // Pre-pass: rename any non-mp3 tracks (e.g. user-added .m4a files) so iOS
  // Safari plays them reliably. Re-reads tracks AFTER rename so the loop
  // works with the post-rename paths.
  autoRenameNonMp3(event, getAllTrackRelPaths());
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();

  let converted = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tracks.length; i++) {
    const relPath = tracks[i];
    const absPath = path.join(GIGALATOR_ROOT, relPath);

    emitProgress(event, { phase: 'mono', current: i + 1, total: tracks.length, name: path.basename(relPath) });

    if (!fs.existsSync(absPath)) { skipped++; continue; }

    try {
      const fp = fingerprint(absPath);
      const stamp = state.tracks[relPath];

      // Skip if already stamped mono AND file hasn't changed
      if (stamp && stamp.mono && stampMatches(stamp, fp)) { skipped++; continue; }

      // Also skip via ffprobe — if file is already 1-channel, just stamp it
      const channels = await getChannelCount(ffprobeBin, absPath);
      if (channels === 1) {
        state.tracks[relPath] = { ...(stamp || {}), mono: true, ...fingerprint(absPath) };
        writeAudioState(state);
        skipped++;
        continue;
      }

      // Convert to mono, 128k CBR, iOS16-safe headers (same flags as fix-ios16-track.sh).
      // -vn drops any attached album-art image streams which would otherwise
      // break the mp3 muxer with "Could not write header (incorrect codec parameters)".
      await safeReencode(ffmpegBin, absPath, MONO_BACKUP_DIR, [
        '-vn',
        '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', '44100',
        '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1',
        '-fflags', '+bitexact', '-flags', '+bitexact',
      ]);
      state.tracks[relPath] = { ...(stamp || {}), mono: true, ...fingerprint(absPath) };
      // Normalisation stamp is invalid now — file content changed
      delete state.tracks[relPath].normalised;
      writeAudioState(state);
      converted++;
    } catch (e) {
      console.error('[audio:mono] failed for ' + relPath + ': ' + e.message);
      failed++;
      failures.push({ track: relPath, error: e.message });
    }
  }

  emitProgress(event, { phase: 'mono', done: true });
  return { converted, skipped, failed, failures, total: tracks.length };
});

// ── Normalise ──
// Two-pass loudnorm: pass 1 measures the file, pass 2 applies correction.
ipcMain.handle('audio:normaliseAll', async (event) => {
  const ffmpegBin = findBinary('ffmpeg');
  autoRenameNonMp3(event, getAllTrackRelPaths());
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();

  let processed = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tracks.length; i++) {
    const relPath = tracks[i];
    const absPath = path.join(GIGALATOR_ROOT, relPath);

    emitProgress(event, { phase: 'normalise', current: i + 1, total: tracks.length, name: path.basename(relPath) });

    if (!fs.existsSync(absPath)) { skipped++; continue; }

    try {
      const fp = fingerprint(absPath);
      const stamp = state.tracks[relPath];

      // Effective params: per-song override wins if set, else current globals
      const params = (stamp && stamp.paramOverride) || getNormaliseParams();

      // Skip if already at current version AND params haven't changed AND file unchanged
      if (
        stamp &&
        stamp.normalised === NORMALISE_VERSION &&
        paramsMatch(stamp.normaliseParams, params) &&
        stampMatches(stamp, fp)
      ) { skipped++; continue; }

      // Two-pass loudnorm measurement + filter assembly (shared helper)
      const filterArgs = await buildNormaliseFilter(ffmpegBin, absPath, params);

      await safeReencode(ffmpegBin, absPath, NORM_BACKUP_DIR, [
        '-vn', // drop attached album-art so the mp3 muxer doesn't choke
        '-af', filterArgs,
        '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', '44100',
        '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1',
      ]);

      state.tracks[relPath] = {
        ...(stamp || {}),
        mono: true,
        normalised: NORMALISE_VERSION,
        normaliseParams: { I: params.I, ratio: params.ratio, threshold: params.threshold },
        ...fingerprint(absPath),
      };
      writeAudioState(state);
      processed++;
    } catch (e) {
      console.error('[audio:normalise] failed for ' + relPath + ': ' + e.message);
      failed++;
      failures.push({ track: relPath, error: e.message });
    }
  }

  emitProgress(event, { phase: 'normalise', done: true });
  return { processed, skipped, failed, failures, total: tracks.length };
});

// Quick summary of how many tracks need each operation (for UI display)
ipcMain.handle('audio:status', async () => {
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();
  const params = getNormaliseParams();

  let needsMono = 0, needsNormalise = 0, missing = 0;
  for (const relPath of tracks) {
    const absPath = path.join(GIGALATOR_ROOT, relPath);
    if (!fs.existsSync(absPath)) { missing++; continue; }
    const fp = fingerprint(absPath);
    const stamp = state.tracks[relPath];
    const effective = (stamp && stamp.paramOverride) || params;
    const isMono = stamp && stamp.mono && stampMatches(stamp, fp);
    const isNorm =
      stamp &&
      stamp.normalised === NORMALISE_VERSION &&
      paramsMatch(stamp.normaliseParams, effective) &&
      stampMatches(stamp, fp);
    if (!isMono) needsMono++;
    if (!isNorm) needsNormalise++;
  }
  return { total: tracks.length, needsMono, needsNormalise, missing, params };
});

// ── Get / Set global normalisation params ──
ipcMain.handle('audio:getParams', () => getNormaliseParams());
ipcMain.handle('audio:setParams', (event, partial) => {
  const merged = { ...getNormaliseParams(), ...(partial || {}) };
  // Sanity-clamp so the user can't enter wildly broken values
  merged.I = Math.max(-30, Math.min(-3, Number(merged.I) || -10));
  merged.ratio = Math.max(1, Math.min(20, Number(merged.ratio) || 2));
  merged.threshold = Math.max(-40, Math.min(0, Number(merged.threshold) || -20));
  writeConfig({ normaliseParams: merged });
  return merged;
});

// ── Per-song params ──
// Each track may optionally have a `paramOverride` recorded in audio-state.json.
// When present, the per-song normalise + skip-check use these instead of the
// global defaults. Setting null clears the override (track goes back to globals).
ipcMain.handle('audio:getTrackParams', (event, relPath) => {
  const state = readAudioState();
  const stamp = state.tracks[relPath] || {};
  return {
    effective: stamp.paramOverride || getNormaliseParams(),
    isOverride: !!stamp.paramOverride,
    lastApplied: stamp.normaliseParams || null,
    normalised: !!stamp.normalised,
  };
});

ipcMain.handle('audio:setTrackParams', (event, relPath, paramOverride) => {
  const state = readAudioState();
  const stamp = state.tracks[relPath] || {};
  if (paramOverride === null || paramOverride === undefined) {
    delete stamp.paramOverride;
  } else {
    stamp.paramOverride = {
      I: Math.max(-30, Math.min(-3, Number(paramOverride.I) || -10)),
      ratio: Math.max(1, Math.min(20, Number(paramOverride.ratio) || 2)),
      threshold: Math.max(-40, Math.min(0, Number(paramOverride.threshold) || -20)),
    };
  }
  state.tracks[relPath] = stamp;
  writeAudioState(state);
  return stamp.paramOverride || null;
});

// Shared helper that builds the loudnorm-measure / volume / acompressor / alimiter
// chain. Used by both normaliseAll, normaliseOne, and previewTrack.
async function buildNormaliseFilter(ffmpegBin, absPath, params) {
  let measureStderr = '';
  await new Promise((resolve, reject) => {
    execFile(ffmpegBin, [
      '-hide_banner', '-i', absPath,
      '-af', 'loudnorm=I=' + params.I + ':TP=-1:LRA=5:print_format=json',
      '-f', 'null', '-',
    ], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      measureStderr = stderr || '';
      if (err) reject(new Error(distilFfError(stderr, err.message)));
      else resolve();
    });
  });
  const jsonMatch = measureStderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!jsonMatch) throw new Error('could not parse loudnorm measurement');
  const m = JSON.parse(jsonMatch[0]);
  const measuredI = parseFloat(m.input_i);
  if (!Number.isFinite(measuredI)) {
    throw new Error('measured loudness invalid (' + m.input_i + ') — silent or corrupt file');
  }
  const gainDb = (params.I - measuredI).toFixed(2);
  return [
    'acompressor=threshold=' + params.threshold + 'dB:ratio=' + params.ratio +
      ':attack=20:release=250:knee=6:makeup=0dB',
    'volume=' + gainDb + 'dB',
    'alimiter=level_in=1:level_out=1:limit=0.891:attack=5:release=50',
  ].join(',');
}

// Render a 5-second preview of the proposed normalise for a single track.
// Returns the absolute path to the temp file; the renderer <audio>s it.
ipcMain.handle('audio:previewTrack', async (event, relPath, overrideParams) => {
  const ffmpegBin = findBinary('ffmpeg');
  const absPath = path.join(GIGALATOR_ROOT, relPath);
  if (!fs.existsSync(absPath)) throw new Error('track file not found');

  const params = { ...getNormaliseParams(), ...(overrideParams || {}) };
  const filterArgs = await buildNormaliseFilter(ffmpegBin, absPath, params);

  // Temp file in userData so it survives across previews and is auto-cleaned
  // when the app quits (not strictly — but it's a single file we overwrite).
  const previewPath = path.join(app.getPath('userData'), 'preview.mp3');
  try { fs.unlinkSync(previewPath); } catch (_) {}

  await runFfBinary(ffmpegBin, [
    '-y', '-i', absPath,
    '-vn',
    '-ss', '0', '-t', '8',  // first 8 seconds (long enough to hear the intro)
    '-af', filterArgs,
    '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', '44100',
    '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1',
    previewPath,
  ]);
  if (!fs.existsSync(previewPath) || fs.statSync(previewPath).size === 0) {
    throw new Error('preview render produced no output');
  }
  // Return as base64 — avoids file:// loading restrictions in the renderer
  // (webSecurity: true blocks cross-origin file:// audio). An 8-second 128kbps
  // mono mp3 is ~130KB, which is fine to ship over IPC.
  const buf = fs.readFileSync(previewPath);
  return 'data:audio/mp3;base64,' + buf.toString('base64');
});

// Normalise a single track with given params. If params omitted, uses
// per-song override if set, else global defaults.
ipcMain.handle('audio:normaliseOne', async (event, relPath, overrideParams) => {
  const ffmpegBin = findBinary('ffmpeg');
  // Auto-rename non-mp3 first so the song editor's track reference becomes valid mp3
  try { relPath = ensureMp3Extension(relPath); } catch (_) {}
  const absPath = path.join(GIGALATOR_ROOT, relPath);
  if (!fs.existsSync(absPath)) throw new Error('track file not found');

  const state = readAudioState();
  const stamp = state.tracks[relPath] || {};
  const params = overrideParams
    ? { ...getNormaliseParams(), ...overrideParams }
    : (stamp.paramOverride || getNormaliseParams());

  const filterArgs = await buildNormaliseFilter(ffmpegBin, absPath, params);

  await safeReencode(ffmpegBin, absPath, NORM_BACKUP_DIR, [
    '-vn',
    '-af', filterArgs,
    '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', '44100',
    '-write_xing', '0', '-id3v2_version', '0', '-map_metadata', '-1',
  ]);

  state.tracks[relPath] = {
    ...stamp,
    mono: true,
    normalised: NORMALISE_VERSION,
    normaliseParams: { I: params.I, ratio: params.ratio, threshold: params.threshold },
    ...fingerprint(absPath),
  };
  writeAudioState(state);
  return { ok: true, params };
});

// ── Remove Normalise: restore from _pre_normalise/ backup, clear stamp ──
ipcMain.handle('audio:removeNormalise', async (event) => {
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();
  let restored = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tracks.length; i++) {
    const relPath = tracks[i];
    const absPath = path.join(GIGALATOR_ROOT, relPath);
    const backupAbs = path.join(GIGALATOR_ROOT, NORM_BACKUP_DIR, path.basename(relPath));

    emitProgress(event, { phase: 'remove-normalise', current: i + 1, total: tracks.length, name: path.basename(relPath) });

    const stamp = state.tracks[relPath];
    // Nothing to undo if it was never normalised
    if (!stamp || !stamp.normalised) { skipped++; continue; }

    if (!fs.existsSync(backupAbs)) {
      failed++;
      failures.push({ track: relPath, error: 'no pre-normalise backup found' });
      continue;
    }

    try {
      fs.copyFileSync(backupAbs, absPath);
      // Keep mono stamp (the backup IS the mono-but-not-yet-normalised version),
      // but drop the normalise stamp + params so the file is now "needs normalise".
      delete stamp.normalised;
      delete stamp.normaliseParams;
      Object.assign(stamp, fingerprint(absPath));
      state.tracks[relPath] = stamp;
      writeAudioState(state);
      restored++;
    } catch (e) {
      failed++;
      failures.push({ track: relPath, error: e.message });
    }
  }

  emitProgress(event, { phase: 'remove-normalise', done: true });
  return { restored, skipped, failed, failures, total: tracks.length };
});

// ── Remove Mono: restore from _original_stereo/ backup, clear all stamps ──
ipcMain.handle('audio:removeMono', async (event) => {
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();
  let restored = 0, skipped = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < tracks.length; i++) {
    const relPath = tracks[i];
    const absPath = path.join(GIGALATOR_ROOT, relPath);
    const backupAbs = path.join(GIGALATOR_ROOT, MONO_BACKUP_DIR, path.basename(relPath));

    emitProgress(event, { phase: 'remove-mono', current: i + 1, total: tracks.length, name: path.basename(relPath) });

    const stamp = state.tracks[relPath];
    if (!stamp || !stamp.mono) { skipped++; continue; }

    if (!fs.existsSync(backupAbs)) {
      // Nothing to restore — the file was already mono when first stamped
      skipped++;
      continue;
    }

    try {
      fs.copyFileSync(backupAbs, absPath);
      // Clear EVERYTHING — restoring stereo invalidates any normalisation too
      delete state.tracks[relPath];
      writeAudioState(state);
      restored++;
    } catch (e) {
      failed++;
      failures.push({ track: relPath, error: e.message });
    }
  }

  emitProgress(event, { phase: 'remove-mono', done: true });
  return { restored, skipped, failed, failures, total: tracks.length };
});
