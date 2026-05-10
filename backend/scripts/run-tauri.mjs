import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const repoRoot = resolve(backendDir, "..");
const isWindows = process.platform === "win32";
const cargoBinDir = isWindows && process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\.cargo\\bin`
  : "";
const localTauriBin = resolve(backendDir, "node_modules", ".bin", isWindows ? "tauri.cmd" : "tauri");
const localTauriJs = resolve(backendDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
const workspaceTauriBin = resolve(repoRoot, "node_modules", ".bin", isWindows ? "tauri.cmd" : "tauri");
const workspaceTauriJs = resolve(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const fallbackTauriBin = resolve(repoRoot, "frontend", "node_modules", ".bin", isWindows ? "tauri.cmd" : "tauri");
const fallbackTauriJs = resolve(repoRoot, "frontend", "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauriBin = [localTauriBin, workspaceTauriBin, fallbackTauriBin].find(existsSync) || localTauriBin;
const tauriJs = [localTauriJs, workspaceTauriJs, fallbackTauriJs].find(existsSync) || localTauriJs;
const vsDevCmd = isWindows
  ? `${process.env["ProgramFiles(x86)"] || ""}\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat`
  : "";

if (!existsSync(isWindows ? tauriJs : tauriBin)) {
  console.error("Tauri CLI was not found in node_modules.");
  console.error("Run this first:");
  console.error("  npm install");
  process.exit(1);
}

const env = {
  ...process.env,
  PATH: cargoBinDir
    ? `${cargoBinDir}${process.env.PATH ? `${isWindows ? ";" : ":"}${process.env.PATH}` : ""}`
    : process.env.PATH,
};

function quoteCmdArg(arg) {
  return `"${arg.replaceAll('"', '""')}"`;
}

const tauriArgs = process.argv.slice(2);

const result = isWindows && existsSync(vsDevCmd)
  ? spawnSync(
      "cmd.exe",
      [
        "/d",
        "/c",
        [
          "call",
          quoteCmdArg(vsDevCmd),
          "-arch=amd64",
          "-host_arch=amd64",
          "&&",
          quoteCmdArg(process.execPath),
          quoteCmdArg(tauriJs),
          ...tauriArgs.map(quoteCmdArg),
        ].join(" "),
      ],
      {
        cwd: backendDir,
        env,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    )
  : spawnSync(isWindows ? process.execPath : tauriBin, isWindows ? [tauriJs, ...tauriArgs] : tauriArgs, {
      cwd: backendDir,
      env,
      stdio: "inherit",
    });

process.exit(result.status ?? 1);
