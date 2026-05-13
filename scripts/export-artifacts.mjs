import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const frontendDir = path.join(repoRoot, "frontend");
const desktopExportDir = process.env.EXPORT_DESKTOP_DIR || "D:\\app\\DESKTOP APP";
const androidExportDir = process.env.EXPORT_ANDROID_DIR || "D:\\app\\ANDROID APP";
const desktopBundleDir = path.join(repoRoot, "backend", "target", "release", "bundle");
const androidApkDir = path.join(repoRoot, "backend", "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
const androidGradleFile = path.join(repoRoot, "backend", "src-tauri", "gen", "android", "app", "build.gradle.kts");
const backendTauriRunner = path.join(repoRoot, "backend", "scripts", "run-tauri.mjs");

const args = process.argv.slice(2);
const mode = args.find((arg) => !arg.startsWith("--")) || "help";
const skipBuild = args.includes("--skip-build");

const help = `
Usage:
  npm run export:desktop -- --backend-url=http://<PI-IP>:14201
  npm run export:android -- --backend-url=http://<PI-IP>:14201
  npm run export:all -- --backend-url=http://<PI-IP>:14201

Environment alternatives:
  VITE_BACKEND_URL=http://<PI-IP>:14201
  VITE_API_BASE_URL=http://<PI-IP>:14201

Optional:
  EXPORT_DESKTOP_DIR="D:\\app\\DESKTOP APP"
  EXPORT_ANDROID_DIR="D:\\app\\ANDROID APP"
  ALLOW_LOCAL_BACKEND=1
`;

if (mode === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(help.trim());
  process.exit(0);
}

function optionValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function resolveBackendUrl() {
  const raw =
    optionValue("--backend-url") ||
    process.env.VITE_BACKEND_URL ||
    process.env.VITE_API_BASE_URL ||
    process.env.TELEGRAM_DRIVE_PUBLIC_API_BASE_URL;

  if (!raw) {
    throw new Error(
      "Missing backend URL. Set VITE_BACKEND_URL, VITE_API_BASE_URL, or pass --backend-url=http://<PI-IP>:14201.",
    );
  }

  const normalized = raw.trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Backend URL must use http or https: ${normalized}`);
  }

  const isLocalhost = ["localhost", "127.0.0.1", "::1", "tauri.localhost"].includes(parsed.hostname);
  if (isLocalhost && process.env.ALLOW_LOCAL_BACKEND !== "1") {
    throw new Error(
      `Refusing to export a production client pointed at ${parsed.hostname}. Set ALLOW_LOCAL_BACKEND=1 only for intentional local test builds.`,
    );
  }

  return { value: normalized, url: parsed };
}

function assertNoSecretViteEnv(env) {
  const allowed = new Set([
    "VITE_API_BASE_URL",
    "VITE_BACKEND_URL",
    "VITE_GOOGLE_OAUTH_CLIENT_ID",
    "VITE_GOOGLE_OAUTH_REDIRECT_URI",
  ]);
  const riskyPatterns = [/API_HASH/i, /TELEGRAM_API/i, /MONGO/i, /SECRET/i, /PASSWORD/i, /SESSION/i, /PRIVATE/i, /TOKEN/i];
  const risky = Object.keys(env)
    .filter((key) => key.startsWith("VITE_") && !allowed.has(key))
    .filter((key) => riskyPatterns.some((pattern) => pattern.test(key)));

  if (risky.length > 0) {
    throw new Error(
      `Refusing to export because these VITE_* variables look secret-like and would be bundled into the frontend: ${risky.join(", ")}`,
    );
  }
}

function tauriConfigForBackend(backendUrl) {
  const origin = backendUrl.origin;
  const csp = [
    "default-src 'self'",
    `connect-src 'self' ${origin}`,
    `media-src 'self' ${origin}`,
    `img-src 'self' data: blob: asset: https://asset.localhost ${origin}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "worker-src 'self' blob:",
  ].join("; ");

  return JSON.stringify({
    build: {
      beforeBuildCommand: "node -e \"process.exit(0)\"",
    },
    app: {
      security: {
        csp: `${csp};`,
      },
    },
  });
}

function run(command, commandArgs, env, cwd = repoRoot) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runTauri(tauriArgs, env) {
  run(process.execPath, [backendTauriRunner, ...tauriArgs], env);
}

function firstExisting(paths) {
  return paths.find((candidate) => existsSync(candidate));
}

function runFrontendBuild(env) {
  const tscBin = firstExisting([
    path.join(frontendDir, "node_modules", "typescript", "bin", "tsc"),
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
  ]);
  const viteBin = firstExisting([
    path.join(frontendDir, "node_modules", "vite", "bin", "vite.js"),
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
  ]);

  if (!tscBin || !viteBin) {
    throw new Error("Could not find local TypeScript/Vite binaries. Run `npm install` first.");
  }

  run(process.execPath, [tscBin], env, frontendDir);
  run(process.execPath, [viteBin, "build"], env, frontendDir);
}

