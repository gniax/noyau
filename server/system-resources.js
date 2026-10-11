import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLOCK_TICKS = 100;
const PAGE_KB = 4;
const SAMPLE_MS = 400;
const DOCKER_TTL_MS = 20_000;
// CLIs d'agents IA reperes hors Noyau (lances a la main dans un terminal).
export const AGENT_BINARY = /^(claude|codex|agy|antigravity|gemini)$/;

export async function processTable() {
  return readProcesses();
}

export function descendants(table, rootPids) {
  const children = new Map();
  for (const [pid, proc] of table) {
    const list = children.get(proc.ppid) || [];
    list.push(pid);
    children.set(proc.ppid, list);
  }
  const result = new Set();
  const stack = [...rootPids].filter((pid) => table.has(pid));
  while (stack.length) {
    const pid = stack.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    stack.push(...(children.get(pid) || []));
  }
  return result;
}

// Un processus detache de tmux (reparente a systemd) garde la variable posee par Noyau dans le pane.
export async function sessionIdFromEnv(pid) {
  try {
    const environ = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    return environ.match(/(?:^|\0)NOYAU_SESSION_ID=([^\0]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

// Navigateur ou appli graphique ouverte depuis un agent: c'est souvent la fenetre de l'utilisateur, on n'y touche pas.
const GUI_APP = /^(firefox|chrome|chromium|chromium-browse|google-chrome|brave|msedge|opera|thunderbird|code|electron|slack|discord)$/i;

export async function isGuiApp(table, pid) {
  const name = table.get(pid)?.name || "";
  const command = await readCmdline(pid);
  if (/--headless|headless_shell/.test(command) || /headless/i.test(name)) return false;
  return GUI_APP.test(name) || /\/(firefox|chrome|chromium|brave|google-chrome)(\/|$)/i.test(command.split(" ")[0] || "");
}

// Regroupe les processus detaches d'une session par racine (le plus haut porteur de NOYAU_SESSION_ID).
export function detachedRoots(table, owned) {
  return [...owned.keys()].filter((pid) => owned.get(table.get(pid)?.ppid) !== owned.get(pid));
}

export async function sessionProcesses(table, sessionId, panePids = []) {
  const own = descendants(table, panePids);
  const orphans = [...table.keys()].filter((pid) => !own.has(pid));
  const owners = await Promise.all(orphans.map((pid) => sessionIdFromEnv(pid)));
  const owned = new Map(orphans.filter((_, index) => owners[index] === sessionId).map((pid) => [pid, sessionId]));
  const kill = new Set(own);
  const spared = [];
  for (const root of detachedRoots(table, owned)) {
    const group = [...descendants(table, [root])].filter((pid) => !own.has(pid));
    if (await isGuiApp(table, root)) spared.push(table.get(root)?.name || String(root));
    else group.forEach((pid) => kill.add(pid));
  }
  return { kill, spared };
}

export function ancestors(table, pid) {
  const result = new Set();
  let current = pid;
  for (let depth = 0; depth < 64 && current > 0 && !result.has(current); depth += 1) {
    result.add(current);
    current = table.get(current)?.ppid;
  }
  return result;
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of String(text).split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) values[match[1]] = Number(match[2]);
  }
  const totalKb = values.MemTotal || 0;
  const availableKb = values.MemAvailable ?? values.MemFree ?? 0;
  const swapTotalKb = values.SwapTotal || 0;
  const swapUsedKb = Math.max(0, swapTotalKb - (values.SwapFree || 0));
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round((totalKb - availableKb) / 1024),
    availableMb: Math.round(availableKb / 1024),
    cachedMb: Math.round(((values.Cached || 0) + (values.Buffers || 0)) / 1024),
    percent: totalKb ? Math.round(((totalKb - availableKb) / totalKb) * 100) : 0,
    swapTotalMb: Math.round(swapTotalKb / 1024),
    swapUsedMb: Math.round(swapUsedKb / 1024),
    swapPercent: swapTotalKb ? Math.round((swapUsedKb / swapTotalKb) * 100) : 0,
  };
}

function parseCpuLine(text) {
  const line = String(text).split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  return { idle, total: parts.reduce((a, b) => a + b, 0) };
}

// /proc/<pid>/stat: le nom peut contenir des espaces, on repart de la derniere parenthese.
export function parseProcStat(text) {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const name = text.slice(text.indexOf("(") + 1, close);
  const fields = text.slice(close + 2).split(" ");
  return {
    name,
    ppid: Number(fields[1]),
    ticks: Number(fields[11]) + Number(fields[12]),
    rssKb: Number(fields[21]) * PAGE_KB,
  };
}

async function readProcesses() {
  const entries = await fs.readdir("/proc").catch(() => []);
  const result = new Map();
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (pid) => {
    try {
      const stat = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
      if (stat) result.set(Number(pid), stat);
    } catch {}
  }));
  return result;
}

