import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
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
import { UsageService, lastClaudeMessage, parseClaudeRateLimits } from "./usage.js";
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
import { TodoService } from "./todo-service.js";

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
const claudeQuota = new ClaudeQuotaService({ store: providerState });
const push = new PushService({ dataDir });
await push.load();
const todoService = new TodoService({
  file: process.env.NOYAU_TODO_FILE || path.join(dataDir, "TO DO.md"),
  mountUri: process.env.NOYAU_TODO_MOUNT_URI || null,
});
const usage = new UsageService();
const projectLogos = new ProjectLogoService();
const migrations = new Map();
const weatherCache = new Map();
const moduleService = new ModuleService({
  workspaceRoot,
  store: moduleStore,
  onActionComplete: async ({ module, action, result }) => {
    await push.send({
      title: `${module.name} · ${result.state === "success" ? "Terminé" : "Erreur"}`,
      body: result.state === "success" ? `${action.label} terminé.` : `${action.label}: ${result.output || "échec"}`,
      tag: `module-${module.id}-${action.id}`,
      url: "/?view=projects",
    });
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
const financeAdvisor = new FinanceAdvisor({ binary: codexBinary, cwd: root });
financeService.setAdvisor(({ message, month, action }) => financeAdvisor.answer({ message, month, action, payload: financePayload(month), history: financeService.agentHistory() }));
financeService.setClassifier((groups, categories) => financeAdvisor.classify(groups, categories));
const handover = new HandoverService();
const MIGRATION_FALLBACK_MS = 3 * 60 * 1000;
const promptWatcher = new PromptWatcher({
  tmux,
  push,
  sessionLabel: (session) => (session.projectId ? projects.get(session.projectId)?.name : null) || session.name,
});
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function currentMonthParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}`;
}

function financePayload(month = currentMonthParis()) {
  const payload = financeService.payload(month);
  const status = enableBanking.status();
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

function logoUrl(session) {
  return session.projectLogo ? `/api/sessions/${encodeURIComponent(session.id)}/logo` : null;
}

async function setAgentState(sessionId, agentState) {
  const current = store.get(sessionId);
  if (!current || !["working", "available", "waiting"].includes(agentState)) return;
  await store.set(sessionId, { ...current, agentState, agentStateUpdatedAt: new Date().toISOString() });
}

function projectPayload(id, project) {
  return { id, ...project, logoUrl: `/api/projects/${encodeURIComponent(id)}/logo` };
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
  return { ...current, name, rootPath, updatedAt: new Date().toISOString() };
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

app.get("/api/finance/banking/callback", async (request, response) => {
  try {
    await enableBanking.complete({
      code: request.query.code,
      state: request.query.state,
      error: request.query.error,
      errorDescription: request.query.error_description,
    });
    response.redirect(303, "/?view=finances&bank=connected");
  } catch (error) {
    response.redirect(303, `/?view=finances&bankError=${encodeURIComponent(error.message)}`);
  }
});

app.use("/api", (request, response, next) => {
  if (!authenticated(request)) return response.status(401).json({ error: "Non autorisé." });
  next();
});

app.get("/api/config", (_request, response) => response.json({ workspaceRoot }));

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
    response.json(financePayload(request.query.month || currentMonthParis()));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/finance/settings", async (request, response, next) => {
  try {
    await financeService.updateSettings(request.body);
    response.json(financePayload(request.body?.month || currentMonthParis()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/modules", async (request, response, next) => {
  try {
    const module = await financeService.addModule(request.body);
    response.status(201).json({ module });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/finance/modules/:id", async (request, response, next) => {
  try {
    response.json({ module: await financeService.updateModule(request.params.id, request.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/modules/:id", async (request, response, next) => {
  try {
    await financeService.removeModule(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/transactions", async (request, response, next) => {
  try {
    const transaction = await financeService.addTransaction(request.body);
    response.status(201).json({ transaction });
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/transactions/categorize", async (request, response, next) => {
  try {
    const month = request.body?.all ? null : request.body?.month || currentMonthParis();
    const result = await financeService.categorizeTransactions({ force: Boolean(request.body?.force), month });
    response.json({ result, finance: financePayload(request.body?.month || currentMonthParis()) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/transactions/:id", async (request, response, next) => {
  try {
    await financeService.removeTransaction(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance/banking/status", (_request, response) => {
  response.json(enableBanking.status());
});

app.patch("/api/finance/banking/config", async (request, response, next) => {
  try {
    const status = await enableBanking.saveConfig(request.body);
    financeService.setAggregatorConfigured(true);
    const application = await enableBanking.verify();
    response.json({ status, application });
  } catch (error) {
    next(error);
  }
});

app.get("/api/finance/banking/institutions", async (_request, response, next) => {
  try {
    response.json({ institutions: await enableBanking.institutions() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/banking/connect", async (request, response, next) => {
  try {
    response.json(await enableBanking.begin(request.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/banking/sync", async (request, response, next) => {
  try {
    const result = await enableBanking.sync(request.body?.bankId || null);
    const month = request.body?.month || currentMonthParis();
    let categorization;
    try {
      categorization = await financeService.categorizeTransactions({ month });
    } catch (error) {
      categorization = { error: error.message };
    }
    response.json({ result, categorization, finance: financePayload(month), banking: enableBanking.status() });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/banking/connections/:bankId", async (request, response, next) => {
  try {
    await enableBanking.disconnect(request.params.bankId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/finance/agent/message", async (request, response, next) => {
  try {
    const month = request.body?.month || currentMonthParis();
    const result = await financeService.financeAgent(request.body?.message, month);
    response.json(result);
    void push.send({ title: "Agent finances · Réponse prête", body: result.reply.slice(0, 180), tag: "finance-agent", url: "/?view=finance-agent" }).catch((error) => console.error(`Notification finances: ${error.message}`));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/finance/recurring/:id", async (request, response, next) => {
  try {
    await financeService.removeRecurring(request.params.id);
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

app.get("/api/projects", (_request, response) => {
  const list = Object.entries(projects.all()).map(([id, project]) => projectPayload(id, project)).sort((a, b) => a.name.localeCompare(b.name));
  response.json({ projects: list });
});

app.post("/api/projects", async (request, response, next) => {
  try {
    const id = `project-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const project = await projectInput(request.body, { createdAt: new Date().toISOString() });
    await projects.set(id, project);
    response.status(201).json({ project: projectPayload(id, project) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/todos", async (_request, response, next) => {
  try {
    response.json({ todos: await todoService.list(), storage: "Obsidian · NAS" });
  } catch (error) {
    next(new Error(`Vault Obsidian indisponible: ${error.message}`));
  }
});

app.post("/api/todos", async (request, response, next) => {
  try {
    const projectId = request.body?.projectId || null;
    if (projectId && !projects.get(projectId)) throw new Error("Projet introuvable.");
    const todo = await todoService.add({ text: request.body?.text, dueDate: request.body?.dueDate || null, projectId });
    response.status(201).json({ todo });
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
      if (changes.projectId && !projects.get(changes.projectId)) throw new Error("Projet introuvable.");
    }
    response.json({ todo: await todoService.update(request.params.id, changes) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/:id/move", async (request, response, next) => {
  try {
    response.json({ todos: await todoService.move(request.params.id, request.body?.direction) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules", async (_request, response, next) => {
  try {
    response.json(await moduleService.list(projects.all()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/install", async (request, response, next) => {
  try {
    const module = await moduleService.install(request.params.id, projects.all());
    response.status(201).json({ module: await moduleService.payload(module) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/toggle", async (request, response, next) => {
  try {
    response.json({ module: await moduleService.setEnabled(request.params.id, request.body?.enabled === true) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/schedules/:scheduleId", async (request, response, next) => {
  try {
    response.json({ module: await moduleService.setSchedule(request.params.id, request.params.scheduleId, request.body?.time) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/actions/:actionId", (request, response, next) => {
  try {
    response.status(202).json({ run: moduleService.runAction(request.params.id, request.params.actionId) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projects.get(request.params.id)) throw new Error("Projet introuvable.");
    const project = await projectInput(request.body, projects.get(request.params.id));
    await projects.set(request.params.id, project);
    response.json({ project: projectPayload(request.params.id, project) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projects.get(request.params.id)) throw new Error("Projet introuvable.");
    for (const [sessionId, session] of Object.entries(store.all())) {
      if (session.projectId === request.params.id) await store.set(sessionId, { ...session, projectId: null });
    }
    await projects.remove(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/logo", async (request, response, next) => {
  try {
    const project = projects.get(request.params.id);
    if (!project) return response.status(404).end();
    const linkedSession = Object.values(store.all()).find((session) => session.projectId === request.params.id);
    const logoRoot = project.rootPath || linkedSession?.cwd;
    if (!logoRoot) return response.status(404).end();
    const file = await projectLogos.find(logoRoot);
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
    if (!validSessionId(request.body?.sessionId) || !(await tmux.exists(request.body.sessionId))) throw new Error("Session invalide.");
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
    await push.subscribe(request.body?.subscription);
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

app.post("/api/notifications/test", async (_request, response, next) => {
  try {
    const devices = await push.send({
      title: "Noyau connecté",
      body: "Notifications prêtes sur cet appareil.",
      tag: "noyau-test",
      url: "/",
    });
    if (!devices) throw new Error("Aucun appareil push actif. Réactive alertes depuis app HTTPS installée.");
    response.json({ ok: true, devices });
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
        title: agentNotificationTitle(notificationLabel, `${source === "codex" ? "Codex" : "Claude"} a terminé`),
        body: lastMessage || "Réponse prête.",
        tag: `${source}-${event["thread-id"] || event.session_id || "complete"}`,
      };
    }
    if (attention) {
      payload = {
        title: agentNotificationTitle(notificationLabel, event.title || "Claude attend"),
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
            favorite: Boolean(sourceSession.favorite),
            prompt: `Tu reprends travail d'un autre agent. Utilise ce récapitulatif comme contexte fiable, vérifie état réel du dépôt avant modification, puis attends prochaine demande utilisateur.\n\nRÉCAPITULATIF DE PASSATION:\n${lastMessage}`,
          });
          await store.set(sessionId, { ...store.get(sessionId), migrationState: "complete", migratedTo: target.id });
          migrations.delete(sessionId);
          payload = {
            title: `Contexte passé à ${migration.target === "codex" ? "Codex" : "Claude"}`,
            body: `${sourceSession.name} prêt dans nouvel agent.`,
            tag: `migration-${target.id}`,
            url: `/?session=${encodeURIComponent(target.id)}`,
            replyUrl: `/?session=${encodeURIComponent(target.id)}&reply=1`,
          };
        } catch (error) {
          migrations.delete(sessionId);
          await store.set(sessionId, { ...store.get(sessionId), migrationState: "failed", migrationError: error.message });
          throw error;
        }
      }
    }
    payload.body = String(payload.body).replace(/\s+/g, " ").trim().slice(0, 220);
    payload.url ||= sessionId && validSessionId(sessionId) ? `/?session=${encodeURIComponent(sessionId)}` : "/";
    payload.replyUrl ||= sessionId && validSessionId(sessionId) ? `/?session=${encodeURIComponent(sessionId)}&reply=1` : payload.url;
    payload.actions = [{ action: "reply", title: "Répondre" }];
    const devices = await push.send(payload);
    response.json({ sent: true, devices });
    if (permissionRestart?.threadId) schedulePermissionRestart(sessionId, permissionRestart);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions", async (_request, response, next) => {
  try {
    const sessions = await tmux.list();
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
      return { ...session, project: project ? { id: session.projectId, name: project.name } : null, logoUrl: logoUrl(session), agentStatus: agentStatus(session, metadata, promptWatcher.isWaiting(session.id)), usage: await usage.get({ ...session, ...metadata }, await tmux.capture(session.id)) };
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
    const codexQuota = [...codexWindows.values()].sort((left, right) => (left.windowMinutes || 0) - (right.windowMinutes || 0));
    response.json({
      sessions: enriched,
      quotas: {
        codex: codexQuota.length ? { remainingPercent: codexQuota[0].remainingPercent, resetsAt: codexQuota[0].resetsAt, windowMinutes: codexQuota[0].windowMinutes, windows: codexQuota } : null,
        claude: providerState.get("claude") || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", async (request, response, next) => {
  try {
    if (request.body?.projectId && !projects.get(request.body.projectId)) throw new Error("Projet introuvable.");
    response.status(201).json({ session: await tmux.create(request.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/logo", async (request, response, next) => {
  try {
    const session = store.get(request.params.id);
    if (!session?.projectLogo) return response.status(404).end();
    const project = session.projectId ? projects.get(session.projectId) : null;
    const file = await projectLogos.find(project?.rootPath || session.cwd);
    if (!file) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=60");
    response.sendFile(file);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/sessions/:id", async (request, response, next) => {
  try {
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
    if (projectId && !projects.get(projectId)) throw new Error("Projet introuvable.");
    const assistant = request.body?.assistant;
    if (assistant && assistant !== session.assistant) {
      if (!["codex", "claude"].includes(assistant) || !["codex", "claude"].includes(session.assistant)) throw new Error("Bascule réservée aux agents Codex/Claude.");
      const metadata = { ...current, name, yolo, projectLogo, projectId, favorite };
      const { prompt, history } = await handoverPrompt({ session, metadata, target: assistant });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target: assistant, prompt, replace: true });
      return response.json({ session: { ...created, logoUrl: logoUrl(created) }, switched: true, history, restarted: true, pending: false });
    }
    let next = { ...current, name, yolo, projectLogo, projectId, favorite };
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
    const session = (await tmux.list()).find((item) => item.id === request.params.id);
    if (!session || !["codex", "claude"].includes(session.assistant)) throw new Error("Migration réservée aux agents Codex/Claude.");
    const target = request.body?.target || (session.assistant === "codex" ? "claude" : "codex");
    if (!["codex", "claude"].includes(target) || target === session.assistant) throw new Error("Agent cible invalide.");
    if (migrations.has(session.id)) throw new Error("Migration déjà en cours.");
    const metadata = store.get(session.id) || {};
    const mode = ["auto", "agent", "transcript"].includes(request.body?.mode) ? request.body.mode : "auto";
    const remaining = mode === "agent" ? null : await sourceQuotaRemaining(session, metadata);
    // Quota epuise: l'agent source ne peut plus rediger de recap, on repart de sa derniere conversation.
    if (mode === "transcript" || (mode === "auto" && Number.isFinite(remaining) && remaining <= 0)) {
      const { prompt, history } = await handoverPrompt({ session, metadata, target });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target, prompt });
      return response.status(201).json({ ok: true, state: "complete", mode: "transcript", history, target, session: { ...created, logoUrl: logoUrl(created) } });
    }
    // Si l'agent source ne rend jamais son recap (quota atteint en cours de route, agent bloque),
    // on bascule automatiquement sur l'historique de sa derniere conversation.
    const fallbackTimer = setTimeout(async () => {
      if (!migrations.has(session.id)) return;
      migrations.delete(session.id);
      try {
        const { prompt } = await handoverPrompt({ session, metadata, target });
        const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target, prompt });
        await push.send({
          title: agentNotificationTitle(metadata.projectId ? projects.get(metadata.projectId)?.name : metadata.name, `Contexte repris par ${target === "codex" ? "Codex" : "Claude"}`),
          body: "Passation faite depuis la dernière conversation.",
          tag: `migration-${created.id}`,
          url: `/?session=${encodeURIComponent(created.id)}`,
        });
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

app.delete("/api/sessions/:id", async (request, response, next) => {
  try {
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
  if (!match || !authenticated(request) || !(await tmux.exists(match[1]))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  request.sessionId = match[1];
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
let todoReminderError = "";
async function checkTodoReminders() {
  if (todoReminderRunning) return;
  todoReminderRunning = true;
  try {
    const reminders = await todoService.reminders();
    for (const reminder of reminders) {
      const project = reminder.projectId ? projects.get(reminder.projectId) : null;
      const title = reminder.kind === "tomorrow" ? "Tâche prévue demain" : reminder.kind === "today" ? "Tâche à faire aujourd’hui" : "Tâche en retard";
      const devices = await push.send({
        title,
        body: `${reminder.text}${project?.name ? ` · ${project.name}` : ""}`,
        tag: `todo-${reminder.id}-${reminder.reminderKey}`,
        url: "/?view=todos",
        actions: [{ action: "open", title: "Ouvrir" }],
      });
      if (devices > 0) await todoService.markReminded(reminder.id, reminder.reminderKey);
    }
    todoReminderError = "";
  } catch (error) {
    if (error.message !== todoReminderError) console.error(`Rappels tâches: ${error.message}`);
    todoReminderError = error.message;
  } finally {
    todoReminderRunning = false;
  }
}

server.listen(port, host, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item?.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
  console.log(`Noyau actif: http://localhost:${port}`);
  for (const address of addresses) console.log(`Réseau/VPN: ${address}`);
});

if (secureServer) {
  const securePort = Number(process.env.NOYAU_HTTPS_PORT || 4243);
  const secureHost = process.env.NOYAU_HTTPS_HOST || host;
  secureServer.listen(securePort, secureHost, () => console.log(`Noyau HTTPS VPN: https://${secureHost}:${securePort}`));
}

promptWatcher.start();
claudeQuota.start();
const todoReminderTimer = setInterval(checkTodoReminders, 5 * 60_000);
todoReminderTimer.unref();
setTimeout(checkTodoReminders, 5_000).unref();
