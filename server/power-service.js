import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

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
  } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.exec = exec;
    this.agentWorkingChecker = agentWorkingChecker;
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
      lastActivityAt: Date.now(),
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
    if (this.cache) this.cache.lastActivityAt = Date.now();
  }

  isSleeping() {
    return Boolean(this.cache?.sleeping);
  }

  canWakeOnActivity() {
    if (!this.cache?.sleeping) return false;
    const since = this.cache?.sleepingSince ? Date.parse(this.cache.sleepingSince) : 0;
    // Période de grâce de 15 secondes après la mise en veille : aucun réveil automatique
    return Date.now() - since > 15_000;
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

  async getEffectiveIdleMinutes(now = new Date()) {
    const state = await this.read();
    const systemIdleMs = await this.getSystemIdleMs();
    const webIdleMs = state.lastActivityAt && state.lastActivityAt <= now.getTime()
      ? now.getTime() - state.lastActivityAt
      : Infinity;

    if (systemIdleMs !== null && Number.isFinite(systemIdleMs)) {
      if (webIdleMs !== Infinity) {
        return Math.floor(Math.min(systemIdleMs, webIdleMs) / 60_000);
      }
      return Math.floor(systemIdleMs / 60_000);
    }
    return webIdleMs === Infinity ? 9999 : Math.floor(webIdleMs / 60_000);
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

  async enterSleep({ auto = false } = {}) {
    return this.enqueue(async () => {
      const state = await this.read();
      // On ne bloque jamais la mise en veille : le statut "travail" des agents
      // peut rester figé (tokens épuisés, hook manqué). L'utilisateur et le repos du laptop sont prioritaires.
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
        sleepingSince: new Date().toISOString(),
        autoTriggered: auto,
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
        lastActivityAt: Date.now(),
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

  async tick(now = new Date()) {
    const state = await this.read();
    if (!state.schedule?.enabled) return;

    const current = currentLocalTime(now);
    const inNight = isWithinTimeWindow(current, state.schedule.start || "00:00", state.schedule.end || "07:30");

    // Sortie de veille automatique à la fin de la plage de nuit
    if (state.sleeping && state.autoTriggered && !inNight) {
      return this.wakeUp().catch((error) => console.warn(`Réveil automatique échoué: ${error.message}`));
    }

    // Si déjà en veille, rien d'autre à faire
    if (state.sleeping) return;

    const idleMinutes = await this.getEffectiveIdleMinutes(now);

    // Entrée en veille nocturne (dès 15 minutes d'inactivité pendant la plage nocturne)
    if (inNight) {
      if (idleMinutes >= 15) {
        return this.enterSleep({ auto: true }).catch((error) => console.warn(`Mise en veille nocturne échouée: ${error.message}`));
      }
    }

    // Entrée en veille pour inactivité : 2h (ou idleMinutes configuré)
    const threshold = state.schedule.idleMinutes > 0 ? state.schedule.idleMinutes : 120;
    if (idleMinutes >= threshold) {
      return this.enterSleep({ auto: true }).catch((error) => console.warn(`Mise en veille inactivité échouée: ${error.message}`));
    }
  }
}