async function readCmdline(pid) {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0+/g, " ").trim();
  } catch {
    return "";
  }
}

async function readNumber(file) {
  try {
    const value = Number((await fs.readFile(file, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function gpuNames() {
  try {
    const { stdout } = await execFileAsync("lspci", ["-mm"], { timeout: 2000 });
    const names = new Map();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\S+) "(VGA compatible controller|3D controller|Display controller)" "([^"]*)" "([^"]*)"/);
      if (match) names.set(match[1], match[4].replace(/^.*\[(.+)\].*$/, "$1"));
    }
    return names;
  } catch {
    return new Map();
  }
}

export class SystemResourcesService {
  constructor({ drmDir = "/sys/class/drm", listPanes = async () => [], dockerStats = null } = {}) {
    this.drmDir = drmDir;
    this.listPanes = listPanes;
    this.dockerStats = dockerStats || defaultDockerStats;
    this.gpuNameCache = null;
    this.docker = { at: 0, value: [], pending: null };
  }

  async gpuCards() {
    const entries = await fs.readdir(this.drmDir).catch(() => []);
    const cards = [];
    for (const entry of entries.filter((e) => /^card\d+$/.test(e))) {
      const dir = path.join(this.drmDir, entry);
      const uevent = await fs.readFile(path.join(dir, "device/uevent"), "utf8").catch(() => "");
      const slot = uevent.match(/PCI_SLOT_NAME=(?:0000:)?(\S+)/)?.[1] || null;
      const driver = uevent.match(/DRIVER=(\S+)/)?.[1] || null;
      cards.push({ id: entry, dir, slot, driver });
    }
    return cards;
  }

  async gpuSample(cards) {
    return Promise.all(cards.map(async (card) => ({
      rc6: await readNumber(path.join(card.dir, "gt/gt0/rc6_residency_ms")),
      busy: await readNumber(path.join(card.dir, "device/gpu_busy_percent")),
      cur: (await readNumber(path.join(card.dir, "gt_act_freq_mhz"))) ?? (await readNumber(path.join(card.dir, "gt_cur_freq_mhz"))),
      max: (await readNumber(path.join(card.dir, "gt_RP0_freq_mhz"))) ?? (await readNumber(path.join(card.dir, "gt_max_freq_mhz"))),
    })));
  }

  async nvidia() {
    try {
      const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 2000 });
      return stdout.trim().split("\n").filter(Boolean).map((line, index) => {
        const [name, util, used, total] = line.split(",").map((s) => s.trim());
        return { id: `nvidia${index}`, name, busyPercent: Number(util), memoryUsedMb: Number(used), memoryTotalMb: Number(total) };
      });
    } catch {
      return [];
    }
  }

  dockerSnapshot() {
    const now = Date.now();
    if (now - this.docker.at > DOCKER_TTL_MS && !this.docker.pending) {
      // docker stats prend ~2 s: on sert la valeur precedente et on rafraichit en fond.
      this.docker.pending = this.dockerStats()
        .then((value) => { this.docker.value = value; })
        .catch(() => {})
        .finally(() => { this.docker.at = Date.now(); this.docker.pending = null; });
    }
    return this.docker.value;
  }

  async read({ sessions = [] } = {}) {
    const [statA, procsA, cards] = await Promise.all([
      fs.readFile("/proc/stat", "utf8").catch(() => ""),
      readProcesses(),
      this.gpuCards(),
    ]);
    const gpuA = await this.gpuSample(cards);
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
    const [statB, procsB, meminfo, panes, nvidia] = await Promise.all([
      fs.readFile("/proc/stat", "utf8").catch(() => ""),
      readProcesses(),
      fs.readFile("/proc/meminfo", "utf8").catch(() => ""),
      this.listPanes().catch(() => []),
      this.nvidia(),
    ]);
    const gpuB = await this.gpuSample(cards);
    const elapsedMs = Date.now() - startedAt;

    const cpuA = parseCpuLine(statA);
    const cpuB = parseCpuLine(statB);
    const cpuPercent = cpuA && cpuB && cpuB.total > cpuA.total
      ? Math.round((1 - (cpuB.idle - cpuA.idle) / (cpuB.total - cpuA.total)) * 100)
      : 0;
    const cores = os.cpus()?.length || 1;

    if (!this.gpuNameCache) this.gpuNameCache = await gpuNames();
    const gpus = cards.map((card, index) => {
      const a = gpuA[index];
      const b = gpuB[index];
      let busyPercent = null;
      if (b.busy !== null) busyPercent = b.busy;
      else if (a.rc6 !== null && b.rc6 !== null && elapsedMs > 0) {
        busyPercent = Math.max(0, Math.min(100, Math.round((1 - (b.rc6 - a.rc6) / elapsedMs) * 100)));
      }
      return {
        id: card.id,
        name: this.gpuNameCache.get(card.slot) || card.driver || card.id,
        driver: card.driver,
        busyPercent,
        freqMhz: b.cur,
        maxFreqMhz: b.max,
      };
    }).concat(nvidia);

    // Arbre des processus: chaque processus est rattache a l'agent Noyau dont il descend.
    const paneOwner = new Map(panes.map((pane) => [pane.pid, pane.sessionId]));
    const sessionMeta = new Map(sessions.map((s) => [s.id, s]));
    const sessionName = new Map(sessions.map((s) => [s.id, s.name]));
    const ownerOf = (pid) => {
      let current = pid;
      for (let depth = 0; depth < 40 && current > 1; depth += 1) {
        if (paneOwner.has(current)) return paneOwner.get(current);
        current = procsB.get(current)?.ppid;
        if (!current) return null;
      }
      return null;
    };

    // Rattrape les processus detaches du pane via leur NOYAU_SESSION_ID.
    const knownSessions = new Set(panes.map((pane) => pane.sessionId));
    const unowned = [...procsB.keys()].filter((pid) => !ownerOf(pid));
    const envOwners = await Promise.all(unowned.map((pid) => sessionIdFromEnv(pid)));
    const detachedOwner = new Map();
    unowned.forEach((pid, index) => { if (envOwners[index] && knownSessions.has(envOwners[index])) detachedOwner.set(pid, envOwners[index]); });
    // Racine detachee de chaque processus: sert a regrouper « firefox », « node »… sous l'agent.
    const detachedRootOf = new Map();
    for (const root of detachedRoots(procsB, detachedOwner)) {
      for (const pid of descendants(procsB, [root])) if (detachedOwner.has(pid)) detachedRootOf.set(pid, root);
    }
    const guiRoots = new Set();
    for (const root of new Set(detachedRootOf.values())) if (await isGuiApp(procsB, root)) guiRoots.add(root);

    const totalTicks = (elapsedMs / 1000) * CLOCK_TICKS;
    const processes = [];
    for (const [pid, b] of procsB) {
      const a = procsA.get(pid);
      const cpu = a && totalTicks > 0 ? ((b.ticks - a.ticks) / totalTicks) * 100 : 0;
      processes.push({ pid, ppid: b.ppid, name: b.name, cpuPercent: Math.max(0, Math.round(cpu * 10) / 10), rssMb: Math.round(b.rssKb / 1024) });
    }

    const agentsUsage = new Map();
    for (const proc of processes) {
      const direct = ownerOf(proc.pid);
      const owner = direct || detachedOwner.get(proc.pid) || null;
      if (!owner) continue;
      proc.agentId = owner;
      const meta = sessionMeta.get(owner) || {};
      const entry = agentsUsage.get(owner) || {
        id: owner,
        kind: "session",
        name: meta.name || owner,
        projectName: meta.projectName || null,
        assistant: meta.assistant || null,
        killable: Boolean(meta.killable),
        cpuPercent: 0,
        rssMb: 0,
        processes: 0,
        detachedMb: 0,
        detachedApps: {},
      };
      if (direct) {
        // La conso affichee est celle de l'agent lui-meme; ce qu'il a lance a part est detaille a cote.
        entry.cpuPercent += proc.cpuPercent;
        entry.rssMb += proc.rssMb;
        entry.processes += 1;
      } else {
        const root = detachedRootOf.get(proc.pid) || proc.pid;
        const key = `${procsB.get(root)?.name || "?"}:${root}`;
        const app = entry.detachedApps[key] || { name: procsB.get(root)?.name || "?", pid: root, rssMb: 0, processes: 0, gui: guiRoots.has(root) };
        app.rssMb += proc.rssMb;
        app.processes += 1;
        entry.detachedApps[key] = app;
        entry.detachedMb += proc.rssMb;
      }
      agentsUsage.set(owner, entry);
    }

    const pick = async (list) => Promise.all(list.map(async (p) => ({
      ...p,
      agentName: p.agentId ? sessionName.get(p.agentId) || p.agentId : null,
      command: (await readCmdline(p.pid)).slice(0, 160) || p.name,
    })));
    const topCpu = await pick([...processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 8));
    const topMemory = await pick([...processes].sort((a, b) => b.rssMb - a.rssMb).slice(0, 8));
    // Sessions IA lancees hors Noyau: on remonte au plus haut processus CLI et on somme son sous-arbre.
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    const externalRoots = new Set();
    for (const proc of processes) {
      if (proc.agentId || !AGENT_BINARY.test(proc.name)) continue;
      let root = proc.pid;
      let parent = procsB.get(root)?.ppid;
      while (parent && byPid.get(parent) && !byPid.get(parent).agentId && AGENT_BINARY.test(byPid.get(parent).name)) {
        root = parent;
        parent = procsB.get(root)?.ppid;
      }
      externalRoots.add(root);
    }
    const external = [];
    for (const root of externalRoots) {
      const tree = descendants(procsB, [root]);
      let cpuPercent = 0;
      let rssMb = 0;
      for (const pid of tree) {
        cpuPercent += byPid.get(pid)?.cpuPercent || 0;
        rssMb += byPid.get(pid)?.rssMb || 0;
      }
      const command = (await readCmdline(root)).slice(0, 160);
      const cwd = await fs.readlink(`/proc/${root}/cwd`).catch(() => null);
      external.push({
        id: `pid:${root}`,
        pid: root,
        kind: "external",
        name: `${procsB.get(root)?.name || "agent"} (hors Noyau)`,
        projectName: cwd ? path.basename(cwd) : null,
        assistant: procsB.get(root)?.name || null,
        command,
        killable: true,
        cpuPercent,
        rssMb,
        processes: tree.size,
      });
    }

    const agents = [...agentsUsage.values(), ...external]
      .map((a) => ({
        ...a,
        cpuPercent: Math.round(a.cpuPercent * 10) / 10,
        detachedApps: Object.values(a.detachedApps || {}).sort((x, y) => y.rssMb - x.rssMb),
      }))
      .sort((a, b) => b.rssMb - a.rssMb);

    const memory = parseMeminfo(meminfo);
    const docker = this.dockerSnapshot();
    const loadAvg = os.loadavg().map((v) => Math.round(v * 100) / 100);
    return {
      cpu: { model: os.cpus()?.[0]?.model || "CPU", cores, percent: cpuPercent, loadAvg },
      memory,
      gpus,
      topCpu,
      topMemory,
      agents,
      docker,
      processCount: processes.length,
      hints: resourceHints({ cpuPercent, cores, loadAvg, memory, gpus, agents, docker, topCpu }),
      timestamp: Date.now(),
    };
  }
}

