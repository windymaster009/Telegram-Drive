# Telegram Drive

Telegram Drive is an open-source desktop app that turns your Telegram account into a cloud storage drive. It is built with Tauri, Rust, React, TypeScript, and Vite.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

![Auth Screen](screenshots/AuthScreen.png)

## What It Does

Telegram Drive uses the Telegram API to upload, organize, preview, stream, and manage files through your Telegram account. Files stay tied to your Telegram account, and the app runs locally on your machine.

## Features

- Unlimited Telegram-backed cloud storage
- Folder management using Telegram channels
- Drag-and-drop uploads
- File previews, thumbnails, audio playback, and video playback
- PDF viewing
- High-performance grid for large folders
- Local-first privacy model
- Cross-platform desktop support through Tauri

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

| Auth Code Screen | Upload Example |
|------------------|----------------|
| ![Auth Code Screen](screenshots/AuthCodeScreen.png) | ![Upload Example](screenshots/UploadExample.png) |

| Folder Creation | Folder List View |
|-----------------|------------------|
| ![Folder Creation](screenshots/FolderCreation.png) | ![Folder List View](screenshots/FolderListView.png) |

## Project Structure

```text
Telegram-Drive/
|-- app/                  # Tauri, React, and Rust application
|   |-- src/              # React frontend
|   |-- src-tauri/        # Rust/Tauri backend
|   |-- package.json      # npm scripts and frontend dependencies
|   `-- vite.config.ts    # Vite development config
|-- screenshots/          # README images
`-- README.md
```

## Requirements

Install these before running the project.

### 1. Node.js

Install Node.js 18 or newer.

- Download: https://nodejs.org/
- Verify:

```bash
node --version
npm --version
```

### 2. Rust and Cargo

Tauri needs Rust and Cargo to compile the desktop backend.

#### Windows

Install Rustup:

```powershell
winget install --id Rustlang.Rustup -e
```

Or download `rustup-init.exe` from https://rustup.rs/.

After installing Rust, close your terminal and open a new one. Then verify:

```powershell
rustc --version
cargo --version
```

If `cargo` is still not found, make sure this folder is in your PATH:

```text
%USERPROFILE%\.cargo\bin
```

#### macOS and Linux

Install Rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Restart your terminal, then verify:

```bash
rustc --version
cargo --version
```

### 3. Tauri System Dependencies

Tauri also needs native build tools for your operating system.

#### Windows

Install Visual Studio Build Tools:

https://visualstudio.microsoft.com/visual-cpp-build-tools/

During installation, select:

- Desktop development with C++
- MSVC build tools
- Windows SDK

Windows 10 and Windows 11 usually already include WebView2. If the app complains about WebView2, install the WebView2 Runtime:

https://developer.microsoft.com/en-us/microsoft-edge/webview2/

#### macOS

Install Xcode Command Line Tools:

```bash
xcode-select --install
```

#### Ubuntu/Debian Linux

Install Tauri's Linux dependencies:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

For other Linux distributions, check the Tauri v2 prerequisites guide:

https://v2.tauri.app/start/prerequisites/

### 4. Telegram API Credentials

You need your own Telegram API ID and API hash.

1. Go to https://my.telegram.org/.
2. Log in with your Telegram account.
3. Open API development tools.
4. Create an application.
5. Save the `api_id` and `api_hash`.
6. Enter them in Telegram Drive when the app asks for them.

## Run the Project

### 1. Clone the Repository

```bash
git clone https://github.com/caamer20/Telegram-Drive.git
cd Telegram-Drive
```

### 2. Install App Dependencies

```bash
cd app
npm install
```

### 3. Start the Desktop App in Development Mode

```bash
npm run tauri dev
```

The first run can take several minutes because Cargo downloads and compiles the Rust dependencies. Later runs are faster.

This command starts the Vite frontend and opens the Tauri desktop window.

## Build the App

From the `app` folder, run:

```bash
npm run tauri build
```

The built installer or application bundle will be created inside:

```text
app/src-tauri/target/release/bundle/
```

## Useful Commands

Run these from the `app` folder.

```bash
npm run dev
```

Starts only the Vite frontend. This is useful for frontend-only work, but it does not run the full desktop app.

```bash
npm run build
```

Builds the frontend with TypeScript and Vite.

```bash
npm run tauri dev
```

Runs the full Tauri desktop app in development mode.

```bash
npm run tauri build
```

Builds the production desktop app.

## Troubleshooting

### `cargo metadata` or `program not found`

This means Cargo is not installed or not available in your terminal PATH.

Fix:

1. Install Rustup.
2. Close the terminal.
3. Open a new terminal.
4. Run:

```bash
cargo --version
```

Then try again:

```bash
npm run tauri dev
```

### `link.exe not found` on Windows

Install Visual Studio Build Tools and select the Desktop development with C++ workload.

### WebView2 Error on Windows

Install the Microsoft Edge WebView2 Runtime:

https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### First Run Is Slow

That is normal. The first Tauri run downloads and compiles Rust crates. It can take 5 to 15 minutes depending on your computer and internet connection.

### npm Audit Warnings

You may see npm vulnerability warnings after `npm install`. They usually come from development dependencies. They do not necessarily stop the app from running.

## Tech Stack

- React
- TypeScript
- Vite
- Tauri v2
- Rust
- Grammers Telegram client
- Tailwind CSS
- Framer Motion

## License

This project is released under the MIT License.

## Disclaimer

This application is not affiliated with Telegram FZ-LLC. Use it responsibly and follow Telegram's Terms of Service.

## Related Project

For a VPN-optimized version, see:

https://github.com/caamer20/Telegram-Drive-ForVPNs
