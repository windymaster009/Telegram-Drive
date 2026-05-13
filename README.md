# Telegram Drive

Telegram Drive is a desktop/web app that uses your Telegram account as file storage. It is built with Tauri 2, Rust, React, TypeScript, Vite, MongoDB, Google OAuth, and the Grammers Telegram client.

Files are stored in Telegram chats/channels. The app provides a desktop UI, an HTTP API, user login, admin approval, folder permissions, previews, downloads, and uploads.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

## Features

- Telegram-backed file storage
- Folder management through Telegram channels
- Google OAuth login for users
- Admin user approval, reject, disable, and QR login controls
- Folder permissions: Hidden, Read Only, Read + Write
- Owner folders are always Read + Write for their owner
- Drag-and-drop uploads
- Image previews and thumbnails
- Audio, video, and PDF previews
- Local temp cache for video/PDF preview playback
- Local REST API for web and desktop sessions
- Cross-platform desktop app through Tauri

## Screenshots

| Dashboard | File Preview |
|-----------|--------------|
| ![Dashboard](screenshots/DashboardWithFiles.png) | ![Preview](screenshots/ImagePreview.png) |

| Grid View | Authentication |
|-----------|----------------|
| ![Dark Mode](screenshots/DarkModeGrid.png) | ![Login](screenshots/LoginScreen.png) |

| Audio Playback | Video Playback |
|----------------|----------------|
| ![Audio Playback](screenshots/AudioPlayback.png) | ![Video Playback](screenshots/VideoPlayback.png) |

## Project Structure

```text
Telegram-Drive/
|-- frontend/        React/Vite UI, admin console, public API client
|-- backend/         Rust code for both the desktop app and API server
|   |-- src-tauri/   Tauri desktop app shell and bundled native code
|   `-- src/         Standalone HTTP API entry point for server/Pi hosting
|-- shared/          Shared TypeScript types
|-- screenshots/     README images
|-- scripts/         Workspace helper scripts
|-- package.json     Root workspace scripts
`-- README.md
```

## Frontend, Backend, and Pi Server

This project has one folder named `backend/`, but it is used in two ways:

- `backend/src-tauri/` is the Tauri desktop app backend. It is compiled into the Windows/macOS/Linux app and is needed when exporting the installer.
- `backend/src/` is the standalone HTTP API server. This is the part you host on a Raspberry Pi or other server.
- `frontend/` is the React UI. It becomes static files when built, but it still needs an API URL to log in, list files, upload, download, and stream previews.

Do not delete `backend/` just because the frontend is built. The frontend folder still needs backend code during development and desktop export because Tauri uses `backend/src-tauri/` to create the installable app.

For a normal hosted setup:

```text
Friend's Windows app
  = built frontend
  + bundled Tauri desktop code from backend/src-tauri/
  + API requests to your Pi

Raspberry Pi/server
  = standalone API from backend/src/
  + backend/.env secrets
  + backend/.data Telegram session files
  + MongoDB connection
```

Only the API server needs to keep running on the Pi. The Windows installer does not need your friend to run the Pi code locally, but the installed app will only work while the Pi API is online and reachable.

## Recommended Development and Hosting Flow

Use local development when changing the UI or backend:

```bash
npm install
npm run dev:web
```

Use the Pi for production API hosting:

```bash
cd backend
npm install
npm run api
```

For production on the Pi, set `backend/.env` carefully:

```text
TELEGRAM_DRIVE_API_HOST=127.0.0.1
TELEGRAM_DRIVE_API_PORT=14201
TELEGRAM_DRIVE_PUBLIC_API_BASE_URL=https://api.example.com
MONGODB_URI=...
JWT_SECRET=...
TELEGRAM_SESSION_ENCRYPTION_KEY=...
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://api.example.com/auth/google/callback
```

Keep secrets only in `backend/.env` on the Pi. Do not put MongoDB passwords, Google client secrets, JWT secrets, Telegram API hashes, or session files in `frontend/.env`.

Before building the desktop installer for friends, point the frontend to the Pi API in `frontend/.env`:

```text
VITE_API_BASE_URL=https://api.example.com
VITE_GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
VITE_GOOGLE_OAUTH_REDIRECT_URI=https://api.example.com/auth/google/callback
```

Then build the Windows installer:

```bash
npm run build
```

The install wizard is created under:

```text
backend/target/release/bundle/nsis/
```

If you change the Pi API URL, Google OAuth redirect URL, or frontend `.env`, rebuild the frontend/desktop installer before sharing a new `.exe`.

## Requirements

