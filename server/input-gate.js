// Brouillon en cours dans un agent: les messages automatiques (inter-agents, modules, relances)
// attendent que l'utilisateur envoie son prompt, sinon ils se colleraient a son texte et partiraient avec.
export class InputGate {
  constructor({ idleMs = 90_000, settleMs = 1_500, pollMs = 500, now = () => Date.now(), onChange = null } = {}) {
    this.idleMs = idleMs;
    this.settleMs = settleMs;
    this.pollMs = pollMs;
    this.now = now;
    this.onChange = onChange;
    this.drafts = new Map();
    this.waiting = new Map();
  }

  // Frappe utilisateur: draft=true tant qu'un texte est en cours, false une fois envoye ou efface.
  typed(id, draft) {
    this.drafts.set(id, { draft: Boolean(draft), at: this.now() });
  }

  busy(id) {
    const entry = this.drafts.get(id);
    if (!entry) return false;
    const age = this.now() - entry.at;
    if (entry.draft) return age < this.idleMs;
    // Juste apres un envoi, on laisse l'agent prendre le prompt avant d'en glisser un autre.
    return age < this.settleMs;
  }

  pending(id) {
    return this.waiting.get(id) || 0;
  }

  async waitFree(id, { maxMs = 30 * 60_000 } = {}) {
    if (!this.busy(id)) return;
    this.#count(id, 1);
    try {
      const deadline = this.now() + maxMs;
      while (this.busy(id) && this.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, this.pollMs); });
    } finally {
      this.#count(id, -1);
    }
  }

  #count(id, delta) {
    const next = Math.max(0, this.pending(id) + delta);
    if (next) this.waiting.set(id, next);
    else this.waiting.delete(id);
    this.onChange?.(id, next);
  }
}

// Classe une saisie: texte en cours ou prompt termine (Entree, Ctrl-C, Ctrl-U).
export function draftAfterInput(data) {
  const text = String(data ?? "");
  if (!text) return null;
  // Focus, souris, reponses du terminal et fleches: pas une frappe de texte, ne doit pas retenir les messages.
  if (/^(?:\x1b\[[0-9;?<>]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO[A-Za-z]|\x1b\[M[\s\S]{3})+$/.test(text)) return null;
  if (/[\r\n]$/.test(text) || text === "\x03" || text === "\x15") return false;
  return true;
}
