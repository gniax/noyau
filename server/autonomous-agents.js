import path from "node:path";
import { AUTONOMY_ASSISTANTS, AUTONOMY_LEVELS, newAutonomy, validCheckMinutes, validLevel, validWatch } from "./autonomy.js";

const HOUR_MS = 3_600_000;
export const AUTONOMY_POLICY = {
  tickMs: 60_000,
  // Laisse passer un redémarrage normal avant de réveiller un agent.
  graceMs: 90_000,
  relaunchBaseMs: 30 * 60_000,
  relaunchMaxMs: 6 * HOUR_MS,
  maxWakesPerHour: 4,
  maxRestartsPerHour: 4,
  resolvedKeepMs: 24 * HOUR_MS,
  modulesTtlMs: 55_000,
  mapTtlMs: 5 * 60_000,
  // Un message envoyé à une interface qui démarre se perd; un redémarrage juste après un réveil couperait son tour.
  startupMs: 30_000,
  wakeSettleMs: 2 * 60_000,
  maxLines: 8,
};

export function relaunchDelay(notifications, policy = AUTONOMY_POLICY) {
  return Math.min(policy.relaunchMaxMs, policy.relaunchBaseMs * 2 ** Math.max(0, notifications - 1));
}

const cleanTitle = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);

// Met à jour le registre d'incidents. Une source en erreur ne prouve rien: ses incidents restent ouverts.
export function reconcileIncidents(previous = {}, found = [], checkedSources = new Set(), now = Date.now(), policy = AUTONOMY_POLICY) {
  const next = {};
  const at = new Date(now).toISOString();
  const present = new Set();
  for (const item of found) {
    present.add(item.key);
    const known = previous[item.key];
    next[item.key] = known
      ? { ...known, title: cleanTitle(item.title), source: item.source, resolvedAt: null }
      : { key: item.key, source: item.source, title: cleanTitle(item.title), firstSeenAt: at, notifications: 0, lastNotifiedAt: null, resolvedAt: null };
  }
  for (const [key, known] of Object.entries(previous)) {
    if (present.has(key)) continue;
    if (!checkedSources.has(known.source)) {
      next[key] = known;
      continue;
    }
    const resolvedAt = known.resolvedAt || at;
    // Conservé un temps: une panne qui clignote garde son délai de relance au lieu de repartir de zéro.
    if (known.notifications && now - Date.parse(resolvedAt) < policy.resolvedKeepMs) next[key] = { ...known, resolvedAt };
  }
  return next;
}

export function dueIncidents(incidents = {}, now = Date.now(), policy = AUTONOMY_POLICY) {
  return Object.values(incidents).filter((incident) => {
    if (incident.resolvedAt) return false;
    if (now - Date.parse(incident.firstSeenAt) < policy.graceMs) return false;
    if (!incident.lastNotifiedAt) return true;
    return now - Date.parse(incident.lastNotifiedAt) >= relaunchDelay(incident.notifications, policy);
  });
}

// Compteur glissant remis à zéro après une heure, porté par la métadonnée pour survivre aux redémarrages.
export function hourlyCount(count, startedAt, now = Date.now()) {
  const started = Date.parse(startedAt || "");
  return Number.isFinite(started) && now - started < HOUR_MS ? Number(count) || 0 : 0;
}

export function wakeBlocker({ autonomy, busy, quotaBlocked, now = Date.now(), policy = AUTONOMY_POLICY }) {
  if (busy) return "busy";
  if (quotaBlocked) return "quota";
  if (hourlyCount(autonomy.wakesThisHour, autonomy.wakeHourAt, now) >= policy.maxWakesPerHour) return "hourly";
  return null;
}

export function incidentMessage(incidents, policy = AUTONOMY_POLICY) {
  const shown = incidents.slice(0, policy.maxLines);
  const lines = shown.map((incident) => `- ${incident.title}${incident.notifications ? ` (relance ${incident.notifications}, toujours en échec)` : ""}`);
  if (incidents.length > shown.length) lines.push(`- et ${incidents.length - shown.length} autre(s)`);
  return [
    `[Incident] ${incidents.length > 1 ? `${incidents.length} problèmes détectés` : "Problème détecté"} par la surveillance de Noyau :`,
    ...lines,
    "Diagnostique la cause et corrige-la toi-même si tu le peux, production comprise. Vérifie le résultat, puis dis en une phrase ce que tu as constaté et fait. Signale uniquement ce qui exige une décision du fondateur.",
  ].join("\n");
}

