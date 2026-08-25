import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const statusline = process.argv[2];
const dataDir = process.env.NOYAU_DATA_DIR || "/home/user/projects/noyau/.data";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const forward = new Promise((resolve) => {
  if (!statusline) return resolve();
  const child = spawn("/bin/bash", [statusline], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdout.pipe(process.stdout);
  child.stdin.end(raw);
  child.on("close", resolve);
  child.on("error", resolve);
});

const report = (async () => {
  try {
    const token = (await fs.readFile(`${dataDir}/access-token`, "utf8")).trim();
    await fetch("http://127.0.0.1:4242/api/hooks/claude-statusline", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: raw || "{}",
      signal: AbortSignal.timeout(1000),
    });
  } catch { /* dashboard quota remains last known value */ }
})();

await Promise.all([forward, report]);
