import fs from "node:fs/promises";

const source = process.argv[2];
const dataDir = process.env.NOYAU_DATA_DIR || "/home/user/projects/noyau/.data";

async function stdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const raw = source === "codex" ? process.argv[3] : await stdin();
  const event = JSON.parse(raw || "{}");
  const token = (await fs.readFile(`${dataDir}/access-token`, "utf8")).trim();
  const response = await fetch("http://127.0.0.1:4242/api/hooks/notify", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source, sessionId: process.env.NOYAU_SESSION_ID || null, event }),
  });
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Noyau notification: ${error.message}`);
  process.exitCode = 1;
}