export function checkMessage() {
  return "[Contrôle] Contrôle périodique demandé par le fondateur : vérifie l'état de ton périmètre. Si tout va bien, réponds en une phrase sans rien lancer.";
}

export class AutonomousAgents {
  constructor({ store, tmux, sources = {}, agentBusy = async () => false, quotaBlocked = () => false, isMigrating = () => false, currentThread = async () => null, notify = async () => {}, estimator = null, now = () => Date.now(), policy = AUTONOMY_POLICY, log = console }) {
    Object.assign(this, { store, tmux, sources, agentBusy, quotaBlocked, isMigrating, currentThread, notify, estimator, now, policy, log });
    this.timer = null;
    this.running = null;
    this.delivering = new Set();
    this.restarting = new Set();
    this.cache = new Map();
  }

  entries() {
    return Object.entries(this.store.all()).filter(([, entry]) => entry?.autonomy?.enabled);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch((error) => this.log.warn?.(`[autonomie] ${error.message}`)); }, this.policy.tickMs);
    this.timer.unref?.();
    void this.tick().catch((error) => this.log.warn?.(`[autonomie] ${error.message}`));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Écrit depuis la dernière valeur du store: aucun await entre lecture et écriture.
  async patch(id, change) {
    const current = this.store.get(id);
    if (!current?.autonomy) return null;
    const autonomy = { ...current.autonomy, ...change(current.autonomy) };
    if (JSON.stringify(autonomy) === JSON.stringify(current.autonomy)) return current;
    const next = { ...current, autonomy };
    await this.store.set(id, next);
    return next;
  }

  tick() {
    if (this.running) return this.running;
    this.running = this.runTick().finally(() => { this.running = null; });
    return this.running;
  }

  async runTick() {
    const entries = this.entries();
    if (!entries.length) return;
    const live = new Set((await this.tmux.list()).map((session) => session.id));
    for (const [id] of entries) {
      try {
        await this.tickAgent(id, live);
      } catch (error) {
        this.log.warn?.(`[autonomie] ${id}: ${error.message}`);
      }
    }
    // Hors du tour de boucle: le premier scan des transcripts peut durer et ne doit retarder aucun réveil.
    void this.estimator?.refresh({ agents: this.entries().map(([, entry]) => entry.autonomy) }).catch((error) => this.log.warn?.(`[autonomie] estimation: ${error.message}`));
  }

  async tickAgent(id, live) {
    const entry = this.store.get(id);
    if (!entry?.autonomy?.enabled) return;
    await this.trackSources(id, entry);
    if (entry.autonomy.paused) {
      // Le niveau se règle aussi en pause: il s'applique dès que l'agent est libre.
      if (live.has(id)) await this.applyLevel(id);
      return;
    }
    if (!live.has(id)) return this.keepAlive(id);
    await this.evaluate(id);
    await this.applyLevel(id);
  }

  async keepAlive(id) {
    const entry = this.store.get(id);
    if (!entry || entry.autoRestore === false || entry.stopRequestedAt || this.isMigrating(id) || entry.migrationState === "summarizing" || entry.autonomy.keepAliveExhausted) return;
    const now = this.now();
    const count = hourlyCount(entry.autonomy.restartsThisHour, entry.autonomy.restartHourAt, now);
    if (count >= this.policy.maxRestartsPerHour) {
      // Un agent qui meurt en boucle consommerait pour rien: on rend la main au fondateur.
      await this.patch(id, () => ({ keepAliveExhausted: true }));
      await this.notify(entry, `${entry.name || "Agent autonome"} ne redémarre plus`, `${count} relances en une heure, surveillance interrompue.`).catch(() => {});
      return;
    }
    await this.patch(id, (autonomy) => ({ restartsThisHour: count + 1, restartHourAt: count ? autonomy.restartHourAt : new Date(now).toISOString(), lastRestartAt: new Date(now).toISOString() }));
    await this.tmux.restoreOne(id, this.store.get(id)).catch((error) => this.patch(id, () => ({ lastError: cleanTitle(error.message) })));
  }

  // Lie l'agent à ses transcripts successifs: uniquement ce qui lui appartient, jamais une déduction par dossier.
  async trackSources(id, entry) {
    // /api/sessions peut deviner un transcript par dossier: seul celui lié par le hook (même id) compte.
    const bound = entry.agentSessionId && entry.transcriptPath && path.basename(String(entry.transcriptPath), ".jsonl") === entry.agentSessionId;
    const transcript = bound ? String(entry.transcriptPath) : null;
    const thread = entry.assistant === "codex" ? entry.threadId || await this.currentThread(id, entry).catch(() => null) : null;
    const known = entry.autonomy.sources || { claude: [], codex: [] };
    const addClaude = transcript && !known.claude?.includes(transcript);
    const addCodex = thread && !known.codex?.includes(thread);
    if (!addClaude && !addCodex) return;
    await this.patch(id, (autonomy) => {
      const sources = autonomy.sources || { claude: [], codex: [] };
      return { sources: {
        claude: addClaude ? [...(sources.claude || []), transcript].slice(-40) : sources.claude || [],
        codex: addCodex ? [...(sources.codex || []), thread].slice(-40) : sources.codex || [],
      } };
    });
  }

  async cached(key, ttl, read) {
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && now - hit.at < ttl) return hit.value;
    const value = await read();
    this.cache.set(key, { at: now, value });
    return value;
  }

  scope(entry) {
    const watch = validWatch(entry.autonomy.watch);
    return { projectIds: [...new Set([entry.projectId, ...watch.projectIds].filter(Boolean))], units: watch.units };
  }

  // Noms et états seulement: le texte des journaux ne doit pas pouvoir dicter ses actions à l'agent.
  async detect(entry) {
    const { projectIds, units } = this.scope(entry);
    const found = [];
    const checked = new Set();
    const collect = async (source, key, ttl, read) => {
      try {
        found.push(...await this.cached(key, ttl, read));
        checked.add(source);
      } catch (error) {
        this.log.warn?.(`[autonomie] source ${source}: ${error.message}`);
      }
    };
    for (const projectId of projectIds) {
      if (this.sources.modules) await collect(`modules:${projectId}`, `modules:${projectId}:${entry.profileId}`, this.policy.modulesTtlMs, async () => (await this.sources.modules(projectId, entry)).map((item) => ({
        key: `module:${item.id}`, source: `modules:${projectId}`, title: `Module « ${item.name} » en échec${item.units?.length ? ` (${item.units.join(", ")})` : ""}`,
      })));
      if (this.sources.map) await collect(`map:${projectId}`, `map:${projectId}:${entry.profileId}`, this.policy.mapTtlMs, async () => (await this.sources.map(projectId, entry)).map((item) => ({
        key: String(item.id).startsWith("module:") ? item.id : `map:${item.id}`, source: `map:${projectId}`, title: `${item.type === "cron" ? "Cron" : item.type === "timer" ? "Timer" : item.type === "module" ? "Module" : "Service"} « ${item.label} » en erreur${item.project ? ` (projet ${item.project})` : ""}`,
      })));
    }
    if (units.length && this.sources.units) await collect("units", `units:${[...units].sort().join(",")}`, this.policy.modulesTtlMs, async () => (await this.sources.units(units)).map((item) => ({
      key: `unit:${item.id}`, source: "units", title: `Unité « ${item.id} » en échec${item.result ? ` (${item.result})` : ""}`,
    })));
    // Un module en échec peut sortir à la fois de son état et de la carte: même incident, une ligne.
    const unique = new Map(found.map((item) => [item.key, item]));
    return { found: [...unique.values()], checked };
  }

  async evaluate(id) {
    const entry = this.store.get(id);
    const { found, checked } = await this.detect(entry);
    const now = this.now();
    const latest = this.store.get(id);
    if (!latest?.autonomy?.enabled || latest.autonomy.paused) return;
    const incidents = reconcileIncidents(latest.autonomy.incidents, found, checked, now, this.policy);
    let due = dueIncidents(incidents, now, this.policy);
    const check = !due.length && this.checkDue(latest.autonomy, now);
    if (!due.length && !check) {
      await this.patch(id, () => ({ incidents, held: null }));
      return;
    }
    if (this.delivering.has(id) || this.restarting.has(id)) {
      await this.patch(id, () => ({ incidents }));
      return;
    }
    const busy = latest.migrationState === "summarizing" || latest.contextTransition || this.justStarted(latest, now) || await this.agentBusy(id, latest);
    const blocker = wakeBlocker({ autonomy: latest.autonomy, busy, quotaBlocked: this.quotaBlocked(latest), now, policy: this.policy });
    if (blocker) {
      await this.patch(id, (autonomy) => ({ incidents, held: { reason: blocker, since: autonomy.held?.reason === blocker ? autonomy.held.since : new Date(now).toISOString(), count: due.length } }));
      return;
    }
    await this.patch(id, () => ({ incidents, held: null }));
    // Sans await: submit peut attendre longtemps le brouillon du fondateur, les autres agents ne patientent pas.
    void this.deliver(id, due, check);
  }

  justStarted(entry, now) {
    const started = Math.max(Date.parse(entry.autonomy?.lastRestartAt || "") || 0, Date.parse(entry.restoredAt || "") || 0);
    return now - started < this.policy.startupMs;
  }

  checkDue(autonomy, now) {
    const minutes = validCheckMinutes(autonomy.checkMinutes);
    if (!minutes) return false;
    const last = Math.max(Date.parse(autonomy.lastWakeAt || "") || 0, Date.parse(autonomy.enabledAt || "") || 0);
    return now - last >= minutes * 60_000;
  }

  // Envoi détaché: submit attend la fin du brouillon du fondateur, parfois longtemps.
  async deliver(id, due, check) {
    const text = due.length ? incidentMessage(due, this.policy) : checkMessage();
    this.delivering.add(id);
    const delivery = this.tmux.submit(id, text).then(() => {
      const now = this.now();
      const at = new Date(now).toISOString();
      return this.patch(id, (autonomy) => {
        const count = hourlyCount(autonomy.wakesThisHour, autonomy.wakeHourAt, now);
        const incidents = { ...(autonomy.incidents || {}) };
        for (const incident of due) if (incidents[incident.key]) incidents[incident.key] = { ...incidents[incident.key], notifications: (incidents[incident.key].notifications || 0) + 1, lastNotifiedAt: at };
        return {
          incidents,
          lastWakeAt: at,
          wakesThisHour: count + 1,
          wakeHourAt: count ? autonomy.wakeHourAt : at,
          ...(due.length ? { lastIncident: { title: cleanTitle(due[0].title), count: due.length, key: due[0].key, at } } : {}),
          lastError: null,
        };
      });
    }).catch((error) => this.patch(id, () => ({ lastError: cleanTitle(error.message) }))).finally(() => { this.delivering.delete(id); });
    this.lastDelivery = delivery;
    return delivery;
  }

  // Un changement de niveau redémarre le processus: on attend que l'agent soit libre pour ne pas couper son tour.
  async applyLevel(id) {
    const entry = this.store.get(id);
    const autonomy = entry?.autonomy;
    if (!autonomy?.enabled || validLevel(autonomy.level) === autonomy.appliedLevel) return false;
    if (this.restarting.has(id) || this.delivering.has(id) || this.isMigrating(id) || entry.contextTransition) return false;
    if (this.now() - (Date.parse(autonomy.lastWakeAt || "") || 0) < this.policy.wakeSettleMs) return false;
    if (await this.agentBusy(id, entry)) return false;
    this.restarting.add(id);
    try {
      const fresh = this.store.get(id);
      const threadId = fresh.assistant === "codex"
        ? fresh.threadId || await this.currentThread(id, fresh).catch(() => null)
        : fresh.agentSessionId || null;
      await this.tmux.restartAgent({ id, assistant: fresh.assistant, model: fresh.model, cwd: fresh.cwd, threadId, yolo: Boolean(fresh.yolo) });
      const level = validLevel(fresh.autonomy.level);
      await this.patch(id, () => ({ appliedLevel: level, lastError: null, lastRestartAt: new Date(this.now()).toISOString() }));
      return true;
    } catch (error) {
      await this.patch(id, () => ({ lastError: cleanTitle(error.message) }));
      return false;
    } finally {
      this.restarting.delete(id);
    }
  }

  // Vue du navigateur: lecture de la métadonnée et du cache d'estimation, aucun accès disque.
  view(id) {
    const entry = this.store.get(id);
    const autonomy = entry?.autonomy;
    if (!autonomy?.enabled) return null;
    const now = this.now();
    const incidents = Object.values(autonomy.incidents || {});
    const active = incidents.filter((incident) => !incident.resolvedAt);
    const scope = this.scope(entry);
    const last = autonomy.lastIncident;
    return {
      enabled: true,
      paused: Boolean(autonomy.paused),
      level: validLevel(autonomy.level),
      appliedLevel: autonomy.appliedLevel,
      levelPending: validLevel(autonomy.level) !== autonomy.appliedLevel,
      checkMinutes: validCheckMinutes(autonomy.checkMinutes),
      watch: validWatch(autonomy.watch),
      watching: { projects: scope.projectIds.length, units: scope.units.length },
      assistant: entry.assistant,
      lastWakeAt: autonomy.lastWakeAt || null,
      wakesThisHour: hourlyCount(autonomy.wakesThisHour, autonomy.wakeHourAt, now),
      maxWakesPerHour: this.policy.maxWakesPerHour,
      activeIncidents: active.length,
      held: autonomy.held || null,
      lastIncident: last ? { title: last.title, count: last.count, at: last.at, resolved: !active.some((incident) => incident.key === last.key) } : null,
      firstActive: active[0]?.title || null,
      keepAliveExhausted: Boolean(autonomy.keepAliveExhausted),
      lastError: autonomy.lastError || null,
      estimate: this.estimator?.estimate(id, autonomy) || { status: "pending" },
    };
  }

  async update(id, body = {}, { projectAllowed = () => true } = {}) {
    const entry = this.store.get(id);
    if (!entry) throw new Error("Agent introuvable.");
    if (!AUTONOMY_ASSISTANTS.includes(entry.assistant)) throw new Error("Autonomie réservée aux agents Claude et Codex.");
    const now = this.now();
    const at = new Date(now).toISOString();
    if (body.level !== undefined && !AUTONOMY_LEVELS.includes(body.level)) throw new Error("Niveau invalide.");
    if (body.watch?.projectIds?.some((projectId) => !projectAllowed(projectId))) throw new Error("Projet introuvable.");
    const current = entry.autonomy;
    if (body.enabled === false) {
      if (current) await this.store.set(id, { ...entry, autonomy: { ...current, enabled: false, held: null } });
      return null;
    }
    if (!current?.enabled) {
      if (body.enabled !== true) throw new Error("Agent non autonome.");
      const created = { ...newAutonomy(body, now), appliedLevel: current?.appliedLevel ?? null, sources: current?.sources || { claude: [], codex: [] } };
      await this.store.set(id, { ...entry, autonomy: created });
    } else {
      await this.patch(id, (autonomy) => {
        const change = {};
        if (body.level !== undefined) change.level = validLevel(body.level);
        if (body.checkMinutes !== undefined) change.checkMinutes = validCheckMinutes(body.checkMinutes);
        if (body.watch !== undefined) change.watch = validWatch(body.watch);
        if (body.paused === true && !autonomy.paused) Object.assign(change, { paused: true, pausedAt: at, held: null });
        if (body.paused === false && autonomy.paused) Object.assign(change, { paused: false, pausedAt: null, pausedMs: Number(autonomy.pausedMs || 0) + Math.max(0, now - (Date.parse(autonomy.pausedAt || "") || now)), keepAliveExhausted: false, restartsThisHour: 0 });
        return change;
      });
    }
    // Sans attendre la réponse HTTP: le redémarrage prend quelques secondes.
    void this.applyLevel(id).catch(() => {});
    return this.view(id);
  }
}
