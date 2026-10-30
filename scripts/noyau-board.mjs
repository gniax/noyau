#!/usr/bin/env node
// Pages de suivi Noyau: chaque agent tient son tableau (prévu / en cours / décision fondateur / fait, KPI, rapports).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
// Noyau tourne en local avec un certificat auto-signe: l'avertissement TLS de Node ne ferait que polluer la sortie.
process.emitWarning = () => {};
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));

const USAGE = `Usage: node scripts/noyau-board.mjs <commande> [...] [--project <nom>]

  list                                   tableaux du projet + décisions en attente
  show <tableau>                         contenu complet (ids des éléments)
  set <tableau> [--title T] [--objective O]   crée ou met à jour l'en-tête (tu deviens propriétaire)
  kpi <tableau> <libellé> <valeur> [--note N] | kpi <tableau> <libellé> --remove
  add <tableau> <colonne> <titre> [--date AAAA-MM-JJ] [--detail D] [--link https://…]
  edit <tableau> <élément> [--title T] [--date D] [--detail D] [--link L]
  move <tableau> <élément> <colonne>
  done <tableau> <élément>               raccourci de move … done
  ask <tableau> <titre> [--detail D] [--link L]   raccourci de add … waiting (décision fondateur)
  rm <tableau> <élément>
  report <tableau> <titre> (--url https://… | --file rapport.html|pdf|png) [--date D]
  report-rm <tableau> <id-rapport>
  delete-board <tableau>

Colonnes : planned (prévu) · inProgress (en cours) · waiting (décision fondateur) · done (fait)
<tableau> = identifiant court en minuscules (ex: marketing-auto). <élément> = id (#a1b2c3) ou extrait unique du titre.`;

function parse(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) options[key] = true;
      else { options[key] = next; index += 1; }
    } else positional.push(arg);
  }
  return { positional, options };
}

