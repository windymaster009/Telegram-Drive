import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const backendDir = path.join(repoRoot, "backend");
const frontendDir = path.join(repoRoot, "frontend");
const npmBin = "npm";
const tauriCli = path.join(
  repoRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const args = process.argv.slice(2);
let viteChild;
let startedVite = false;

function stopProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed || !child.pid) return;

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }

  child.kill(signal);
}

function isPortOpen(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function isViteRunning() {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (await isPortOpen(1420, host)) return true;
  }
  return false;
}

async function waitForVite() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await isViteRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for Vite on port 1420");
}

const command = args[0];
const commandArgs = args.slice(1);
const shouldRunDev = command === "dev" && !commandArgs.some((arg) => arg === "--help" || arg === "-h");

if (shouldRunDev && !(await isViteRunning())) {
  const viteCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npmBin;
  const viteArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm run dev"] : ["run", "dev"];
  viteChild = spawn(viteCommand, viteArgs, {
    cwd: frontendDir,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  startedVite = true;
  await waitForVite();
}

const tauriArgs = shouldRunDev
  ? [
      command,
      "--config",
      JSON.stringify({ build: { beforeDevCommand: "node -e \"process.exit(0)\"" } }),
      ...commandArgs,
    ]
  : args;

const child = spawn(process.execPath, [tauriCli, ...tauriArgs], {
  cwd: backendDir,
  env: {
    ...process.env,
    TELEGRAM_DRIVE_EXTERNAL_BACKEND: "1",
  },
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (startedVite) stopProcessTree(viteChild);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  if (startedVite) stopProcessTree(viteChild, "SIGINT");
  stopProcessTree(child, "SIGINT");
  process.exit(130);
});

process.on("SIGTERM", () => {
  if (startedVite) stopProcessTree(viteChild, "SIGTERM");
  stopProcessTree(child, "SIGTERM");
  process.exit(143);
});
