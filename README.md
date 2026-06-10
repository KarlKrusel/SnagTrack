# SnagTrack

SnagTrack is a desktop-style local web app for collecting DJ free downloads from Hypeddit gates and related SoundCloud links.

It runs a local server, opens a browser UI at `http://127.0.0.1:7766`, and automates the download flow using a mix of direct HTTP requests and a saved browser session for follow / like gates.

The current packaged release targets Windows. A macOS version is in development.

## What it does

- Accepts SoundCloud track URLs, Hypeddit track URLs, and Hypeddit chart / playlist URLs
- Resolves SoundCloud tracks to their matching Hypeddit free-download gate when available
- Supports chart preview loading with live progress feedback
- Expands chart URLs into full track batches before download
- Keeps an on-screen download queue and batch history
- Reuses a saved SoundCloud / Spotify / Hypeddit login session for gated downloads
- Falls back between direct and browser-assisted flows depending on what the gate needs
- Embeds SoundCloud cover art into supported files when artwork is missing

## Main workflow

1. Start SnagTrack.
2. Open `Settings` and enter your email and name.
3. Pick a download folder.
4. Open the login browser, sign into SoundCloud and any other services you need, then save the session.
5. Paste one track URL per line, or load a Hypeddit chart / playlist.
6. Start the batch and watch progress in the Downloads, Queue, and Charts tabs.

## Download modes

- `hybrid`: tries direct HTTP first, then uses the saved browser session when needed
- `browser`: uses the browser path for maximum gate coverage
- `direct`: only uses direct HTTP flows

`hybrid` is the default and recommended mode.

## Local development

### Requirements

- Node.js
- npm
- Playwright browser binaries

### Install

```bash
npm install
npm run install-browsers
```

### Run

```bash
npm start
```

Or on Windows:

```bat
start.bat
```

When running, SnagTrack serves its UI at:

```text
http://127.0.0.1:7766
```

If another SnagTrack instance is already using that port, the app opens the existing UI instead of starting a duplicate server.

## First-run setup

### Identity

Fill in:

- email
- name

These are used for email-only gates.

### Download location

Choose the folder where finished tracks should be written.

### Login session

Use `Settings -> Login Session` to:

1. open the dedicated login browser
2. sign into SoundCloud
3. optionally sign into Spotify and Hypeddit
4. close the login browser
5. click `Save Session`

The saved session is stored in the local app folder and reused during later runs.

## Supported inputs

- SoundCloud track URL
- Hypeddit track URL
- Hypeddit chart URL
- Hypeddit playlist URL

Example inputs:

```text
https://soundcloud.com/artist/track-name
https://hypeddit.com/track/67890
https://hypeddit.com/music
```

## UI areas

- `Downloads`: paste links, start / stop a batch, view overall progress
- `Queue`: view per-track progress and previous batch history
- `Charts`: preview a chart or playlist before queueing the tracks
- `Settings`: configure identity, download strategy, browser engine, session, and cover art behavior
- `Guide`: built-in first-time setup help
- `Logs`: open runtime logs

## Project structure

```text
SnagTrack/
  app.js               Local server + WebSocket entrypoint
  public/              Browser UI
  src/                 Download, browser, config, resolver, and tagging logic
  build.sh             Windows distro staging script
  installer.iss        Inno Setup installer definition
  start.bat            Windows local launcher
```

## Building the Windows distro

### Stage the app bundle

From Git Bash:

```bash
./build.sh
```

This produces:

```text
build/SnagTrack
```

### Build the installer

Compile `installer.iss` with Inno Setup 6.

Output:

```text
dist/SnagTrack-Setup.exe
```

## Notes

- The app keeps running if the UI tab closes while downloads are still active.
- Chart loading now reports progress so the UI does not appear stalled during larger previews.
- Queue history is preserved across batches until the user clears it.

## License

This project is proprietary and `UNLICENSED`.

See [LICENSE.txt](LICENSE.txt) for usage and redistribution restrictions.
