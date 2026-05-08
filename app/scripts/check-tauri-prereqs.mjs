import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const cargoBinDir = process.platform === "win32" && process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\.cargo\\bin`
  : "";

function hasCommand(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: cargoBinDir
      ? { ...process.env, PATH: `${cargoBinDir}${process.env.PATH ? `;${process.env.PATH}` : ""}` }
      : process.env,
    shell: process.platform === "win32",
    stdio: "pipe",
  });

  return result.status === 0;
}

const hasCargo = hasCommand("cargo")
  || (cargoBinDir && existsSync(`${cargoBinDir}\\cargo.exe`));

if (!hasCargo) {
  const isWindows = process.platform === "win32";

  console.error("\nMissing Rust/Cargo.");
  console.error("Tauri needs Cargo to compile the Rust backend before it can run.");
  console.error("");

  if (isWindows) {
    console.error("Install Rust with one of these options:");
    console.error("  winget install --id Rustlang.Rustup -e");
    console.error("  or download rustup-init.exe from https://rustup.rs/");
    console.error("");
    console.error("After installing, close this terminal, open a new one, then run:");
    console.error("  cargo --version");
    console.error("  npm run tauri dev");
    console.error("");
    console.error("If Cargo is already installed, add this folder to PATH:");
    console.error("  %USERPROFILE%\\.cargo\\bin");
  } else {
    console.error("Install Rust from https://rustup.rs/, restart your shell, then run:");
    console.error("  cargo --version");
    console.error("  npm run tauri dev");
  }

  process.exit(1);
}
