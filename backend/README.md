# Telegram Drive Backend

This folder contains the Rust/Tauri backend for Telegram Drive.

It provides:

- Embedded Tauri desktop backend
- Standalone local REST API
- Telegram owner session management
- MongoDB persistence
- Google OAuth session support
- Admin/user authorization
- Folder permission enforcement
- Local preview/cache server for video, audio, and PDF previews

## Environment

Copy the example file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Required secrets and config live in `backend/.env`, not in the frontend.

Important values:

- `MONGODB_URI`: MongoDB connection string.
- `MONGODB_DB_NAME`: MongoDB database name.
- `JWT_SECRET`: long random secret for app sessions.
- `TELEGRAM_SESSION_ENCRYPTION_KEY`: stable 32-byte key for encrypted Telegram sessions.
- `GOOGLE_OAUTH_CLIENT_ID`: Google OAuth client ID.
- `GOOGLE_OAUTH_CLIENT_SECRET`: Google OAuth client secret.
- `GOOGLE_OAUTH_REDIRECT_URI`: OAuth redirect URL.
- `TELEGRAM_API_ID`: optional owner API ID seed.
- `TELEGRAM_API_HASH`: optional owner API hash seed.

Do not rotate `TELEGRAM_SESSION_ENCRYPTION_KEY` unless you are ready to delete and recreate the Telegram owner session.

## Run API Only

From the repository root:

```bash
npm run dev:api
```

From this folder:

```bash
npm run api
```

or:

```bash
cargo run
```

The API listens on `http://127.0.0.1:14201` by default.

## Run Desktop App

From the repository root:

```bash
npm run tauri:dev
```

## Build Desktop App

From the repository root:

```bash
npm run build
```

The executable and installers are created under:

```text
backend/target/release/
backend/target/release/bundle/
```

## Data Files

By default local backend data is stored in:

```text
backend/.data/
```

Important files:

- `telegram.session.enc`: encrypted Telegram owner session.
- `master.key`: local encryption key for stored owner secrets.
- `jwt.key`: generated only when `JWT_SECRET` is not set.

Keep these private. Do not commit them.

## Permissions Model

Folder permission states are:

- Hidden: no permission record; folder is not visible to that user.
- Read Only: user can view/download.
- Read + Write: user can upload and move/copy where allowed.

Folders created by a user are always visible to that user as Read + Write.

## Preview Cache

Preview jobs download Telegram media into temporary files and serve those files through the local API. Closing a preview cancels the job and removes the temp file. Video previews may also prefetch the end of the file to support MP4 metadata stored at the tail.

## Troubleshooting

If the backend fails to start:

- Check `backend/.env`.
- Confirm MongoDB is reachable.
- Confirm `TELEGRAM_SESSION_ENCRYPTION_KEY` exists and is valid.
- Confirm no old Telegram Drive process is already using port `14201`.

If Cargo is missing, install Rust from https://rustup.rs/ and restart your terminal.
