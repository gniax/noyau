export class QuotaNotifier {
  constructor({
    push,
    providerState,
    profileService,
    now = () => Date.now(),
    interval = 30_000,
  }) {
    this.push = push;
    this.providerState = providerState;
    this.profileService = profileService;
    this.now = now;
    this.interval = interval;
    this.timer = null;
    this.tracked = new Map();
  }

  start() {
    if (this.timer) return;
    this.check().catch(() => {});
    this.timer = setInterval(() => this.check().catch(() => {}), this.interval);
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  extractWindows(provider, quota) {
    if (!quota) return [];
    if (provider === "claude") {
      const list = [];
      if (quota.fiveHour && Number.isFinite(quota.fiveHour.remainingPercent)) {
        list.push({ label: "5 h", remainingPercent: quota.fiveHour.remainingPercent, resetsAt: quota.fiveHour.resetsAt });
      }
      if (quota.sevenDay && Number.isFinite(quota.sevenDay.remainingPercent)) {
        list.push({ label: "7 j", remainingPercent: quota.sevenDay.remainingPercent, resetsAt: quota.sevenDay.resetsAt });
      }
      return list;
    }
    if (Array.isArray(quota.windows)) {
      return quota.windows.filter((w) => Number.isFinite(w.remainingPercent)).map((w) => ({
        label: w.label || (w.windowMinutes >= 8640 ? "7 j" : "5 h"),
        remainingPercent: w.remainingPercent,
        resetsAt: w.resetsAt,
      }));
    }
    return [];
  }

  async check() {
    const currentTime = this.now();
    const providers = ["codex", "claude", "antigravity"];
    const resetsToNotify = [];

    for (const provider of providers) {
      const quota = this.providerState.get(provider);
      const windows = this.extractWindows(provider, quota);

      for (const win of windows) {
        const key = `${provider}:${win.label}`;
        const previous = this.tracked.get(key);
        const hasFutureReset = win.resetsAt && new Date(win.resetsAt).getTime() > currentTime;
        const isLow = win.remainingPercent < 90;

        if (isLow && hasFutureReset) {
          if (!previous || previous.resetsAt !== win.resetsAt) {
            this.tracked.set(key, {
              provider,
              label: win.label,
              resetsAt: win.resetsAt,
              wasLow: true,
              notified: false,
            });
          }
        } else if (previous && previous.wasLow && !previous.notified) {
          const resetTimeReached = previous.resetsAt && currentTime >= new Date(previous.resetsAt).getTime();
          const renewed = win.remainingPercent >= 95 && (!win.resetsAt || win.resetsAt !== previous.resetsAt);

          if (resetTimeReached || renewed) {
            previous.notified = true;
            resetsToNotify.push({ provider, label: previous.label });
          }
        }
      }
    }

    if (!resetsToNotify.length) return 0;

    let sentTotal = 0;
    const profiles = this.profileService.list();

    for (const reset of resetsToNotify) {
      const providerLabel = reset.provider === "claude" ? "Claude" : reset.provider === "codex" ? "Codex" : "Antigravity";
      const windowText = reset.label || "5 h";

      for (const profile of profiles) {
        const notifySettings = profile.quotaResetNotify || { codex: true, claude: true, antigravity: false };
        if (!notifySettings[reset.provider]) continue;

        try {
          const sent = await this.push.send({
            title: `${providerLabel} · Quota renouvelé`,
            body: `Le quota ${windowText} est réinitialisé et prêt à l'emploi.`,
            tag: `quota-reset-${reset.provider}-${windowText.replace(/\s+/g, "")}`,
            url: `/?view=dashboard&profile=${encodeURIComponent(profile.id)}`,
          }, profile.id);
          sentTotal += Number(sent || 0);
        } catch (error) {
          console.error(`Erreur notification quota reset ${reset.provider} (${profile.name}): ${error.message}`);
        }
      }
    }

    return sentTotal;
  }
}
