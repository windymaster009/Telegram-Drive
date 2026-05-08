import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
const cargoBinDir = isWindows && process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\.cargo\\bin`
  : "";
const tauriBin = resolve(appDir, "node_modules", ".bin", isWindows ? "tauri.cmd" : "tauri");
const vsDevCmd = isWindows
  ? `${process.env["ProgramFiles(x86)"]}\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat`
  : "";

if (!existsSync(tauriBin)) {
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

const tauriArgs = process.argv
  .slice(2)
  .map((arg) => `"${arg.replaceAll('"', '""')}"`)
  .join(" ");

const result = isWindows && existsSync(vsDevCmd)
  ? spawnSync(
      "cmd.exe",
      [
        "/d",
        "/c",
        `call "${vsDevCmd}" -arch=amd64 -host_arch=amd64 && call "${tauriBin}" ${tauriArgs}`,
      ],
      {
        cwd: appDir,
        env,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    )
  : spawnSync(tauriBin, process.argv.slice(2), {
      cwd: appDir,
      env,
      shell: isWindows,
      stdio: "inherit",
    });

process.exit(result.status ?? 1);
