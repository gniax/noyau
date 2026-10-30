import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUserText,
  conversationEvents,
  creatorOf,
  normalizeMapConfig,
  parseCrontab,
  parseProdStatus,
  parseTranscriptLine,
  redact,
  scriptName,
  execArgv,
  systemdTime,
  topDir,
  unitStatus,
} from "./agent-map.js";

test("redact masks tokens, keys and credentials but keeps prose", () => {
  const text = [
    "token=abcd1234efgh",
    "TELEGRAM 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawz",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "https://user:hunter2@example.com/path",
    "Le bot tourne bien.",
  ].join("\n");
  const clean = redact(text);
  for (const secret of ["abcd1234efgh", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawz", "eyJhbGciOiJIUzI1NiJ9", "sk-ant-api03", "hunter2"]) assert.equal(clean.includes(secret), false, secret);
  assert.match(clean, /Le bot tourne bien\./);
});

test("user texts are classified as inter-agent, founder or noise", () => {
  assert.deepEqual(classifyUserText("[Message inter-agent de « Atlas (Projet Atlas) »]:\nGo"), { from: "Atlas", kind: "agent", text: "Go" });
  assert.deepEqual(classifyUserText("<pasted_content id=\"x\">[Message inter-agent de « Backlinks »]:\nPhase 1</pasted_content>"), { from: "Backlinks", kind: "agent", text: "Phase 1" });
  assert.equal(classifyUserText("<command-name>/clear</command-name>"), null);
  assert.equal(classifyUserText("[Request interrupted by user]"), null);
  assert.equal(classifyUserText("<system-reminder>x</system-reminder>"), null);
  assert.deepEqual(classifyUserText("Ajoute une carte"), { from: null, kind: "founder", text: "Ajoute une carte" });
  const creator = creatorOf("Créé par Atlas : Tu es l'agent Carte, construis la vue");
  assert.deepEqual(creator, { name: "Atlas", prompt: "Tu es l'agent Carte, construis la vue" });
  assert.equal(classifyUserText("Tu es l'agent Carte, construis la vue complète", creator).from, "Atlas");
});

test("conversation keeps requests and final replies only", () => {
  const lines = [
    { type: "user", timestamp: "2026-10-12T10:00:00Z", message: { content: "Fais X" } },
    { type: "assistant", timestamp: "2026-10-12T10:00:05Z", message: { content: [{ type: "text", text: "Je regarde." }], stop_reason: "tool_use" } },
    { type: "user", timestamp: "2026-10-12T10:00:06Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", timestamp: "2026-10-12T10:01:00Z", message: { content: [{ type: "text", text: "X fait." }], stop_reason: "end_turn" } },
    { type: "user", isSidechain: true, timestamp: "2026-10-12T10:02:00Z", message: { content: "sous-agent" } },
    { type: "user", timestamp: "2026-10-12T10:03:00Z", message: { content: "[Message inter-agent de « Ops »]:\nStatut ?" } },
  ].map((entry) => parseTranscriptLine(JSON.stringify(entry), "claude")).filter(Boolean);
  const events = conversationEvents(lines);
  assert.deepEqual(events.map((event) => [event.direction, event.kind, event.from, event.text]), [
    ["in", "founder", null, "Fais X"],
    ["out", "reply", null, "X fait."],
    ["in", "agent", "Ops", "Statut ?"],
  ]);
  assert.equal(conversationEvents(lines, { since: Date.parse("2026-10-12T10:02:00Z") }).length, 1);
});

test("codex transcripts flush the last assistant message of a turn", () => {
  const lines = [
    { timestamp: "2026-10-12T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] } },
    { timestamp: "2026-10-12T10:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "étape" }] } },
    { timestamp: "2026-10-12T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fini" }] } },
  ].map((entry) => parseTranscriptLine(JSON.stringify(entry), "codex"));
  assert.deepEqual(conversationEvents(lines).map((event) => event.text), ["Go", "fini"]);
  assert.deepEqual(conversationEvents(lines, { working: true }).map((event) => event.text), ["Go"]);
});

test("unit helpers expose script names only and map statuses", () => {
  const argv = execArgv("{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -n /tmp/x.lock /usr/bin/node /home/u/projects/app/run.cjs --token=abc ; ignore_errors=no }");
  assert.equal(scriptName(argv), "run.cjs");
  assert.equal(topDir("/home/u/projects/app/scripts", "/home/u/projects"), "app");
  assert.equal(topDir("/etc/x", "/home/u/projects"), null);
  assert.equal(unitStatus({ Id: "a.service", ActiveState: "failed" }), "err");
  assert.equal(unitStatus({ Id: "a.service", ActiveState: "active", SubState: "running" }), "ok");
  assert.equal(unitStatus({ Id: "a.service", ActiveState: "inactive", Result: "success" }), "stop");
  assert.equal(unitStatus({ Id: "a.service", ActiveState: "inactive", Result: "success", triggeredBy: "a.timer" }), "ok");
  assert.equal(unitStatus({ Id: "a.timer", ActiveState: "active" }, { ActiveState: "failed" }), "err");
  assert.equal(unitStatus({ Id: "a.timer", ActiveState: "active" }, { ActiveState: "activating" }), "run");
  assert.equal(systemdTime("@1791824400"), "2026-10-12T17:00:00.000Z");
  assert.equal(systemdTime("n/a"), null);
});

test("crontab parsing keeps schedule and script, never the command", () => {
  const jobs = parseCrontab("# c\nAPI_KEY=secret\n0 9 * * * cd /home/u/projects/bot && TOKEN=x /usr/bin/node keep-alive.js --all >> log 2>&1\n@reboot /home/u/projects/app/start.sh\n");
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => [job.schedule, job.script]), [["0 9 * * *", "keep-alive.js"], ["@reboot", "start.sh"]]);
  assert.equal(JSON.stringify(jobs).includes("TOKEN"), false);
});

