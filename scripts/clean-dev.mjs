import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 清理本仓库残留的 dev 进程:固定端口占用 + 常驻 watch 进程(nest --watch / vite / dist app)。
// 只按本仓库根路径匹配,绝不误伤同名的其它仓库(如 agework-dev)。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const self = process.pid;

// 端口以 env 为准:server 读 PORT(默认 3000);web(vite)是框架默认 5173
const PORTS = [Number(process.env.PORT ?? 3000), 5173];

// 仓库内 watch/常驻进程特征(不占端口也要清,否则会像僵尸一样堆积)
const PATTERNS = [
  `${repoRoot}/apps/server/node_modules.*nest.js start --watch`,
  `${repoRoot}/apps/server/dist/src/main`,
  `${repoRoot}/apps/web/node_modules.*vite`,
  `${repoRoot}/node_modules.*turbo.*dev`,
];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function pidsOnPort(port) {
  if (isWin) {
    return run(`netstat -ano | findstr :${port} | findstr LISTENING`)
      .split("\n")
      .map((line) => line.trim().split(/\s+/).pop())
      .filter(Boolean);
  }
  return run(`lsof -ti tcp:${port} -sTCP:LISTEN`).split("\n").filter(Boolean);
}

function pidsByPattern(pattern) {
  if (isWin) return []; // Windows 只按端口清理
  return run(`pgrep -f "${pattern}"`).split("\n").filter(Boolean);
}

const targets = new Set();
for (const port of PORTS) for (const pid of pidsOnPort(port)) targets.add(pid);
for (const pattern of PATTERNS) for (const pid of pidsByPattern(pattern)) targets.add(pid);
targets.delete(String(self));

if (targets.size === 0) {
  console.log("clean-dev: 没有残留的 dev 进程");
  process.exit(0);
}

const pids = [...targets];
run(isWin ? pids.map((p) => `taskkill /PID ${p} /F`).join(" & ") : `kill -9 ${pids.join(" ")}`);
console.log(`clean-dev: 已清理 ${pids.length} 个残留进程 (${pids.join(", ")})`);
