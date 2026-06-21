import { execSync } from "node:child_process";

const port = process.argv[2];

if (!port) {
  console.error("Usage: pnpm kill-port <port>");
  process.exit(1);
}

const isWin = process.platform === "win32";

try {
  if (isWin) {
    const pid = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: "utf-8",
    })
      .trim()
      .split("\n")[0]
      ?.trim()
      .split(/\s+/)
      .pop();

    if (!pid) {
      console.log(`No process listening on port ${port}`);
      process.exit(0);
    }

    execSync(`taskkill /PID ${pid} /F`, { stdio: "inherit" });
    console.log(`Killed process ${pid} on port ${port}`);
  } else {
    const pids = execSync(`lsof -ti :${port}`, {
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    if (pids.length === 0) {
      console.log(`No process listening on port ${port}`);
      process.exit(0);
    }

    execSync(`kill -9 ${pids.join(" ")}`, { stdio: "inherit" });
    console.log(`Killed process(es) on port ${port}: ${pids.join(", ")}`);
  }
} catch {
  console.log(`No process listening on port ${port}`);
}