test("prod status output maps service and cron health keys", () => {
  const status = parseProdStatus("VPN: CONNECTÉ (laptop)\nMaintenance: OFF (site public)\nServices: nginx ok · php8.3-fpm ok · mysql failed · tracker ok\nCrons/health (contrôle il y a 9 min): 2 problème(s)\n");
  assert.equal(status.reachable, true);
  assert.equal(status.keys["service:nginx"], "ok");
  assert.equal(status.keys["service:mysql"], "err");
  assert.equal(status.keys.crons, "err");
  assert.equal(status.maintenance, "OFF");
  assert.equal(parseProdStatus("VPN: DÉCONNECTÉ (cvprod absent)").reachable, false);
});

test("map config keeps declared names and drops invalid refs", () => {
  const config = normalizeMapConfig({
    zone: "prod",
    status: { action: "status" },
    units: { "canva-bot.service": { role: "bot", zone: "diffusion" }, "bad name": {} },
    nodes: [{ id: "newsdesk", type: "cron", label: "NewsDesk", statusKey: "crons" }, { id: "../x", type: "cron" }],
    links: [["newsdesk", "unit:llm-proxy.service", "WireGuard"], ["unit:x.service", "api:telegram"], ["rm -rf", "api:x"]],
  });
  assert.equal(config.zone, "prod");
  assert.equal(config.statusAction, "status");
  assert.deepEqual(Object.keys(config.units), ["canva-bot.service"]);
  assert.deepEqual(config.nodes.map((node) => node.id), ["newsdesk"]);
  assert.deepEqual(config.links.map((link) => [link.source, link.target]), [["local:newsdesk", "unit:llm-proxy.service"], ["unit:x.service", "api:telegram"]]);
  assert.equal(normalizeMapConfig(null), null);
});