- Node.js 18 or newer
- Rust and Cargo
- Tauri system dependencies for your OS
- MongoDB Atlas or another MongoDB instance
- Google OAuth client
- Telegram API ID and API hash from https://my.telegram.org/

### Windows Native Dependencies

Install Visual Studio Build Tools and select:

- Desktop development with C++
- MSVC build tools
- Windows SDK

Windows 10/11 usually include WebView2. If Tauri complains, install Microsoft Edge WebView2 Runtime.

### macOS Native Dependencies

```bash
xcode-select --install
```

### Ubuntu/Debian Native Dependencies

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Environment Setup

Copy the example env files:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

On Windows PowerShell:

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

### Backend Environment

Backend-only secrets belong in `backend/.env`.

Required:

```text
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/?appName=<app-name>
MONGODB_DB_NAME=telegram_drive
JWT_SECRET=<long-random-secret>
TELEGRAM_SESSION_ENCRYPTION_KEY=<32-byte-base64-or-hex-key>
GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-oauth-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1420/auth/google/callback
```

Optional but recommended for first-run owner setup:

```text
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
```

`TELEGRAM_SESSION_ENCRYPTION_KEY` must stay stable. If you change it, the existing encrypted Telegram session file in `backend/.data/telegram.session.enc` cannot be read.

### Frontend Environment

Frontend env values are public. Do not put secrets here.

```text
VITE_API_BASE_URL=http://localhost:14201
VITE_GOOGLE_OAUTH_CLIENT_ID=<google-oauth-client-id>
VITE_GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1420/auth/google/callback
```

## First Admin Setup

1. Start the app.
2. Sign in once with Google.
3. Open MongoDB and update your user document:

```text
role: "admin"
approval_status: "approved"
is_approved: true
disabled: false
```

After that, sign in again. The admin console can approve, reject, disable, enable, and manage folder permissions for other users.

## Folder Permissions

Admin folder permissions have three states:

- Hidden: the user cannot see the folder.
- Read Only: the user can open and download files.
- Read + Write: the user can upload and move/copy files where allowed.

Folders owned by a user are always Read + Write for that user and cannot be hidden or downgraded in the admin UI.

## Preview Behavior

Video, audio, and PDF previews use a local temp cache. When a preview opens, the backend downloads to the app cache and serves it through the local API. Closing the preview cancels the download and removes the temp file.

Some MP4 files store playback metadata at the end of the file. Telegram Drive also prefetches a small tail section for video files so playback can start earlier when possible.

## Install Dependencies

From the repository root:

```bash
npm install
```

## Development

Run the full Tauri desktop app:

```bash
npm run tauri:dev
```

Run only the local backend API:

```bash
npm run dev:api
```

Run only the Vite frontend:

```bash
npm run dev:frontend
```

Run backend API and frontend together without launching Tauri:

```bash
npm run dev:web
```

## Build

From the repository root:

```bash
npm run build
```

Build outputs are created under:

```text
backend/target/release/
backend/target/release/bundle/
```

Common Windows outputs:

```text
backend/target/release/app.exe
backend/target/release/bundle/msi/
backend/target/release/bundle/nsis/
```

## Useful Commands

```bash
npm run build:frontend
npm run build:backend
npm run tauri:dev
npm run tauri:build
```

## Troubleshooting

### Cargo Not Found

Install Rust from https://rustup.rs/, restart your terminal, then verify:

```bash
cargo --version
rustc --version
```

### `link.exe` Not Found on Windows

Install Visual Studio Build Tools with the Desktop development with C++ workload.

### WebView2 Error on Windows

Install Microsoft Edge WebView2 Runtime.

### Android APK Says Package Is Missing or Invalid

If the Android export gives you a file named like `app-universal-release-unsigned.apk`, that APK is not signed and Android will reject it during install.

For local testing, use the debug APK if present:

```text
backend/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
```

For a shareable release APK, configure Android signing and build a signed release APK. The export script now refuses to copy an unsigned release APK as if it were install-ready.

### Preview or Stream Still Uses Old Behavior

Close every running Telegram Drive window. If an old process still owns port `14201`, it may serve old backend code. Restart the newly built app.

### User Still Sees Hidden Folder

Make sure you saved permissions after setting the folder to Hidden, then sign out and sign in as that user. Users see only assigned folders plus folders they own.

## Tech Stack

- React
- TypeScript
- Vite
- Tauri v2
- Rust
- Grammers Telegram client
- MongoDB
- Google OAuth
- Tailwind CSS
- Framer Motion

## License

This project is released under the MIT License.

## Disclaimer

This application is not affiliated with Telegram FZ-LLC. Use it responsibly and follow Telegram's Terms of Service.
