#!/usr/bin/env node
// Tri des fichiers partagés Noyau: scan, mise à la corbeille motivée (restaurable 30 j), rapport final.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// Noyau tourne en local avec un certificat auto-signe: l'avertissement TLS de Node ne ferait que polluer la sortie.
process.emitWarning = () => {};
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));

const USAGE = `Usage: node scripts/noyau-file-sort.mjs <commande> --project <id|nom>

  scan                                              fichiers + sha256, doublons, founder, protected (< 48 h)
  trash <nom> --reason R [--duplicate-of <gardé>]   met à la corbeille (restaurable 30 j)
  keep <nom> --reason R                             gardé en cas de doute (apparaît dans le rapport)
  finish [--summary S]                              termine le tri et arrête l'agent de tri
  status                                            état du tri et corbeille`;

function parse(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) options[arg.slice(2)] = true;
      else { options[arg.slice(2)] = next; index += 1; }
    } else positional.push(arg);
  }
  return { positional, options };
}

const print = (data) => process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);

try {
  const { positional, options } = parse(process.argv.slice(2));
  const command = (positional[0] || "help").toLowerCase();
  if (["help", "-h", "--help"].includes(command) || options.help) {
    print(USAGE);
    process.exit(0);
  }
  const [token, projectsRaw] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((value) => value.trim()).catch(() => ""),
    fs.readFile(path.join(dataDir, "projects.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  const all = Object.entries(projectsRaw.projects || projectsRaw).filter(([, project]) => project?.name);
  const needle = String(options.project || process.env.NOYAU_PROJECT_ID || "").toLowerCase();
  const found = all.find(([id]) => id.toLowerCase() === needle) || all.find(([, project]) => project.name.toLowerCase() === needle);
  if (!found) throw new Error(`--project requis (${all.map(([id, project]) => `${project.name}=${id}`).join(", ")})`);
  const [projectId, project] = found;

  const api = async (pathname, body) => {
    const response = await fetch(`https://127.0.0.1:4242/api/projects/${encodeURIComponent(projectId)}/files/sort${pathname}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json", ...(project.profileId ? { "x-noyau-profile": project.profileId } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Noyau: erreur ${response.status}`);
    return payload;
  };
  const name = positional.slice(1).join(" ");

  if (command === "scan") print((await api("/scan")).files);
  else if (command === "status") print(await api(""));
  else if (command === "trash") {
    if (!name || !options.reason) throw new Error(`Nom et --reason requis.\n\n${USAGE}`);
    const item = await api("/trash", { name, reason: String(options.reason), duplicateOf: typeof options["duplicate-of"] === "string" ? options["duplicate-of"] : null });
    print({ trashed: item.name, id: item.id, size: item.size });
  } else if (command === "keep") {
    if (!name || !options.reason) throw new Error(`Nom et --reason requis.\n\n${USAGE}`);
    print(await api("/keep", { name, reason: String(options.reason) }));
  } else if (command === "finish") print(await api("/finish", { summary: typeof options.summary === "string" ? options.summary : "" }));
  else throw new Error(`Commande inconnue : ${command}\n\n${USAGE}`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
