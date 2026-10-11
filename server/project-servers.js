import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

export function isProjectServer(root, cwd, command) {
  if (!inside(root, cwd)) return false;
  return /^(?:next-server\b|(?:\S*\/)?(?:node|bun|deno)\s+\S*(?:\/next\s+(?:dev|start)\b|\/vite(?:\s|$)|\/tsx\s+watch\b))/.test(command)
    || /^php\s+-S\s/.test(command);
}

export function isProjectContainer(root, container) {
  const labels = container.Config?.Labels || {};
  const cwd = labels["com.docker.compose.project.working_dir"] || "";
  const config = labels["com.docker.compose.project.config_files"] || "";
  const service = labels["com.docker.compose.service"];
  return (inside(root, cwd) || config.split(",").some((file) => inside(root, file)))
    && ["web", "api", "gateway", "nginx", "php", "frontend", "backend"].includes(service);
}

export async function projectServers(root) {
  root = await fs.realpath(root);
  const processes = [];
  for (const pid of (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    try {
      const cwd = await fs.readlink(`/proc/${pid}/cwd`);
      const command = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
      if (isProjectServer(root, cwd, command)) processes.push({ pid: Number(pid), cwd, command });
    } catch { /* Process may have exited or belong to another user. */ }
  }
  let containers = [];
  const warnings = [];
  try {
    const { stdout } = await exec("docker", ["ps", "-q"], { timeout: 5000 });
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      const result = await exec("docker", ["inspect", ...ids], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      containers = JSON.parse(result.stdout).filter((item) => isProjectContainer(root, item))
        .map((item) => ({ id: item.Id, name: item.Name.replace(/^\//, "") }));
    }
  } catch (error) { warnings.push(`Docker indisponible: ${error.message.split("\n")[0]}`); }
  return { root, processes, containers, warnings };
}

export async function stopProjectServers(root) {
  const found = await projectServers(root);
  for (const item of found.processes) {
    try {
      // Recheck identity immediately before signaling to avoid stale PID matches.
      const cwd = await fs.readlink(`/proc/${item.pid}/cwd`);
      const command = (await fs.readFile(`/proc/${item.pid}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
      if (cwd === item.cwd && command === item.command) process.kill(item.pid, "SIGTERM");
    } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
  }
  if (found.containers.length) await exec("docker", ["stop", "--time", "10", ...found.containers.map((item) => item.id)], { timeout: 60000 });
  return found;
}