async function defaultDockerStats() {
  const { stdout } = await execFileAsync("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { timeout: 8000 });
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    const memMb = parseDockerSize(String(row.MemUsage || "").split("/")[0]);
    return { name: row.Name, cpuPercent: Number.parseFloat(row.CPUPerc) || 0, memoryMb: memMb };
  }).sort((a, b) => b.memoryMb - a.memoryMb);
}

export function parseDockerSize(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2].toUpperCase();
  const factor = unit.startsWith("G") ? 1024 : unit.startsWith("T") ? 1024 * 1024 : unit.startsWith("K") ? 1 / 1024 : unit === "B" ? 1 / (1024 * 1024) : 1;
  return Math.round(n * factor);
}

export function resourceHints({ cpuPercent, cores, loadAvg, memory, gpus, agents, docker, topCpu }) {
  const hints = [];
  if (memory.percent >= 85) hints.push({ level: "high", text: `RAM à ${memory.percent}% (${memory.availableMb} Mo dispo)` });
  else if (memory.percent >= 70) hints.push({ level: "medium", text: `RAM à ${memory.percent}%` });
  if (memory.swapUsedMb >= 1024 || memory.swapPercent >= 50) hints.push({ level: memory.swapPercent >= 75 ? "high" : "medium", text: `Swap utilisé: ${memory.swapUsedMb} Mo` });
  if (loadAvg[1] > cores) hints.push({ level: "high", text: `Charge 5 min ${loadAvg[1]} > ${cores} cœurs` });
  else if (cpuPercent >= 80) hints.push({ level: "medium", text: `CPU à ${cpuPercent}%` });
  const hog = topCpu.find((p) => p.cpuPercent >= 90);
  if (hog) hints.push({ level: "medium", text: `${hog.agentName ? `${hog.agentName} · ` : ""}${hog.name} consomme ${Math.round(hog.cpuPercent)}% d'un cœur` });
  const heavyAgents = agents.filter((a) => a.rssMb >= 1500);
  if (heavyAgents.length) hints.push({ level: "low", text: `${heavyAgents.length} agent${heavyAgents.length > 1 ? "s" : ""} > 1,5 Go RAM` });
  const busyGpu = gpus.find((g) => g.busyPercent >= 80);
  if (busyGpu) hints.push({ level: "low", text: `${busyGpu.name} à ${busyGpu.busyPercent}%` });
  const dockerMb = docker.reduce((total, c) => total + c.memoryMb, 0);
  if (dockerMb >= 2048) hints.push({ level: "low", text: `Docker: ${(dockerMb / 1024).toFixed(1)} Go sur ${docker.length} conteneurs` });
  return hints;
}

