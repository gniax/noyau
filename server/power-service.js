import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Un ecran d'agent sans marqueur de travail passe "disponible" sous forte charge: un seul releve ne prouve rien.
const AGENT_QUIET_MS = 10 * 60_000;
const BUSY_LOAD_RATIO = 0.75;
const defaultLoadRatio = () => os.loadavg()[0] / Math.max(1, os.cpus().length);

export function isWithinTimeWindow(current, start, end) {
  if (!TIME_PATTERN.test(current) || !TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) return false;
  if (start === end) return false;
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

export function currentLocalTime(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export class PowerService {
  constructor({
    file = null,
    exec = execFileAsync,
    agentWorkingChecker = null,
    loadRatio = defaultLoadRatio,
    now = () => Date.now(),
  } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.exec = exec;
    this.agentWorkingChecker = agentWorkingChecker;
    this.loadRatio = loadRatio;
    this.now = now;
    this.startedAt = now();
    this.lastBusyAt = this.startedAt;
    this.lastClientAt = 0;
    this.queue = Promise.resolve();
    this.cache = null;
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async read() {
    if (this.cache) return this.cache;
    const initial = {
      sleeping: false,
      sleepingSince: null,
      autoTriggered: false,
      pausedContainers: [],
      schedule: {
        enabled: true,
        start: "00:00",
        end: "07:30",
        idleMinutes: 120,
      },
      lastActivityAt: this.now(),
    };
    if (!this.file) {
      this.cache = initial;
      return this.cache;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      const schedule = { ...initial.schedule, ...(parsed.schedule || {}) };
      if (schedule.idleMinutes === 30) {
        schedule.idleMinutes = 120;
      }
      this.cache = {
        ...initial,
        ...parsed,
        schedule,
        // Date figee au dernier enregistrement: un redemarrage ne doit pas la lire comme des heures d'absence.
        lastActivityAt: this.now(),
      };
    } catch {
      this.cache = initial;
    }
    return this.cache;
  }

  async write(state) {
    this.cache = state;
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      console.error(`PowerService write error: ${error.message}`);
    }
  }

  touchActivity() {
    if (this.cache) this.cache.lastActivityAt = this.now();
  }

  touchClient() {
    this.lastClientAt = this.now();
  }

  isSleeping() {
    return Boolean(this.cache?.sleeping);
  }

  canWakeOnActivity() {
    if (!this.cache?.sleeping) return false;
    const since = this.cache?.sleepingSince ? Date.parse(this.cache.sleepingSince) : 0;
    // Période de grâce de 15 secondes après la mise en veille : aucun réveil automatique
    return this.now() - since > 15_000;
  }

  async getSystemIdleMs() {
    try {
      const { stdout } = await this.exec("gdbus", [
        "call",
        "--session",
        "--dest", "org.gnome.Mutter.IdleMonitor",
        "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
        "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime",
      ], { timeout: 3000 });
      const match = String(stdout || "").match(/\(uint64 (\d+),\)/);
      if (match) return Number(match[1]);
    } catch {
      // Ignorer si headless, pas sous GNOME ou gdbus indisponible
    }
    return null;
  }

  async getEffectiveIdleMinutes(now = new Date(this.now())) {
    const state = await this.read();
    const systemIdleMs = await this.getSystemIdleMs();
    const lastSeen = Math.max(Number(state.lastActivityAt) || 0, this.lastClientAt);
    const webIdleMs = Math.max(0, now.getTime() - (lastSeen || this.startedAt));
    const idleMs = systemIdleMs !== null && Number.isFinite(systemIdleMs) ? Math.min(systemIdleMs, webIdleMs) : webIdleMs;
    return Math.floor(idleMs / 60_000);
  }

  // Charge elevee = quelque chose tourne: elle retarde la veille, elle ne la declenche jamais.
  async workInProgress() {
    if (this.agentWorkingChecker) {
      try {
        const active = await this.agentWorkingChecker({ fresh: true });
        if (!Array.isArray(active) || active.length) return true;
      } catch {
        return true;
      }
    }
    return this.loadRatio() >= BUSY_LOAD_RATIO;
  }

  async setDisplayPower(on = true) {
    const display = process.env.DISPLAY || ":0";
    const env = {
      ...process.env,
      DISPLAY: display,
      XAUTHORITY: process.env.XAUTHORITY || `/run/user/${process.getuid?.() || 1000}/gdm/Xauthority`,
    };
    try {
      if (on) {
        await this.exec("xset", ["-display", display, "dpms", "force", "on"], { timeout: 3000, env });
      } else {
        await this.exec("xset", ["-display", display, "+dpms", "dpms", "force", "off"], { timeout: 3000, env });
      }
    } catch {
      // Ignorer si headless, écran distant ou xset non disponible
    }
  }

  async getRunningContainers() {
    try {
      const { stdout } = await this.exec("docker", ["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"], { timeout: 5000 });
      return stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name, ...statusParts] = line.split("\t");
          const status = statusParts.join("\t");
          return { id, name, status, isPaused: status.toLowerCase().includes("paused") };
        });
    } catch (error) {
      return [];
    }
  }

  async getStatus() {
    return this.enqueue(async () => {
      const state = await this.read();
      const working = this.agentWorkingChecker ? await this.agentWorkingChecker() : [];
      const containers = await this.getRunningContainers();
      return {
        sleeping: Boolean(state.sleeping),
        sleepingSince: state.sleepingSince,
        autoTriggered: Boolean(state.autoTriggered),
        pausedContainers: state.pausedContainers || [],
        schedule: state.schedule,
        workingAgents: working,
        canSleep: working.length === 0,
        runningContainersCount: containers.filter((c) => !c.isPaused).length,
      };
    });
  }

  async enterSleep({ auto = false, reason = null } = {}) {
    return this.enqueue(async () => {
      const state = await this.read();
      // Automatic sleep must fail closed when an agent is busy or status cannot be checked.
      if (auto && this.agentWorkingChecker) {
        const active = await this.agentWorkingChecker({ fresh: true });
        if (!Array.isArray(active) || active.length) return { sleeping: false, blocked: true, workingAgents: Array.isArray(active) ? active : [] };
      }
      const containers = await this.getRunningContainers();
      const toPause = containers.filter((c) => !c.isPaused);
      const paused = [];

      for (const container of toPause) {
        try {
          await this.exec("docker", ["pause", container.id], { timeout: 10_000 });
          paused.push({ id: container.id, name: container.name });
        } catch (error) {
          console.warn(`Impossible de mettre en pause le conteneur ${container.name}: ${error.message}`);
        }
      }

      const next = {
        ...state,
        sleeping: true,
        sleepingSince: new Date(this.now()).toISOString(),
        autoTriggered: auto,
        autoReason: auto ? reason : null,
        pausedContainers: paused,
      };
      await this.write(next);
      await this.setDisplayPower(false);
      return { ok: true, sleeping: true, pausedContainers: paused };
    });
  }

  async wakeUp() {
    return this.enqueue(async () => {
      const state = await this.read();
      const unpaused = [];

      for (const container of state.pausedContainers || []) {
        try {
          await this.exec("docker", ["unpause", container.id], { timeout: 10_000 });
          unpaused.push(container);
        } catch (error) {
          console.warn(`Impossible de reprendre le conteneur ${container.name || container.id}: ${error.message}`);
        }
      }

      const next = {
        ...state,
        sleeping: false,
        sleepingSince: null,
        autoTriggered: false,
        pausedContainers: [],
        lastActivityAt: this.now(),
      };
      await this.write(next);
      await this.setDisplayPower(true);
      return { ok: true, sleeping: false, unpausedContainers: unpaused };
    });
  }

  async updateSchedule(changes = {}) {
    return this.enqueue(async () => {
      const state = await this.read();
      const schedule = { ...state.schedule };
      if (changes.enabled !== undefined) schedule.enabled = Boolean(changes.enabled);
      if (changes.start !== undefined && TIME_PATTERN.test(changes.start)) schedule.start = changes.start;
      if (changes.end !== undefined && TIME_PATTERN.test(changes.end)) schedule.end = changes.end;
      if (changes.idleMinutes !== undefined) {
        const val = Number(changes.idleMinutes);
        if (Number.isFinite(val) && val >= 0 && val <= 1440) schedule.idleMinutes = val;
      }
      const next = { ...state, schedule };
      await this.write(next);
      return next.schedule;
    });
  }

  async tick(now = new Date(this.now())) {
    const state = await this.read();
    if (!state.schedule?.enabled) return;

    const current = currentLocalTime(now);
    const inNight = isWithinTimeWindow(current, state.schedule.start || "00:00", state.schedule.end || "07:30");
    const wake = (label) => this.wakeUp().catch((error) => console.warn(`Réveil automatique (${label}) échoué: ${error.message}`));

    if (state.sleeping) {
      if (!state.autoTriggered) return;
      if (state.autoReason === "night" && !inNight) return wake("fin de nuit");
      // Veille heritee d'avant un redemarrage: conteneurs relances, banniere fausse.
      if (Date.parse(state.sleepingSince || "") < this.startedAt) return wake("redémarrage");
      if (await this.workInProgress()) return wake("agent actif");
      return;
    }

    if (await this.workInProgress()) {
      this.lastBusyAt = now.getTime();
      return;
    }
    if (now.getTime() - this.lastBusyAt < AGENT_QUIET_MS) return;

    const idleMinutes = await this.getEffectiveIdleMinutes(now);
    const threshold = state.schedule.idleMinutes > 0 ? state.schedule.idleMinutes : 120;
    const reason = inNight && idleMinutes >= 15 ? "night" : idleMinutes >= threshold ? "idle" : null;
    if (!reason) return;
    console.log(`Veille automatique (${reason}): aucune activité depuis ${idleMinutes} min, aucun agent actif depuis ${Math.floor((now.getTime() - this.lastBusyAt) / 60_000)} min.`);
    return this.enterSleep({ auto: true, reason }).catch((error) => console.warn(`Veille automatique échouée: ${error.message}`));
  }
}
