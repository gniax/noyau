// Réglages purs d'un agent autonome, sans dépendance: tmux.js les lit à chaque lancement.
export const AUTONOMY_LEVELS = ["eco", "normal", "max"];
export const AUTONOMY_ASSISTANTS = ["claude", "codex"];
const CLAUDE_MODELS = { eco: "haiku", normal: "sonnet", max: "opus" };
const CODEX_EFFORT = { eco: "low", normal: "medium", max: "high" };
const UNIT_NAME = /^[\w@.\\-]+\.(service|timer)$/;
const CHECK_MIN_MINUTES = 15;
const CHECK_MAX_MINUTES = 7 * 24 * 60;

export function validLevel(value) {
  return AUTONOMY_LEVELS.includes(value) ? value : "normal";
}

export function validCheckMinutes(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(CHECK_MAX_MINUTES, Math.max(CHECK_MIN_MINUTES, minutes));
}

export function validWatch(watch) {
  const list = (value) => (Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : []);
  return {
    projectIds: list(watch?.projectIds).slice(0, 30),
    units: list(watch?.units).filter((unit) => UNIT_NAME.test(unit)).slice(0, 50),
  };
}

export function newAutonomy({ level, checkMinutes, watch } = {}, now = Date.now()) {
  const chosen = validLevel(level);
  return {
    enabled: true,
    paused: false,
    level: chosen,
    appliedLevel: chosen,
    checkMinutes: validCheckMinutes(checkMinutes),
    watch: validWatch(watch),
    enabledAt: new Date(now).toISOString(),
    pausedAt: null,
    pausedMs: 0,
    lastWakeAt: null,
    wakesThisHour: 0,
    wakeHourAt: null,
    restartsThisHour: 0,
    restartHourAt: null,
    keepAliveExhausted: false,
    incidents: {},
    held: null,
    sources: { claude: [], codex: [] },
  };
}

// Ce que le niveau impose au lancement. Rien pour un autre assistant: Antigravity n'a pas d'équivalent connu.
export function levelLaunch(assistant, autonomy) {
  if (!autonomy?.enabled) return { model: null, args: [] };
  const level = validLevel(autonomy.level);
  if (assistant === "claude") return { model: CLAUDE_MODELS[level], args: [] };
  if (assistant === "codex") return { model: null, args: ["-c", `model_reasoning_effort=${CODEX_EFFORT[level]}`] };
  return { model: null, args: [] };
}
