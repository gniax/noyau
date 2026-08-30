import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// `agy -p "/usage"` sort une ligne par fenetre: famille, libelle, pourcentage restant, renouvellement.
const USAGE_LINE = /^(.+?)\t(.+?)\t(\d{1,3})%\t(\S+)\s*$/;

export function parseAntigravityUsage(output) {
  const windows = String(output).split(/\r?\n/).flatMap((line) => {
    const match = line.match(USAGE_LINE);
    if (!match) return [];
    const [, family, label, percent, resetsAt] = match;
    const weekly = /week/i.test(label);
    return [{
      family: family.trim(),
      label: weekly ? "7 j" : "5 h",
      windowMinutes: weekly ? 10_080 : 300,
      remainingPercent: Number(percent),
      resetsAt: Number.isNaN(new Date(resetsAt).getTime()) ? null : new Date(resetsAt).toISOString(),
    }];
  });
  if (!windows.length) return null;
  // Les modeles Gemini portent le quota du forfait: ce sont eux qu'on affiche en premier.
  const primary = windows.filter(({ family }) => /gemini/i.test(family));
  return { windows: (primary.length ? primary : windows).sort((left, right) => left.windowMinutes - right.windowMinutes), families: windows };
}

export class AntigravityQuotaService {
  constructor({ store, binary, cwd, run = execFileAsync, interval = 5 * 60 * 1000, timeout = 60_000 }) {
    this.store = store;
    this.binary = binary;
    this.cwd = cwd;
    this.run = run;
    this.interval = interval;
    this.timeout = timeout;
    this.timer = null;
  }

  start() {
    if (this.timer || !this.binary) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.interval);
    this.timer.unref();
  }

  async refresh() {
    const { stdout } = await this.run(this.binary, ["-p", "/usage"], { cwd: this.cwd, timeout: this.timeout, maxBuffer: 256 * 1024 });
    const quota = parseAntigravityUsage(stdout);
    if (!quota) throw new Error("Relevé Antigravity illisible.");
    await this.store.set("antigravity", { ...quota, updatedAt: new Date().toISOString() });
    return quota;
  }
}