export function optimizationPrompt(snapshot) {
  const mb = (v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} Go` : `${v} Mo`);
  const lines = [
    "Mission : analyser l'usage CPU / GPU / RAM de ce PC (laptop Noyau) et proposer puis appliquer des optimisations SÛRES.",
    "",
    "RÈGLES STRICTES :",
    "- N'arrête, ne tue, ne redémarre AUCUN processus, agent Noyau, session tmux, conteneur Docker ou service systemd sans ma confirmation explicite dans ce chat.",
    "- Interdits sans confirmation : kill/pkill/killall, systemctl stop/restart/disable, docker stop/rm/pause/restart, tmux kill-*, noyau-agent stop, suppression de fichiers, changement de config système.",
    "- Autorisé sans confirmation : lecture/diagnostic (ps, top -b, free, /proc, journalctl, docker stats, du), et réglages réversibles sans impact (ex: renice d'un processus non critique) — annonce-les.",
    "- Présente d'abord un tableau : élément · conso · cause probable · action proposée · gain estimé · risque. Puis demande-moi quelles actions appliquer.",
    "- Ne touche jamais à ton propre processus ni au serveur Noyau (port 4242/4243).",
    "",
    `INSTANTANÉ (${new Date(snapshot.timestamp).toLocaleString("fr-FR")}) :`,
    `- CPU ${snapshot.cpu.model} · ${snapshot.cpu.cores} threads · ${snapshot.cpu.percent}% · load ${snapshot.cpu.loadAvg.join(" / ")}`,
    `- RAM ${mb(snapshot.memory.usedMb)} / ${mb(snapshot.memory.totalMb)} (${snapshot.memory.percent}%) · dispo ${mb(snapshot.memory.availableMb)} · swap ${mb(snapshot.memory.swapUsedMb)} / ${mb(snapshot.memory.swapTotalMb)}`,
    ...snapshot.gpus.map((g) => `- GPU ${g.name}: ${g.busyPercent ?? "?"}%${g.freqMhz ? ` · ${g.freqMhz}/${g.maxFreqMhz} MHz` : ""}`),
  ];
  if (snapshot.hints.length) lines.push("", "Alertes : " + snapshot.hints.map((h) => h.text).join(" ; "));
  lines.push("", "Top CPU :", ...snapshot.topCpu.slice(0, 6).map((p) => `- ${p.cpuPercent}% · ${mb(p.rssMb)} · pid ${p.pid} ${p.agentName ? `[agent ${p.agentName}] ` : ""}${p.command}`));
  lines.push("", "Top RAM :", ...snapshot.topMemory.slice(0, 6).map((p) => `- ${mb(p.rssMb)} · ${p.cpuPercent}% · pid ${p.pid} ${p.agentName ? `[agent ${p.agentName}] ` : ""}${p.command}`));
  if (snapshot.agents.length) lines.push("", "Agents Noyau (somme de leurs processus) :", ...snapshot.agents.slice(0, 12).map((a) => `- ${a.name}${a.projectName ? ` [${a.projectName}]` : ""}: ${mb(a.rssMb)} · ${a.cpuPercent}% CPU · ${a.processes} proc.${a.detachedApps?.length ? ` · a lancé à part : ${a.detachedApps.map((d) => `${d.name} ${mb(d.rssMb)}${d.gui ? " (appli graphique, ne pas fermer)" : ""}`).join(", ")}` : ""}`));
  if (snapshot.docker.length) lines.push("", "Docker :", ...snapshot.docker.map((c) => `- ${c.name}: ${mb(c.memoryMb)} · ${c.cpuPercent}% CPU`));
  lines.push("", "Commence par confirmer l'instantané avec tes propres mesures, puis propose.");
  return lines.join("\n");
}
