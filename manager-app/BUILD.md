# Building the Gigalator Manager DMG

## One-time setup

```
cd manager-app
npm install
```

This installs Electron + electron-builder + their dependencies.

## (Optional but recommended) App icon

For a proper app icon in Finder / Dock, drop an `icon.icns` file at
`manager-app/build/icon.icns`. macOS .icns files can be generated from a
1024×1024 PNG with:

```
mkdir Gigalator.iconset
sips -z 16 16     icon-1024.png --out Gigalator.iconset/icon_16x16.png
sips -z 32 32     icon-1024.png --out Gigalator.iconset/icon_16x16@2x.png
sips -z 32 32     icon-1024.png --out Gigalator.iconset/icon_32x32.png
sips -z 64 64     icon-1024.png --out Gigalator.iconset/icon_32x32@2x.png
sips -z 128 128   icon-1024.png --out Gigalator.iconset/icon_128x128.png
sips -z 256 256   icon-1024.png --out Gigalator.iconset/icon_128x128@2x.png
sips -z 256 256   icon-1024.png --out Gigalator.iconset/icon_256x256.png
sips -z 512 512   icon-1024.png --out Gigalator.iconset/icon_256x256@2x.png
sips -z 512 512   icon-1024.png --out Gigalator.iconset/icon_512x512.png
cp icon-1024.png Gigalator.iconset/icon_512x512@2x.png
iconutil -c icns Gigalator.iconset -o build/icon.icns
```

If no `icon.icns` is present, electron-builder uses a default Electron icon.

## Build the DMG

```
cd manager-app
npm run dist
```

After ~1 minute, the DMG appears in `../dist/`:

```
dist/Gigalator Manager-1.0.0.dmg
```

Double-click it, drag **Gigalator Manager.app** into Applications, eject the
DMG. Open the app from Launchpad / Spotlight.

## First-time launch

macOS Gatekeeper will warn that the app is from an unidentified developer (no
code signing). To bypass once: **right-click the app → Open → confirm.** From
then on, normal launches work.

For proper distribution without the warning, add code signing:

1. Apple Developer account (you have this).
2. Set the env vars before running `npm run dist`:
   ```
   export CSC_LINK=/path/to/your/cert.p12
   export CSC_KEY_PASSWORD=your-cert-password
   export APPLE_ID=your@apple.id
   export APPLE_ID_PASSWORD=app-specific-password
   ```
3. Add `"hardenedRuntime": true` and `"notarize": true` in `package.json`'s
   `build.mac` section (currently both off for simpler unsigned dev builds).

## Where the app expects your data

The Manager looks for your Gigalator git repo (with `songs/songs.json` etc) in:

1. `~/Desktop/Gigalator/` (default — recommended)
2. `~/Documents/Gigalator/`
3. `~/Gigalator/`

The first one that contains a valid `songs/songs.json` wins. If none exist,
the app will fail to load data — clone or move the Gigalator repo to one of
those locations first.

## What's bundled vs not

Bundled inside the .app:
- `manager.html` (the UI)
- `api/` (the local Claude proxy server + its node_modules)
- Electron + Chromium runtime

NOT bundled (must exist on the user's machine):
- The Gigalator git repo (songs.json, tracks/, sheets/)
- `node` binary (the API server uses the system node — Homebrew or system)

## Troubleshooting

**"AI Format failed: Failed to fetch"** — The bundled API server didn't
start. Open the Settings modal in the Manager (gear icon, bottom of sidebar)
and confirm your Anthropic API key is set. Then quit + relaunch the app.

**App opens but sidebar is empty** — Manager couldn't find the data folder.
Make sure `~/Desktop/Gigalator/songs/songs.json` exists.
