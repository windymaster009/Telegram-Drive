# Raspberry Pi Web Deployment

This deployment runs Telegram Drive as a web app:

```text
Browser -> Nginx :80/443 -> /api/* -> Rust API :14201
                       -> everything else -> React frontend
```

The Rust API binds to `127.0.0.1:14201`, so it is not exposed directly. The production frontend uses the same browser origin for API requests.

## 1. Install system packages

On 64-bit Raspberry Pi OS / Debian:

```bash
sudo apt update
sudo apt install -y \
  git nginx curl build-essential pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev
```

Install Node.js 20+ and Rust stable if they are not already installed:

```bash
node --version
cargo --version
```

Rust can be installed with rustup:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

For a low-memory Pi, enabling swap before the first Rust release build can prevent the compiler from being killed by the OOM killer.

## 2. Clone and build

```bash
sudo mkdir -p /opt/telegram-drive
sudo chown "$USER":"$USER" /opt/telegram-drive
git clone https://github.com/windymaster009/Telegram-Drive.git /opt/telegram-drive
cd /opt/telegram-drive
npm ci
npm run build:pi
```

`npm run build:pi` creates:

```text
frontend/dist/
backend/target/release/telegram-drive-backend
```

For later updates:

```bash
cd /opt/telegram-drive
git pull origin main
npm ci
npm run build:pi
sudo systemctl restart telegram-drive
sudo systemctl reload nginx
```

## 3. Configure the backend

```bash
cd /opt/telegram-drive
cp backend/.env.example backend/.env
nano backend/.env
```

Recommended Pi values:

```env
TELEGRAM_DRIVE_API_HOST=127.0.0.1
TELEGRAM_DRIVE_API_PORT=14201
TELEGRAM_DRIVE_DATA_DIR=.data
MONGODB_URI=...
MONGODB_DB_NAME=telegram_drive
JWT_SECRET=...
TELEGRAM_SESSION_ENCRYPTION_KEY=...
```

Generate secrets with:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

If the app is exposed through a real HTTPS domain, also set:

```env
TELEGRAM_DRIVE_PUBLIC_API_BASE_URL=https://drive.example.com
GOOGLE_OAUTH_REDIRECT_URI=https://drive.example.com/auth/google/callback
```

Frontend Google OAuth values can be placed in `frontend/.env` before `npm run build:web`:

```env
VITE_GOOGLE_OAUTH_CLIENT_ID=...
VITE_GOOGLE_OAUTH_REDIRECT_URI=https://drive.example.com/auth/google/callback
```

Do not put MongoDB credentials, Telegram API hashes, JWT secrets, or Google client secrets in the frontend environment.

## 4. Install the systemd service

Create the service account and writable data directory:

```bash
sudo useradd --system --no-create-home --home-dir /opt/telegram-drive --shell /usr/sbin/nologin telegram-drive || true
sudo mkdir -p /opt/telegram-drive/backend/.data
sudo chown -R telegram-drive:telegram-drive /opt/telegram-drive/backend/.data
sudo chown telegram-drive:telegram-drive /opt/telegram-drive/backend/.env
sudo chmod 600 /opt/telegram-drive/backend/.env
```

Install and start the service:

```bash
sudo cp deploy/pi/telegram-drive.service /etc/systemd/system/telegram-drive.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-drive
sudo systemctl status telegram-drive
```

Follow logs with:

```bash
journalctl -u telegram-drive -f
```

The API should now answer locally:

```bash
curl http://127.0.0.1:14201/api/system/status
```

## 5. Configure Nginx

```bash
sudo cp deploy/pi/nginx.conf /etc/nginx/sites-available/telegram-drive
sudo ln -sf /etc/nginx/sites-available/telegram-drive /etc/nginx/sites-enabled/telegram-drive
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Open the Pi IP address in a browser. The React app is served by Nginx and its `/api/*` requests are proxied internally to the Rust service.

## 6. Public HTTPS

Keep port `14201` private. If exposing Telegram Drive to the internet, put HTTPS in front of Nginx using a reverse proxy or tunnel and point the public hostname at Nginx. Then update the backend/public OAuth URLs and rebuild the frontend if its OAuth redirect URL changed.

## Useful checks

```bash
systemctl status telegram-drive
systemctl status nginx
curl http://127.0.0.1:14201/api/system/status
curl -I http://127.0.0.1/
journalctl -u telegram-drive -n 100 --no-pager
```