async function context(projectOption) {
  const [token, sessions, projects] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((value) => value.trim()).catch(() => ""),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(path.join(dataDir, "projects.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  const allProjects = Object.entries(projects.projects || projects).filter(([, project]) => project && typeof project === "object" && project.name);
  const cwd = path.resolve(process.cwd());
  const exact = process.env.NOYAU_SESSION_ID && sessions[process.env.NOYAU_SESSION_ID] ? [process.env.NOYAU_SESSION_ID, sessions[process.env.NOYAU_SESSION_ID]] : null;
  const owner = exact || Object.entries(sessions)
    .filter(([, session]) => session?.cwd && (cwd === path.resolve(session.cwd) || cwd.startsWith(`${path.resolve(session.cwd)}${path.sep}`)))
    .sort((a, b) => path.resolve(b[1].cwd).length - path.resolve(a[1].cwd).length || Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0))[0];
  let projectId = owner?.[1]?.projectId || null;
  if (projectOption) {
    const needle = String(projectOption).toLowerCase();
    const found = allProjects.find(([id]) => id === projectOption)
      || allProjects.find(([, project]) => project.name.toLowerCase() === needle)
      || allProjects.find(([, project]) => project.name.toLowerCase().includes(needle));
    if (!found) throw new Error(`Projet « ${projectOption} » introuvable. Projets : ${allProjects.map(([, project]) => project.name).join(", ")}`);
    projectId = found[0];
  }
  if (!projectId) throw new Error("Projet inconnu pour cet agent : ajoute --project <nom>.");
  const profileId = allProjects.find(([id]) => id === projectId)?.[1]?.profileId || owner?.[1]?.profileId || "";

  async function api(pathname, options = {}) {
    const response = await fetch(`https://127.0.0.1:4242/api/projects/${encodeURIComponent(projectId)}/tracking${pathname}`, {
      ...options,
      headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json", ...(profileId ? { "x-noyau-profile": profileId } : {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Noyau: erreur ${response.status}`);
    return payload;
  }

  return { api, agentId: owner?.[0] || null, agentName: owner?.[1]?.name || null };
}

const print = (data) => process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
const seg = (value) => encodeURIComponent(String(value || "").replace(/^#/, ""));
const need = (value, message) => { if (!value) throw new Error(`${message}\n\n${USAGE}`); return value; };

try {
  const { positional, options } = parse(process.argv.slice(2));
  const command = (positional[0] || "help").toLowerCase();
  if (["help", "-h", "--help"].includes(command) || options.help) {
    print(USAGE);
    process.exit(0);
  }
  const { api, agentId, agentName } = await context(options.project);
  const board = positional[1];
  const send = (method, body) => ({ method, body: JSON.stringify(body) });

  if (command === "list" || command === "ls") {
    print(await api(""));
  } else if (command === "show") {
    print(await api(`/${seg(need(board, "Tableau requis."))}`));
  } else if (command === "set") {
    const body = { agentId, agentName };
    if (options.title !== undefined) body.title = String(options.title);
    if (options.objective !== undefined) body.objective = String(options.objective);
    const result = await api(`/${seg(need(board, "Tableau requis."))}`, send("PUT", body));
    print({ board: result.id, title: result.title, agent: result.agentName });
  } else if (command === "kpi") {
    const label = need(positional[2], "Libellé KPI requis.");
    const body = options.remove ? { label, remove: true } : { label, value: need(positional[3], "Valeur KPI requise."), ...(options.note !== undefined ? { note: String(options.note) } : {}) };
    print((await api(`/${seg(need(board, "Tableau requis."))}/kpis`, send("PUT", body))).kpis);
  } else if (command === "add" || command === "ask") {
    const column = command === "ask" ? "waiting" : need(positional[2], "Colonne requise.");
    const title = need(positional.slice(command === "ask" ? 2 : 3).join(" "), "Titre requis.");
    const item = await api(`/${seg(need(board, "Tableau requis."))}/items`, send("POST", { column, title, date: options.date, detail: options.detail, link: options.link, agentId, agentName }));
    print({ added: `#${item.id}`, column: item.column, title: item.title });
  } else if (command === "edit") {
    const body = {};
    for (const key of ["title", "date", "detail", "link"]) if (options[key] !== undefined) body[key] = options[key] === true ? "" : String(options[key]);
    const item = await api(`/${seg(need(board, "Tableau requis."))}/items/${seg(need(positional[2], "Élément requis."))}`, send("PATCH", body));
    print({ updated: `#${item.id}`, column: item.column, title: item.title });
  } else if (command === "move" || command === "done") {
    const column = command === "done" ? "done" : need(positional[3], "Colonne requise.");
    const item = await api(`/${seg(need(board, "Tableau requis."))}/items/${seg(need(positional[2], "Élément requis."))}`, send("PATCH", { column }));
    print({ moved: `#${item.id}`, column: item.column, title: item.title });
  } else if (command === "rm") {
    const item = await api(`/${seg(need(board, "Tableau requis."))}/items/${seg(need(positional[2], "Élément requis."))}`, { method: "DELETE" });
    print({ removed: `#${item.id}`, title: item.title });
  } else if (command === "report") {
    const title = need(positional.slice(2).join(" "), "Titre du rapport requis.");
    const body = { title, date: options.date };
    if (options.url) body.url = String(options.url);
    else if (options.file) {
      const file = path.resolve(String(options.file));
      body.fileName = path.basename(file);
      body.content = (await fs.readFile(file)).toString("base64");
    } else throw new Error(`--url https://… ou --file <chemin> requis.\n\n${USAGE}`);
    const report = await api(`/${seg(need(board, "Tableau requis."))}/reports`, send("POST", body));
    print({ report: report.id, title: report.title, url: report.url, file: report.file });
  } else if (command === "report-rm") {
    print(await api(`/${seg(need(board, "Tableau requis."))}/reports/${seg(need(positional[2], "Id du rapport requis."))}`, { method: "DELETE" }));
  } else if (command === "delete-board") {
    print(await api(`/${seg(need(board, "Tableau requis."))}`, { method: "DELETE" }));
  } else {
    throw new Error(`Commande inconnue : ${command}\n\n${USAGE}`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
