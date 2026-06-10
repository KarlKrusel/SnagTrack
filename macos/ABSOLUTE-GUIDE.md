# Absolute macOS guide

This is the exact first-pass Mac setup flow for SnagTrack.

## 1. Get the repo onto your Mac

If you are cloning the repo:

```bash
cd ~/Downloads
git clone https://github.com/KarlKrusel/SnagTrack.git
cd SnagTrack
```

If you already copied the repo onto your Mac, just open Terminal and `cd` into that folder:

```bash
cd /path/to/SnagTrack
```

## 2. Make the Mac scripts executable

Run this once inside the repo root:

```bash
chmod +x macos/run-dev.sh macos/build-app.sh macos/SnagTrack.command
```

## 3. Make sure Node.js is installed

Check:

```bash
node -v
npm -v
```

If those commands fail, install Node.js first, then come back and run the steps again.

## 4. Run SnagTrack from source

From the repo root:

```bash
./macos/run-dev.sh
```

What that does:

- installs `node_modules` if missing
- installs Playwright Chromium if no system Chrome or Edge is found
- starts SnagTrack on `http://127.0.0.1:7766`

Once it starts, open:

```text
http://127.0.0.1:7766
```

## 5. Optional: build the Mac app bundle

From the repo root:

```bash
./macos/build-app.sh
```

That creates:

```text
build-macos/SnagTrack.app
```

Then launch it:

```bash
open build-macos/SnagTrack.app
```

## 6. If macOS blocks the app or script

Because this Mac build is still unsigned, macOS may warn you.

Try these in order:

1. Right-click the app or `.command` file and choose `Open`
2. Go to `System Settings -> Privacy & Security` and use `Open Anyway`

If needed for a downloaded zip or app bundle, remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine build-macos/SnagTrack.app
```

Or for the scripts:

```bash
xattr -dr com.apple.quarantine macos
```

## 7. First-run SnagTrack setup

Inside the app:

1. Open `Settings`
2. Enter your name and email
3. Choose a download folder
4. Open the login browser
5. Sign into SoundCloud
6. Optionally sign into Spotify and Hypeddit
7. Save the session

## 8. Current state of the Mac build

This is a scaffold, not a finished Mac release.

Right now it is intended for:

- development
- local testing
- proving the browser/download flow on macOS

It is not finished for:

- signing
- notarization
- polished consumer distribution
