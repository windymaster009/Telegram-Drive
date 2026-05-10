# Telegram Drive

Telegram Drive is a local desktop app that uses your Telegram account as file storage. It is built with Tauri 2, Rust, React, TypeScript, Vite, MongoDB, Google OAuth, and the Grammers Telegram client.

Files are stored in Telegram chats/channels. The app provides a local desktop UI, a local HTTP API, user login, admin approval, folder permissions, previews, downloads, and uploads.

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
|-- frontend/        React/Vite UI, admin console, API client
|-- backend/         Rust/Tauri app, REST API, Telegram, MongoDB
|-- shared/          Shared TypeScript types
|-- screenshots/     README images
|-- scripts/         Workspace helper scripts
|-- package.json     Root workspace scripts
`-- README.md
```

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
