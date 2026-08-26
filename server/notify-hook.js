import fs from "node:fs/promises";

const source = process.argv[2];
const dataDir = process.env.NOYAU_DATA_DIR || "/home/user/projects/noyau/.data";
const sessionId = process.env.NOYAU_SESSION_ID || null;

if (!sessionId) process.exit(0);

async function stdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const raw = source === "codex" ? process.argv[3] : await stdin();
  const event = JSON.parse(raw || "{}");
  const compactEvent = source === "codex"
    ? { type: event.type, "thread-id": event["thread-id"], "last-assistant-message": event["last-assistant-message"] }
    : {
        hook_event_name: event.hook_event_name,
        transcript_path: event.transcript_path,
        session_id: event.session_id,
        last_assistant_message: event.last_assistant_message,
        title: event.title,
        message: event.message,
        notification_type: event.notification_type,
      };
  const token = (await fs.readFile(`${dataDir}/access-token`, "utf8")).trim();
  const response = await fetch("http://127.0.0.1:4242/api/hooks/notify", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ source, sessionId, event: compactEvent }),
  });
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Noyau notification: ${error.message}`);
  process.exitCode = 1;
}