function ensureAndroidCleartextCanFollowBackend() {
  if (!existsSync(androidGradleFile)) {
    console.warn("Android Gradle file was not found yet. If this is a fresh checkout, run `npm --prefix backend run tauri -- android init` first.");
  }
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function newestFirst(files) {
  return [...files].sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs);
}

function desktopArtifacts() {
  const nsisArtifacts = newestFirst(
    walkFiles(path.join(desktopBundleDir, "nsis")).filter((file) => path.extname(file).toLowerCase() === ".exe"),
  );
  if (nsisArtifacts.length > 0) return [nsisArtifacts[0]];

  const extensions = new Set([".exe", ".msi", ".dmg", ".appimage", ".deb", ".rpm"]);
  const fallbackArtifacts = newestFirst(
    walkFiles(desktopBundleDir).filter((file) => extensions.has(path.extname(file).toLowerCase())),
  );
  return fallbackArtifacts.slice(0, 1);
}

function androidArtifacts() {
  const files = walkFiles(androidApkDir).filter((file) => path.extname(file).toLowerCase() === ".apk");
  const signedReleaseFiles = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower.includes("release") && !lower.includes("unsigned");
  });
  if (signedReleaseFiles.length > 0) {
    return newestFirst(signedReleaseFiles).slice(0, 1);
  }

  const unsignedReleaseFiles = newestFirst(
    files.filter((file) => {
      const lower = file.toLowerCase();
      return lower.includes("release") && lower.includes("unsigned");
    }),
  );
  const debugFiles = newestFirst(files.filter((file) => file.toLowerCase().includes("debug")));

  if (unsignedReleaseFiles.length > 0) {
    const message = [
      "Android export found only unsigned release APKs.",
      "Unsigned release APKs cannot be installed directly on a device.",
      `Unsigned release APK: ${unsignedReleaseFiles[0]}`,
      debugFiles[0]
        ? `For local testing, install the debug APK instead: ${debugFiles[0]}`
        : "No debug APK was found for local testing.",
      "For a shareable release APK, configure Android signing and build a signed release APK.",
    ].join("\n");
    throw new Error(message);
  }

  return newestFirst(files).slice(0, 1);
}

function copyArtifacts(files, destination) {
  if (files.length === 0) {
    throw new Error(`No artifacts found to copy into ${destination}.`);
  }
  mkdirSync(destination, { recursive: true });

  const seen = new Set();
  for (const file of files) {
    let name = path.basename(file);
    if (seen.has(name)) {
      name = `${path.basename(path.dirname(file))}-${name}`;
    }
    seen.add(name);
    const target = path.join(destination, name);
    copyFileSync(file, target);
    console.log(`Copied ${file} -> ${target}`);
  }
}

const { value: backendUrl, url: parsedBackendUrl } = resolveBackendUrl();
const exportEnv = {
  ...process.env,
  VITE_API_BASE_URL: backendUrl,
  VITE_BACKEND_URL: backendUrl,
  TELEGRAM_DRIVE_EXTERNAL_BACKEND: "1",
  TELEGRAM_DRIVE_PUBLIC_API_BASE_URL: backendUrl,
  TAURI_ANDROID_USES_CLEARTEXT: parsedBackendUrl.protocol === "http:" ? "true" : "false",
};
assertNoSecretViteEnv(exportEnv);

const tauriConfig = tauriConfigForBackend(parsedBackendUrl);

function buildDesktop() {
  console.log(`Building desktop client for backend ${backendUrl}`);
  runFrontendBuild(exportEnv);
  runTauri(["build", "--bundles", "nsis", "--config", tauriConfig], exportEnv);
}

function buildAndroid() {
  console.log(`Building Android client for backend ${backendUrl}`);
  ensureAndroidCleartextCanFollowBackend();
  runFrontendBuild(exportEnv);
  runTauri(["android", "build", "--apk", "--config", tauriConfig], exportEnv);
}

switch (mode) {
  case "build:desktop":
    if (!skipBuild) buildDesktop();
    break;
  case "build:android":
    if (!skipBuild) buildAndroid();
    break;
  case "export:desktop":
    if (!skipBuild) buildDesktop();
    copyArtifacts(desktopArtifacts(), desktopExportDir);
    break;
  case "export:android":
    if (!skipBuild) buildAndroid();
    copyArtifacts(androidArtifacts(), androidExportDir);
    break;
  case "export:all":
    if (!skipBuild) {
      buildDesktop();
      buildAndroid();
    }
    copyArtifacts(desktopArtifacts(), desktopExportDir);
    copyArtifacts(androidArtifacts(), androidExportDir);
    break;
  default:
    console.error(`Unknown export mode: ${mode}`);
    console.error(help.trim());
    process.exit(1);
}
