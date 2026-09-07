// Un agent qui sort de lui-meme (exit, /exit, crash) doit disparaitre pour de bon.
// On ne purge que les sessions vues vivantes dans ce processus: apres un reboot,
// aucune session n'a ete vue, donc la restauration automatique reste intacte.
export class SessionReaper {
  constructor({ tmux, store, archiveService = null, isMigrating = () => false, graceMs = 20_000, now = () => Date.now(), onReap = () => {} }) {
    this.tmux = tmux;
    this.store = store;
    this.archiveService = archiveService;
    this.isMigrating = isMigrating;
    this.graceMs = graceMs;
    this.now = now;
    this.onReap = onReap;
    this.seen = new Set();
    this.missingSince = new Map();
    this.timer = null;
  }

  isProtected(entry) {
    return Boolean(entry.migrationState === "summarizing" || entry.permissionRestartPending);
  }

  async tick() {
    let live;
    try {
      live = await this.tmux.list();
    } catch {
      return [];
    }
    const liveIds = new Set(live.map((session) => session.id));
    for (const id of liveIds) {
      this.seen.add(id);
      this.missingSince.delete(id);
    }
    const reaped = [];
    for (const id of [...this.seen]) {
      if (liveIds.has(id)) continue;
      const entry = this.store.get(id);
      if (!entry) {
        this.forget(id);
        continue;
      }
      // Bascule ou redemarrage permissions en cours: la session revient, on ne touche a rien.
      if (this.isMigrating(id) || this.isProtected(entry)) continue;
      const since = this.missingSince.get(id);
      if (!since) {
        this.missingSince.set(id, this.now());
        continue;
      }
      if (this.now() - since < this.graceMs) continue;
      this.forget(id);
      if (this.archiveService) {
        await this.archiveService.archive(id, entry, { reason: "reaped" }).catch(() => {});
      }
      await this.store.remove(id);
      this.onReap(id, entry);
      reaped.push(id);
    }
    return reaped;
  }

  forget(id) {
    this.seen.delete(id);
    this.missingSince.delete(id);
  }

  start(interval = 10_000) {
    this.stop();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, interval);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
