# Gigalator

Gigalator is a PWA for iPad that a professional gigging musician uses on stage to display song lyrics, chord sheets, and play backing tracks. Songs are organised into setlists. A companion Electron desktop app (the "Manager") on Mac is used to add/edit songs, upload tracks and sheet images, and deploy changes to the iPad via GitHub Pages. A separate Node.js API server handles PDF chord extraction using the Claude API. The entire stack is vanilla JavaScript — no frameworks, no build step.

## Project structure

```
index.html          iPad PWA entry point
app.js              iPad app logic (views, audio, navigation)
styles.css          All styling (iPad + shared)
sw.js               Service worker (offline caching)
manifest.json       PWA manifest
manager.html        Manager UI (runs in Electron or browser)
manager-app/        Electron wrapper
  main.js           Main process (IPC, file system, git deploy)
  preload.js        Context bridge (exposes electronAPI)
  package.json      Electron dependency
api/                Chord Extractor API server
  server.js         Express server (PDF → Claude → plain text)
  upload.html       Upload UI
  package.json      API dependencies
  .env              ANTHROPIC_API_KEY (git-ignored)
songs/songs.json    All song data (lyrics, metadata, setlists)
tracks/             MP3 backing tracks (128kbps mono)
sheets/             PNG sheet images (chord/lyric scans)
icons/              PWA icons (192px, 512px)
deploy.command      Quick git push script (double-click)
Gigalator Manager.command  Electron app launcher (double-click)
```

## How to run

**iPad app (local):** Open `index.html` in a browser. No server needed — it's static files.

**iPad app (production):** Hosted on GitHub Pages. The iPad accesses it via Safari / Add to Home Screen.

**Manager (Electron):**
```bash
cd manager-app
npm install          # first time only
npx electron .
```
Or double-click `Gigalator Manager.command`.

**Chord Extractor API:**
```bash
cd api
npm install
# Ensure api/.env contains ANTHROPIC_API_KEY=sk-ant-...
node server.js       # runs on http://localhost:3111
```

## How to deploy

The Manager app has a Deploy button that runs `git add -A && git commit && git pull --rebase && git push` with 3 retries. Alternatively, double-click `deploy.command` or run git manually. Changes go live on GitHub Pages within a few minutes.

**Service worker cache version** (`sw.js` line 5): Bump `CACHE_NAME` version (e.g. `v14` → `v15`) whenever `app.js`, `styles.css`, or `index.html` change, otherwise iPads will serve stale cached files.

## After every code change

1. **Bump `CACHE_NAME`** in `sw.js` if you changed any iPad-facing file (`app.js`, `styles.css`, `index.html`).
2. **Test in browser** — open `index.html` locally and verify the change (lyrics view, setlist navigation, audio playback, sheets toggle, bottom nav).
3. **Test portrait mode** — the user gigs in portrait on iPad 9th gen. Check that the bottom nav, lyrics scroll, and player bar all display correctly.
4. **Check with player visible and hidden** — the audio player bar toggles visibility and affects layout. Verify nothing gets clipped.
5. **No test suite exists.** Verify manually in browser. If adding significant logic, consider whether a test would catch regressions.

## Code conventions

- **Vanilla JS only.** No frameworks, no TypeScript, no build tools, no bundler.
- **ES5 style in app.js** — uses `var`, string concatenation for HTML, `function` declarations. The IIFE pattern wraps everything. Follow this style when editing app.js.
- **ES6 in Electron/API code** — `const`/`let`, arrow functions, `async`/`await`, template literals are fine in `manager-app/` and `api/`.
- **HTML built via string concatenation** — `app.js` builds all DOM with `html += '<div>...'` and sets `main.innerHTML`. No template literals, no JSX, no DOM API.
- **Section comments** use `// ── Section Name ──` ASCII dividers.
- **IDs are kebab-case**: `back-btn`, `header-title`, `lyrics-scroll`.
- **Variables are camelCase**: `currentSetlist`, `playingSongId`.
- **CSS uses custom properties** defined in `:root` — `--bg`, `--accent`, `--text-dim`, etc.
- **No linting, no prettier.** Match the existing style by eye.
- **Semicolons** are used consistently.
- **No comments unless non-obvious.** The codebase is light on comments — don't add unnecessary ones.

## Data format

`songs/songs.json` structure:
```json
{
  "setlists": [
    { "id": "guitar-gig", "name": "Guitar Gig", "songs": ["song-id", ...] }
  ],
  "songs": {
    "song-id": {
      "title": "Song Title",
      "artist": "Artist Name",
      "lyrics": "[Verse 1]\nChords and lyrics...",
      "track": "tracks/filename.mp3",
      "sheets": ["sheets/name-page-1.png", null, null, null, null],
      "fontSize": null
    }
  }
}
```

- `track` and `sheets` entries are relative paths from the repo root.
- `sheets` is a 5-element array (up to 5 pages). Unused slots are `null`.
- `fontSize` is per-song override or `null` for default (30px).
- Lyrics are plain text with `[Section]` markers and chord lines aligned with spaces.

## Key gotchas

- **Safari flex height bugs**: Safari/WebKit doesn't resolve percentage heights in nested flex containers. Use `flex: 1` with `min-height: 0` instead of `height: 100%`. This has bitten us before — see `.lyrics-wrap` fix.
- **Service worker is aggressive**: iPads cache everything. Always bump `CACHE_NAME` in `sw.js` or users won't see updates. The "Refresh Songs" button only refreshes `songs.json`, not the app shell.
- **Repo is large (~500MB+)** because it contains MP3 tracks. `.nojekyll` file in root is required for GitHub Pages to build.
- **manager.html is dual-mode**: It detects Electron via `window.electronAPI` and switches between File System Access API (browser) and Node.js fs (Electron). Both code paths must work.
- **The API server is optional**: It's only used for the Chord Extractor feature. The iPad app and Manager work without it.
- **Tracks are 128kbps mono MP3**: The user runs mono PA at gigs. Don't re-encode or change format.
- **Portrait mode is primary for gigging**: The user performs with iPad in portrait orientation. All lyrics view layout must work well in portrait.
- **manager.html has an embedded `<script>` block (~1800 lines)**: All manager logic is inline in the HTML file, not a separate JS file.

## Environment variables

| Variable | Location | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `api/.env` | Claude API key for chord extraction |

No other env vars are needed. The iPad app and Manager are fully static/local.

## External services

- **GitHub Pages** — hosts the iPad PWA at the repo's GitHub Pages URL
- **Claude API** — used only by the Chord Extractor (`api/server.js`) for PDF-to-text conversion
- **PDF.js CDN** — loaded in `manager.html` for client-side PDF page rendering
