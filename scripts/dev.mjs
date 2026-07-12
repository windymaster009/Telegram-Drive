import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const spawnOptions = {
  stdio: "inherit",
  shell: process.platform === "win32",
};

const children = [
  spawn(npm, ["--prefix", "backend", "run", "api"], spawnOptions),
  spawn(npm, ["--prefix", "frontend", "run", "dev"], spawnOptions),
];

let shuttingDown = false;

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      stopAll();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
