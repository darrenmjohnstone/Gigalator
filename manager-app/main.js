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
const NORMALISE_VERSION = 'v2-gain-comp-limit-I-10';
const AUDIO_STATE_FILE = 'audio-state.json'; // at GIGALATOR_ROOT, tracked in git
const MONO_BACKUP_DIR = 'tracks/_original_stereo';
const NORM_BACKUP_DIR = 'tracks/_pre_normalise';

function findBinary(name) {
  // Probe absolute paths FIRST — apps launched from Finder/Launchpad don't
  // inherit Homebrew's PATH, so bare names like 'ffmpeg' would ENOENT.
  // Only fall back to the bare name if no absolute candidate exists.
  const envOverride = process.env[name.toUpperCase() + '_BIN'];
  const absoluteCandidates = [
    envOverride,
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/opt/local/bin/' + name,
    '/usr/bin/' + name,
  ].filter(Boolean);
  for (const p of absoluteCandidates) {
    if (p.startsWith('/') && fs.existsSync(p)) return p;
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

      if (stamp && stamp.normalised === NORMALISE_VERSION && stampMatches(stamp, fp)) {
        skipped++; continue;
      }

      // Pass 1: measure (output to /dev/null, capture JSON from stderr)
      // loudnorm writes its JSON to stderr — ffmpeg execFile capture handles it.
      let measureStderr = '';
      await new Promise((resolve, reject) => {
        execFile(ffmpegBin, [
          '-hide_banner', '-i', absPath,
          '-af', 'loudnorm=I=-10:TP=-1:LRA=5:print_format=json',
          '-f', 'null', '-',
        ], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          measureStderr = stderr || '';
          if (err) reject(new Error(distilFfError(stderr, err.message)));
          else resolve();
        });
      });

      // The JSON is the last { ... } block in stderr
      const jsonMatch = measureStderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
      if (!jsonMatch) throw new Error('could not parse loudnorm measurement');
      const m = JSON.parse(jsonMatch[0]);

      // Pass 2: compute a single linear gain to hit -10 LUFS, then apply
      // a chain that has NO startup ramp:
      //   acompressor → static volume gain → look-ahead brick-wall limiter
      // The compressor reduces dynamic range (so loud and quiet sections sit
      // closer together) without an envelope-follower attack at t=0 because
      // it's at unity gain until signal exceeds threshold. The limiter only
      // engages on peaks, so it doesn't touch quiet intros.
      const TARGET_LUFS = -10;
      const measuredI = parseFloat(m.input_i);
      if (!Number.isFinite(measuredI)) {
        throw new Error('measured loudness is invalid (' + m.input_i + ') — likely silent or corrupt file');
      }
      const gainDb = (TARGET_LUFS - measuredI).toFixed(2);
      const filterArgs = [
        // Gentle 2:1 compression above -20 dBFS to tame dynamic range —
        // attack/release are fast enough to follow musical phrasing but
        // not so fast they pump audibly. knee=6 smooths the transition.
        'acompressor=threshold=-20dB:ratio=2:attack=20:release=250:knee=6:makeup=0dB',
        // Single fixed gain — true linear, no envelope follower.
        'volume=' + gainDb + 'dB',
        // Brick-wall limiter at -1 dBTP catches any peaks that would clip
        // after the gain. limit=0.891 ≈ -1 dB. Short attack to catch
        // transients cleanly, modest release.
        'alimiter=level_in=1:level_out=1:limit=0.891:attack=5:release=50',
      ].join(',');

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
  const ffprobeBin = findBinary('ffprobe');
  const state = readAudioState();
  const tracks = getAllTrackRelPaths();

  let needsMono = 0, needsNormalise = 0, missing = 0;
  for (const relPath of tracks) {
    const absPath = path.join(GIGALATOR_ROOT, relPath);
    if (!fs.existsSync(absPath)) { missing++; continue; }
    const fp = fingerprint(absPath);
    const stamp = state.tracks[relPath];
    const isMono = stamp && stamp.mono && stampMatches(stamp, fp);
    const isNorm = stamp && stamp.normalised === NORMALISE_VERSION && stampMatches(stamp, fp);
    if (!isMono) needsMono++;
    if (!isNorm) needsNormalise++;
  }
  return { total: tracks.length, needsMono, needsNormalise, missing };
});
