import { spawnSync } from "node:child_process";

const port = process.argv[2] || "1420";

if (process.platform === "win32") {
  const command = [
    "$pids = Get-NetTCPConnection -LocalPort",
    port,
    "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;",
    "foreach ($pid in $pids) {",
    "if ($pid -and $pid -ne $PID) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }",
    "}",
  ].join(" ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 0);
}

const result = spawnSync("sh", ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`], {
  stdio: "inherit",
});
process.exit(result.status ?? 0);
