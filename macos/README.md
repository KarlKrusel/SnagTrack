# SnagTrack macOS

This folder is the first-pass macOS path for SnagTrack.

It gives you two ways to run the project on a Mac:

- run directly from the repo during development
- build an unsigned `.app` bundle for local testing

If you want the exact command-by-command setup, start with [ABSOLUTE-GUIDE.md](ABSOLUTE-GUIDE.md).

## Requirements

- macOS
- Node.js
- npm
- either Google Chrome / Microsoft Edge installed, or Playwright Chromium installed

## Run from source

From the repo root:

```bash
./macos/run-dev.sh
```

That script:

- checks for Node.js
- installs npm dependencies if `node_modules` is missing
- installs Playwright Chromium only when no system Chrome is found
- starts SnagTrack on `http://127.0.0.1:7766`

You can also double-click:

```text
macos/SnagTrack.command
```

## Build a local Mac app

From the repo root:

```bash
./macos/build-app.sh
```

That produces:

```text
build-macos/SnagTrack.app
```

Then launch it with:

```bash
open build-macos/SnagTrack.app
```

## Current limitations

- the `.app` bundle is unsigned
- it is not notarized yet
- the Mac packaging path is meant for development and local testing first
- broader Intel / Apple Silicon validation still needs to happen