test("commented crontab listing gives one entry per line with its comment", async () => {
  const { parseCronListing, cronLabel } = await import("./agent-map.js");
  const entries = parseCronListing([
    "## user atlas",
    "# atlas.example - Cron jobs (all times UTC)",
    "# --- PHP crons ---",
    "# IndexNow (Bing/Yandex): new coin pages hourly.",
    "40 * * * * /usr/bin/php /var/www/core/cron/IndexNowCron.php coins >> /var/log/i.log 2>&1",
    "30 6 * * * /usr/bin/php /var/www/core/cron/IndexNowCron.php landings >> /var/log/i.log 2>&1",
    "0 0 * * * /usr/bin/php /var/www/core/cron/AdsCron.php >> /var/log/a.log 2>&1",
    "17 * * * * cd /home/c/trending && API_TOKEN=abcdef123456 /venv/python3 /home/c/trending/main.py >> main.log 2>&1",
    "## user root",
    "# m h  dom mon dow   command",
  ].join("\n"));
  assert.deepEqual(entries.map((entry) => entry.id), ["indexnowcron-coins", "indexnowcron-landings", "adscron", "trending"]);
  assert.equal(entries[0].comment, "IndexNow (Bing/Yandex): new coin pages hourly.");
  assert.equal(entries[1].comment, entries[0].comment);
  assert.equal(entries[2].comment, null);
  assert.equal(entries[3].command.includes("abcdef123456"), false);
  assert.equal(cronLabel(entries[0]), "IndexNowCron · coins");
  assert.equal(cronLabel(entries[3]), "trending");
});

test("schedules read in plain French with Paris time and next run", async () => {
  const { describeCron, nextCronRun, describeCalendar } = await import("./schedule-text.js");
  const now = new Date("2026-10-12T14:50:00Z");
  assert.equal(describeCron("*/10 * * * *"), "toutes les 10 min");
  assert.equal(describeCron("40 * * * *"), "toutes les heures à :40");
  assert.equal(describeCron("30 6 * * *", { now }), "tous les jours à 06:30 UTC (08:30 Paris)");
  assert.equal(describeCron("0 3 * * 0", { now }), "le dimanche à 03:00 UTC (05:00 Paris)");
  assert.equal(nextCronRun("40 * * * *", { from: now }), "2026-10-12T15:40:00.000Z");
  assert.equal(nextCronRun("0 3 * * 0", { from: now }), "2026-10-18T03:00:00.000Z");
  assert.equal(nextCronRun("bad"), null);
  assert.equal(describeCalendar("*-*-* 09:30:00 Europe/Paris"), "tous les jours à 09:30 Paris");
  assert.equal(describeCalendar("*-*-* *:00/15:00"), "toutes les 15 min");
  assert.equal(describeCalendar(["Sun *-*-* 20:00:00 Europe/Paris", "*-*-* 19:00:00 Europe/Paris"]), "le dimanche à 20:00 Paris et tous les jours à 19:00 Paris");
});

test("systemctl show keeps every OnCalendar of a timer", async () => {
  const { parseUnitShow } = await import("./agent-map.js");
  const [unit] = parseUnitShow("Id=a.timer\nTimersCalendar={ OnCalendar=*-*-* 19:00:00 Europe/Paris ; next_elapse=@1 }\nTimersCalendar={ OnCalendar=*-*-* 09:30:00 Europe/Paris ; next_elapse=@2 }\n\n");
  assert.deepEqual(unit.calendars, ["*-*-* 19:00:00 Europe/Paris", "*-*-* 09:30:00 Europe/Paris"]);
});

test("declared APIs keep key names only and a known cost", async () => {
  const { normalizeMapConfig } = await import("./agent-map.js");
  const config = normalizeMapConfig({ apis: { "solana-rpc": { label: "Solana RPC", desc: "RPC", keys: ["SOLANA_RPC_URL=https://x.example/?api-key=abc — .env"], cost: "subscription", lifecycle: "actif" }, bad: { cost: "cheap", lifecycle: "zombie" }, "Bad Id": {} } });
  assert.deepEqual(Object.keys(config.apis), ["solana-rpc", "bad"]);
  assert.deepEqual(config.apis["solana-rpc"].keys, ["SOLANA_RPC_URL"]);
  assert.equal(config.apis["solana-rpc"].cost, "subscription");
  assert.equal(config.apis.bad.cost, null);
  assert.equal(config.apis.bad.lifecycle, null);
});
