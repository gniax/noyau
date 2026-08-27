import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import pty from "node-pty";
import sharp from "sharp";
import { WebSocketServer } from "ws";
import { SessionStore } from "./session-store.js";
import { TmuxController, validSessionId } from "./tmux.js";
import { PushService } from "./push-service.js";
import { UsageService, lastClaudeMessage, parseClaudeRateLimits, refreshExpiredQuota } from "./usage.js";
import { ProjectLogoService } from "./project-logo.js";
import { agentNotificationTitle, PromptWatcher } from "./prompt-watcher.js";
import { HandoverService } from "./handover.js";
import { SessionReaper } from "./session-reaper.js";
import { ClaudeQuotaService } from "./claude-quota.js";
import { ModuleService } from "./module-service.js";
import { FinanceService } from "./finance-service.js";
import { FinanceAdvisor } from "./finance-advisor.js";
import { EnableBankingService } from "./enable-banking.js";
import { agentStatus } from "./agent-status.js";
import { ROOT_FOLDER, TodoService } from "./todo-service.js";
import { ProfileService } from "./profile-service.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const appVersion = String(packageMetadata.version || "0.0.0");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const workspaceRoot = path.resolve(process.env.NOYAU_WORKSPACE_ROOT || path.join(os.homedir(), "projects"));
const port = Number(process.env.PORT || 4242);
const host = process.env.HOST || "0.0.0.0";
// Version = empreinte du build. Change a chaque `npm run build` => purge de cache automatique cote client.
let clientVersionCache = { key: "", value: "dev" };
async function clientVersion() {
  if (process.env.NODE_ENV !== "production") return "dev";
  try {
    const file = path.join(root, "dist", "index.html");
    const stat = await fs.stat(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key !== clientVersionCache.key) {
      const html = await fs.readFile(file);
      clientVersionCache = { key, value: crypto.createHash("sha1").update(html).digest("hex").slice(0, 12) };
    }
    return clientVersionCache.value;
  } catch {
    return "dev";
  }
}
const PROJECT_PATTERN = /^project-[a-z0-9]+-[a-f0-9]{6}$/;

await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const uploadsDir = path.join(dataDir, "uploads");
await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });

async function getAccessToken() {
  if (process.env.NOYAU_TOKEN) return process.env.NOYAU_TOKEN;
  const file = path.join(dataDir, "access-token");
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const token = crypto.randomBytes(18).toString("base64url");
    await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

async function commandPath(name) {
  try {
    return (await execFileAsync("which", [name])).stdout.trim() || name;
  } catch {
    return name;
  }
}

const accessToken = await getAccessToken();
const store = new SessionStore(path.join(dataDir, "sessions.json"));
await store.load();
const projects = new SessionStore(path.join(dataDir, "projects.json"));
await projects.load();
const moduleStore = new SessionStore(path.join(dataDir, "modules.json"));
await moduleStore.load();
const financeStore = new SessionStore(path.join(dataDir, "finance.json"));
await financeStore.load();
const bankingStore = new SessionStore(path.join(dataDir, "enable-banking.json"));
await bankingStore.load();
const providerState = new SessionStore(path.join(dataDir, "provider-state.json"));
await providerState.load();
const profileStore = new SessionStore(path.join(dataDir, "profiles.json"));
await profileStore.load();
const profileService = new ProfileService({
  store: profileStore,
  dataDir,
  primaryTodoFile: process.env.NOYAU_TODO_FILE || path.join(dataDir, "TO DO.md"),
  primaryTodoMountUri: process.env.NOYAU_TODO_MOUNT_URI || null,
  primaryName: os.userInfo().username,
});
await profileService.initialize();
const primaryProfileId = profileService.primaryId();
const legacySessions = Object.entries(store.all()).filter(([, session]) => !session.profileId).map(([id, session]) => [id, { ...session, profileId: primaryProfileId, shared: false }]);
if (legacySessions.length) await store.setMany(legacySessions);
const legacyProjects = Object.entries(projects.all()).filter(([, project]) => !project.profileId).map(([id, project]) => [id, { ...project, profileId: primaryProfileId }]);
if (legacyProjects.length) await projects.setMany(legacyProjects);
// Agent de base du Noyau: il travaille sur le depot lui-meme, il reste protege contre la suppression.
if (!Object.values(store.all()).some((session) => session.core)) {
  const [coreId, coreSession] = Object.entries(store.all())
    .filter(([, session]) => path.resolve(session.cwd || "/") === root)
    .sort(([, a], [, b]) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || [];
  if (coreId) await store.set(coreId, { ...coreSession, core: true, autoRestore: true });
}
const claudeQuota = new ClaudeQuotaService({ store: providerState });
const push = new PushService({ dataDir, defaultProfileId: primaryProfileId });
await push.load();
const todoService = new TodoService({
  file: process.env.NOYAU_TODO_FILE || path.join(dataDir, "TO DO.md"),
  mountUri: process.env.NOYAU_TODO_MOUNT_URI || null,
});
const usage = new UsageService();
const projectLogos = new ProjectLogoService();
const migrations = new Map();
const notificationTestCursor = new Map();
const weatherCache = new Map();
const moduleService = new ModuleService({
  workspaceRoot,
  store: moduleStore,
  onActionComplete: async ({ module, action, result }) => {
    const profileId = projects.get(module.projectId)?.profileId || primaryProfileId;
    await push.send({
      title: `${module.name} · ${result.state === "success" ? "Terminé" : "Erreur"}`,
      body: result.state === "success" ? `${action.label} terminé.` : `${action.label}: ${result.output || "échec"}`,
      tag: `module-${module.id}-${action.id}`,
      url: `/?view=projects&profile=${encodeURIComponent(profileId)}`,
    }, profileId);
  },
});
const financeService = new FinanceService({
  store: financeStore,
});
await financeService.migrateLegacyModules();
const environmentBankingConfig = process.env.NOYAU_ENABLE_BANKING_APP_ID && process.env.NOYAU_ENABLE_BANKING_PRIVATE_KEY && process.env.NOYAU_ENABLE_BANKING_REDIRECT_URL
  ? {
      appId: process.env.NOYAU_ENABLE_BANKING_APP_ID,
      privateKey: process.env.NOYAU_ENABLE_BANKING_PRIVATE_KEY,
      redirectUrl: process.env.NOYAU_ENABLE_BANKING_REDIRECT_URL,
    }
  : null;
const enableBanking = new EnableBankingService({ store: bankingStore, finance: financeService, environmentConfig: environmentBankingConfig });
financeService.setAggregatorConfigured(enableBanking.configured());
const codexBinary = process.env.CODEX_BIN || (await commandPath("codex"));
const claudeBinary = process.env.CLAUDE_BIN || (await commandPath("claude"));
const tmux = new TmuxController({
  store,
  workspaceRoot,
  codexBinary,
  claudeBinary,
});
const restorePlan = await tmux.initializeRestorePlan();
const restoreResult = await tmux.restorePersisted();
if (restorePlan.migrated || restoreResult.restored.length || restoreResult.failed.length) {
  console.log(`Restauration agents: ${restoreResult.restored.length} repris, ${restoreResult.failed.length} échecs, ${restorePlan.migrated} états initialisés.`);
}
// Quota du compte: on envoie l'agent finances vers le fournisseur qui peut encore repondre.
function providerRemaining(quota) {
  const values = [quota?.fiveHour?.remainingPercent, quota?.sevenDay?.remainingPercent, ...(quota?.windows || []).map(({ remainingPercent }) => remainingPercent)]
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function preferredAiProvider() {
  const codex = providerRemaining(providerState.get("codex"));
  const claude = providerRemaining(providerState.get("claude"));
  if (Number.isFinite(codex) && codex <= 2) return "claude";
  if (Number.isFinite(claude) && claude <= 2) return "codex";
  if (Number.isFinite(codex) && Number.isFinite(claude)) return claude > codex ? "claude" : "codex";
  return "codex";
}

const financeAdvisor = new FinanceAdvisor({ binary: codexBinary, claudeBinary, cwd: root, pickProvider: () => preferredAiProvider() });
const profileRuntimes = new Map();

function configureFinanceRuntime(profileId, runtime) {
  runtime.financeService.setAdvisor(({ message, month, action }) => financeAdvisor.answer({ message, month, action, payload: financePayload(profileId, month), history: runtime.financeService.agentHistory() }));
  runtime.financeService.setClassifier((groups, categories) => financeAdvisor.classify(groups, categories));
}

const primaryRuntime = { profileId: primaryProfileId, financeService, enableBanking, todoService };
profileRuntimes.set(primaryProfileId, primaryRuntime);
configureFinanceRuntime(primaryProfileId, primaryRuntime);

async function ensureProfileRuntime(profileId) {
  const known = profileRuntimes.get(profileId);
  if (known) return known;
  const profile = profileService.get(profileId);
  if (!profile) throw new Error("Profil introuvable.");
  const profileDir = path.join(dataDir, "profiles", profileId);
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const scopedFinanceStore = new SessionStore(path.join(profileDir, "finance.json"));
  const scopedBankingStore = new SessionStore(path.join(profileDir, "enable-banking.json"));
  await Promise.all([scopedFinanceStore.load(), scopedBankingStore.load()]);
  const scopedFinance = new FinanceService({ store: scopedFinanceStore });
  await scopedFinance.migrateLegacyModules();
  const scopedBanking = new EnableBankingService({ store: scopedBankingStore, finance: scopedFinance });
  scopedFinance.setAggregatorConfigured(scopedBanking.configured());
  const runtime = {
    profileId,
    financeService: scopedFinance,
    enableBanking: scopedBanking,
    todoService: new TodoService({ file: profile.todoFile, mountUri: profile.todoMountUri }),
  };
  profileRuntimes.set(profileId, runtime);
  configureFinanceRuntime(profileId, runtime);
  return runtime;
}

function resetProfileTodo(profileId) {
  const runtime = profileRuntimes.get(profileId);
  const profile = profileService.get(profileId);
  if (runtime && profile) runtime.todoService = new TodoService({ file: profile.todoFile, mountUri: profile.todoMountUri });
}
const handover = new HandoverService();
const MIGRATION_FALLBACK_MS = 90 * 1000;
const QUOTA_EXHAUSTED_PERCENT = 5;
const promptWatcher = new PromptWatcher({
  tmux,
  push,
  sessionLabel: (session) => (session.projectId ? projects.get(session.projectId)?.name : null) || session.name,
  sessionIcon: (sessionId) => notificationIcon(sessionId),
});
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function currentMonthParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}`;
}

function financePayload(profileId, month = currentMonthParis()) {
  const runtime = profileRuntimes.get(profileId);
  if (!runtime) throw new Error("Profil finances indisponible.");
  const payload = runtime.financeService.payload(month);
  const status = runtime.enableBanking.status();
  const currentAccounts = status.connections.flatMap((connection) => connection.accounts
    .filter((account) => Number.isFinite(account.balance) && account.balanceType !== "OTHR" && !/carte|livret|\blep\b|\bpea\b|epargne|assurance vie|compte titres/i.test(account.name))
    .map((account) => ({ bank: connection.bankName, name: account.name, balance: account.balance, currency: account.currency, balanceAt: account.balanceAt })));
  const currentCash = Math.round(currentAccounts.reduce((total, account) => total + account.balance, 0) * 100) / 100;
  const expectedIncomeRemaining = month === currentMonthParis() ? Math.max(0, Math.round((payload.summary.inferredIncome - payload.summary.recordedSalary) * 100) / 100) : 0;
  const forecastBalance = Math.round((currentCash + expectedIncomeRemaining - payload.summary.remainingPlannedExpenses) * 100) / 100;
  const cashSafeToSpend = Math.max(0, Math.round((forecastBalance - payload.summary.safetyBuffer - payload.summary.protectedSavings) * 100) / 100);
  const safeToSpend = currentAccounts.length && month === currentMonthParis() ? Math.max(0, Math.min(cashSafeToSpend, payload.summary.safeToSpend)) : payload.summary.safeToSpend;
  const dailyAllowance = payload.summary.daysRemaining ? Math.round((safeToSpend / payload.summary.daysRemaining) * 100) / 100 : 0;
  const warnings = payload.summary.warnings.filter(({ id }) => id !== "safe-spend");
  if (payload.summary.income > 0 && safeToSpend === 0) warnings.push({ id: "safe-spend", tone: "danger", title: "Pause dépenses libres", detail: "Solde prévu réservé aux charges, imprévus et épargne soutenable." });
  return {
    ...payload,
    summary: { ...payload.summary, currentCash, currentAccounts, expectedIncomeRemaining, forecastBalance, safeToSpend, dailyAllowance, warnings },
    banking: { ...payload.banking, status },
  };
}

function logoUrl(session, profileId = session.profileId || primaryProfileId) {
  return session.projectLogo ? `/api/sessions/${encodeURIComponent(session.id)}/logo?profile=${encodeURIComponent(profileId)}` : null;
}

async function setAgentState(sessionId, agentState) {
  const current = store.get(sessionId);
  if (!current || !["working", "available", "waiting"].includes(agentState)) return;
  await store.set(sessionId, { ...current, agentState, agentStateUpdatedAt: new Date().toISOString() });
}

function projectPayload(id, project, profileId = project.profileId || primaryProfileId) {
  const owner = profileService.resolve(project.profileId);
  return {
    id,
    ...project,
    canEdit: (project.profileId || primaryProfileId) === profileId,
    owner: { id: owner.id, name: owner.name },
    logoUrl: `/api/projects/${encodeURIComponent(id)}/logo?profile=${encodeURIComponent(project.profileId || primaryProfileId)}`,
  };
}

async function projectInput(body, current = {}) {
  const name = body?.name === undefined ? current.name : String(body.name).trim().slice(0, 80);
  if (!name) throw new Error("Nom projet requis.");
  const requestedRoot = body?.rootPath === undefined ? current.rootPath : body.rootPath;
  const rootPath = requestedRoot ? path.resolve(String(requestedRoot)) : null;
  if (rootPath) {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) throw new Error("Dossier projet invalide.");
  }
  const shared = body?.shared === undefined ? Boolean(current.shared) : Boolean(body.shared);
  return { ...current, name, rootPath, shared, updatedAt: new Date().toISOString() };
}

function projectOwned(profileId, projectId) {
  return Boolean(projects.get(projectId)?.profileId === profileId);
}

function scopedProjects(profileId) {
  return Object.fromEntries(Object.entries(projects.all()).filter(([, project]) => project.profileId === profileId || project.shared));
}

function ownedProjects(profileId) {
  return Object.entries(projects.all()).filter(([, project]) => (project.profileId || primaryProfileId) === profileId);
}

// Un projet partage garde sa liste Todo chez son proprietaire: les deux profils travaillent au meme endroit.
function foreignSharedProjects(profileId) {
  const byOwner = new Map();
  for (const [id, project] of Object.entries(projects.all())) {
    const owner = project.profileId || primaryProfileId;
    if (owner === profileId || !project.shared) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, new Map());
    byOwner.get(owner).set(id, project);
  }
  return byOwner;
}

async function todosView(profile) {
  const runtime = await ensureProfileRuntime(profile.id);
  const mine = ownedProjects(profile.id).map(([id, project]) => ({ id, name: project.name }));
  const view = await runtime.todoService.syncProjectFolders(mine);
  const merged = { todos: [...view.todos], folders: [...view.folders] };
  for (const [ownerId, owned] of foreignSharedProjects(profile.id)) {
    const ownerRuntime = await ensureProfileRuntime(ownerId);
    const owner = profileService.resolve(ownerId);
    const remote = await ownerRuntime.todoService.syncProjectFolders([...owned].map(([id, project]) => ({ id, name: project.name })));
    const shared = remote.folders.filter((folder) => folder.projectId && owned.has(folder.projectId));
    const folderIds = new Set(shared.map((folder) => folder.id));
    merged.folders.push(...shared.map((folder) => ({ ...folder, ownerProfileId: ownerId, ownerName: owner.name })));
    merged.todos.push(...remote.todos.filter((todo) => folderIds.has(todo.folderId)));
  }
  return merged;
}

async function todoRuntime(profile, { todoId = null, folderId = null }) {
  const own = await ensureProfileRuntime(profile.id);
  if (todoId && await own.todoService.find(todoId)) return own;
  if (!todoId && (!folderId || folderId === "root" || await own.todoService.folder(folderId))) return own;
  for (const [ownerId, owned] of foreignSharedProjects(profile.id)) {
    const runtime = await ensureProfileRuntime(ownerId);
    const found = todoId ? await runtime.todoService.find(todoId) : await runtime.todoService.folder(folderId);
    if (found?.projectId && owned.has(found.projectId)) return runtime;
  }
  return own;
}

// Un projet partage reste modifiable par son seul proprietaire, mais utilisable par tous.
function projectVisible(profileId, projectId) {
  const project = projects.get(projectId);
  return Boolean(project && (project.profileId === profileId || project.shared));
}

function sessionVisible(profileId, sessionId) {
  const session = store.get(sessionId);
  return Boolean(session && (session.profileId === profileId || session.shared));
}

function sessionOwned(profileId, sessionId) {
  return Boolean(store.get(sessionId)?.profileId === profileId);
}

function moduleOwned(profileId, moduleId) {
  const module = moduleStore.get(moduleId);
  return Boolean(module && projectVisible(profileId, module.projectId));
}

// Une bascule interrompue par un redemarrage ne doit pas laisser l'agent bloque sur "Récap en cours".
for (const [id, entry] of Object.entries(store.all())) {
  if (entry.migrationState === "summarizing") await store.set(id, { ...entry, migrationState: null, migrationTarget: null });
}

const sessionReaper = new SessionReaper({
  tmux,
  store,
  isMigrating: (id) => migrations.has(id),
  onReap: (id) => console.log(`Agent ${id} terminé: entrée supprimée, aucune restauration.`),
});
sessionReaper.start();

function schedulePermissionRestart(sessionId, details) {
  setTimeout(async () => {
    try {
      const current = store.get(sessionId);
      if (!current?.permissionRestartPending) return;
      await tmux.restartAgent({ ...details, yolo: Boolean(current.yolo) });
      await store.set(sessionId, { ...store.get(sessionId), runningYolo: Boolean(current.yolo), permissionRestartPending: false, permissionRestartError: null });
    } catch (error) {
      const current = store.get(sessionId);
      if (current) await store.set(sessionId, { ...current, permissionRestartPending: true, permissionRestartError: error.message });
      console.error(`Redémarrage permissions ${sessionId}: ${error.message}`);
    }
  }, 800);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)]),
  );
}

function tokenMatches(candidate = "") {
  const expected = crypto.createHash("sha256").update(accessToken).digest();
  const actual = crypto.createHash("sha256").update(String(candidate)).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function authenticated(request) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const cookie = parseCookies(request.headers.cookie).noyau_session;
  return tokenMatches(bearer || cookie || "");
}

function loopbackRequest(request) {
  const address = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const hostname = String(request.hostname || "").replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "::1"].includes(address) && ["127.0.0.1", "::1", "localhost"].includes(hostname);
}

const app = express();
app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'",
  );
  next();
});
app.use((request, response, next) => {
  if (request.path === "/sw.js" || request.headers.accept?.includes("text/html")) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
app.use(express.json({ limit: "32kb" }));

app.post("/api/auth", (request, response) => {
  if (!tokenMatches(request.body?.token)) return response.status(401).json({ error: "Clé incorrecte." });
  const secureCookie = request.secure || request.headers["x-forwarded-proto"] === "https";
  response.setHeader(
    "Set-Cookie",
    `noyau_session=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secureCookie ? "; Secure" : ""}`,
  );
  response.json({ ok: true });
});

app.post("/api/logout", (_request, response) => {
  response.setHeader("Set-Cookie", "noyau_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  response.json({ ok: true });
});

app.get("/api/auth/session", (request, response) => {
  response.status(authenticated(request) ? 200 : 401).json({ authenticated: authenticated(request) });
});

app.get("/noyau-ca.cer", async (_request, response, next) => {
  try {
    if (!process.env.NOYAU_CA_CERT) return response.status(404).end();
    response.type("application/x-x509-ca-cert");
    response.setHeader("Content-Disposition", "attachment; filename=noyau-local-ca.cer");
    response.send(await fs.readFile(process.env.NOYAU_CA_CERT));
  } catch (error) {
    next(error);
  }
});

app.get("/version.json", async (_request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const build = await clientVersion();
    response.json({ version: appVersion, build, release: `${appVersion}+${build}` });
  } catch (error) {
    next(error);
  }
});

// Manifeste par profil: chaque compte installe son app (nom, couleurs, profil d'ouverture) sur son telephone.
const MANIFEST_COLORS = { noyau: "#080b0a", "aurora": "#0f1119" };

app.get("/manifest.webmanifest", (request, response) => {
  const profile = profileService.resolve(request.query.profile);
  const color = MANIFEST_COLORS[profile.theme] || MANIFEST_COLORS.noyau;
  const suffix = profile.id === primaryProfileId ? "" : ` · ${profile.name}`;
  response.setHeader("Cache-Control", "no-store");
  response.type("application/manifest+json").send(JSON.stringify({
    name: `Noyau${suffix} — Centre de contrôle`,
    short_name: `Noyau${suffix}`,
    description: "Centre de contrôle local pour agents, projets et automatisations.",
    id: `/?profile=${profile.id}`,
    start_url: `/?profile=${encodeURIComponent(profile.id)}`,
    scope: "/",
    display: "standalone",
    background_color: color,
    theme_color: color,
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  }));
});

app.get("/api/finance/banking/callback", async (request, response) => {
  try {
    const pendingId = `pending-${String(request.query.state || "").slice(0, 80)}`;
    const runtime = [...profileRuntimes.values()].find((item) => item.enableBanking.store.get(pendingId));
    if (!runtime) throw new Error("Retour bancaire expiré ou invalide.");
    await runtime.enableBanking.complete({
      code: request.query.code,
      state: request.query.state,
      error: request.query.error,
      errorDescription: request.query.error_description,
    });
    response.redirect(303, `/?view=finances&bank=connected&profile=${encodeURIComponent(runtime.profileId)}`);
  } catch (error) {
    response.redirect(303, `/?view=finances&bankError=${encodeURIComponent(error.message)}`);
  }
});

app.use("/api", async (request, response, next) => {
  if (!authenticated(request)) return response.status(401).json({ error: "Non autorisé." });
  try {
    request.profile = profileService.resolve(request.headers["x-noyau-profile"] || request.query.profile);
    request.profileRuntime = await ensureProfileRuntime(request.profile.id);
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/config", (_request, response) => response.json({ workspaceRoot }));

app.get("/api/profiles", (request, response) => {
  response.json({ profiles: profileService.list(), activeProfileId: request.profile.id, primaryProfileId });
});

app.post("/api/profiles", async (request, response, next) => {
  try {
    const profile = await profileService.create(request.body);
    await ensureProfileRuntime(profile.id);
    response.status(201).json({ profile });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/profiles/:id", async (request, response, next) => {
  try {
    if (request.profile.id !== request.params.id) throw new Error("Bascule sur profil avant modification.");
    const profile = await profileService.update(request.params.id, request.body);
    resetProfileTodo(profile.id);
    response.json({ profile });
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/display/sleep", async (request, response, next) => {
  if (!loopbackRequest(request)) return response.status(403).json({ error: "Commande écran disponible uniquement depuis ce PC." });
  try {
    await execFileAsync("/usr/bin/xset", ["-display", process.env.DISPLAY || ":0", "dpms", "force", "off"], { timeout: 5000 });
    response.json({ ok: true });
  } catch (error) {
    next(new Error(`Mise en veille écran impossible: ${error.message}`));
  }
});

app.get("/api/weather", async (request, response, next) => {
  try {
    const asked = request.query.latitude !== undefined || request.query.longitude !== undefined;
    // Sans geolocalisation (http en local, permission refusee sur iOS) on repart de la derniere
    // position connue, sinon de la position configuree au service.
    const fallback = providerState.get("weather") || {
      latitude: Number(process.env.NOYAU_WEATHER_LATITUDE),
      longitude: Number(process.env.NOYAU_WEATHER_LONGITUDE),
    };
    const latitude = asked ? Number(request.query.latitude) : Number(fallback.latitude);
    const longitude = asked ? Number(request.query.longitude) : Number(fallback.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return response.status(asked ? 400 : 404).json({ error: "Position météo inconnue." });
    }
    if (asked) await providerState.set("weather", { latitude, longitude, updatedAt: new Date().toISOString() });
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.cachedAt < 10 * 60 * 1000) return response.json(cached.payload);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", latitude.toFixed(4));
    url.searchParams.set("longitude", longitude.toFixed(4));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,is_day");
    url.searchParams.set("timezone", "auto");
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok) throw new Error(`Météo indisponible (${upstream.status}).`);
    const data = await upstream.json();
    if (!Number.isFinite(data.current?.temperature_2m)) throw new Error("Réponse météo invalide.");
    const payload = {
      temperature: data.current.temperature_2m,
      apparentTemperature: data.current.apparent_temperature,
      code: data.current.weather_code,
      isDay: data.current.is_day === 1,
      retrievedAt: new Date().toISOString(),
    };
    weatherCache.set(key, { cachedAt: Date.now(), payload });
    if (weatherCache.size > 100) weatherCache.delete(weatherCache.keys().next().value);
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance", (request, response, next) => {
  try {
    response.json(financePayload(request.profile.id, request.query.month || currentMonthParis()));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/finance/settings", async (request, response, next) => {
  try {
    await request.profileRuntime.financeService.updateSettings(request.body);
    response.json(financePayload(request.profile.id, request.body?.month || currentMonthParis()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/modules", async (request, response, next) => {
  try {
    const module = await request.profileRuntime.financeService.addModule(request.body);
    response.status(201).json({ module });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/finance/modules/:id", async (request, response, next) => {
  try {
    response.json({ module: await request.profileRuntime.financeService.updateModule(request.params.id, request.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/modules/:id", async (request, response, next) => {
  try {
    await request.profileRuntime.financeService.removeModule(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/transactions", async (request, response, next) => {
  try {
    const transaction = await request.profileRuntime.financeService.addTransaction(request.body);
    response.status(201).json({ transaction });
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/transactions/categorize", async (request, response, next) => {
  try {
    const month = request.body?.all ? null : request.body?.month || currentMonthParis();
    const result = await request.profileRuntime.financeService.categorizeTransactions({ force: Boolean(request.body?.force), month });
    response.json({ result, finance: financePayload(request.profile.id, request.body?.month || currentMonthParis()) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/transactions/:id", async (request, response, next) => {
  try {
    await request.profileRuntime.financeService.removeTransaction(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance/banking/status", (request, response) => {
  response.json(request.profileRuntime.enableBanking.status());
});

app.patch("/api/finance/banking/config", async (request, response, next) => {
  try {
    const status = await request.profileRuntime.enableBanking.saveConfig(request.body);
    request.profileRuntime.financeService.setAggregatorConfigured(true);
    const application = await request.profileRuntime.enableBanking.verify();
    response.json({ status, application });
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance/banking/institutions", async (request, response, next) => {
  try {
    response.json({ institutions: await request.profileRuntime.enableBanking.institutions() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/banking/connect", async (request, response, next) => {
  try {
    response.json(await request.profileRuntime.enableBanking.begin(request.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/banking/sync", async (request, response, next) => {
  try {
    const result = await request.profileRuntime.enableBanking.sync(request.body?.bankId || null);
    const month = request.body?.month || currentMonthParis();
    let categorization;
    try {
      categorization = await request.profileRuntime.financeService.categorizeTransactions({ month });
    } catch (error) {
      categorization = { error: error.message };
    }
    response.json({ result, categorization, finance: financePayload(request.profile.id, month), banking: request.profileRuntime.enableBanking.status() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/banking/connections/:bankId", async (request, response, next) => {
  try {
    await request.profileRuntime.enableBanking.disconnect(request.params.bankId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/quotas/refresh", async (_request, response, next) => {
  try {
    const [, codexWindows] = await Promise.all([
      claudeQuota.refresh().catch((error) => console.error(`Quota Claude: ${error.message}`)),
      usage.latestCodexRateWindows().catch(() => []),
    ]);
    if (codexWindows.length) await providerState.set("codex", { windows: codexWindows, updatedAt: new Date().toISOString() });
    const codex = providerState.get("codex");
    response.json({
      quotas: {
        codex: codex?.windows?.length
          ? refreshExpiredQuota({ remainingPercent: codex.windows[0].remainingPercent, resetsAt: codex.windows[0].resetsAt, windowMinutes: codex.windows[0].windowMinutes, windows: codex.windows })
          : null,
        claude: refreshExpiredQuota(providerState.get("claude")) || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance/insights", (request, response) => {
  const month = request.query.month || currentMonthParis();
  const cached = providerState.get(request.profile.primary ? "finance-insights" : `finance-insights:${request.profile.id}`);
  response.json(cached?.month === month ? cached : { month, insights: [], headline: "", generatedAt: null, provider: null });
});

app.post("/api/finance/insights", async (request, response, next) => {
  try {
    const month = request.body?.month || currentMonthParis();
    const result = await financeAdvisor.insights({ month, payload: financePayload(request.profile.id, month) });
    const payload = { ...result, month, provider: financeAdvisor.lastProvider, generatedAt: new Date().toISOString() };
    await providerState.set(request.profile.primary ? "finance-insights" : `finance-insights:${request.profile.id}`, payload);
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/agent/message", async (request, response, next) => {
  try {
    const month = request.body?.month || currentMonthParis();
    const result = await request.profileRuntime.financeService.financeAgent(request.body?.message, month);
    response.json(result);
    void push.send({ title: "Agent finances · Réponse prête", body: result.reply.slice(0, 180), tag: `finance-agent-${request.profile.id}`, url: `/?view=finance-agent&profile=${encodeURIComponent(request.profile.id)}` }, request.profile.id).catch((error) => console.error(`Notification finances: ${error.message}`));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/recurring/:id", async (request, response, next) => {
  try {
    await request.profileRuntime.financeService.removeRecurring(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/hooks/claude-statusline", async (request, response, next) => {
  try {
    const quota = parseClaudeRateLimits(request.body?.rate_limits);
    if (quota) await providerState.set("claude", quota);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", (request, response) => {
  const list = Object.entries(scopedProjects(request.profile.id)).map(([id, project]) => projectPayload(id, project, request.profile.id)).sort((a, b) => a.name.localeCompare(b.name));
  response.json({ projects: list });
});

app.post("/api/projects", async (request, response, next) => {
  try {
    const id = `project-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const project = await projectInput(request.body, { profileId: request.profile.id, createdAt: new Date().toISOString() });
    await projects.set(id, project);
    response.status(201).json({ project: projectPayload(id, project, request.profile.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/todos", async (request, response, next) => {
  try {
    const view = await todosView(request.profile);
    response.json({ ...view, storage: request.profile.todoMountUri ? "Obsidian · NAS" : "Obsidian · profil local" });
  } catch (error) {
    next(new Error(`Vault Obsidian indisponible: ${error.message}`));
  }
});

app.post("/api/todos", async (request, response, next) => {
  try {
    const projectId = request.body?.projectId || null;
    if (projectId && !projectVisible(request.profile.id, projectId)) throw new Error("Projet introuvable.");
    const folderId = request.body?.folderId || null;
    const runtime = await todoRuntime(request.profile, { folderId });
    const { todo } = await runtime.todoService.add({ text: request.body?.text, dueDate: request.body?.dueDate || null, projectId, folderId });
    response.status(201).json({ todo, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/:id", async (request, response, next) => {
  try {
    const changes = {};
    if (request.body?.text !== undefined) changes.text = request.body.text;
    if (request.body?.completed !== undefined) changes.completed = request.body.completed === true;
    if (request.body?.dueDate !== undefined) changes.dueDate = request.body.dueDate || null;
    if (request.body?.projectId !== undefined) {
      changes.projectId = request.body.projectId || null;
      if (changes.projectId && !projectVisible(request.profile.id, changes.projectId)) throw new Error("Projet introuvable.");
    }
    if (request.body?.folderId !== undefined) changes.folderId = request.body.folderId || ROOT_FOLDER;
    const source = await todoRuntime(request.profile, { todoId: request.params.id });
    const target = changes.folderId === undefined ? source : await todoRuntime(request.profile, { folderId: changes.folderId });
    if (target === source) {
      const { todo } = await source.todoService.update(request.params.id, changes);
      return response.json({ todo, ...(await todosView(request.profile)) });
    }
    // Changement de profil proprietaire: la tache est recreee dans le dossier cible puis retiree de l'ancien.
    const current = (await source.todoService.list()).todos.find((item) => item.id === request.params.id);
    if (!current) throw new Error("Tâche introuvable.");
    const { todo } = await target.todoService.add({
      text: changes.text ?? current.text,
      dueDate: changes.dueDate === undefined ? current.dueDate : changes.dueDate,
      folderId: changes.folderId,
    });
    await source.todoService.remove(request.params.id);
    response.json({ todo, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/:id/move", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { todoId: request.params.id });
    if (request.body?.beforeId === undefined) await runtime.todoService.move(request.params.id, request.body?.direction);
    else await runtime.todoService.placeBefore(request.params.id, request.body.beforeId || null);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/folders", async (request, response, next) => {
  try {
    await request.profileRuntime.todoService.addFolder({ name: request.body?.name });
    response.status(201).json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/folders/:id", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { folderId: request.params.id });
    await runtime.todoService.renameFolder(request.params.id, request.body?.name);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/todos/folders/:id", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { folderId: request.params.id });
    await runtime.todoService.removeFolder(request.params.id);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules", async (request, response, next) => {
  try {
    response.json(await moduleService.list(scopedProjects(request.profile.id)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/install", async (request, response, next) => {
  try {
    const module = await moduleService.install(request.params.id, scopedProjects(request.profile.id));
    response.status(201).json({ module: await moduleService.payload(module) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/toggle", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json({ module: await moduleService.setEnabled(request.params.id, request.body?.enabled === true) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/schedules/:scheduleId", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json({ module: await moduleService.setSchedule(request.params.id, request.params.scheduleId, request.body?.time) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/actions/:actionId", (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.status(202).json({ run: moduleService.runAction(request.params.id, request.params.actionId) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectOwned(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const previous = projects.get(request.params.id);
    const project = await projectInput(request.body, previous);
    await projects.set(request.params.id, project);
    // Partager un projet partage tout ce qu'il contient: ses agents suivent l'etat du projet.
    if (Boolean(previous.shared) !== Boolean(project.shared)) {
      const agents = Object.entries(store.all()).filter(([, session]) => session.projectId === request.params.id && (session.profileId || primaryProfileId) === request.profile.id);
      if (agents.length) await store.setMany(agents.map(([id, session]) => [id, { ...session, shared: Boolean(project.shared) }]));
    }
    response.json({ project: projectPayload(request.params.id, project, request.profile.id) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectOwned(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    for (const [sessionId, session] of Object.entries(store.all())) {
      if (session.projectId === request.params.id) await store.set(sessionId, { ...session, projectId: null });
    }
    await projects.remove(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

// Les projets n'ont pas toujours de dossier propre: on prend le premier logo trouve
// dans le dossier du projet ou dans ceux de ses agents, pour que toute l'equipe partage l'icone.
async function projectLogoFile(projectId) {
  const project = projects.get(projectId);
  if (!project) return null;
  const roots = [project.rootPath, ...Object.values(store.all()).filter((session) => session.projectId === projectId).map((session) => session.cwd)];
  for (const root of roots.filter(Boolean)) {
    const file = await projectLogos.find(root).catch(() => null);
    if (file) return file;
  }
  return null;
}

app.get("/api/projects/:id/logo", async (request, response, next) => {
  try {
    const project = projects.get(request.params.id);
    if (!project || project.profileId !== request.profile.id) return response.status(404).end();
    const file = await projectLogoFile(request.params.id);
    if (!file) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=60");
    response.sendFile(file);
  } catch (error) {
    next(error);
  }
});

async function saveUpload(request, response, next) {
  try {
    if (!request.file) throw new Error("Fichier manquant.");
    if (!validSessionId(request.body?.sessionId) || !sessionVisible(request.profile.id, request.body.sessionId) || !(await tmux.exists(request.body.sessionId))) throw new Error("Session invalide.");
    const base = `${request.body.sessionId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const image = /^image\//.test(request.file.mimetype);
    const originalExtension = path.extname(request.file.originalname).toLowerCase();
    const extension = image ? ".png" : (/^\.[a-z0-9]{1,10}$/.test(originalExtension) ? originalExtension : ".bin");
    const filename = `${base}${extension}`;
    const target = path.join(uploadsDir, filename);
    if (image) {
      try {
        await sharp(request.file.buffer, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 8 })
          .toFile(target);
      } catch {
        throw new Error("Image invalide ou format non pris en charge.");
      }
    } else {
      await fs.writeFile(target, request.file.buffer, { mode: 0o600 });
    }
    response.status(201).json({ path: target, name: request.file.originalname.slice(0, 120), image });
  } catch (error) {
    next(error);
  }
}

app.post("/api/uploads/file", fileUpload.single("file"), saveUpload);
app.post("/api/uploads/image", fileUpload.single("image"), saveUpload);

app.get("/api/notifications", (_request, response) => {
  response.json({ publicKey: push.publicKey() });
});

app.post("/api/notifications/subscribe", async (request, response, next) => {
  try {
    await push.subscribe(request.body?.subscription, request.profile.id);
    response.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/notifications/subscribe", async (request, response, next) => {
  try {
    await push.unsubscribe(request.body?.endpoint);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/notifications/test", async (request, response, next) => {
  try {
    // Test grandeur nature: on emprunte l'agent le plus recent pour verifier l'icone et l'ouverture.
    const visible = (await tmux.list()).filter((session) => session.managed && sessionVisible(request.profile.id, session.id));
    // Chaque test prend l'agent suivant: on voit tourner les icones (logo projet, Codex, Claude, terminal).
    const cursor = (notificationTestCursor.get(request.profile.id) || 0) % Math.max(1, visible.length);
    notificationTestCursor.set(request.profile.id, cursor + 1);
    const sample = visible[cursor] || null;
    const devices = await push.send({
      title: sample ? agentNotificationTitle(sample.projectId ? projects.get(sample.projectId)?.name : sample.name, "Test notification", sample.assistant) : "Noyau connecté",
      body: sample ? `Icône et ouverture de ${sample.name} vérifiées.` : "Notifications prêtes sur cet appareil.",
      tag: "noyau-test",
      icon: sample ? await notificationIcon(sample.id) : null,
      sessionId: sample?.id || null,
      url: sample ? `/?session=${encodeURIComponent(sample.id)}&profile=${encodeURIComponent(request.profile.id)}` : "/",
    }, request.profile.id);
    if (!devices) throw new Error("Aucun appareil push actif. Réactive alertes depuis app HTTPS installée.");
    response.json({ ok: true, devices, agent: sample?.name || null, icon: sample ? await notificationIcon(sample.id) : null });
  } catch (error) {
    next(error);
  }
});

app.post("/api/hooks/notify", async (request, response, next) => {
  try {
    const { source, sessionId, event = {} } = request.body || {};
    const completion = (source === "codex" && event.type === "agent-turn-complete") || (source === "claude" && event.hook_event_name === "Stop");
    const attention = source === "claude" && event.hook_event_name === "Notification";
    const existing = sessionId && validSessionId(sessionId) ? store.get(sessionId) : null;
    if (!existing) return response.status(202).json({ sent: false, reason: "unmanaged-session" });
    let metadata = existing;
    if (existing) {
      metadata = {
        ...existing,
        threadId: source === "codex" ? event["thread-id"] || existing.threadId : existing.threadId,
        transcriptPath: source === "claude" ? event.transcript_path || existing.transcriptPath : existing.transcriptPath,
        agentSessionId: source === "claude" ? event.session_id || existing.agentSessionId : existing.agentSessionId,
        agentState: completion ? "available" : attention ? "waiting" : existing.agentState,
        agentStateUpdatedAt: completion || attention ? new Date().toISOString() : existing.agentStateUpdatedAt,
      };
      await store.set(sessionId, metadata);
    }
    const migrationWasPending = Boolean(completion && sessionId && migrations.has(sessionId));
    const permissionRestart = completion && metadata?.permissionRestartPending && !migrationWasPending
      ? { id: sessionId, assistant: metadata.assistant, cwd: metadata.cwd, threadId: source === "codex" ? metadata.threadId : metadata.agentSessionId }
      : null;
    const lastMessage = source === "claude"
      ? event.last_assistant_message || await lastClaudeMessage(event.transcript_path)
      : event["last-assistant-message"] || "";
    const notificationLabel = (metadata?.projectId ? projects.get(metadata.projectId)?.name : null) || metadata?.name || null;
    let payload = null;
    if (completion) {
      payload = {
        title: agentNotificationTitle(notificationLabel, `${source === "codex" ? "Codex" : "Claude"} a terminé`, metadata?.assistant || source),
        body: lastMessage || "Réponse prête.",
        tag: `${source}-${event["thread-id"] || event.session_id || "complete"}`,
      };
    }
    if (attention) {
      payload = {
        title: agentNotificationTitle(notificationLabel, event.title || "Claude attend", metadata?.assistant || source),
        body: event.message || "Action demandée.",
        tag: `claude-${event.session_id || "attention"}-${event.notification_type || "notification"}`,
      };
    }
    if (!payload) return response.status(202).json({ sent: false });
    if (completion && sessionId && migrations.has(sessionId)) {
      const migration = migrations.get(sessionId);
      clearTimeout(migration.timer);
      const sourceSession = store.get(sessionId);
      if (sourceSession && lastMessage) {
        try {
          const target = await tmux.create({
            name: `${sourceSession.name} · ${migration.target === "codex" ? "Codex" : "Claude"}`,
            assistant: migration.target,
            cwd: sourceSession.cwd,
            migratedFrom: sessionId,
            yolo: Boolean(sourceSession.yolo),
            projectLogo: Boolean(sourceSession.projectLogo),
            projectId: sourceSession.projectId || null,
            profileId: sourceSession.profileId || primaryProfileId,
            shared: Boolean(sourceSession.shared),
            favorite: Boolean(sourceSession.favorite),
            prompt: `Tu reprends travail d'un autre agent. Utilise ce récapitulatif comme contexte fiable, vérifie état réel du dépôt avant modification, puis attends prochaine demande utilisateur.\n\nRÉCAPITULATIF DE PASSATION:\n${lastMessage}`,
          });
          await store.set(sessionId, { ...store.get(sessionId), migrationState: "complete", migratedTo: target.id });
          migrations.delete(sessionId);
          payload = {
            title: `Contexte passé à ${migration.target === "codex" ? "Codex" : "Claude"}`,
            body: `${sourceSession.name} prêt dans nouvel agent.`,
            tag: `migration-${target.id}`,
            url: `/?session=${encodeURIComponent(target.id)}&profile=${encodeURIComponent(sourceSession.profileId || primaryProfileId)}`,
            replyUrl: `/?session=${encodeURIComponent(target.id)}&reply=1&profile=${encodeURIComponent(sourceSession.profileId || primaryProfileId)}`,
          };
        } catch (error) {
          migrations.delete(sessionId);
          await store.set(sessionId, { ...store.get(sessionId), migrationState: "failed", migrationError: error.message });
          throw error;
        }
      }
    }
    payload.body = String(payload.body).replace(/\s+/g, " ").trim().slice(0, 220);
    payload.icon ||= await notificationIcon(sessionId);
    payload.sessionId = sessionId && validSessionId(sessionId) ? sessionId : null;
    const notificationProfileId = metadata?.profileId || primaryProfileId;
    payload.url ||= sessionId && validSessionId(sessionId) ? `/?session=${encodeURIComponent(sessionId)}&profile=${encodeURIComponent(notificationProfileId)}` : "/";
    payload.replyUrl ||= sessionId && validSessionId(sessionId) ? `/?session=${encodeURIComponent(sessionId)}&reply=1&profile=${encodeURIComponent(notificationProfileId)}` : payload.url;
    payload.actions = [{ action: "reply", title: "Répondre" }];
    const devices = await push.send(payload, notificationProfileId);
    response.json({ sent: true, devices });
    if (permissionRestart?.threadId) schedulePermissionRestart(sessionId, permissionRestart);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions", async (request, response, next) => {
  try {
    const sessions = (await tmux.list()).filter((session) => sessionVisible(request.profile.id, session.id));
    const enriched = await Promise.all(sessions.map(async (session) => {
      let metadata = store.get(session.id) || {};
      if (session.assistant === "codex" && !metadata.threadId) {
        const threadId = await usage.discoverCodexThread(session.panePid);
        if (threadId) {
          metadata = { ...metadata, threadId };
          await store.set(session.id, metadata);
        }
      }
      const project = session.projectId ? projects.get(session.projectId) : null;
      const owner = profileService.resolve(session.profileId);
      const pane = await tmux.capture(session.id);
      return { ...session, canEdit: session.profileId === request.profile.id, owner: { id: owner.id, name: owner.name }, project: project ? { id: session.projectId, name: project.name } : null, logoUrl: logoUrl(session, request.profile.id), agentStatus: agentStatus(session, metadata, promptWatcher.isWaiting(session.id), Date.now(), pane), usage: await usage.get({ ...session, ...metadata }, pane) };
    }));
    // Les quotas sont ceux du compte: chaque agent Codex n'en voit qu'une partie selon sa conversation.
    const codexWindows = new Map();
    for (const session of enriched) {
      if (session.assistant !== "codex") continue;
      for (const window of session.usage?.rateWindows || []) {
        const current = codexWindows.get(window.windowMinutes);
        const fresher = !current
          || String(window.resetsAt) > String(current.resetsAt)
          || (window.resetsAt === current.resetsAt && window.remainingPercent < current.remainingPercent);
        if (fresher) codexWindows.set(window.windowMinutes, window);
      }
    }
    for (const window of providerState.get("codex")?.windows || []) {
      const current = codexWindows.get(window.windowMinutes);
      if (!current || String(window.resetsAt) > String(current.resetsAt)) codexWindows.set(window.windowMinutes, window);
    }
    const codexQuota = [...codexWindows.values()].sort((left, right) => (left.windowMinutes || 0) - (right.windowMinutes || 0));
    if (codexQuota.length) await providerState.set("codex", { windows: codexQuota, updatedAt: new Date().toISOString() });
    response.json({
      sessions: enriched,
      quotas: {
        codex: codexQuota.length ? refreshExpiredQuota({ remainingPercent: codexQuota[0].remainingPercent, resetsAt: codexQuota[0].resetsAt, windowMinutes: codexQuota[0].windowMinutes, windows: codexQuota }) : null,
        claude: refreshExpiredQuota(providerState.get("claude")) || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", async (request, response, next) => {
  try {
    if (request.body?.projectId && !projectVisible(request.profile.id, request.body.projectId)) throw new Error("Projet introuvable.");
    const project = request.body?.projectId ? projects.get(request.body.projectId) : null;
    const shared = request.body?.shared === undefined ? Boolean(project?.shared) : Boolean(request.body.shared);
    response.status(201).json({ session: await tmux.create({ ...(request.body || {}), profileId: request.profile.id, shared }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/logo", async (request, response, next) => {
  try {
    const session = store.get(request.params.id);
    if (!session?.projectLogo || !sessionVisible(request.profile.id, request.params.id)) return response.status(404).end();
    const file = (session.projectId ? await projectLogoFile(session.projectId) : null) || await projectLogos.find(session.cwd).catch(() => null);
    if (!file) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=60");
    response.sendFile(file);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/sessions/:id", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const session = (await tmux.list()).find((item) => item.id === request.params.id);
    const current = store.get(request.params.id);
    if (!session?.managed || !current) throw new Error("Session Noyau introuvable.");
    const name = request.body?.name === undefined ? current.name : String(request.body.name).trim().slice(0, 60);
    if (!name) throw new Error("Nom requis.");
    const yolo = ["codex", "claude"].includes(session.assistant)
      ? (request.body?.yolo === undefined ? Boolean(current.yolo) : Boolean(request.body.yolo))
      : false;
    const projectLogo = request.body?.projectLogo === undefined ? Boolean(current.projectLogo) : Boolean(request.body.projectLogo);
    const projectId = request.body?.projectId === undefined ? current.projectId || null : request.body.projectId || null;
    const favorite = request.body?.favorite === undefined ? Boolean(current.favorite) : Boolean(request.body.favorite);
    const shared = request.body?.shared === undefined ? Boolean(current.shared) : Boolean(request.body.shared);
    if (projectId && !projectVisible(request.profile.id, projectId)) throw new Error("Projet introuvable.");
    const assistant = request.body?.assistant;
    if (assistant && assistant !== session.assistant) {
      if (!["codex", "claude"].includes(assistant) || !["codex", "claude"].includes(session.assistant)) throw new Error("Bascule réservée aux agents Codex/Claude.");
      const metadata = { ...current, name, yolo, projectLogo, projectId, favorite, shared };
      const { prompt, history } = await handoverPrompt({ session, metadata, target: assistant });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target: assistant, prompt, replace: true });
      return response.json({ session: { ...created, logoUrl: logoUrl(created) }, switched: true, history, restarted: true, pending: false });
    }
    let next = { ...current, name, yolo, projectLogo, projectId, favorite, shared };
    const permissionChanged = ["codex", "claude"].includes(session.assistant) && yolo !== Boolean(current.runningYolo);
    let restarted = false;
    if (permissionChanged) {
      let threadId = session.assistant === "codex" ? current.threadId : current.agentSessionId;
      if (session.assistant === "codex" && !threadId) threadId = await usage.discoverCodexThread(session.panePid);
      next.permissionRestartPending = true;
      if (threadId && session.assistant === "codex") next.threadId = threadId;
      await store.set(session.id, next);
      await tmux.restartAgent({ id: session.id, assistant: session.assistant, cwd: session.cwd, threadId, yolo });
      next = { ...store.get(session.id), runningYolo: yolo, permissionRestartPending: false, permissionRestartError: null };
      restarted = true;
    } else {
      next.permissionRestartPending = false;
    }
    await store.set(session.id, next);
    response.json({ session: { ...session, ...next, logoUrl: logoUrl({ ...session, ...next }) }, restarted, pending: Boolean(next.permissionRestartPending) });
  } catch (error) {
    next(error);
  }
});

// Logo de l'agent pour la notification: le navigateur le charge en same-origin avec le cookie.
// Icone de notification: logo du projet si on en trouve un, sinon l'icone de l'agent lui-meme.
function assistantIcon(assistant) {
  return ["codex", "claude", "shell"].includes(assistant) ? `/agents/${assistant}.png` : null;
}

async function notificationIcon(sessionId) {
  if (!sessionId || !validSessionId(sessionId)) return null;
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (!entry.projectLogo) return assistantIcon(entry.assistant);
  const file = (entry.projectId ? await projectLogoFile(entry.projectId) : null) || await projectLogos.find(entry.cwd).catch(() => null);
  return file
    ? `/api/sessions/${encodeURIComponent(sessionId)}/logo?profile=${encodeURIComponent(entry.profileId || primaryProfileId)}`
    : assistantIcon(entry.assistant);
}

async function sourceQuotaRemaining(session, metadata) {
  if (session.assistant === "codex") {
    const info = await usage.get({ ...session, ...metadata }, await tmux.capture(session.id));
    return Number.isFinite(info?.rateRemainingPercent) ? info.rateRemainingPercent : null;
  }
  const claude = providerState.get("claude");
  const values = [claude?.fiveHour?.remainingPercent, claude?.sevenDay?.remainingPercent].filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

async function handoverPrompt({ session, metadata, target }) {
  const transcript = await handover.prompt({
    assistant: session.assistant,
    target,
    threadId: metadata.threadId,
    agentSessionId: metadata.agentSessionId,
    cwd: session.cwd,
  });
  if (transcript) return { prompt: transcript, history: true };
  return {
    prompt: `Tu reprends le travail d'un agent ${session.assistant === "codex" ? "Codex" : "Claude"} dans ${session.cwd}. Aucun historique lisible n'a été retrouvé: inspecte le dépôt, le git log et les fichiers modifiés pour comprendre l'état, puis attends la prochaine demande de l'utilisateur.`,
    history: false,
  };
}

async function spawnHandoverSession({ sessionId, session, metadata, target, prompt, replace = false }) {
  const created = await tmux.create({
    name: replace ? metadata.name || session.name : `${metadata.name || session.name} · ${target === "codex" ? "Codex" : "Claude"}`,
    assistant: target,
    cwd: session.cwd,
    migratedFrom: sessionId,
    yolo: Boolean(metadata.yolo),
    projectLogo: Boolean(metadata.projectLogo),
    projectId: metadata.projectId || null,
    profileId: metadata.profileId || primaryProfileId,
    shared: Boolean(metadata.shared),
    favorite: Boolean(metadata.favorite),
    prompt,
  });
  await store.set(created.id, { ...store.get(created.id), switchedFrom: session.assistant, switchedAt: new Date().toISOString() });
  await store.set(sessionId, { ...store.get(sessionId), migrationState: "complete", migrationTarget: target, migratedTo: created.id });
  if (replace) await tmux.kill(sessionId).catch(() => {});
  return { ...store.get(created.id), id: created.id, managed: true };
}

app.post("/api/sessions/:id/migrate", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const session = (await tmux.list()).find((item) => item.id === request.params.id);
    if (!session || !["codex", "claude"].includes(session.assistant)) throw new Error("Migration réservée aux agents Codex/Claude.");
    const target = request.body?.target || (session.assistant === "codex" ? "claude" : "codex");
    if (!["codex", "claude"].includes(target) || target === session.assistant) throw new Error("Agent cible invalide.");
    const metadata = store.get(session.id) || {};
    const mode = ["auto", "agent", "transcript"].includes(request.body?.mode) ? request.body.mode : "auto";
    const pending = migrations.get(session.id);
    const remaining = mode === "agent" ? null : await sourceQuotaRemaining(session, metadata);
    // Quota epuise ou recap deja demande sans reponse: on reprend la derniere conversation
    // et l'agent change de type sur place, sans attendre l'agent source.
    if (mode === "transcript" || pending || (mode === "auto" && Number.isFinite(remaining) && remaining <= QUOTA_EXHAUSTED_PERCENT)) {
      if (pending) {
        clearTimeout(pending.timer);
        migrations.delete(session.id);
      }
      const { prompt, history } = await handoverPrompt({ session, metadata, target });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target, prompt, replace: true });
      return response.status(201).json({ ok: true, state: "complete", mode: "transcript", history, target, session: { ...created, logoUrl: logoUrl(created) } });
    }
    // Si l'agent source ne rend jamais son recap (quota atteint en cours de route, agent bloque),
    // on bascule automatiquement sur l'historique de sa derniere conversation.
    const fallbackTimer = setTimeout(async () => {
      if (!migrations.has(session.id)) return;
      migrations.delete(session.id);
      try {
        const { prompt } = await handoverPrompt({ session, metadata, target });
        const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target, prompt, replace: true });
        await push.send({
          title: agentNotificationTitle(metadata.projectId ? projects.get(metadata.projectId)?.name : metadata.name, `Contexte repris par ${target === "codex" ? "Codex" : "Claude"}`, target),
          body: "Passation faite depuis la dernière conversation.",
          tag: `migration-${created.id}`,
          url: `/?session=${encodeURIComponent(created.id)}&profile=${encodeURIComponent(metadata.profileId || primaryProfileId)}`,
        }, metadata.profileId || primaryProfileId);
      } catch (error) {
        await store.set(session.id, { ...store.get(session.id), migrationState: "failed", migrationError: error.message });
      }
    }, MIGRATION_FALLBACK_MS);
    fallbackTimer.unref?.();
    migrations.set(session.id, { target, startedAt: new Date().toISOString(), timer: fallbackTimer });
    await store.set(session.id, { ...store.get(session.id), migrationState: "summarizing", migrationTarget: target, migratedTo: null, agentState: "working", agentStateUpdatedAt: new Date().toISOString() });
    await tmux.submit(session.id, `Prépare passation vers ${target === "codex" ? "Codex" : "Claude"}. Réponds uniquement avec récapitulatif autonome et compact: objectif, décisions, fichiers modifiés, état actuel, tests, commandes utiles, blocages, prochaines étapes. N'effectue aucune autre action.`);
    response.status(202).json({ ok: true, state: "summarizing", target });
  } catch (error) {
    migrations.delete(request.params.id);
    const current = store.get(request.params.id);
    if (current?.migrationState === "summarizing") await store.set(request.params.id, { ...current, migrationState: "failed", migrationError: error.message });
    next(error);
  }
});

// Redemarrage manuel: l'agent repart dans le meme pane et reprend la conversation en cours.
app.post("/api/sessions/:id/restart", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    const threadId = current.assistant === "codex" ? current.threadId : current.agentSessionId;
    await tmux.restartAgent({ id: request.params.id, assistant: current.assistant, cwd: current.cwd, threadId, yolo: Boolean(current.yolo) });
    await store.set(request.params.id, {
      ...current,
      runningYolo: Boolean(current.yolo),
      permissionRestartPending: false,
      permissionRestartError: null,
      agentState: "available",
      agentStateUpdatedAt: new Date().toISOString(),
    });
    response.json({ ok: true, resumed: Boolean(threadId) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:id", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    if (store.get(request.params.id)?.core) throw new Error("Agent de base du Noyau: non supprimable.");
    await tmux.kill(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 400;
  if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
  response.status(status).json({ error: error.message || "Erreur serveur.", ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist"), { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    response.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

const server = http.createServer(app);
const secureServer = process.env.NOYAU_TLS_CERT && process.env.NOYAU_TLS_KEY
  ? https.createServer({
      cert: await fs.readFile(process.env.NOYAU_TLS_CERT),
      key: await fs.readFile(process.env.NOYAU_TLS_KEY),
      minVersion: "TLSv1.2",
    }, app)
  : null;
const sockets = new WebSocketServer({ noServer: true });

async function upgradeTerminal(request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const match = url.pathname.match(/^\/ws\/terminal\/([a-zA-Z0-9_-]+)$/);
  const profile = profileService.resolve(url.searchParams.get("profile"));
  if (!match || !authenticated(request) || !sessionVisible(profile.id, match[1]) || !(await tmux.exists(match[1]))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  request.sessionId = match[1];
  request.profileId = profile.id;
  sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
}

server.on("upgrade", upgradeTerminal);
secureServer?.on("upgrade", upgradeTerminal);

sockets.on("connection", (websocket, request) => {
  const terminalUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const initialCols = Math.max(20, Math.min(300, Math.trunc(Number(terminalUrl.searchParams.get("cols"))) || 100));
  const initialRows = Math.max(5, Math.min(120, Math.trunc(Number(terminalUrl.searchParams.get("rows"))) || 30));
  const specialKeys = {
    Enter: "C-m",
    Backspace: "BSpace",
    Escape: "Escape",
    Tab: "Tab",
    ArrowLeft: "Left",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowRight: "Right",
    Transcript: "C-t",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };
  let mobileCopyMode = false;
  let keyQueue = tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]).catch(() => {});
  const terminal = pty.spawn(tmux.binary, ["attach-session", "-t", `=${request.sessionId}`], {
    name: "xterm-256color",
    cols: initialCols,
    rows: initialRows,
    cwd: workspaceRoot,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  terminal.onData((data) => {
    if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify({ type: "output", data }));
  });
  terminal.onExit(({ exitCode }) => {
    if (websocket.readyState === websocket.OPEN) websocket.send(JSON.stringify({ type: "exit", exitCode }));
    websocket.close();
  });
  websocket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const leaveMobileCopyMode = async () => {
        if (!mobileCopyMode) return;
        mobileCopyMode = false;
        await tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]);
      };
      if (message.type === "input" && typeof message.data === "string") {
        const data = message.data.slice(0, 16384);
        keyQueue = keyQueue
          .then(leaveMobileCopyMode)
          .then(() => terminal.write(data))
          .then(() => /[\r\n]/.test(data) ? setAgentState(request.sessionId, "working") : null)
          .catch(() => {});
      }
      if (message.type === "submit" && typeof message.data === "string" && message.data.length) {
        const data = message.data.slice(0, 16384);
        keyQueue = keyQueue
          .then(leaveMobileCopyMode)
          .then(() => setAgentState(request.sessionId, "working"))
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, "-l", data]))
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, "C-m"]))
          .then(() => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify({ type: "key-ack", key: "Enter" })))
          .catch(() => {});
      }
      if (message.type === "key" && specialKeys[message.key]) {
        keyQueue = keyQueue
          .then(leaveMobileCopyMode)
          .then(() => message.key === "Enter" ? setAgentState(request.sessionId, "working") : null)
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, specialKeys[message.key]]))
          .then(() => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify({ type: "key-ack", key: message.key })))
          .catch(() => {});
      }
      if (message.type === "scroll" && ["up", "down"].includes(message.direction)) {
        const count = Math.max(1, Math.min(80, Math.trunc(Number(message.count)) || 1));
        keyQueue = keyQueue
          .then(async () => {
            if (!mobileCopyMode) {
              await tmux.run(["copy-mode", "-t", request.sessionId]);
              mobileCopyMode = true;
            }
            await tmux.run(["send-keys", "-X", "-N", String(count), "-t", request.sessionId, `scroll-${message.direction}`]);
            if (message.direction === "down") {
              const position = Number((await tmux.run(["display-message", "-p", "-t", request.sessionId, "#{scroll_position}"])).stdout.trim());
              if (position === 0) {
                await tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]);
                mobileCopyMode = false;
              }
            }
          })
          .catch(() => {});
      }
      if (message.type === "resize") terminal.resize(Math.max(20, Math.min(300, Number(message.cols))), Math.max(5, Math.min(120, Number(message.rows))));
    } catch {
      websocket.send(JSON.stringify({ type: "error", message: "Message invalide." }));
    }
  });
  websocket.on("close", () => {
    if (mobileCopyMode) tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]).catch(() => {});
    mobileCopyMode = false;
    terminal.kill();
  });
});

let todoReminderRunning = false;
const todoReminderErrors = new Map();
async function checkTodoReminders() {
  if (todoReminderRunning) return;
  todoReminderRunning = true;
  try {
    for (const profile of profileService.list()) {
      try {
        const runtime = await ensureProfileRuntime(profile.id);
        const reminders = await runtime.todoService.reminders();
        for (const reminder of reminders) {
          const project = reminder.projectId && projectVisible(profile.id, reminder.projectId) ? projects.get(reminder.projectId) : null;
          const title = reminder.kind === "tomorrow" ? "Tâche prévue demain" : reminder.kind === "today" ? "Tâche à faire aujourd’hui" : "Tâche en retard";
          const devices = await push.send({
            title: `${profile.name} · ${title}`,
            body: `${reminder.text}${project?.name ? ` · ${project.name}` : ""}`,
            tag: `todo-${profile.id}-${reminder.id}-${reminder.reminderKey}`,
            url: `/?view=todos&profile=${encodeURIComponent(profile.id)}`,
            actions: [{ action: "open", title: "Ouvrir" }],
          }, profile.id);
          if (devices > 0) await runtime.todoService.markReminded(reminder.id, reminder.reminderKey);
        }
        todoReminderErrors.delete(profile.id);
      } catch (error) {
        if (error.message !== todoReminderErrors.get(profile.id)) console.error(`Rappels tâches ${profile.name}: ${error.message}`);
        todoReminderErrors.set(profile.id, error.message);
      }
    }
  } finally {
    todoReminderRunning = false;
  }
}

// Un seul port pour les deux protocoles: le premier octet 0x16 signale une poignee de main TLS,
// tout le reste part sur le serveur HTTP. Plus besoin de retenir quel port porte quel schema.
const frontDoor = secureServer
  ? net.createServer((socket) => {
      socket.setTimeout(15_000);
      socket.once("timeout", () => socket.destroy());
      socket.once("error", () => socket.destroy());
      // Lecture d'un seul octet sans passer le socket en mode flux: TLS doit recevoir tout le reste intact.
      socket.once("readable", () => {
        const first = socket.read(1);
        if (!first) return socket.destroy();
        socket.setTimeout(0);
        socket.unshift(first);
        (first[0] === 0x16 ? secureServer : server).emit("connection", socket);
      });
    })
  : server;

frontDoor.listen(port, host, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item?.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  console.log(`Noyau actif: http://localhost:${port}`);
  for (const address of addresses) console.log(`Réseau/VPN: http://${address}:${port}${secureServer ? ` et https://${address}:${port}` : ""}`);
});

if (secureServer) {
  const securePort = Number(process.env.NOYAU_HTTPS_PORT || 4243);
  const secureHost = process.env.NOYAU_HTTPS_HOST || host;
  secureServer.listen(securePort, secureHost, () => console.log(`Noyau HTTPS VPN: https://${secureHost}:${securePort}`));
}

promptWatcher.start();
claudeQuota.start();

// Releve Codex periodique: les quotas se renouvellent meme quand aucun agent ne parle.
async function refreshCodexQuota() {
  const windows = await usage.latestCodexRateWindows().catch(() => []);
  if (windows.length) await providerState.set("codex", { windows, updatedAt: new Date().toISOString() });
}
void refreshCodexQuota();
setInterval(() => { refreshCodexQuota().catch(() => {}); }, 5 * 60 * 1000).unref();
const todoReminderTimer = setInterval(checkTodoReminders, 5 * 60_000);
todoReminderTimer.unref();
setTimeout(checkTodoReminders, 5_000).unref();
