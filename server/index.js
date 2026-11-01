import { answeredQuestions } from "./question-status.js";
import { claudeNeedsAttention } from "./agent-notification.js";
import { autoCloseCandidates, finishedTodos } from "./todo-autoclose.js";
import { ensureLocalTls } from "./local-tls.js";
import { totalTodoUnread } from "../shared/todo-unread.js";
import { DevicePresence } from "./device-presence.js";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
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
import { InputGate, draftAfterInput } from "./input-gate.js";
import { resolveModules, sanitizeModules } from "./app-modules.js";
import { TmuxController, batchTmuxCommands, literalKeyCommands, validSessionId } from "./tmux.js";
import { PushService } from "./push-service.js";
import { UsageService, lastClaudeMessage, parseClaudeRateLimits, refreshExpiredQuota } from "./usage.js";
import { ProjectLogoService, IMAGE_EXTENSIONS } from "./project-logo.js";
import { sendMobileRelease } from "./mobile-releases.js";
import { ProjectFilesService } from "./project-files-service.js";
import { FileSortService, TRASH_DAYS, PROTECTED_HOURS } from "./file-sort-service.js";
import { agentNotificationTitle, PromptWatcher } from "./prompt-watcher.js";
import { agentAlertTitle, agentAlertBody } from "../shared/agent-alerts.js";
import { HandoverService } from "./handover.js";
import { SessionReaper } from "./session-reaper.js";
import { AgentArchiveService } from "./agent-archive-service.js";
import { BoardService } from "./board-service.js";
import { TrackingService, MAX_REPORT_BYTES } from "./tracking-service.js";
import { TodoSeenService } from "./todo-seen-service.js";
import { VoiceService } from "./voice-service.js";
import { LocalLlm } from "./local-llm.js";
import { TodoTriage, suggestEmojiForFolder } from "./todo-triage.js";
import { suggestAgentDescription } from "./agent-description.js";
import { AntigravityQuotaService } from "./antigravity-quota.js";
import { ClaudeQuotaService } from "./claude-quota.js";
import { CodexQuotaService } from "./codex-quota.js";
import { contextAdvice, optimizeCommand } from "./context-advice.js";
import { ContextAudit } from "./context-audit.js";
import { ModuleService } from "./module-service.js";
import { createBuildGrant, createProjectFileGrant, iosInstallManifest, verifyBuildGrant, verifyProjectFileGrant } from "./build-grant.js";
import { KnowledgeService } from "./knowledge-service.js";
import { normalizeProjectOrder, sortProjects } from "./project-order.js";
import { FinanceService } from "./finance-service.js";
import { FinanceAdvisor } from "./finance-advisor.js";
import { EnableBankingService } from "./enable-banking.js";
import { agentStatus, withSubagents, paneAgentState } from "./agent-status.js";
import { ROOT_FOLDER, TodoService } from "./todo-service.js";
import { CalendarService, generateICal } from "./calendar-service.js";
import { TextCorrector } from "./text-corrector.js";
import { ProfileService } from "./profile-service.js";
import { QuotaNotifier } from "./quota-notifier.js";
import { CodexCapacityRetry } from "./codex-capacity-retry.js";
import { ClaudeDesignTool } from "./claude-design-tool.js";
import { AgentCommunicationService } from "./agent-tools.js";
import { initializeAgentIdentities } from "./agent-identity.js";
import { AgentMemoryService } from "./agent-memory.js";
import { GroceriesService } from "./groceries-service.js";
import { RecipeImportJobs } from "./recipe-import-jobs.js";
import { groceryRoutes, publicGroceryRoutes } from "./groceries-routes.js";
import { NATIVE_ORIGINS, NativeWebSocketTickets } from "./native-websocket.js";
import { NativePushService, NotificationGateway } from "./native-push-service.js";
import { BackgroundAlertService } from "./background-alerts.js";
import { staticCacheHeaders } from "./static-cache.js";
import { BiometricAuthService, biometricSessionRoutes } from "./biometric-auth.js";
import { AgentMapService } from "./agent-map.js";
import { AutonomousAgents } from "./autonomous-agents.js";
import { AutonomyEstimator } from "./autonomy-estimate.js";
import { AUTONOMY_ASSISTANTS, newAutonomy } from "./autonomy.js";
import { SubagentReader } from "./subagents.js";
import { AiJobs } from "./ai-jobs.js";
import { resolveAgentDirectory } from "./agent-directory.js";
import { freshStartPrompt } from "./fresh-start.js";
import { readAgentConversation, liveActivity } from "./agent-conversation.js";
import { MapScanStore } from "./map-scanner.js";
import { summarizeRequestPrompt } from "./prompt-recap.js";
import { PowerService } from "./power-service.js";
import { HardwareService } from "./hardware-service.js";
import { SystemResourcesService, optimizationPrompt, swapPrompt, processTable, descendants, ancestors, sessionProcesses, AGENT_BINARY } from "./system-resources.js";
import { createLoginThrottle, createSessionToken, loadAccessToken, sameWebSocketOrigin, SESSION_MAX_AGE_MS, SESSION_MAX_AGE_SECONDS, verifySessionToken } from "./security.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const appVersion = String(packageMetadata.version || "0.0.0");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
await ensureLocalTls(dataDir).catch((error) => console.warn(`HTTPS local non généré (openssl requis) : ${error.message}`));
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
// Un allegement de contexte appartient a un agent, pas au dossier: chaque agent a son fichier de reglages.
const agentSettingsRoot = path.join(dataDir, "agent-settings");
await fs.mkdir(agentSettingsRoot, { recursive: true, mode: 0o700 });
const agentSettingsFile = (id) => path.join(agentSettingsRoot, `${id}.json`);

async function commandPath(name) {
  try {
    return (await execFileAsync("which", [name])).stdout.trim() || name;
  } catch {
    return name;
  }
}

// Un outil peut s'installer sous plusieurs noms: on retient le premier reellement present.
async function firstCommandPath(names) {
  for (const name of names) {
    const found = await commandPath(name);
    if (path.isAbsolute(found)) return found;
  }
  return names[0];
}

const accessTokenState = await loadAccessToken(path.join(dataDir, "access-token"), process.env.NOYAU_TOKEN);
const accessToken = accessTokenState.token;
if (accessTokenState.rotated) console.warn("Clé d’accès Noyau faible remplacée. Reconnexion requise avec .data/access-token.");
const buildGrantSecret = crypto.randomBytes(32);
const store = new SessionStore(path.join(dataDir, "sessions.json"));
await store.load();
await initializeAgentIdentities(store);
const groceries = new GroceriesService({ file: path.join(dataDir, "groceries.json"), automaticScans: true });
await groceries.load();
const recipeImportJobs = new RecipeImportJobs({ file: path.join(dataDir, "recipe-import-jobs.json"), importer: (url) => groceries.importRecipe(url) });
await recipeImportJobs.load();
const projects = new SessionStore(path.join(dataDir, "projects.json"));
await projects.load();
const moduleStore = new SessionStore(path.join(dataDir, "modules.json"));
await moduleStore.load();
const knowledgeConfigStore = new SessionStore(path.join(dataDir, "knowledge-config.json"));
await knowledgeConfigStore.load();
const projectOrderStore = new SessionStore(path.join(dataDir, "project-order.json"));
const featureStore = new SessionStore(path.join(dataDir, "features.json"));
await projectOrderStore.load();
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
if (profileService.setupNeeded()) console.log(`\nInstallation : ouvre Noyau et saisis ce code d'installation pour créer le compte administrateur :\n\n    ${accessToken}\n\n(Il reste aussi dans ${path.join(dataDir, "access-token")}.)\n`);
const biometricAuth = new BiometricAuthService({ file: path.join(dataDir, "biometric-devices.json"), profiles: profileService, secret: accessToken });
await biometricAuth.load();
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
const webPush = new PushService({ dataDir, defaultProfileId: primaryProfileId });
await webPush.load();
const nativePush = new NativePushService({ file: path.join(dataDir, "native-push-devices.json") });
await nativePush.load();
const backgroundAlerts = new BackgroundAlertService({ file: path.join(dataDir, "background-alerts.json") });
await backgroundAlerts.load();
const push = new NotificationGateway(webPush, nativePush, backgroundAlerts);
const todoService = new TodoService({
  file: process.env.NOYAU_TODO_FILE || path.join(dataDir, "TO DO.md"),
  mountUri: process.env.NOYAU_TODO_MOUNT_URI || null,
});
const agentArchiveService = new AgentArchiveService({ file: path.join(dataDir, "agent-archives.json") });
const boardService = new BoardService({ file: path.join(dataDir, "todo-boards.json") });
const trackingService = new TrackingService({ dir: path.join(dataDir, "tracking") });
const todoSeenService = new TodoSeenService({ file: path.join(dataDir, "todo-seen.json") });
const calendarService = new CalendarService({ storagePath: path.join(dataDir, "calendar-subscriptions.json") });
const voiceClients = new Set();

function broadcastVoice(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of voiceClients) {
    try { client.write(frame); } catch { voiceClients.delete(client); }
  }
}

const voiceService = new VoiceService({
  root,
  dataDir,
  listAgents: async () => {
    // Seules les sessions reellement vivantes sont pilotables a la voix.
    const live = await tmux.list().catch(() => []);
    return live
      .filter((session) => session.managed && session.name)
      .map((session) => ({ id: session.id, name: session.name }));
  },
  listProjects: () => Object.entries(projects.all()).map(([id, project]) => ({ id, name: project.name })),
  // La dictee ecrit dans le terminal ouvert sans valider: l'utilisateur relit avant d'envoyer.
  onDictation: async (dictated) => {
    broadcastVoice({ type: "action", action: dictated });
  },
  // Ce qui est entendu s'affiche pendant qu'on parle: on voit venir l'action avant qu'elle parte.
  onPartial: (partial) => {
    broadcastVoice({ type: "partial", partial });
  },
  onAction: async (action) => {
    broadcastVoice({ type: "action", action });
    if (action.action === "open-agent") await voiceService.say(`J'ouvre ${action.name}.`);
    else if (action.action === "open-project") await voiceService.say(`J'ouvre le projet ${action.name}.`);
    else if (action.action === "unknown") await voiceService.say("Je n'ai pas compris.");
    // Noyau orchestre: la demande part dans l'agent vise sans que l'utilisateur ouvre sa vue.
    else if (action.action === "send-agent") {
      try {
        await tmux.submit(action.id, action.text, { force: true });
        trackComposerPrompt(action.id, store.get(action.id)?.profileId || null, action.text);
        await voiceService.say(`C'est passé à ${action.name}.`);
      } catch {
        await voiceService.say(`Je n'ai pas pu écrire à ${action.name}.`);
      }
    } else if (action.action === "optimize") {
      try {
        await tmux.submit(action.id, optimizeCommand(store.get(action.id)?.assistant, action.mode), { force: true });
        await voiceService.say(action.mode === "clear" ? `${action.name} repart propre.` : `Je compacte ${action.name}.`);
      } catch {
        await voiceService.say(`Je n'ai pas pu alléger ${action.name}.`);
      }
    } else if (action.action === "restart") {
      const current = store.get(action.id);
      if (current && await restartWithSettings(action.id, current)) await voiceService.say(`Je relance ${action.name}.`);
      else await voiceService.say(`Je n'ai pas pu relancer ${action.name}.`);
    } else if (action.action === "interrupt" && action.id) {
      try {
        await interruptSession(action.id);
        await voiceService.say(`J'arrête ${action.name}.`);
      } catch {
        await voiceService.say(`Je n'ai pas pu arrêter ${action.name}.`);
      }
    }
  },
});
const usage = new UsageService({ providerState });
const projectLogos = new ProjectLogoService();
const migrations = new Map();
const notificationTestCursor = new Map();
// Presence: on sait quel appareil est aux commandes, et quel agent il regarde.
const presence = new DevicePresence();
function watchingSession(profileId, sessionId) { return presence.watching(profileId, sessionId); }
function activeDevice(profileId) { return presence.active(profileId); }
const weatherCache = new Map();
const moduleService = new ModuleService({
  workspaceRoot,
  store: moduleStore,
  listProjectAgents: async (projectId) => {
    const sessions = (await tmux.list()).filter((session) => session.projectId === projectId);
    return Promise.all(sessions.map(async (session) => {
      const metadata = store.get(session.id) || {};
      const pane = await tmux.capture(session.id);
      const status = agentStatus(session, metadata, promptWatcher.isWaiting(session.id), Date.now(), pane);
      return {
        id: session.id,
        name: session.name || session.id,
        state: status?.state || "unknown",
      };
    }));
  },
  submitAgent: async (sessionId, message) => {
    await tmux.submit(sessionId, message);
  },
  onActionComplete: async ({ module, action, result }) => {
    const profileId = projects.get(module.projectId)?.profileId || primaryProfileId;
    await push.send({
      title: `${module.name} · ${result.state === "success" ? "Terminé" : "Erreur"}`,
      body: result.state === "success" ? `${action.label} terminé.` : `${action.label}: ${result.output || "échec"}`,
      tag: `module-${module.id}-${action.id}`,
      url: `/?view=projects&profile=${encodeURIComponent(profileId)}`,
    }, profileId);
  },
  onBuildComplete: async ({ module, run }) => {
    const profileId = projects.get(module.projectId)?.profileId || primaryProfileId;
    const platformLabel = run.platform === "android" ? "APK" : "IPA";
    let title = `${module.name} · Build ${platformLabel}`;
    let body = "";
    if (run.state === "installed") {
      title = `${module.name} · Installé sur appareil`;
      body = run.output || `Build installé sur ${run.device?.serial || "l'appareil"}.`;
    } else if (run.state === "download-ready") {
      title = `${module.name} · APK prête`;
      body = run.output || "APK prête au téléchargement.";
    } else if (run.state === "installation-requested") {
      title = `${module.name} · IPA prête`;
      body = run.output || "IPA prête. Demande transmise à l'agent.";
    } else if (run.state === "error") {
      title = `${module.name} · Échec build ${platformLabel}`;
      body = run.output || "Erreur pendant la production du build.";
    } else {
      body = run.output || "Build terminé.";
    }
    await push.send({
      title,
      body,
      tag: `module-${module.id}-build`,
      url: `/?view=projects&profile=${encodeURIComponent(profileId)}`,
    }, profileId);
  },
});
const knowledgeService = new KnowledgeService({ configStore: knowledgeConfigStore });
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
const antigravityBinary = process.env.ANTIGRAVITY_BIN || (await firstCommandPath(["antigravity", "agy"]));
const handover = new HandoverService();
const agentMemory = new AgentMemoryService({ root: path.join(dataDir, "agent-memory"), store, handover, script: path.join(root, "scripts/noyau-agent.mjs") });
const tmux = new TmuxController({
  store,
  workspaceRoot,
  codexBinary,
  claudeBinary,
  antigravityBinary,
  antigravityArgs: (process.env.NOYAU_ANTIGRAVITY_ARGS || "").split(" ").filter(Boolean),
  agentSettingsRoot,
  launchRoot: dataDir,
  memory: agentMemory,
});
// Clients terminal ouverts par agent: on leur signale les messages automatiques retenus.
const terminalClients = new Map();
const inputGate = new InputGate({
  onChange: (id, pending) => {
    for (const client of terminalClients.get(id) || []) {
      if (client.readyState === client.OPEN) client.send(JSON.stringify({ type: "held", pending }));
    }
  },
});
tmux.inputGate = inputGate;
// `which` renvoie un chemin absolu quand l'outil est installe, sinon le nom brut.
const installedAssistants = {
  codex: path.isAbsolute(codexBinary),
  claude: path.isAbsolute(claudeBinary),
  "claude-design": path.isAbsolute(claudeBinary),
  antigravity: path.isAbsolute(antigravityBinary),
  shell: true,
};
const antigravityQuota = new AntigravityQuotaService({
  store: providerState,
  binary: installedAssistants.antigravity ? antigravityBinary : null,
  cwd: workspaceRoot,
});
const codexQuota = new CodexQuotaService({
  store: providerState,
  binary: installedAssistants.codex ? codexBinary : null,
  fallback: () => usage.latestCodexRateWindows(),
});
await tmux.applyScrollDefaults();
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

const localLlm = new LocalLlm({ dataDir });
const contextAudit = new ContextAudit({ localLlm });
// Le catalogue de la derniere analyse: on n'applique que ce qui a ete montre a l'ecran.
const auditCatalog = new Map();
const financeAdvisor = new FinanceAdvisor({ binary: codexBinary, claudeBinary, antigravityBinary: installedAssistants.antigravity ? antigravityBinary : null, cwd: root });
const todoTriage = new TodoTriage({ localLlm });
const textCorrector = new TextCorrector({ localLlm });
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
const MIGRATION_FALLBACK_MS = 90 * 1000;
const QUOTA_EXHAUSTED_PERCENT = 5;
const promptWatcher = new PromptWatcher({
  shouldNotify: (sessionId, profileId) => !watchingSession(profileId || primaryProfileId, sessionId),
  sessionDevice: (session) => activeDevice(session.profileId || primaryProfileId),
  tmux,
  push,
  sessionLabel: (session) => agentAlertTitle(session.projectId ? projects.get(session.projectId)?.name : null, session.name),
  sessionIcon: (sessionId) => notificationIcon(sessionId),
});
const quotaNotifier = new QuotaNotifier({
  push,
  providerState,
  profileService,
});
const codexCapacityRetry = new CodexCapacityRetry({ tmux, providerState });
const claudeDesignTool = new ClaudeDesignTool({ claudeBinary, store, projects, workspaceRoot: root });
const projectFilesService = new ProjectFilesService({ dataDir });
const fileSortService = new FileSortService({ dataDir });
setInterval(() => fileSortService.purgeAll().catch(() => {}), 6 * 60 * 60 * 1000).unref();
const agentCommunication = new AgentCommunicationService({ tmux, store, projects, handover, agentStatus, workspaceRoot: root, projectFiles: projectFilesService, memory: agentMemory });
const mapScanStore = new MapScanStore({ file: path.join(dataDir, "map-scan.json"), overridesFile: path.join(dataDir, "map-overrides.json"), providersFile: path.join(dataDir, "map-providers.json") });
await mapScanStore.load();
const LLM_PROXY_URL = process.env.NOYAU_LLM_PROXY_URL || "http://127.0.0.1:3001/v1/chat/completions";
// Fiches de la carte rédigées via llm-proxy (loopback, sans jeton): preuves = noms seulement.
async function mapSheetLlm(prompt) {
  const response = await fetch(LLM_PROXY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new Error(`llm-proxy ${response.status}`);
  const text = (await response.json())?.choices?.[0]?.message?.content || "";
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
const subagentReader = new SubagentReader();
const aiJobs = new AiJobs();
const CONTEXT_TRANSITION_MAX_MS = 3 * 60_000;
const agentMap = new AgentMapService({
  scanStore: mapScanStore,
  llm: mapSheetLlm,
  store,
  projects,
  tmux,
  archives: agentArchiveService,
  handover,
  moduleService,
  workspaceRoot,
  noyauRoot: root,
  run: (file, args, options = {}) => execFileAsync(file, args, { maxBuffer: 4 * 1024 * 1024, ...options }),
  agentState: async (session, metadata) => {
    const status = agentStatus(session, metadata, promptWatcher.isWaiting(session.id), Date.now(), await tmux.capture(session.id));
    return (metadata.transcriptPath && (await subagentReader.list(metadata.transcriptPath)).some((item) => item.running)) ? "working" : status?.state || null;
  },
  subagents: (metadata) => subagentReader.list(metadata.transcriptPath),
});
const autonomyEstimator = new AutonomyEstimator({ quota: (provider) => providerState.get(provider) });
const FAILED_NODE_TYPES = new Set(["service", "timer", "cron", "module"]);
const autonomousAgents = new AutonomousAgents({
  store,
  tmux,
  estimator: autonomyEstimator,
  isMigrating: (id) => migrations.has(id),
  sources: {
    modules: async (projectId, entry) => (scopedProjects(entry.profileId)[projectId] ? moduleService.failedModules([projectId]) : []),
    map: async (projectId, entry) => {
      const visibleProjects = scopedProjects(entry.profileId);
      if (!visibleProjects[projectId]) return [];
      const snapshot = await agentMap.snapshot({ projectId, window: "24h", visibleProjects, sessionVisible: (id) => sessionVisible(entry.profileId, id) });
      const foreign = projectId !== entry.projectId ? visibleProjects[projectId].name : null;
      return snapshot.nodes.filter((node) => node.status === "err" && FAILED_NODE_TYPES.has(node.type) && !node.archived).map((node) => ({ id: node.id, type: node.type, label: node.label, project: foreign }));
    },
    units: async (units) => {
      const failed = [];
      for (const scope of [["--user"], []]) {
        const { stdout } = await execFileAsync("/usr/bin/systemctl", [...scope, "show", ...units, "--no-pager", "--property=Id,ActiveState,Result"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
        for (const block of stdout.split(/\n\s*\n/)) {
          const fields = Object.fromEntries(block.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
          if (fields.Id && fields.ActiveState === "failed") failed.push({ id: fields.Id, result: fields.Result && fields.Result !== "success" ? fields.Result : null });
        }
      }
      return failed;
    },
  },
  agentBusy: async (id, metadata) => {
    const session = (await tmux.list()).find((item) => item.id === id);
    if (!session) return true;
    const pane = await tmux.capture(id).catch(() => "");
    if (agentStatus(session, metadata, promptWatcher.isWaiting(id), Date.now(), pane).state !== "available") return true;
    const subagents = metadata.transcriptPath ? await subagentReader.list(metadata.transcriptPath).catch(() => []) : [];
    return subagents.some((item) => item.running);
  },
  // Limite atteinte: le message partirait dans le vide.
  quotaBlocked: (entry) => {
    const quota = refreshExpiredQuota(providerState.get(entry.assistant));
    const windows = entry.assistant === "claude" ? [quota?.fiveHour, quota?.sevenDay] : quota?.windows || [];
    return windows.some((window) => window && window.remainingPercent === 0);
  },
  currentThread: async (id) => {
    const session = (await tmux.list()).find((item) => item.id === id);
    return session?.panePid ? usage.discoverCodexThread(session.panePid) : null;
  },
  notify: (entry, title, body) => push.send({ title, body, tag: `autonomy-${entry.agentId || "agent"}`, url: "/" }, entry.profileId),
});
let powerAgentSnapshot = null; let powerAgentSnapshotAt = 0;
const powerService = new PowerService({
  file: path.join(dataDir, "power-state.json"),
  agentWorkingChecker: async ({ fresh = false } = {}) => {
    if (!fresh && powerAgentSnapshot && Date.now() - powerAgentSnapshotAt < 20000) return powerAgentSnapshot;
    const sessions = await tmux.list();
    const states = await Promise.all(sessions.filter((session) => session.managed && session.assistant !== "shell").map(async (session) => {
      const metadata = store.get(session.id) || {};
      const pane = await tmux.captureVisible(session.id);
      if (!pane.trim()) return { id: session.id, name: session.name || session.assistant, state: "unknown" };
      return { id: session.id, name: session.name || session.assistant, state: agentStatus(session, metadata, promptWatcher.isWaiting(session.id), Date.now(), pane).state };
    }));
    powerAgentSnapshot = states.filter((item) => item.state !== "available"); powerAgentSnapshotAt = Date.now();
    return powerAgentSnapshot;
  },
});
setInterval(() => {
  powerService.tick().catch(() => {});
}, 60_000);
const hardwareService = new HardwareService();
const systemResources = new SystemResourcesService({
  listPanes: async () => {
    const { stdout } = await tmux.run(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]);
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [sessionId, pid] = line.split(" ");
      return { sessionId, pid: Number(pid) };
    });
  },
});
const OPTIMIZER_AGENT_NAME = "Optimisation PC";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 500);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const fileUpload = multer({
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const AUTO_SYNC_KEY = "auto-sync";

function parisNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function currentMonthParis() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}`;
}

const SAVINGS_ACCOUNT = /livret|\blep\b|\bldds?\b|\bpel\b|\bcel\b|epargne|épargne/i;
const INVESTED_ACCOUNT = /\bpea\b|assurance vie|compte titres|\btitres\b|bourse|\bper\b/i;

function financePayload(profileId, month = currentMonthParis()) {
  const runtime = profileRuntimes.get(profileId);
  if (!runtime) throw new Error("Profil finances indisponible.");
  const payload = runtime.financeService.payload(month);
  const status = runtime.enableBanking.status();
  const currentAccounts = status.connections.flatMap((connection) => connection.accounts
    .filter((account) => Number.isFinite(account.balance) && account.balanceType !== "OTHR" && !/carte|livret|\blep\b|\bpea\b|epargne|assurance vie|compte titres/i.test(account.name))
    .map((account) => ({ bank: connection.bankName, name: account.name, balance: account.balance, currency: account.currency, balanceAt: account.balanceAt })));
  const currentCash = Math.round(currentAccounts.reduce((total, account) => total + account.balance, 0) * 100) / 100;
  // Les livrets et placements suivent les soldes reels: un virement vers le LEP se voit sans saisie manuelle.
  const savingsAccounts = status.connections.flatMap((connection) => connection.accounts
    .filter((account) => Number.isFinite(account.balance) && account.balanceType !== "OTHR" && (SAVINGS_ACCOUNT.test(account.name) || INVESTED_ACCOUNT.test(account.name)))
    .map((account) => ({
      id: `bank-${connection.bankName}-${account.name}`.replace(/\s+/g, "-").toLowerCase(),
      name: account.name,
      institution: connection.bankName,
      amount: account.balance,
      bucket: INVESTED_ACCOUNT.test(account.name) ? "invested" : "liquid",
      balanceAt: account.balanceAt,
      source: "banque",
    })));
  const bankAssets = {
    liquid: Math.round(savingsAccounts.filter(({ bucket }) => bucket === "liquid").reduce((total, account) => total + account.amount, 0) * 100) / 100,
    invested: Math.round(savingsAccounts.filter(({ bucket }) => bucket === "invested").reduce((total, account) => total + account.amount, 0) * 100) / 100,
  };
  const manualAssets = payload.summary.assets.entries.filter((asset) => !savingsAccounts.some((account) => account.name.toLowerCase() === asset.name.toLowerCase()));
  const assetEntries = [...savingsAccounts, ...manualAssets];
  const assets = savingsAccounts.length
    ? {
        liquid: Math.round((bankAssets.liquid + manualAssets.filter(({ bucket }) => bucket === "liquid").reduce((total, asset) => total + asset.amount, 0)) * 100) / 100,
        invested: Math.round((bankAssets.invested + manualAssets.filter(({ bucket }) => bucket === "invested").reduce((total, asset) => total + asset.amount, 0)) * 100) / 100,
        total: Math.round(assetEntries.reduce((total, asset) => total + asset.amount, 0) * 100) / 100,
        entries: assetEntries,
        source: "banque",
      }
    : { ...payload.summary.assets, source: "modules" };
  // Ce qui est parti vers l'epargne ce mois-ci, transferts internes compris.
  const savedThisMonth = Math.round(payload.transactions
    .filter((item) => item.date.startsWith(month) && item.excluded && item.exclusionReason === "placement" && item.amount < 0)
    .reduce((total, item) => total + Math.abs(item.amount), 0) * 100) / 100;
  const expectedIncomeRemaining = month === currentMonthParis() ? Math.max(0, Math.round((payload.summary.inferredIncome - payload.summary.recordedSalary) * 100) / 100) : 0;
  const forecastBalance = Math.round((currentCash + expectedIncomeRemaining - payload.summary.remainingPlannedExpenses) * 100) / 100;
  const cashSafeToSpend = Math.max(0, Math.round((forecastBalance - payload.summary.safetyBuffer - payload.summary.protectedSavings) * 100) / 100);
  const safeToSpend = currentAccounts.length && month === currentMonthParis() ? Math.max(0, Math.min(cashSafeToSpend, payload.summary.safeToSpend)) : payload.summary.safeToSpend;
  const dailyAllowance = payload.summary.daysRemaining ? Math.round((safeToSpend / payload.summary.daysRemaining) * 100) / 100 : 0;
  const warnings = payload.summary.warnings.filter(({ id }) => id !== "safe-spend");
  if (payload.summary.income > 0 && safeToSpend === 0) warnings.push({ id: "safe-spend", tone: "danger", title: "Pause dépenses libres", detail: "Solde prévu réservé aux charges, imprévus et épargne soutenable." });
  const lastSyncAt = status.connections.map((connection) => connection.lastSyncAt).filter(Boolean).sort().at(-1) || null;
  return {
    ...payload,
    summary: { ...payload.summary, currentCash, currentAccounts, savingsAccounts, assets, savedThisMonth, expectedIncomeRemaining, forecastBalance, safeToSpend, dailyAllowance, warnings },
    banking: { ...payload.banking, status, lastSyncAt, autoSync: runtime.enableBanking.store.get(AUTO_SYNC_KEY) || null },
  };
}

function logoUrl(session, profileId = session.profileId || primaryProfileId) {
  if (!session.projectLogo) return null;
  const project = session.projectId ? projects.get(session.projectId) : null;
  const v = project?.updatedAt ? `&v=${encodeURIComponent(project.updatedAt)}` : "";
  return `/api/sessions/${encodeURIComponent(session.id)}/logo?profile=${encodeURIComponent(profileId)}${v}`;
}

async function setAgentState(sessionId, agentState) {
  const current = store.get(sessionId);
  if (!current || !["working", "available", "waiting"].includes(agentState)) return;
  await store.set(sessionId, { ...current, agentState, agentStateUpdatedAt: new Date().toISOString() });
}

function normalizeBudgetItem(item) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name || "").trim().slice(0, 100);
  if (!name) return null;
  const amount = Math.max(0, Math.round((Number(item.amount) || 0) * 100) / 100);
  const cadence = ["monthly", "yearly", "weekly", "once"].includes(item.cadence) ? item.cadence : "monthly";
  const kind = ["subscription", "recurring"].includes(item.kind) ? item.kind : "recurring";
  const category = String(item.category || (kind === "subscription" ? "Abonnement SaaS" : "Hébergement / Cloud")).trim().slice(0, 50);
  const billingDay = item.billingDay ? Math.min(31, Math.max(1, parseInt(item.billingDay, 10))) : null;
  const notes = String(item.notes || "").trim().slice(0, 200);
  const active = item.active !== false;
  const id = item.id && /^item-[a-z0-9-]+$/.test(item.id) ? item.id : `item-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const createdAt = item.createdAt || new Date().toISOString();
  return { id, name, amount, cadence, kind, category, billingDay, notes, active, createdAt };
}

function normalizeProjectBudget(raw) {
  if (!raw || typeof raw !== "object") return { items: [] };
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeBudgetItem).filter(Boolean) : [];
  return { items };
}

function projectPayload(id, project, profileId = project.profileId || primaryProfileId) {
  const owner = profileService.resolve(project.profileId);
  const v = project.updatedAt ? `&v=${encodeURIComponent(project.updatedAt)}` : "";
  return {
    id,
    ...project,
    budget: project.budget || { items: [] },
    canEdit: (project.profileId || primaryProfileId) === profileId,
    owner: { id: owner.id, name: owner.name },
    logoUrl: `/api/projects/${encodeURIComponent(id)}/logo?profile=${encodeURIComponent(project.profileId || primaryProfileId)}${v}`,
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
  // Suivi to-do actif par defaut: un projet existant garde son reglage tant qu'on n'y touche pas.
  const todoTracking = body?.todoTracking === undefined ? current.todoTracking !== false : Boolean(body.todoTracking);
  let logoPath = current.logoPath || null;
  if (body?.logoPath !== undefined) {
    if (body.logoPath === null || body.logoPath === "") {
      logoPath = null;
    } else {
      const resolvedLogo = path.resolve(String(body.logoPath));
      const stat = await fs.stat(resolvedLogo);
      if (!stat.isFile()) throw new Error("Fichier logo introuvable.");
      logoPath = resolvedLogo;
    }
  }
  const budget = body?.budget !== undefined ? normalizeProjectBudget(body.budget) : (current.budget || { items: [] });
  return { ...current, name, rootPath, shared, todoTracking, logoPath, budget, updatedAt: new Date().toISOString() };
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

function resolveFolderProjectId(folder, folderList) {
  let cur = folder;
  while (cur) {
    if (cur.projectId) return cur.projectId;
    cur = cur.parentId ? folderList.find((f) => f.id === cur.parentId) : null;
  }
  return null;
}

async function syncAndCleanForeignSharedProjects(profile, view, runtime) {
  const foreign = foreignSharedProjects(profile.id);
  if (!foreign.size) return { folders: [...view.folders], todos: [...view.todos] };

  const foreignProjectIds = new Set();
  for (const [, owned] of foreign) {
    for (const pid of owned.keys()) foreignProjectIds.add(pid);
  }

  // Dossiers orphelins locaux appartenant à un projet partagé distant
  const orphanLocalFolders = view.folders.filter((f) => {
    const pId = resolveFolderProjectId(f, view.folders);
    return pId && foreignProjectIds.has(pId);
  });

  const orphanFolderIds = new Set(orphanLocalFolders.map((f) => f.id));
  const localTasksToMigrate = view.todos.filter((t) =>
    orphanFolderIds.has(t.folderId) || (t.projectId && foreignProjectIds.has(t.projectId))
  );

  if (orphanLocalFolders.length > 0 || localTasksToMigrate.length > 0) {
    for (const [ownerId, owned] of foreign) {
      const ownerRuntime = await ensureProfileRuntime(ownerId);
      const ownerProjects = [...owned].map(([id, project]) => ({ id, name: project.name }));
      const ownerView = await ownerRuntime.todoService.syncProjectFolders(ownerProjects);

      for (const task of localTasksToMigrate) {
        const localFolder = orphanLocalFolders.find((f) => f.id === task.folderId);
        const pId = task.projectId || resolveFolderProjectId(localFolder, view.folders);
        if (!pId || !owned.has(pId)) continue;

        const exists = ownerView.todos.some((t) => t.id === task.id || t.text.trim().toLowerCase() === task.text.trim().toLowerCase());
        if (!exists) {
          let destFolderId = null;
          const ownerRootFolder = ownerView.folders.find((f) => f.projectId === pId && !f.parentId);
          const ownerSubFolders = ownerView.folders.filter((f) => f.parentId === ownerRootFolder?.id);

          if (localFolder && localFolder.name) {
            const cleanLocalName = localFolder.name.replace(/^[\p{Extended_Pictographic}\s]+/u, "").trim().toLowerCase();
            const matchedSub = ownerSubFolders.find((f) =>
              f.name.replace(/^[\p{Extended_Pictographic}\s]+/u, "").trim().toLowerCase() === cleanLocalName
            );
            if (matchedSub) destFolderId = matchedSub.id;
          }
          if (!destFolderId) {
            const isDesign = /design|graphisme|visuel|maquette|fond|octane|arrière-plan|bulle|perle|badge|logo|couleur|asset/i.test(task.text);
            if (isDesign) {
              let designSub = ownerSubFolders.find((f) => /design|graphisme|visuel/i.test(f.name));
              if (!designSub && ownerRootFolder) {
                const res = await ownerRuntime.todoService.addFolder({
                  name: "🎨 Design",
                  parentId: ownerRootFolder.id,
                  projectId: pId,
                });
                designSub = res.folders.find((f) => f.parentId === ownerRootFolder.id && /design/i.test(f.name));
                if (designSub) ownerSubFolders.push(designSub);
              }
              if (designSub) destFolderId = designSub.id;
            }
          }
          if (!destFolderId) {
            const devSub = ownerSubFolders.find((f) => /développement|dev/i.test(f.name));
            destFolderId = devSub ? devSub.id : ownerRootFolder?.id;
          }

          const { todo: added } = await ownerRuntime.todoService.add({
            text: task.text,
            dueDate: task.dueDate || null,
            priority: task.priority || "medium",
            status: task.status || "todo",
            folderId: destFolderId,
            projectId: pId,
            kind: task.kind || "user",
            author: task.author || profile.name,
          });
          if (task.comments && task.comments.length > 0) {
            await ownerRuntime.todoService.update(added.id, { comments: task.comments });
          }
        }
        await runtime.todoService.remove(task.id).catch(() => {});
      }

      for (const folder of orphanLocalFolders) {
        await runtime.todoService.removeFolder(folder.id, { force: true }).catch(() => {});
      }
    }
  }

  const cleanFolders = view.folders.filter((f) => {
    const pId = resolveFolderProjectId(f, view.folders);
    return !pId || !foreignProjectIds.has(pId);
  });
  const cleanFolderIds = new Set(cleanFolders.map((f) => f.id));
  const cleanTodos = view.todos.filter((t) =>
    cleanFolderIds.has(t.folderId) && (!t.projectId || !foreignProjectIds.has(t.projectId))
  );

  return { folders: cleanFolders, todos: cleanTodos };
}

async function todosView(profile) {
  const runtime = await ensureProfileRuntime(profile.id);
  const mine = ownedProjects(profile.id).map(([id, project]) => ({ id, name: project.name }));
  const view = await runtime.todoService.syncProjectFolders(mine);
  const clean = await syncAndCleanForeignSharedProjects(profile, view, runtime);
  const cleanTodos = clean.todos.map((t) => {
    const proj = t.projectId ? projects.get(t.projectId) : null;
    const isShared = t.shared === true || (Boolean(proj?.shared) && t.shared !== false);
    return { ...t, shared: isShared, ownerProfileId: profile.id, ownerName: profile.name };
  });
  const merged = { todos: cleanTodos, folders: [...clean.folders] };

  for (const [ownerId, owned] of foreignSharedProjects(profile.id)) {
    const ownerRuntime = await ensureProfileRuntime(ownerId);
    const owner = profileService.resolve(ownerId);
    const remote = await ownerRuntime.todoService.syncProjectFolders([...owned].map(([id, project]) => ({ id, name: project.name })));
    const sharedProjectIds = new Set([...owned.keys()]);
    const sharedFolderIds = new Set();
    // 1. Dossiers racines du projet
    remote.folders.forEach((f) => {
      if (f.projectId && sharedProjectIds.has(f.projectId)) sharedFolderIds.add(f.id);
    });
    // 2. Sous-dossiers transitifs à toute profondeur
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const f of remote.folders) {
        if (f.parentId && sharedFolderIds.has(f.parentId) && !sharedFolderIds.has(f.id)) {
          sharedFolderIds.add(f.id);
          expanded = true;
        }
      }
    }
    const shared = remote.folders.filter((folder) => sharedFolderIds.has(folder.id));
    const folderIds = new Set(shared.map((folder) => folder.id));
    merged.folders.push(...shared.map((folder) => ({
      ...folder,
      projectId: resolveFolderProjectId(folder, remote.folders),
      ownerProfileId: ownerId,
      ownerName: owner.name,
    })));
    merged.todos.push(...remote.todos.filter((todo) => {
      if (todo.shared === false) return false;
      return folderIds.has(todo.folderId) || (todo.projectId && sharedProjectIds.has(todo.projectId));
    }).map((t) => ({ ...t, shared: true, ownerProfileId: ownerId, ownerName: owner.name })));
  }

  // 3. Tâches partagées ou attribuées inter-profils hors projets partagés
  const existingTodoIds = new Set(merged.todos.map((t) => t.id));
  const otherProfiles = profileService.list().filter((p) => p.id !== profile.id);
  for (const other of otherProfiles) {
    const otherRt = await ensureProfileRuntime(other.id);
    const otherRemote = await otherRt.todoService.list();
    for (const t of otherRemote.todos) {
      if (existingTodoIds.has(t.id)) continue;
      existingTodoIds.add(t.id);
      merged.todos.push({
        ...t,
        shared: t.shared || t.assignee === "all" || t.assignee === "both",
        ownerProfileId: other.id,
        ownerName: other.name,
      });
    }
  }

  const boardSettings = await boardService.settings(profile.id);
  merged.columns = boardSettings.columns;
  merged.correction = boardSettings.correction;
  const reviewCol = boardSettings.columns?.find((c) => c.id === "review" || c.kind === "review");
  if (reviewCol && reviewCol.enabled === false) {
    for (const todo of merged.todos) {
      if (todo.status === "review") {
        todo.status = "done";
        todo.completed = true;
      }
    }
  }
  const seen = await todoSeenService.bootstrap(profile.id, merged.todos);
  merged.todos = todoSeenService.decorate(merged.todos, seen);
  merged.unread = totalTodoUnread(merged.todos);
  return merged;
}

async function todoRuntime(profile, { todoId = null, folderId = null, projectId = null }) {
  const foreign = foreignSharedProjects(profile.id);

  // 1. Si projectId explicitement fourni et projet partagé d'un autre profil:
  if (projectId) {
    for (const [ownerId, owned] of foreign) {
      if (owned.has(projectId)) {
        return await ensureProfileRuntime(ownerId);
      }
    }
  }

  // 2. Si folderId fourni, vérifier s'il appartient à un projet partagé distant:
  if (folderId && folderId !== "root") {
    for (const [ownerId, owned] of foreign) {
      const ownerRt = await ensureProfileRuntime(ownerId);
      const found = await ownerRt.todoService.folder(folderId);
      if (found) {
        let check = found;
        while (check) {
          if (check.projectId && owned.has(check.projectId)) return ownerRt;
          if (check.parentId) check = await ownerRt.todoService.folder(check.parentId);
          else break;
        }
      }
    }
  }

  // 3. Si todoId fourni: vérifier d'abord dans le profil courant, puis chez les autres profils
  if (todoId) {
    const ownRt = await ensureProfileRuntime(profile.id);
    const ownFound = await ownRt.todoService.find(todoId);
    if (ownFound) return ownRt;

    for (const [ownerId] of foreign) {
      const ownerRt = await ensureProfileRuntime(ownerId);
      const found = await ownerRt.todoService.find(todoId);
      if (found) return ownerRt;
    }

    const others = profileService.list().filter((p) => p.id !== profile.id);
    for (const other of others) {
      const otherRt = await ensureProfileRuntime(other.id);
      const found = await otherRt.todoService.find(todoId);
      if (found) return otherRt;
    }
  }

  // 4. Par défaut, runtime propre du profil:
  return await ensureProfileRuntime(profile.id);
}

// Un projet partage reste modifiable par son seul proprietaire, mais utilisable par tous.
function projectVisible(profileId, projectId) {
  const project = projects.get(projectId);
  return Boolean(project && (project.profileId === profileId || project.shared));
}

function sessionVisible(profileId, sessionId) {
  const session = store.get(sessionId);
  if (!session || !profileId) return false;
  if (session.profileId === profileId) return true;
  if (session.shared === true) return true;
  if (session.projectId && projectVisible(profileId, session.projectId)) return true;
  return false;
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
  archiveService: agentArchiveService,
  isMigrating: (id) => migrations.has(id),
  onReap: (id) => console.log(`Agent ${id} terminé: archivé et retiré des sessions actives.`),
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
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "") || (typeof request.query?.token === "string" ? request.query.token : "");
  if (bearer) {
    if (tokenMatches(bearer)) {
      request.sessionProfileId = primaryProfileId;
      request.masterAuthenticated = true;
      request.rawSessionToken = bearer;
      return true;
    }
    const verified = verifySessionToken(bearer, accessToken, SESSION_MAX_AGE_MS);
    if (verified && profileService.get(verified.profileId) && (!verified.biometricDeviceId || biometricAuth.active(verified.biometricDeviceId, verified.profileId))) {
      request.sessionProfileId = verified.profileId;
      request.rawSessionToken = bearer;
      return true;
    }
  }
  if (request.query?.grant) {
    const verified = verifyProjectFileGrant(buildGrantSecret, request.query.grant);
    if (verified) {
      request.sessionProfileId = verified.profileId;
      request.fileGrant = verified;
      return true;
    }
  }
  const cookie = parseCookies(request.headers.cookie).noyau_session;
  if (cookie) {
    const verified = verifySessionToken(cookie, accessToken, SESSION_MAX_AGE_MS);
    if (verified && profileService.get(verified.profileId) && (!verified.biometricDeviceId || biometricAuth.active(verified.biometricDeviceId, verified.profileId))) {
      request.sessionProfileId = verified.profileId;
      request.rawSessionToken = cookie;
      return true;
    }
  }
  return false;
}

function httpsOrigin(request) {
  if (!request.secure) {
    const error = new Error("HTTPS requis pour installer ou télécharger build sur appareil distant.");
    error.statusCode = 400;
    throw error;
  }
  const host = String(request.headers.host || "");
  if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)) {
    const error = new Error("Hôte HTTPS invalide.");
    error.statusCode = 400;
    throw error;
  }
  return `https://${host}`;
}

async function grantedBuild(request) {
  const grant = verifyBuildGrant(buildGrantSecret, request.params.grant);
  if (!grant || !moduleOwned(grant.profileId, grant.moduleId)) return null;
  const artifact = await moduleService.buildFile(grant.moduleId, grant.buildId).catch(() => null);
  if (!artifact) return null;
  return { grant, artifact, module: moduleService.get(grant.moduleId) };
}

function loopbackRequest(request) {
  const address = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const hostname = String(request.hostname || "").replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "::1"].includes(address) && ["127.0.0.1", "::1", "localhost"].includes(hostname);
}

const app = express();
const loginThrottle = createLoginThrottle();
const nativeWebSocketTickets = new NativeWebSocketTickets();
app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'",
  );
  if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use((request, response, next) => {
  if (request.secure || request.path === "/noyau-ca.cer" || request.path.startsWith("/api/hooks/")) return next();
  const host = String(request.headers.host || "");
  if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host)) return response.status(400).end();
  response.redirect(308, `https://${host}${request.originalUrl}`);
});
const BACKGROUND_AUTOMATED_PATHS = new Set([
  "/api/presence",
  "/api/system/hardware",
  "/api/system/resources",
  "/api/system/power",
  "/api/system/power/sleep",
  "/api/system/power/wake",
  "/api/system/power/schedule",
  "/api/system/activity",
  "/api/quotas",
  "/api/sessions",
  "/api/map",
  "/api/todos",
  "/api/weather",
  "/api/voice/status",
  "/api/agent-settings",
  "/api/version",
  "/version.json",
  "/sw.js",
]);

function isHumanActivity(request) {
  if (BACKGROUND_AUTOMATED_PATHS.has(request.path)) return false;
  if (request.path.startsWith("/api/system/power") || request.path.startsWith("/api/system/activity")) return false;
  if (request.path.startsWith("/assets/") || request.path.startsWith("/fonts/") || request.path.startsWith("/icons/") || request.path.startsWith("/backgrounds/")) {
    return false;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return true;
  }
  return false;
}

app.use((request, response, next) => {
  if (isHumanActivity(request)) {
    powerService.touchActivity();
    if (powerService.canWakeOnActivity()) {
      powerService.wakeUp().catch((error) => console.warn(`Réveil auto sur activité échoué: ${error.message}`));
    }
  }
  if (request.path === "/sw.js" || request.headers.accept?.includes("text/html")) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }
  next();
});
// Le Markdown brut des todos depasse largement 32 Ko: seule cette route accepte un gros corps.
const jsonBody = express.json({ limit: "32kb" });
const rawTodoBody = express.json({ limit: "4mb" });
const groceryBody = express.json({ limit: "512kb" });
const questionBody = express.json({ limit: "256kb" });
// Rapports de suivi: fichier encode en base64 dans le JSON (10 Mo max une fois decode).
const trackingReportBody = express.json({ limit: `${Math.ceil(MAX_REPORT_BYTES * 1.4 / 1024 / 1024)}mb` });
app.use((request, response, next) => (/^\/api\/(?:mobile\/)?groceries(?:\/|$)/.test(request.path) ? groceryBody : request.path === "/api/agent/question-status" ? questionBody : request.path === "/api/todos/raw" ? rawTodoBody : /^\/api\/projects\/[^/]+\/tracking\/[^/]+\/reports$/.test(request.path) && request.method === "POST" ? trackingReportBody : jsonBody)(request, response, next));
// The only remotely exposable mobile surface: a revocable, profile-bound grocery capability.
app.use("/api/mobile/groceries", publicGroceryRoutes(groceries));
// Avant le controle de session: l'app en arriere-plan releve ses alertes avec son seul jeton d'appareil.
app.get("/api/mobile/background-alerts/poll", (request, response) => {
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const result = backgroundAlerts.poll(token, request.query.after);
  response.set("Cache-Control", "no-store");
  if (!result) return response.status(401).json({ error: "Appareil non enregistré." });
  response.json(result);
});
app.use("/api/auth/biometric", biometricSessionRoutes({ service: biometricAuth, profiles: profileService, secret: accessToken, throttle: createLoginThrottle() }));

app.get("/api/auth/profiles", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({
    profiles: profileService.list().map(({ id, name, theme, primary, hasPassword }) => ({
      id,
      name,
      theme,
      primary,
      hasPassword,
    })),
    primaryProfileId,
    setupNeeded: profileService.setupNeeded(),
  });
});

// First admin of a fresh install. The setup code is the access key printed at startup:
// whoever reaches the port first must not become admin of a machine that runs agents.
app.post("/api/setup", async (request, response, next) => {
  try {
    const remote = String(request.socket.remoteAddress || "inconnu");
    const retryAfter = loginThrottle.retryAfter(remote);
    if (retryAfter) {
      response.setHeader("Retry-After", String(retryAfter));
      return response.status(429).json({ error: "Trop de tentatives. Réessaie plus tard.", retryAfter });
    }
    if (!profileService.setupNeeded()) return response.status(409).json({ error: "Installation déjà terminée." });
    if (!tokenMatches(request.body?.code)) {
      loginThrottle.fail(remote);
      return response.status(401).json({ error: "Code d'installation incorrect." });
    }
    loginThrottle.clear(remote);
    const profile = await profileService.completeSetup(request.body);
    const sessionToken = createSessionToken({ profileId: profile.id, issuedAt: Date.now() }, accessToken);
    response.setHeader("Set-Cookie", `noyau_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; ${request.secure ? "Secure" : ""}`);
    response.json({ ok: true, profile, token: sessionToken, expiresAt: Date.now() + SESSION_MAX_AGE_MS });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth", (request, response) => {
  const remote = String(request.socket.remoteAddress || "inconnu");
  const retryAfter = loginThrottle.retryAfter(remote);
  if (retryAfter) {
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({ error: "Trop de tentatives. Réessaie plus tard.", retryAfter });
  }

  const credential = request.body?.password || request.body?.token;
  const profileId = request.body?.profileId || null;
  const authenticatedProfile = profileService.authenticate(credential, profileId, accessToken);

  if (!authenticatedProfile) {
    loginThrottle.fail(remote);
    return response.status(401).json({ error: "Mot de passe ou clé incorrecte." });
  }

  loginThrottle.clear(remote);
  const sessionToken = createSessionToken({ profileId: authenticatedProfile.id, issuedAt: Date.now() }, accessToken);
  const remember = Boolean(request.body?.remember);
  const cookieMaxAge = remember ? `Max-Age=${SESSION_MAX_AGE_SECONDS}; ` : "";
  response.setHeader(
    "Set-Cookie",
    `noyau_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; ${cookieMaxAge}Secure`,
  );
  response.json({ ok: true, profile: authenticatedProfile, token: sessionToken, expiresAt: Date.now() + SESSION_MAX_AGE_MS });
});

app.post("/api/auth/switch", (request, response) => {
  const remote = String(request.socket.remoteAddress || "inconnu");
  const retryAfter = loginThrottle.retryAfter(remote);
  if (retryAfter) {
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({ error: "Trop de tentatives. Réessaie plus tard.", retryAfter });
  }

  const credential = request.body?.password || request.body?.token;
  const profileId = request.body?.profileId || null;
  if (!profileId) {
    return response.status(400).json({ error: "Identifiant de profil requis." });
  }

  const authenticatedProfile = profileService.authenticate(credential, profileId, accessToken);
  if (!authenticatedProfile) {
    loginThrottle.fail(remote);
    return response.status(401).json({ error: "Mot de passe incorrect pour ce profil." });
  }

  loginThrottle.clear(remote);
  const sessionToken = createSessionToken({ profileId: authenticatedProfile.id, issuedAt: Date.now() }, accessToken);
  response.setHeader(
    "Set-Cookie",
    `noyau_session=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure`,
  );
  response.json({ ok: true, profile: authenticatedProfile, token: sessionToken, expiresAt: Date.now() + SESSION_MAX_AGE_MS });
});

app.post("/api/logout", (_request, response) => {
  response.setHeader("Set-Cookie", "noyau_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
  response.json({ ok: true });
});

app.get("/api/auth/session", (request, response) => {
  const ok = authenticated(request);
  const profile = ok ? profileService.getPublic(request.sessionProfileId || primaryProfileId) : null;
  const token = ok && profile ? (request.rawSessionToken || createSessionToken({ profileId: profile.id, issuedAt: Date.now() }, accessToken)) : null;
  response.status(ok ? 200 : 401).json({ authenticated: ok, profile, token });
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
const MANIFEST_COLORS = { noyau: "#080b0a", "moving-castle": "#0f1119" };

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

app.get("/install/build/:grant/manifest.plist", async (request, response, next) => {
  try {
    const resolved = await grantedBuild(request);
    if (!resolved || resolved.artifact.platform !== "ios" || !resolved.module.deviceBuild?.ios) return response.status(404).end();
    const origin = httpsOrigin(request);
    const artifactUrl = `${origin}/install/build/${encodeURIComponent(request.params.grant)}/${encodeURIComponent(resolved.artifact.name)}`;
    response.setHeader("Cache-Control", "no-store");
    response.type("text/xml").send(iosInstallManifest({
      artifactUrl,
      bundleId: resolved.module.deviceBuild.ios.bundleId,
      bundleVersion: resolved.module.deviceBuild.ios.bundleVersion,
      title: resolved.module.deviceBuild.ios.title,
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/install/build/:grant/:filename", async (request, response, next) => {
  try {
    const resolved = await grantedBuild(request);
    if (!resolved || request.params.filename !== resolved.artifact.name) return response.status(404).end();
    response.setHeader("Cache-Control", "no-store");
    response.type(resolved.artifact.platform === "ios" ? "application/octet-stream" : "application/vnd.android.package-archive");
    response.download(resolved.artifact.file, resolved.artifact.name, { dotfiles: "allow" });
  } catch (error) {
    next(error);
  }
});

app.get("/download/project-file/:grant/:filename", async (request, response, next) => {
  try {
    const verified = verifyProjectFileGrant(buildGrantSecret, request.params.grant);
    if (!verified || verified.filename !== request.params.filename) return response.status(404).end();
    const filePath = await projectFilesService.getFilePath(verified.projectId, verified.filename);
    const stat = await fs.stat(filePath);
    const isInline = request.query.inline === "1" || request.query.inline === "true" || request.query.preview === "1";
    const disposition = isInline ? "inline" : "attachment";
    response.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(verified.filename)}"`);
    response.setHeader("Content-Length", stat.size);
    if (isInline) {
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.setHeader("Content-Security-Policy", "default-src 'self' blob: data:; script-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'");
    }
    const ext = path.extname(verified.filename).toLowerCase();
    if ([".md", ".markdown"].includes(ext)) {
      response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    } else if ([".csv", ".tsv"].includes(ext)) {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
    } else if ([".txt", ".log", ".env", ".sh", ".bash", ".zsh", ".conf", ".ini", ".toml", ".yml", ".yaml"].includes(ext)) {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    } else if ([".json"].includes(ext)) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    } else {
      response.type(ext || "application/octet-stream");
    }
    const stream = createReadStream(filePath);
    stream.on("error", next);
    stream.pipe(response);
  } catch (error) {
    next(error);
  }
});

// Icone de notification: le navigateur la telecharge hors session applicative, donc sans cle.
// On n'expose qu'une image (logo de projet ou icone d'agent), jamais de donnee de session.
app.get("/notification-icon/:id", async (request, response, next) => {
  try {
    const id = String(request.params.id).replace(/\.png$/, "");
    const session = validSessionId(id) ? store.get(id) : null;
    const file = session?.projectLogo
      ? (session.projectId ? await projectLogoFile(session.projectId) : null) || await projectLogos.find(session.cwd).catch(() => null)
      : null;
    response.setHeader("Cache-Control", "public, max-age=300");
    if (file) return response.sendFile(file);
    const fallback = assistantIcon(session?.assistant);
    if (!fallback) return response.status(404).end();
    response.sendFile(path.join(root, process.env.NODE_ENV === "production" ? "dist" : "public", fallback));
  } catch (error) {
    next(error);
  }
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
    const requestedId = request.headers["x-noyau-profile"] || request.query.profile;
    const profileId = request.masterAuthenticated ? (requestedId || request.sessionProfileId) : request.sessionProfileId;
    request.profile = profileService.resolve(profileId);
    request.profileRuntime = await ensureProfileRuntime(request.profile.id);
    next();
  } catch (error) {
    next(error);
  }
});

app.use("/api/groceries", groceryRoutes({ service: groceries, profile: (request) => request.profile.id }));
const biometricEnrollThrottle = createLoginThrottle();
app.get("/api/auth/biometric/devices", (request, response) => response.set("Cache-Control", "no-store").json({ devices: biometricAuth.list(request.profile.id) }));
app.post("/api/auth/biometric/devices", async (request, response, next) => {
  const remote = request.socket.remoteAddress || "unknown"; const retry = biometricEnrollThrottle.retryAfter(remote);
  if (retry) return response.status(429).set("Retry-After", String(retry)).json({ error: "Trop de tentatives. Réessayez plus tard." });
  try { const device = await biometricAuth.enroll(request.profile.id, request.body); biometricEnrollThrottle.clear(remote); response.set("Cache-Control", "no-store").status(201).json(device); }
  catch (error) { if (error.statusCode === 401) biometricEnrollThrottle.fail(remote); next(error); }
});
app.delete("/api/auth/biometric/devices/:id", async (request, response, next) => { try { await biometricAuth.revoke(request.profile.id, request.params.id); response.sendStatus(204); } catch (error) { next(error); } });
app.get("/api/mobile/releases", async (_request, response, next) => { try { response.json(await fs.readFile(path.join(dataDir, "mobile-releases.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return { android: null, ios: null }; throw error; })); } catch (error) { next(error); } });
app.get("/api/mobile/releases/:platform/file", (request, response, next) => sendMobileRelease(dataDir, request.params.platform, response, next));
app.post("/api/mobile/ws-ticket", async (request, response, next) => {
  try {
    const target = String(request.body?.path || ""); const match = target.match(/^\/ws\/terminal\/([a-zA-Z0-9_-]{1,80})$/);
    if (target !== "/ws/voice" && (!match || !sessionVisible(request.profile.id, match[1]))) throw new Error("Session mobile inaccessible.");
    response.set("Cache-Control", "no-store").json(nativeWebSocketTickets.issue(request.profile.id, target));
  } catch (error) { next(error); }
});
app.get("/api/mobile/push-status", (request, response) => response.json({ configured: nativePush.status(), devices: nativePush.devices(request.profile.id).map(({ token, ...device }) => device), backgroundDevices: backgroundAlerts.devices(request.profile.id).length }));
app.post("/api/mobile/background-alerts", async (request, response, next) => { try { response.set("Cache-Control", "no-store").status(201).json(await backgroundAlerts.register(request.profile.id, request.body || {})); } catch (error) { next(error); } });
app.delete("/api/mobile/background-alerts", async (request, response, next) => { try { await backgroundAlerts.unregister(request.profile.id, request.body?.deviceId); response.sendStatus(204); } catch (error) { next(error); } });
app.post("/api/mobile/push", async (request, response, next) => { try { await nativePush.subscribe(request.profile.id, request.body || {}); response.sendStatus(204); } catch (error) { next(error); } });
app.delete("/api/mobile/push", async (request, response, next) => { try { await nativePush.unsubscribe(request.profile.id, request.body?.deviceId); response.sendStatus(204); } catch (error) { next(error); } });
app.get("/api/groceries/devices", (request, response) => response.json({ devices: groceries.devices(request.profile.id) }));
app.post("/api/groceries/devices", async (request, response, next) => { try { response.status(201).json(await groceries.addDevice(request.profile.id, request.body?.name)); } catch (error) { next(error); } });
app.delete("/api/groceries/devices/:id", async (request, response, next) => { try { await groceries.revokeDevice(request.profile.id, request.params.id); response.sendStatus(204); } catch (error) { next(error); } });
app.post("/api/groceries/share", async (request, response, next) => { try {
  if (request.profile.id !== primaryProfileId) return response.status(403).json({ error: "Seul le profil principal peut partager Courses." });
  const memberId = String(request.body?.profileId || ""); if (!profileService.get(memberId)) return response.status(404).json({ error: "Profil introuvable." });
  response.json(await groceries.shareProfiles(primaryProfileId, memberId));
} catch (error) { next(error); } });
app.get("/api/groceries/import-jobs", (request, response) => response.set("Cache-Control", "no-store").json({ jobs: recipeImportJobs.list(request.profile.id) }));
app.post("/api/groceries/import-jobs", async (request, response, next) => { try { response.status(202).json({ job: await recipeImportJobs.enqueue(request.profile.id, request.body?.url) }); } catch (error) { next(error); } });
app.get("/api/groceries/import-jobs/:id", (request, response) => { const job = recipeImportJobs.get(request.profile.id, request.params.id); if (!job) return response.status(404).json({ error: "Import introuvable." }); return response.set("Cache-Control", "no-store").json({ job }); });
app.delete("/api/groceries/import-jobs/:id", async (request, response, next) => { try { if (!await recipeImportJobs.remove(request.profile.id, request.params.id)) return response.status(404).json({ error: "Import introuvable." }); response.sendStatus(204); } catch (error) { next(error); } });
app.post("/api/groceries/import-jobs/:id/retry", async (request, response, next) => { try { if (!await recipeImportJobs.retry(request.profile.id, request.params.id)) return response.status(400).json({ error: "Import non réessayable." }); response.json({ ok: true }); } catch (error) { next(error); } });
app.post("/api/groceries/recipe-import", async (request, response, next) => { try { response.json(await groceries.importRecipe(request.body?.url)); } catch (error) { next(error); } });
app.post("/api/groceries/product-page", async (request, response, next) => { try { response.json(await groceries.publicProduct(request.body?.url, request.body?.storeId)); } catch (error) { next(error); } });

app.get("/api/config", (_request, response) => response.json({ workspaceRoot, modules: resolveModules(featureStore.get("modules")) }));
app.put("/api/config/modules", async (request, response, next) => {
  try {
    // Reglage de toute l'instance: reserve au profil principal.
    if (request.profile?.id !== primaryProfileId) throw new Error("Seul le profil principal peut changer les modules.");
    const modules = sanitizeModules(request.body?.modules, resolveModules(featureStore.get("modules")));
    await featureStore.set("modules", modules);
    response.json({ modules });
  } catch (error) {
    next(error);
  }
});

app.post("/api/presence", (request, response) => {
  const deviceId = String(request.body?.deviceId || "").slice(0, 64);
  const sessionId = validSessionId(String(request.body?.sessionId || "")) ? request.body.sessionId : null;
  presence.update(request.profile.id, deviceId, sessionId, request.body?.visible !== false);
  // Ecran distant ouvert = quelqu'un lit. Le kiosque local reste allume sans personne devant: il ne compte pas.
  if (request.body?.visible !== false && !loopbackRequest(request)) powerService.touchClient();
  response.status(204).end();
});

app.get("/api/profiles", (request, response) => {
  response.json({ profiles: profileService.list(), activeProfileId: request.profile.id, primaryProfileId });
});

app.post("/api/profiles", async (request, response, next) => {
  try {
    if (request.profile.id !== primaryProfileId) return response.status(403).json({ error: "Réservé au profil administrateur." });
    const profile = await profileService.create(request.body);
    await ensureProfileRuntime(profile.id);
    response.status(201).json({ profile });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/profiles/:id", async (request, response, next) => {
  try {
    if (request.profile.id !== request.params.id && request.profile.id !== primaryProfileId) {
      throw new Error("Bascule sur profil avant modification.");
    }
    const profile = await profileService.update(request.params.id, request.body);
    resetProfileTodo(profile.id);
    response.json({ profile });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/profiles/:id", async (request, response, next) => {
  try {
    if (request.profile.id !== primaryProfileId) return response.status(403).json({ error: "Réservé au profil administrateur." });
    await profileService.remove(request.params.id);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/profiles/:id/password", async (request, response, next) => {
  try {
    if (request.profile.id !== request.params.id && request.profile.id !== primaryProfileId) {
      throw new Error("Bascule sur profil avant modification du mot de passe.");
    }
    const { password } = request.body || {};
    const profile = await profileService.setPassword(request.params.id, password);
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

app.post("/api/system/activity", (_request, response) => {
  powerService.touchActivity();
  if (powerService.canWakeOnActivity()) {
    powerService.wakeUp().catch((error) => console.warn(`Réveil auto sur activité échoué: ${error.message}`));
  }
  response.json({ ok: true, active: true });
});

app.get("/api/system/hardware", async (_request, response, next) => {
  try {
    response.json(await hardwareService.read());
  } catch (error) {
    next(error);
  }
});

function resourceSessions(profileId) {
  return Object.entries(store.all ? store.all() : {}).map(([id, value]) => {
    if (!sessionVisible(profileId, id)) return { id, name: "Agent privé", killable: false };
    return {
      id,
      name: value?.name || id,
      projectName: value?.projectId ? projects.get(value.projectId)?.name || null : null,
      assistant: value?.assistant || null,
      killable: sessionOwned(profileId, id) && !value?.core,
    };
  });
}

async function listPanePids(sessionId) {
  const { stdout } = await tmux.run(["list-panes", "-s", "-t", `=${sessionId}:`, "-F", "#{pane_pid}"]).catch(() => ({ stdout: "" }));
  return stdout.split("\n").map(Number).filter((pid) => pid > 1);
}

// TERM puis KILL sur ce qui survit; le serveur Noyau et sa lignee ne sont jamais vises.
async function terminateProcesses(pids) {
  const protectedPids = ancestors(await processTable(), process.pid);
  const targets = [...pids].filter((pid) => pid > 1 && !protectedPids.has(pid));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const pid of targets) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const survivors = targets.filter(alive);
  for (const pid of survivors) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return { signalled: targets.length, forced: survivors.length };
}

app.get("/api/system/resources", async (request, response, next) => {
  try {
    response.json(await systemResources.read({ sessions: resourceSessions(request.profile.id) }));
  } catch (error) {
    next(error);
  }
});

// Confie l'analyse a un agent dedie: il diagnostique librement mais doit demander avant tout arret.
app.post("/api/system/resources/optimize", async (request, response, next) => {
  try {
    const snapshot = await systemResources.read({ sessions: resourceSessions(request.profile.id) });
    const prompt = request.body?.focus === "swap" ? swapPrompt(snapshot) : optimizationPrompt(snapshot);
    const agents = await agentCommunication.list({ profileId: request.profile.id });
    const existing = agents.find((agent) => agent.name === OPTIMIZER_AGENT_NAME);
    if (existing) {
      await agentCommunication.send(existing.id, { message: `Nouvel instantané à analyser.\n\n${prompt}`, callerName: "Tableau de bord", profileId: request.profile.id });
      return response.json({ agentId: existing.id, reused: true });
    }
    // Sans rootPath, path.resolve("") vaut le cwd (= root): il faut l'exclure sinon le premier projet sans dossier gagne.
    const profileProjects = Object.entries(projects.all ? projects.all() : {}).filter(([, project]) => project.profileId === request.profile.id);
    const noyauProject = profileProjects.find(([, project]) => project.rootPath && path.resolve(project.rootPath) === root)
      || profileProjects.find(([, project]) => project.name?.trim().toLowerCase() === "noyau");
    const result = await agentCommunication.create({
      name: OPTIMIZER_AGENT_NAME,
      assistant: "claude",
      projectId: noyauProject?.[0] || null,
      cwd: os.homedir(),
      prompt,
      description: "Analyse CPU/GPU/RAM et propose des optimisations, sans rien arrêter sans confirmation.",
      callerName: "Tableau de bord",
      profileId: request.profile.id,
    });
    response.status(201).json({ agentId: result.agent.id, reused: false });
  } catch (error) {
    next(error);
  }
});

// Libere la RAM: archive la session Noyau (restaurable) puis tue tout son arbre de processus,
// y compris ce qui s'est detache de tmux. Une session hors Noyau est simplement tuee.
app.post("/api/system/resources/kill", async (request, response, next) => {
  try {
    const sessionId = request.body?.sessionId ? String(request.body.sessionId) : null;
    const pid = Number(request.body?.pid) || null;
    if (sessionId) {
      if (!sessionOwned(request.profile.id, sessionId)) throw new Error("Agent appartient à autre profil.");
      const current = store.get(sessionId);
      if (!current) throw new Error("Session Noyau introuvable.");
      if (current.core) throw new Error("Agent de base du Noyau: non archivable.");
      const { kill, spared } = await sessionProcesses(await processTable(), sessionId, await listPanePids(sessionId));
      const archived = await archiveSession(sessionId, current);
      const result = await terminateProcesses(kill);
      return response.json({ archived: Boolean(archived), name: current.name, spared, ...result });
    }
    if (pid) {
      const table = await processTable();
      const proc = table.get(pid);
      if (!proc || !AGENT_BINARY.test(proc.name)) throw new Error("Processus introuvable ou pas une session IA.");
      const panePids = new Set((await systemResources.listPanes()).map((pane) => pane.pid));
      if ([...ancestors(table, pid)].some((p) => panePids.has(p))) throw new Error("Session gérée par Noyau: archive-la via son agent.");
      const result = await terminateProcesses(descendants(table, [pid]));
      return response.json({ archived: false, name: proc.name, ...result });
    }
    throw new Error("sessionId ou pid requis.");
  } catch (error) {
    next(error);
  }
});

app.get("/api/system/power", async (_request, response, next) => {
  try {
    response.json(await powerService.getStatus());
  } catch (error) {
    next(error);
  }
});

function primaryProfileOnly(request, response, next) {
  if (request.profile.id !== primaryProfileId) return response.status(403).json({ error: "Commande réservée au profil principal." });
  next();
}


app.post("/api/system/power/sleep", primaryProfileOnly, async (request, response) => {
  try {
    const force = request.body?.force === true;
    const result = await powerService.enterSleep({ force });
    response.json(result);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/system/power/wake", primaryProfileOnly, async (_request, response) => {
  try {
    const result = await powerService.wakeUp();
    response.json(result);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.patch("/api/system/power/schedule", primaryProfileOnly, async (request, response) => {
  try {
    const schedule = await powerService.updateSchedule(request.body || {});
    response.json({ schedule });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get("/api/system/ssh-key", primaryProfileOnly, async (_request, response) => {
  try {
    const authKeysPath = path.join(os.homedir(), ".ssh", "authorized_keys");
    let count = 0;
    try {
      const content = await fs.readFile(authKeysPath, "utf8");
      count = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).length;
    } catch {}
    response.json({ count });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/system/ssh-key", primaryProfileOnly, async (request, response) => {
  try {
    const rawKey = String(request.body?.publicKey || "").trim();
    if (!rawKey) return response.status(400).json({ error: "Clé publique SSH requise." });

    const validPrefixes = [
      "ssh-ed25519",
      "ssh-rsa",
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "sk-ssh-ed25519@openssh.com",
      "sk-ecdsa-sha2-nistp256@openssh.com",
    ];
    const lines = rawKey.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const validKeys = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && validPrefixes.includes(parts[0])) {
        validKeys.push(line);
      }
    }
    if (!validKeys.length) {
      return response.status(400).json({
        error: "Format de clé SSH invalide. La clé doit commencer par ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp...",
      });
    }

    const sshDir = path.join(os.homedir(), ".ssh");
    const authKeysPath = path.join(sshDir, "authorized_keys");
    await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });

    let existingContent = "";
    try {
      existingContent = await fs.readFile(authKeysPath, "utf8");
    } catch {}

    const existingLines = existingContent.split("\n").map((l) => l.trim()).filter(Boolean);
    const added = [];
    for (const k of validKeys) {
      const kParts = k.split(/\s+/);
      const isAlreadyPresent = existingLines.some((existing) => {
        const eParts = existing.split(/\s+/);
        return eParts[0] === kParts[0] && eParts[1] === kParts[1];
      });
      if (!isAlreadyPresent) {
        added.push(k);
      }
    }

    if (added.length) {
      const newContent = (existingContent.trimEnd() ? existingContent.trimEnd() + "\n" : "") + added.join("\n") + "\n";
      await fs.writeFile(authKeysPath, newContent, { mode: 0o600 });
      await fs.chmod(authKeysPath, 0o600).catch(() => {});
    }

    response.json({ ok: true, added: added.length, total: existingLines.length + added.length });
  } catch (error) {
    response.status(500).json({ error: error.message });
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

app.patch("/api/finance/transactions/:id", async (request, response, next) => {
  try {
    await request.profileRuntime.financeService.assignTransactionAsset(request.params.id, request.body?.assetId || null);
    response.json({ finance: financePayload(request.profile.id, request.body?.month || currentMonthParis()) });
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
    const entries = [["claude", claudeQuota.refresh()], ["antigravity", antigravityQuota.refresh()], ["codex", codexQuota.refresh()]];
    const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
    const refreshed = Object.fromEntries(settled.map((result, index) => {
      const provider = entries[index][0];
      if (result.status === "fulfilled") return [provider, { ok: true, source: result.value?.source || "live" }];
      console.error(`Quota ${provider}: ${result.reason?.message || "échec"}`);
      return [provider, { ok: false, error: result.reason?.message || "Relevé impossible." }];
    }));
    void quotaNotifier.check().catch(() => {});
    const codex = providerState.get("codex");
    response.json({
      quotas: {
        codex: codex?.windows?.length
          ? refreshExpiredQuota({ remainingPercent: codex.windows[0].remainingPercent, resetsAt: codex.windows[0].resetsAt, windowMinutes: codex.windows[0].windowMinutes, windows: codex.windows, updatedAt: codex.updatedAt, source: codex.source })
          : null,
        claude: refreshExpiredQuota(providerState.get("claude")) || null,
        antigravity: refreshExpiredQuota(providerState.get("antigravity")) || null,
      },
      refreshed,
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
    if (quota) {
      await providerState.set("claude", quota);
      void quotaNotifier.check().catch(() => {});
    }
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", (request, response) => {
  const entries = Object.entries(scopedProjects(request.profile.id));
  const list = sortProjects(entries, projectOrderStore.get(request.profile.id)?.ids).map(([id, project]) => projectPayload(id, project, request.profile.id));
  response.json({ projects: list });
});

app.patch("/api/projects/order", async (request, response, next) => {
  try {
    const entries = Object.entries(scopedProjects(request.profile.id));
    const ids = normalizeProjectOrder(entries.map(([id]) => id), request.body?.ids);
    if (ids.length > 200 || ids.some((id) => !PROJECT_PATTERN.test(id))) throw new Error("Ordre projets invalide.");
    await projectOrderStore.set(request.profile.id, { ids, updatedAt: new Date().toISOString() });
    response.json({ projects: sortProjects(entries, ids).map(([id, project]) => projectPayload(id, project, request.profile.id)) });
  } catch (error) {
    next(error);
  }
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

app.get("/api/voice", async (_request, response, next) => {
  try {
    response.json({ ...voiceService.state(), installed: await voiceService.installed() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/start", async (_request, response, next) => {
  try {
    response.json({ ...(await voiceService.start()), installed: await voiceService.installed() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/stop", async (_request, response, next) => {
  try {
    response.json(voiceService.stop());
  } catch (error) {
    next(error);
  }
});

// Utile sans parler: rejoue une phrase comme si le micro l'avait entendue.
app.post("/api/voice/dictation", async (request, response, next) => {
  try {
    const sessionId = String(request.body?.sessionId || "");
    const enabled = request.body?.enabled !== false;
    if (enabled && !sessionOwned(request.profile.id, sessionId)) throw new Error("Agent appartient à autre profil.");
    const state = enabled ? await voiceService.startDictation(sessionId) : voiceService.stopDictation();
    broadcastVoice({ type: "state", state });
    response.json({ ...state, installed: await voiceService.installed() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/simulate", async (request, response, next) => {
  try {
    const command = await voiceService.handle(String(request.body?.text || ""));
    response.json({ command, state: voiceService.state() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/alias", async (request, response, next) => {
  try {
    await voiceService.loadAliases();
    const aliases = await voiceService.addAlias(request.body?.name, request.body?.heard);
    response.json({ aliases });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice/say", async (request, response, next) => {
  try {
    response.json({ spoken: await voiceService.say(request.body?.text) });
  } catch (error) {
    next(error);
  }
});

// Flux d'evenements vocaux: l'interface suit la voix sans interroger le serveur en boucle.
app.get("/api/voice/events", (request, response) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(`data: ${JSON.stringify({ type: "hello", state: voiceService.state() })}\n\n`);
  voiceClients.add(response);
  const beat = setInterval(() => { try { response.write(": ping\n\n"); } catch { /* client parti */ } }, 25_000);
  request.on("close", () => { clearInterval(beat); voiceClients.delete(response); });
});

app.get("/api/todos", async (request, response, next) => {
  try {
    const view = await todosView(request.profile);
    response.json({ ...view, storage: request.profile.todoMountUri ? "Obsidian · NAS" : "Obsidian · profil local" });
  } catch (error) {
    next(new Error(`Vault Obsidian indisponible: ${error.message}`));
  }
});

app.get("/api/todos/raw", async (request, response, next) => {
  try {
    const runtime = await ensureProfileRuntime(request.profile.id);
    const raw = await runtime.todoService.readRaw();
    response.json({ raw, storage: request.profile.todoMountUri ? "Obsidian · NAS" : "Obsidian · profil local" });
  } catch (error) {
    next(new Error(`Vault Obsidian indisponible: ${error.message}`));
  }
});

app.put("/api/todos/raw", async (request, response, next) => {
  try {
    if (typeof request.body?.raw !== "string") throw new Error("Contenu markdown requis.");
    const raw = request.body.raw;
    const runtime = await ensureProfileRuntime(request.profile.id);
    await runtime.todoService.saveRaw(raw);
    const view = await todosView(request.profile);
    response.json({ raw, ...view, storage: request.profile.todoMountUri ? "Obsidian · NAS" : "Obsidian · profil local" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos", async (request, response, next) => {
  try {
    const projectId = request.body?.projectId || null;
    if (projectId && !projectVisible(request.profile.id, projectId)) throw new Error("Projet introuvable.");
    const folderId = request.body?.folderId || null;
    const rawText = String(request.body?.text || "");
    const { correction } = await boardService.settings(request.profile.id);
    const byAgent = request.body?.authorKind === "agent" || request.body?.kind === "agent";
    const author = byAgent ? String(request.body?.author || "Agent").slice(0, 50) : request.profile?.name || null;
    const runtime = await todoRuntime(request.profile, { folderId, projectId });
    let status = request.body?.status || "todo";
    if (status === "review") {
      const { columns } = await boardService.settings(request.profile.id);
      const reviewCol = columns?.find((c) => c.id === "review" || c.kind === "review");
      if (reviewCol && reviewCol.enabled === false) {
        status = "done";
      }
    }
    const projectObj = projectId ? projects.get(projectId) : null;
    const defaultShared = Boolean(projectObj?.shared);
    const assignee = request.body?.assignee || null;
    const isBoth = assignee === "all" || assignee === "both";
    const shared = request.body?.shared !== undefined ? Boolean(request.body.shared) : (isBoth || defaultShared);
    const { todo } = await runtime.todoService.add({
      text: rawText,
      dueDate: request.body?.dueDate || null,
      priority: request.body?.priority !== undefined ? request.body.priority : "medium",
      status,
      projectId,
      folderId,
      kind: byAgent ? "agent" : "user",
      author,
      shared,
      assignee,
    });
    if (!byAgent) {
      await todoSeenService.mark(request.profile.id, todo.id);
    }
    response.status(201).json({ todo, ...(await todosView(request.profile)) });

    // Correction LLM en tâche de fond pour un ajout immédiat sans attente
    if (correction && !byAgent && rawText.trim()) {
      (async () => {
        try {
          const corrected = await textCorrector.correct(rawText, { context: "todo" });
          if (corrected && corrected.trim() && corrected.trim() !== rawText.trim()) {
            await runtime.todoService.update(todo.id, { text: corrected.trim() });
          }
        } catch {}
      })();
    }
  } catch (error) {
    next(error);
  }
});

// Tri d'une demande utilisateur par le modele local: cree la tache, ou commente
// celle qui existe deja. Le travail se fait en fond, l'agent n'a rien a porter.
// Une meme demande peut arriver par le hook de l'agent et par le composeur de Noyau.
const triagedPrompts = new Map();
const TRIAGE_MEMORY = 5 * 60_000;

function alreadyTriaged(sessionId, text) {
  const key = `${sessionId || ""}:${text.replace(/\s+/g, " ").trim().slice(0, 400)}`;
  const now = Date.now();
  for (const [entry, at] of triagedPrompts) if (now - at > TRIAGE_MEMORY) triagedPrompts.delete(entry);
  if (triagedPrompts.has(key)) return true;
  triagedPrompts.set(key, now);
  return false;
}

// Ce qui part du composeur de Noyau vaut demande, quel que soit l'agent:
// Codex et Antigravity n'ont pas de hook de prompt, leurs demandes se perdaient.
function trackComposerPrompt(sessionId, profileId, text) {
  const session = store.get(sessionId);
  if (!session || session.assistant === "shell" || session.todoTracking === false) return;
  const projectId = session.projectId || null;
  if (projectId && projects.get(projectId)?.todoTracking === false) return;
  const clean = String(text || "").trim();
  if (!clean || clean.startsWith("/") || clean.length > 12000) return;
  if (alreadyTriaged(projectId || sessionId, clean)) return;
  queuePromptTriage(profileService.resolve(profileId), clean, projectId);
}

// Fin de tour: l'agent coche lui-meme ce que sa reponse declare livre, le fondateur n'a pas a repasser.
async function closeFinishedTodos(metadata, reply) {
  if (!metadata?.projectId || metadata.todoTracking === false || projects.get(metadata.projectId)?.todoTracking === false) return;
  const profile = profileService.resolve(metadata.profileId || primaryProfileId);
  const view = await todosView(profile);
  const candidates = autoCloseCandidates(view.todos, metadata.projectId);
  const finished = await finishedTodos({ todos: candidates, reply });
  if (!finished.length) return;
  const { columns } = await boardService.settings(profile.id);
  const status = columns?.find((column) => column.id === "review" || column.kind === "review")?.enabled === false ? "done" : "review";
  for (const { id, evidence } of finished) {
    const runtime = await todoRuntime(profile, { todoId: id });
    await runtime.todoService.addComment(id, { text: `Coché à la fin du tour : ${evidence}`, author: metadata.name || "Agent", kind: "agent" });
    await runtime.todoService.update(id, { status });
  }
}

// Tri d'une demande: le modele local decide, Noyau ecrit la tache. Vaut pour tout agent.
function queuePromptTriage(profile, text, projectId) {
    return todoTriage.enqueue(async () => {
      try {
        const view = await todosView(profile);
        const rootFolder = projectId ? view.folders.find((item) => item.projectId === projectId && !item.parentId) : null;
        if (projectId && !rootFolder) throw new Error("Dossier projet introuvable.");

        // Sous-dossiers pertinents du projet ou tous les dossiers utilisateur
        const candidateFolders = projectId
          ? view.folders.filter((f) => f.parentId === rootFolder.id || (f.projectId === projectId && f.id !== rootFolder.id))
          : view.folders.filter((f) => f.id !== "root");

        const scoped = view.todos.filter((todo) => {
          if (projectId) {
            return todo.projectId === projectId || todo.folderId === rootFolder.id || candidateFolders.some((cf) => cf.id === todo.folderId);
          }
          return !todo.projectId;
        });

        const verdict = await todoTriage.triage(text, scoped, candidateFolders);
        if (!verdict.follow) return;

        // Résolution du dossier cible: sous-dossier identifié par le modèle, ou dossier racine
        let targetFolderId = rootFolder?.id || null;
        if (verdict.folderTarget && candidateFolders.length > 0) {
          const needle = verdict.folderTarget.toLowerCase();
          const matched = candidateFolders.find((f) =>
            f.id === verdict.folderTarget ||
            f.name.toLowerCase() === needle ||
            f.name.toLowerCase().includes(needle) ||
            needle.includes(f.name.toLowerCase())
          );
          if (matched) {
            targetFolderId = matched.id;
          }
        }

        const runtime = verdict.duplicate
          ? await todoRuntime(profile, { todoId: verdict.duplicate.id })
          : await todoRuntime(profile, { folderId: targetFolderId, projectId });

        if (verdict.duplicate) {
          const userPrompt = text.slice(0, 220);
          await runtime.todoService.addComment(verdict.duplicate.id, {
            text: userPrompt,
            author: profile?.name || "Utilisateur",
            kind: "user",
          });
          return;
        }
        const added = await runtime.todoService.add({
          text: verdict.title,
          folderId: targetFolderId,
          projectId,
          status: "todo",
          kind: "user",
          author: profile?.name || "Utilisateur",
          priority: verdict.priority || "medium",
        });
        if (added?.todo?.id && text.trim().toLowerCase() !== verdict.title.trim().toLowerCase()) {
          await runtime.todoService.addComment(added.todo.id, {
            text: text.slice(0, 300),
            author: profile?.name || "Utilisateur",
            kind: "user",
          });
        }
      } catch (error) {
        console.warn(`Tri to-do impossible: ${error.message}`);
      }
    }).catch((error) => console.warn(`Tri to-do impossible: ${error.message}`));
}

app.post("/api/todos/triage", async (request, response, next) => {
  try {
    const rawText = String(request.body?.text || "").trim();
    const projectId = request.body?.projectId || null;
    if (!rawText) throw new Error("Texte requis.");
    const text = rawText.slice(0, 12000);
    if (projectId && !projectVisible(request.profile.id, projectId)) throw new Error("Projet introuvable.");
    if (projectId && projects.get(projectId)?.todoTracking === false) return response.json({ accepted: false });
    if (alreadyTriaged(projectId || request.body?.sessionId || "", text)) return response.json({ accepted: false });
    response.status(202).json({ accepted: true });

    queuePromptTriage(request.profile, text, projectId);
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/seen", async (request, response, next) => {
  try {
    const view = await todosView(request.profile);
    const ids = Array.isArray(request.body?.ids) && request.body.ids.length ? new Set(request.body.ids) : null;
    await todoSeenService.markTodos(request.profile.id, ids ? view.todos.filter((todo) => ids.has(todo.id)) : view.todos);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/settings", async (request, response, next) => {
  try {
    if (request.body?.correction !== undefined) await boardService.setCorrection(request.profile.id, request.body.correction);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/:id", async (request, response, next) => {
  try {
    const changes = {};
    if (request.body?.text !== undefined) changes.text = request.body.text;
    if (request.body?.status !== undefined) {
      let nextStatus = request.body.status;
      if (nextStatus === "review") {
        const { columns } = await boardService.settings(request.profile.id);
        const reviewCol = columns?.find((c) => c.id === "review" || c.kind === "review");
        if (reviewCol && reviewCol.enabled === false) {
          nextStatus = "done";
        }
      }
      changes.status = nextStatus;
    }
    if (request.body?.priority !== undefined) changes.priority = request.body.priority;
    if (request.body?.completed !== undefined) changes.completed = request.body.completed === true;
    if (request.body?.dueDate !== undefined) changes.dueDate = request.body.dueDate || null;
    if (request.body?.shared !== undefined) changes.shared = Boolean(request.body.shared);
    if (request.body?.assignee !== undefined) {
      changes.assignee = request.body.assignee;
      if (changes.assignee === "all" || changes.assignee === "both") {
        changes.shared = true;
      }
    }
    if (request.body?.comments !== undefined) changes.comments = request.body.comments;
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
      priority: changes.priority === undefined ? current.priority : changes.priority,
      folderId: changes.folderId,
      status: changes.status ?? current.status,
      shared: changes.shared !== undefined ? Boolean(changes.shared) : (current.shared || false),
      assignee: changes.assignee !== undefined ? changes.assignee : (current.assignee || null),
    });
    if (current.comments?.length) {
      await target.todoService.update(todo.id, { comments: current.comments });
    }
    await source.todoService.remove(request.params.id);
    response.json({ todo, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/:id/comments", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { todoId: request.params.id });
    const byAgent = request.body?.authorKind === "agent" || request.body?.kind === "agent";
    const author = byAgent ? String(request.body?.author || "Agent").slice(0, 50) : request.profile?.name || null;
    const rawText = String(request.body?.text || "");
    const { correction } = await boardService.settings(request.profile.id);
    const text = correction && !byAgent && rawText.trim() ? await textCorrector.correct(rawText, { context: "comment" }).catch(() => rawText) : rawText;
    const result = await runtime.todoService.addComment(request.params.id, { text, author, kind: byAgent ? "agent" : "user" });
    if (!byAgent) {
      await todoSeenService.mark(request.profile.id, request.params.id);
    }
    response.status(201).json({ ...result, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/todos/:id/comments/:commentId", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { todoId: request.params.id });
    const result = await runtime.todoService.removeComment(request.params.id, request.params.commentId);
    response.json({ ...result, ...(await todosView(request.profile)) });
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

app.get("/api/todos/suggest-emoji", async (request, response, next) => {
  try {
    const name = String(request.query?.name || "").trim();
    if (!name) return response.json({ emoji: "📁" });
    const emoji = await suggestEmojiForFolder(name, localLlm);
    response.json({ emoji });
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/folders", async (request, response, next) => {
  try {
    const parentId = request.body?.parentId || null;
    const projectId = request.body?.projectId || null;
    let name = String(request.body?.name || "").trim();
    if (parentId && name && !/^\p{Extended_Pictographic}/u.test(name)) {
      const em = request.body?.emoji || await suggestEmojiForFolder(name, localLlm);
      if (em) name = `${em} ${name}`;
    }
    const runtime = await todoRuntime(request.profile, { folderId: parentId, projectId });
    await runtime.todoService.addFolder({
      name,
      parentId,
      projectId,
    });
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

app.delete("/api/todos/:id", async (request, response, next) => {
  try {
    const runtime = await todoRuntime(request.profile, { todoId: request.params.id });
    await runtime.todoService.remove(request.params.id);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.post("/api/todos/columns", async (request, response, next) => {
  try {
    const { column } = await boardService.add(request.profile.id, request.body?.name);
    response.status(201).json({ column, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/columns/order", async (request, response, next) => {
  try {
    await boardService.reorder(request.profile.id, request.body?.ids);
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/todos/columns/:id", async (request, response, next) => {
  try {
    await boardService.update(request.profile.id, request.params.id, request.body);
    if (request.body?.enabled === false) {
      const view = await todosView(request.profile);
      const targetStatus = request.params.id === "review" ? "done" : "todo";
      for (const todo of view.todos.filter((item) => item.status === request.params.id)) {
        const runtime = await todoRuntime(request.profile, { todoId: todo.id });
        await runtime.todoService.update(todo.id, { status: targetStatus }).catch(() => {});
      }
    }
    response.json(await todosView(request.profile));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/todos/columns/:id", async (request, response, next) => {
  try {
    const columns = await boardService.remove(request.profile.id, request.params.id);
    // Aucune tache ne reste orpheline: la zone supprimee renvoie ses taches en « A faire ».
    const view = await todosView(request.profile);
    for (const todo of view.todos.filter((item) => item.status === request.params.id)) {
      const runtime = await todoRuntime(request.profile, { todoId: todo.id });
      await runtime.todoService.update(todo.id, { status: "todo" }).catch(() => {});
    }
    response.json({ columns, ...(await todosView(request.profile)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/calendar/events", async (request, response, next) => {
  try {
    const view = await todosView(request.profile);
    const result = await calendarService.getAllEvents({
      profileId: request.profile.id,
      todos: view.todos,
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/calendar/subscriptions", async (request, response, next) => {
  try {
    const subscriptions = await calendarService.listSubscriptions(request.profile.id);
    response.json({ subscriptions });
  } catch (error) {
    next(error);
  }
});

app.post("/api/calendar/subscriptions", async (request, response, next) => {
  try {
    const created = await calendarService.addSubscription({
      name: request.body?.name,
      url: request.body?.url,
      color: request.body?.color,
      profileId: request.profile.id,
    });
    response.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/calendar/subscriptions/:id", async (request, response, next) => {
  try {
    const updated = await calendarService.updateSubscription(request.params.id, request.body || {});
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/calendar/subscriptions/:id", async (request, response, next) => {
  try {
    await calendarService.removeSubscription(request.params.id);
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/calendar/export.ics", async (request, response, next) => {
  try {
    const view = await todosView(request.profile);
    const ical = generateICal(view.todos, {
      calendarName: `Noyau Todos (${request.profile.name || "Personnel"})`,
    });
    response.setHeader("Content-Type", "text/calendar; charset=utf-8");
    response.setHeader("Content-Disposition", 'attachment; filename="noyau-todos.ics"');
    response.send(ical);
  } catch (error) {
    next(error);
  }
});

app.get("/api/mobile/noyau.apk", async (_request, response, next) => {
  try {
    const candidates = [
      path.join(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
      path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
      path.join(dataDir, "noyau.apk"),
      path.join(root, "dist", "noyau.apk"),
      path.join(root, "public", "noyau.apk"),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        response.setHeader("Content-Type", "application/vnd.android.package-archive");
        response.setHeader("Content-Disposition", 'attachment; filename="noyau.apk"');
        return response.sendFile(candidate);
      } catch {}
    }
    response.status(404).json({
      error: "APK non encore générée sur ce serveur.",
      hint: "Exécutez 'node scripts/build-mobile.mjs' pour assembler l'APK, ou installez directement l'application via le bouton 'Ajouter à l'écran d'accueil' (PWA) qui active le mode hors-ligne et WireGuard.",
    });
  } catch (error) {
    next(error);
  }
});


function moduleKnowledgePayload(payload) {
  if (!payload.knowledge) return payload;
  const status = knowledgeService.status(moduleService.get(payload.id));
  const setup = payload.knowledge.provider === "notion"
    ? { status: status.scoped ? "ready" : "required", label: status.label, description: status.scoped ? "Contenu Notion disponible dans Noyau et pour agents." : "Dans Notion: page Octanix > ••• > Ajouter des connexions > choisir intégration." }
    : payload.setup;
  return { ...payload, setup, enabled: status.configured, state: status.scoped ? "ready" : "setup-required", knowledge: { ...payload.knowledge, status } };
}

function mapRequest(request, project = request.query.project) {
  const visibleProjects = scopedProjects(request.profile.id);
  const projectId = String(project || "");
  if (!visibleProjects[projectId]) throw Object.assign(new Error("Projet introuvable."), { statusCode: 404 });
  return { projectId, window: request.query.window === "7d" ? "7d" : "24h", visibleProjects, sessionVisible: (id) => sessionVisible(request.profile.id, id) };
}

app.get("/api/map", async (request, response, next) => {
  try {
    const { chats, ...snapshot } = await agentMap.snapshot(mapRequest(request));
    response.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.get("/api/map/exchanges", async (request, response, next) => {
  try {
    const visibleProjects = scopedProjects(request.profile.id);
    const raw = String(request.query.project || "all");
    if (raw !== "all" && !visibleProjects[raw]) throw Object.assign(new Error("Projet introuvable."), { statusCode: 404 });
    const exchanges = await agentMap.exchanges({
      projectId: raw === "all" ? null : raw,
      window: request.query.window === "7d" ? "7d" : "24h",
      agentId: request.query.agent ? String(request.query.agent) : null,
      visibleProjects,
      sessionVisible: (id) => sessionVisible(request.profile.id, id),
    });
    response.json({ exchanges, generatedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/map/node", async (request, response, next) => {
  try {
    const snapshot = await agentMap.snapshot(mapRequest(request));
    const node = snapshot.nodes.find((item) => item.id === String(request.query.node || ""));
    if (!node) throw Object.assign(new Error("Nœud introuvable."), { statusCode: 404 });
    const details = await agentMap.nodeDetails(node, snapshot.window);
    response.json({ node, chat: snapshot.chats.get(node.id) || [], ...details });
  } catch (error) {
    next(error);
  }
});

app.get("/api/map/scan", async (request, response, next) => {
  try {
    const { projectId } = mapRequest(request);
    response.json(agentMap.scanStatus(projectId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/map/scan", async (request, response, next) => {
  try {
    const context = mapRequest(request, request.body?.project);
    agentMap.startScan(context.projectId, context);
    response.json(agentMap.scanStatus(context.projectId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/map/scan/apply", async (request, response, next) => {
  try {
    const { projectId } = mapRequest(request, request.body?.project);
    response.json(await agentMap.applyScan(projectId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/map/override", async (request, response, next) => {
  try {
    const { projectId } = mapRequest(request, request.body?.project);
    const node = String(request.body?.node || "");
    if (!node || node.length > 300) throw Object.assign(new Error("Nœud requis."), { statusCode: 400 });
    response.json({ override: await agentMap.setOverride(projectId, node, request.body?.fields || {}) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/map/agents/:id/message", async (request, response, next) => {
  try {
    const id = String(request.params.id);
    const text = String(request.body?.message || "").trim().slice(0, 20_000);
    if (!text) throw Object.assign(new Error("Message requis."), { statusCode: 400 });
    if (!sessionVisible(request.profile.id, id)) throw Object.assign(new Error("Agent introuvable."), { statusCode: 404 });
    if (!(await tmux.list()).some((session) => session.id === id)) throw Object.assign(new Error("Agent arrêté."), { statusCode: 409 });
    const held = Boolean(tmux.inputGate?.busy(id));
    const delivery = tmux.submit(id, text);
    if (held) delivery.catch((error) => console.warn(`[map] message différé vers ${id} perdu: ${error.message}`));
    else await delivery;
    agentMap.invalidate();
    response.json({ success: true, held });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules", async (request, response, next) => {
  try {
    const result = await moduleService.list(scopedProjects(request.profile.id));
    response.json({ ...result, modules: result.modules.map(moduleKnowledgePayload) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/install", async (request, response, next) => {
  try {
    const module = await moduleService.install(request.params.id, scopedProjects(request.profile.id));
    response.status(201).json({ module: moduleKnowledgePayload(await moduleService.payload(module)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/environment", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json({ module: moduleKnowledgePayload(await moduleService.setEnvironment(request.params.id, request.body?.environment ?? null)) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/modules/:id", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    await moduleService.remove(request.params.id);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/planning", async (request, response, next) => {
  try {
    if (!scopedProjects(request.profile.id)[request.params.id]) throw new Error("Projet introuvable.");
    const days = Math.min(Math.max(Number(request.query.days) || 3, 1), 14);
    response.json(await moduleService.planning(request.params.id, { days }));
  } catch (error) {
    next(error);
  }
});

// Pages de suivi par agent: les agents ecrivent via scripts/noyau-board.mjs, le fondateur lit et tranche les decisions.
function trackingProject(request) {
  if (!scopedProjects(request.profile.id)[request.params.id]) throw new Error("Projet introuvable.");
  return request.params.id;
}

app.get("/api/projects/:id/tracking", async (request, response, next) => {
  try {
    response.json(await trackingService.list(trackingProject(request)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tracking/:board", async (request, response, next) => {
  try {
    response.json(await trackingService.get(trackingProject(request), request.params.board));
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:id/tracking/:board", async (request, response, next) => {
  try {
    const { title, objective, kpis, agentId, agentName } = request.body || {};
    response.json(await trackingService.set(trackingProject(request), request.params.board, { title, objective, kpis, agentId, agentName }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/tracking/:board", async (request, response, next) => {
  try {
    await trackingService.remove(trackingProject(request), request.params.board);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:id/tracking/:board/kpis", async (request, response, next) => {
  try {
    response.json(await trackingService.setKpi(trackingProject(request), request.params.board, request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/tracking/:board/items", async (request, response, next) => {
  try {
    const { agentId, agentName, ...item } = request.body || {};
    response.status(201).json(await trackingService.addItem(trackingProject(request), request.params.board, item, { agentId, agentName }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id/tracking/:board/items/:item", async (request, response, next) => {
  try {
    response.json(await trackingService.updateItem(trackingProject(request), request.params.board, request.params.item, request.body || {}));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/tracking/:board/items/:item", async (request, response, next) => {
  try {
    response.json(await trackingService.removeItem(trackingProject(request), request.params.board, request.params.item));
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/tracking/:board/items/:item/decision", async (request, response, next) => {
  try {
    const projectId = trackingProject(request);
    const decision = String(request.body?.decision || "");
    const note = String(request.body?.note || "");
    const { item, board } = await trackingService.decide(projectId, request.params.board, request.params.item, { decision, note, by: request.profile.name });
    let notified = false;
    if (board.agentId) {
      const verdict = decision === "go" ? "GO" : "NON";
      const message = [
        `Décision du fondateur sur ton suivi « ${board.title} » : ${verdict} pour « ${item.title} » (#${item.id}).`,
        note.trim() ? `Note : ${note.trim()}` : null,
        decision === "go" ? `L'élément est passé « En cours » : lance-le, puis \`node ${path.join(root, "scripts/noyau-board.mjs")} done ${board.id} ${item.id}\` une fois fait.` : "L'élément est classé « Fait » (refusé) : ne le lance pas.",
      ].filter(Boolean).join("\n");
      notified = await agentCommunication.send(board.agentId, { message, callerName: `Suivi · ${request.profile.name || "fondateur"}`, profileId: request.profile.id }).then(() => true, () => false);
    }
    response.json({ item, notified });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/tracking/:board/reports", async (request, response, next) => {
  try {
    const { title, url, date, fileName, content } = request.body || {};
    response.status(201).json(await trackingService.addReport(trackingProject(request), request.params.board, { title, url, date, fileName, content }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/tracking/:board/reports/:report", async (request, response, next) => {
  try {
    response.json(await trackingService.removeReport(trackingProject(request), request.params.board, request.params.report));
  } catch (error) {
    next(error);
  }
});

// Rapport local en lecture seule: le HTML tourne en sandbox stricte (pas de script, pas d'acces a l'origine Noyau).
app.get("/api/projects/:id/tracking/:board/files/:name", async (request, response, next) => {
  try {
    const report = await trackingService.reportFile(trackingProject(request), request.params.board, request.params.name);
    // Le lecteur PDF de Chrome refuse les documents sous CSP sandbox: seul le HTML en a besoin.
    const csp = report.type.startsWith("text/html")
      ? "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; media-src data: https:; frame-ancestors 'self'"
      : "default-src 'self' blob: data:; script-src 'none'; frame-ancestors 'self'";
    response.set({ "Content-Security-Policy": csp, "X-Frame-Options": "SAMEORIGIN", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60" });
    response.type(report.type).sendFile(report.file, { dotfiles: "allow" });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id/planning/boost", async (request, response, next) => {
  try {
    if (!scopedProjects(request.profile.id)[request.params.id] || !moduleOwned(request.profile.id, String(request.body?.moduleId || ""))) throw new Error("Projet introuvable.");
    await moduleService.setBoost(request.params.id, String(request.body.moduleId), String(request.body?.entryId || ""), request.body?.enabled === true, request.body?.date ? String(request.body.date) : null);
    response.json(await moduleService.planning(request.params.id, { days: 3 }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/chat", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json(await moduleService.chatDay(request.params.id, request.query.day));
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

app.post("/api/modules/:id/actions/:actionId", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const options = { input: request.body?.input, resume: request.body?.resume === true };
    response.status(202).json({ run: await moduleService.runAction(request.params.id, request.params.actionId, options) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/actions/:actionId/stop", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json({ run: await moduleService.stopAction(request.params.id, request.params.actionId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/builds", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.status(202).json({
      run: await moduleService.requestBuild(request.params.id, {
        platform: request.body?.platform || "android",
        force: request.body?.force === true,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/builds/refresh", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json(await moduleService.refreshBuilds(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/modules/:id/builds/:buildId/access", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const artifact = await moduleService.buildFile(request.params.id, request.params.buildId);
    const module = moduleService.get(request.params.id);
    if (artifact.platform === "ios" && !module.deviceBuild?.ios) throw new Error("Installation OTA iOS non configurée.");
    const origin = httpsOrigin(request);
    const expiresAt = Date.now() + 10 * 60_000;
    const grant = createBuildGrant(buildGrantSecret, {
      moduleId: request.params.id,
      buildId: artifact.id,
      profileId: request.profile.id,
      expiresAt,
    });
    const downloadUrl = `${origin}/install/build/${encodeURIComponent(grant)}/${encodeURIComponent(artifact.name)}`;
    const manifestUrl = `${origin}/install/build/${encodeURIComponent(grant)}/manifest.plist`;
    response.json({
      downloadUrl,
      installUrl: artifact.platform === "ios" ? `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}` : null,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/builds/:buildId", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const artifact = await moduleService.buildFile(request.params.id, request.params.buildId);
    response.download(artifact.file, artifact.name, { dotfiles: "allow" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/board/media/:name", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const media = await moduleService.boardMedia(request.params.id, request.params.name);
    response.type(media.type).set("Cache-Control", "private, max-age=60").sendFile(media.file, { dotfiles: "allow" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/knowledge", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json(await knowledgeService.list(moduleService.get(request.params.id), { folderId: request.query.folderId, query: request.query.q }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/knowledge/content", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    response.json(await knowledgeService.content(moduleService.get(request.params.id), { itemId: request.query.itemId, kind: request.query.kind }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/modules/:id/knowledge/pages", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const module = moduleService.get(request.params.id);
    if (module.knowledge?.provider !== "notion") throw new Error("Configuration indisponible.");
    response.json({ pages: await knowledgeService.availablePages(module.id, { token: request.query.token }) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/modules/:id/knowledge/config", async (request, response, next) => {
  try {
    if (!moduleOwned(request.profile.id, request.params.id)) throw new Error("Module introuvable.");
    const module = moduleService.get(request.params.id);
    if (module.knowledge?.provider !== "notion") throw new Error("Configuration indisponible.");
    response.json({ status: await knowledgeService.configureNotion(module.id, { token: request.body?.token, rootPageId: request.body?.rootPageId, pageUrl: request.body?.pageUrl }) });
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

app.get("/api/projects/:id/budget", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const project = projects.get(request.params.id);
    response.json({ budget: project.budget || { items: [] } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/budget/items", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectOwned(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const project = projects.get(request.params.id);
    const item = normalizeBudgetItem(request.body);
    if (!item) throw new Error("Informations de dépense invalides.");
    const items = [...(project.budget?.items || []), item];
    const updatedProject = { ...project, budget: { items }, updatedAt: new Date().toISOString() };
    await projects.set(request.params.id, updatedProject);
    response.status(201).json({ budget: updatedProject.budget, item });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id/budget/items/:itemId", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectOwned(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const project = projects.get(request.params.id);
    const currentItems = project.budget?.items || [];
    const index = currentItems.findIndex((i) => i.id === request.params.itemId);
    if (index === -1) throw new Error("Ligne de budget introuvable.");
    const merged = normalizeBudgetItem({ ...currentItems[index], ...request.body, id: request.params.itemId });
    const items = [...currentItems];
    items[index] = merged;
    const updatedProject = { ...project, budget: { items }, updatedAt: new Date().toISOString() };
    await projects.set(request.params.id, updatedProject);
    response.json({ budget: updatedProject.budget, item: merged });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/budget/items/:itemId", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id) || !projectOwned(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const project = projects.get(request.params.id);
    const currentItems = project.budget?.items || [];
    const items = currentItems.filter((i) => i.id !== request.params.itemId);
    const updatedProject = { ...project, budget: { items }, updatedAt: new Date().toISOString() };
    await projects.set(request.params.id, updatedProject);
    response.json({ budget: updatedProject.budget });
  } catch (error) {
    next(error);
  }
});


function projectRoots(projectId) {
  const project = projects.get(projectId);
  if (!project) return [];
  const roots = [
    project.rootPath,
    ...Object.values(store.all()).filter((session) => session.projectId === projectId).map((session) => session.cwd),
  ].filter(Boolean);
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

// Les projets n'ont pas toujours de dossier propre: on prend le premier logo trouve
// dans le dossier du projet ou dans ceux de ses agents, pour que toute l'equipe partage l'icone.
// Si un logo explicite a ete configure, il est prioritaire.
async function projectLogoFile(projectId) {
  const project = projects.get(projectId);
  if (!project) return null;
  if (project.logoPath) {
    try {
      const stat = await fs.stat(project.logoPath);
      if (stat.isFile()) return project.logoPath;
    } catch {
      // logo introuvable sur disque: retombe sur la detection
    }
  }
  const roots = projectRoots(projectId);
  for (const root of roots) {
    const file = await projectLogos.find(root).catch(() => null);
    if (file) return file;
  }
  return null;
}

app.get("/api/projects/:id/logo", async (request, response, next) => {
  try {
    const project = projects.get(request.params.id);
    if (!project || (project.profileId !== request.profile.id && !project.shared)) return response.status(404).end();
    const file = await projectLogoFile(request.params.id);
    if (!file) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
    response.vary("Cookie"); response.vary("Authorization");
    response.sendFile(file);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/images", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) throw new Error("Projet introuvable.");
    const project = projects.get(request.params.id);
    if (!project || (project.profileId !== request.profile.id && !project.shared)) throw new Error("Projet introuvable.");
    const roots = projectRoots(request.params.id);
    const offset = Number(request.query.offset) || 0;
    const limit = Number(request.query.limit) || 30;
    const search = String(request.query.search || "");
    const result = await projectLogos.list(roots, { offset, limit, search });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/image-file", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) return response.status(404).end();
    const project = projects.get(request.params.id);
    if (!project || (project.profileId !== request.profile.id && !project.shared)) return response.status(404).end();
    const requestedPath = String(request.query.path || "");
    if (!requestedPath) return response.status(400).end();
    const filePath = path.resolve(requestedPath);
    const roots = projectRoots(request.params.id);
    const isAllowed = roots.some((root) => {
      const rel = path.relative(root, filePath);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    if (!isAllowed) return response.status(403).end();
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return response.status(403).end();
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
    response.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

const FILE_SORT_AGENT_NAME = "Tri fichiers partagés";

function fileSortPrompt(project, dir) {
  const cli = `node ${path.join(root, "scripts/noyau-file-sort.mjs")} --project ${project.id}`;
  return [
    `Mission : trier les fichiers partagés du projet « ${project.name} » (dossier ${dir}) et mettre à la corbeille ceux qui ne servent à rien.`,
    "",
    "Outil (seule façon autorisée de supprimer, jamais rm/mv) :",
    `- ${cli} scan : liste nom, taille, âge, sha256, doublons exacts, founder (uploadé par le fondateur), protected (< ${PROTECTED_HOURS} h)`,
    `- ${cli} trash <nom> --reason "raison courte" [--duplicate-of <nom gardé>]`,
    `- ${cli} keep <nom> --reason "doute : …"  (fichiers gardés en cas de doute, visibles dans le rapport)`,
    `- ${cli} finish --summary "bilan en une phrase"  (termine le tri ; tu seras arrêté automatiquement)`,
    "",
    "À supprimer : doublons exacts (même sha256 : garder le plus récent ou le mieux nommé, passer --duplicate-of), versions intermédiaires remplacées (v1/v2/draft/test/old quand une version finale existe), essais et rendus ratés, captures de debug, fichiers vides ou corrompus, exports temporaires.",
    `À garder : livrables finaux, dernière version de chaque série, fichiers founder (sauf doublon exact), fichiers protected (< ${PROTECTED_HOURS} h).`,
    "Ouvre les images/PDF si besoin pour juger (Read). En cas de doute : keep avec la raison, ne supprime pas.",
    `Tout passe par la corbeille (restaurable ${TRASH_DAYS} jours). Ne crée, ne renomme et ne modifie aucun fichier. Termine toujours par finish, même si rien n'est supprimé.`,
  ].join("\n");
}

function fileSortProject(request) {
  if (!PROJECT_PATTERN.test(request.params.id) || !projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
  return projects.get(request.params.id);
}

app.get("/api/projects/:id/files/sort", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json(await fileSortService.status(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files/sort", async (request, response, next) => {
  try {
    const project = fileSortProject(request);
    const dir = await projectFilesService.ensureProjectDir(request.params.id);
    await fileSortService.start(request.params.id);
    try {
      const result = await agentCommunication.create({
        name: FILE_SORT_AGENT_NAME,
        assistant: "claude",
        projectId: request.params.id,
        cwd: dir,
        prompt: fileSortPrompt({ ...project, id: request.params.id }, dir),
        description: "Trie les fichiers partagés du projet et met l'inutile à la corbeille (30 j).",
        callerName: "Fichiers partagés",
        profileId: request.profile.id,
      });
      await fileSortService.setAgent(request.params.id, result.agent.id);
      response.status(201).json({ agentId: result.agent.id });
    } catch (error) {
      await fileSortService.finish(request.params.id, { summary: `Échec du lancement : ${error.message}` }).catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/files/sort/scan", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json({ files: await fileSortService.scan(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files/sort/trash", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json(await fileSortService.trash(request.params.id, request.body?.name, { reason: request.body?.reason, duplicateOf: request.body?.duplicateOf || null }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files/sort/keep", async (request, response, next) => {
  try {
    fileSortProject(request);
    await fileSortService.keep(request.params.id, request.body?.name, { reason: request.body?.reason });
    response.json({ kept: request.body?.name });
  } catch (error) {
    next(error);
  }
});

// L'agent appelle finish depuis son propre terminal: on repond avant de l'arreter.
app.post("/api/projects/:id/files/sort/finish", async (request, response, next) => {
  try {
    fileSortProject(request);
    const { agentId, deleted } = await fileSortService.finish(request.params.id, { summary: request.body?.summary });
    response.json({ finished: true, deleted });
    const session = agentId ? store.get(agentId) : null;
    if (session && !session.core && session.name === FILE_SORT_AGENT_NAME) {
      setTimeout(async () => {
        await agentArchiveService.archive(agentId, store.get(agentId) || session, { reason: "closed" }).catch(() => {});
        await tmux.kill(agentId).catch(() => {});
      }, 3000);
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files/trash/:trashId/restore", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json(await fileSortService.restore(request.params.id, request.params.trashId));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/files/trash/:trashId", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json(await fileSortService.deleteForever(request.params.id, request.params.trashId));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/files/trash", async (request, response, next) => {
  try {
    fileSortProject(request);
    response.json(await fileSortService.emptyTrash(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/files", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) throw new Error("Projet introuvable.");
    if (!projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const files = await projectFilesService.list(request.params.id);
    response.json({ files });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files", fileUpload.single("file"), async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) throw new Error("Projet introuvable.");
    if (!projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    if (!request.file) throw new Error("Fichier manquant.");
    const file = await projectFilesService.saveFile(request.params.id, {
      originalname: request.file.originalname,
      buffer: request.file.buffer,
    });
    await fileSortService.markFounder(request.params.id, file.name).catch(() => {});
    response.status(201).json({ file });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/files/:filename", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) return response.status(404).end();
    if (request.fileGrant) {
      if (request.fileGrant.projectId !== request.params.id || request.fileGrant.filename !== request.params.filename) {
        return response.status(403).json({ error: "Grant invalide pour ce fichier." });
      }
    } else if (!projectVisible(request.profile.id, request.params.id) && !(request.masterAuthenticated && projectVisible(primaryProfileId, request.params.id))) {
      return response.status(404).end();
    }
    const filePath = await projectFilesService.getFilePath(request.params.id, request.params.filename);
    const stat = await fs.stat(filePath);
    const isInline = request.query.inline === "1" || request.query.inline === "true" || request.query.preview === "1";
    const disposition = isInline ? "inline" : "attachment";
    response.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(request.params.filename)}"`);
    response.setHeader("Content-Length", stat.size);
    if (isInline) {
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.setHeader("Content-Security-Policy", "default-src 'self' blob: data:; script-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'");
    }
    const ext = path.extname(request.params.filename).toLowerCase();
    if ([".md", ".markdown"].includes(ext)) {
      response.setHeader("Content-Type", "text/markdown; charset=utf-8");
    } else if ([".csv", ".tsv"].includes(ext)) {
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
    } else if ([".txt", ".log", ".env", ".sh", ".bash", ".zsh", ".conf", ".ini", ".toml", ".yml", ".yaml"].includes(ext)) {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
    } else if ([".json"].includes(ext)) {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
    } else {
      response.type(ext || "application/octet-stream");
    }
    const stream = createReadStream(filePath);
    stream.on("error", next);
    stream.pipe(response);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/files/:filename/grant", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) return response.status(404).end();
    if (!projectVisible(request.profile.id, request.params.id)) return response.status(404).end();
    const grant = createProjectFileGrant(buildGrantSecret, {
      projectId: request.params.id,
      filename: request.params.filename,
      profileId: request.profile.id,
    });
    response.json({
      grant,
      downloadUrl: `/download/project-file/${encodeURIComponent(grant)}/${encodeURIComponent(request.params.filename)}`,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/files/:filename", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) throw new Error("Projet introuvable.");
    if (!projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    await projectFilesService.deleteFile(request.params.id, request.params.filename);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/files/tell-agent", async (request, response, next) => {
  try {
    if (!PROJECT_PATTERN.test(request.params.id)) throw new Error("Projet introuvable.");
    if (!projectVisible(request.profile.id, request.params.id)) throw new Error("Projet introuvable.");
    const targetAgent = String(request.body?.agentId || request.body?.agentName || "").trim();
    const action = String(request.body?.action || "share"); // 'share' ou 'request_upload'
    const filename = String(request.body?.filename || "").trim();
    const userPrompt = String(request.body?.prompt || "").trim();
    const project = projects.get(request.params.id);
    const projectName = project?.name || "ce projet";
    const dir = await projectFilesService.ensureProjectDir(request.params.id);

    let message = "";
    if (action === "request_upload") {
      message = `[Demande de fichier partagé]: L'utilisateur te demande de générer ou déposer un fichier dans l'espace partagé du projet « ${projectName} ».\n` +
        `Chemin du dossier partagé du projet : ${dir}\n` +
        (userPrompt ? `Consigne : ${userPrompt}\n` : "") +
        `Dépose directement ton/tes fichiers dans ce dossier pour qu'ils soient immédiatement téléchargeables par l'utilisateur et partagés avec le reste du noyau.`;
    } else {
      message = `[Fichier partagé]: Un fichier est disponible dans l'espace partagé du projet « ${projectName} ».\n` +
        `Chemin du dossier : ${dir}\n` +
        (filename ? `Fichier : ${filename} (chemin complet : ${path.join(dir, filename)})\n` : "") +
        (userPrompt ? `Consigne utilisateur : ${userPrompt}\n` : "Tu peux consulter ce fichier ou l'utiliser comme référence pour tes tâches.");
    }

    const result = await agentCommunication.send(targetAgent, {
      message,
      callerName: "Espace Fichiers Noyau",
      profileId: request.profile.id,
    });
    response.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});

async function saveUpload(request, response, next) {
  try {
    if (!request.file) throw new Error("Fichier manquant.");
    if (!validSessionId(request.body?.sessionId) || !sessionVisible(request.profile.id, request.body.sessionId) || !(await tmux.exists(request.body.sessionId))) throw new Error("Session invalide.");
    const base = `${request.body.sessionId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const originalExtension = path.extname(request.file.originalname).toLowerCase();
    // SVG = code vectoriel: le rasteriser en PNG le ferait passer pour une capture ([Image #1] dans le CLI).
    const image = /^image\//.test(request.file.mimetype) && request.file.mimetype !== "image/svg+xml" && originalExtension !== ".svg";
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

app.post("/api/uploads/raw-files", async (request, response, next) => {
  try {
    const { sessionId, files } = request.body || {};
    if (!validSessionId(sessionId) || !sessionVisible(request.profile.id, sessionId) || !(await tmux.exists(sessionId))) {
      throw new Error("Session invalide.");
    }
    if (!Array.isArray(files) || !files.length) {
      throw new Error("Aucun fichier fourni.");
    }
    const created = [];
    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      const rawName = String(item.name || "").trim();
      const content = String(item.content ?? "");
      const safeName = rawName.replace(/[/\\?%*:|"<>]/g, "_") || `fichier-${i + 1}.txt`;
      const originalExtension = path.extname(safeName).toLowerCase();
      const extension = /^\.[a-z0-9_-]{1,15}$/.test(originalExtension) ? originalExtension : ".txt";
      const stem = (path.basename(safeName, originalExtension) || `document-${i + 1}`).slice(0, 80);
      const filename = `${sessionId}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${stem}${extension}`;
      const target = path.join(uploadsDir, filename);
      await fs.writeFile(target, content, { encoding: "utf-8", mode: 0o600 });
      created.push({ path: target, name: safeName, size: Buffer.byteLength(content, "utf-8") });
    }
    response.status(201).json({ files: created });
  } catch (error) {
    next(error);
  }
});

app.get("/api/notifications", (_request, response) => {
  response.json({ publicKey: push.publicKey() });
});

app.post("/api/notifications/subscribe", async (request, response, next) => {
  try {
    await push.subscribe(request.body?.subscription, request.profile.id, String(request.body?.deviceId || "").slice(0, 64) || null);
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
      title: sample ? agentNotificationTitle(sample.projectId ? projects.get(sample.projectId)?.name : sample.name, "Test notification") : "Noyau connecté",
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
    const attention = source === "claude" && claudeNeedsAttention(event);
    const idleNotice = source === "claude" && event.hook_event_name === "Notification" && event.notification_type === "idle_prompt";
    const existing = sessionId && validSessionId(sessionId) ? store.get(sessionId) : null;
    if (!existing) return response.status(202).json({ sent: false, reason: "unmanaged-session" });
    if (source !== existing.assistant && !(source === "claude" && existing.assistant === "claude-design")) return response.status(202).json({ sent: false, reason: "previous-provider" });
    let metadata = existing;
    if (existing) {
      metadata = {
        ...existing,
        threadId: source === "codex" ? event["thread-id"] || existing.threadId : existing.threadId,
        transcriptPath: source === "claude" ? event.transcript_path || existing.transcriptPath : existing.transcriptPath,
        agentSessionId: source === "claude" ? event.session_id || existing.agentSessionId : existing.agentSessionId,
        agentState: completion || idleNotice ? "available" : attention ? "waiting" : existing.agentState,
        agentStateUpdatedAt: completion || attention || idleNotice ? new Date().toISOString() : existing.agentStateUpdatedAt,
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
    if (completion && lastMessage) await agentMemory.checkpoint(sessionId, { assistant: source, text: lastMessage }).catch((error) => console.warn(`Mémoire agent ${sessionId}: ${error.message}`));
    if (completion && lastMessage) void closeFinishedTodos(metadata, lastMessage).catch((error) => console.warn(`Fin de tour todos ${sessionId}: ${error.message}`));
    const notificationLabel = agentAlertTitle(metadata?.projectId ? projects.get(metadata.projectId)?.name : null, metadata?.name);
    let payload = null;
    if (completion) {
      payload = {
        title: notificationLabel,
        body: agentAlertBody("done", metadata?.name),
        tag: `${source}-${event["thread-id"] || event.session_id || "complete"}`,
      };
    }
    if (attention) {
      payload = {
        title: notificationLabel,
        body: agentAlertBody("waiting", metadata?.name),
        tag: `claude-${event.session_id || "attention"}-${event.notification_type || "notification"}`,
      };
    }
    if (!payload) return response.status(202).json({ sent: false });
    if (completion && sessionId && migrations.has(sessionId)) {
      const migration = migrations.get(sessionId);
      clearTimeout(migration.timer);
      const sourceSession = store.get(sessionId);
      if (sourceSession) {
        try {
          // Quota epuise en cours de route: on repart de l'historique de la conversation
          // plutot que d'annuler la bascule.
          const recap = usableRecap(lastMessage);
          const prompt = recap
            ? `Tu reprends travail d'un autre agent. Utilise ce récapitulatif comme contexte fiable, vérifie état réel du dépôt avant modification, puis attends prochaine demande utilisateur.\n\nRÉCAPITULATIF DE PASSATION:\n${recap}`
            : (await handoverPrompt({ session: sourceSession, metadata: sourceSession, target: migration.target })).prompt;
          // L'agent change de fournisseur sur place: meme nom, meme projet, l'ancien s'efface.
          const target = await spawnHandoverSession({
            sessionId,
            session: sourceSession,
            metadata: sourceSession,
            target: migration.target,
            prompt,
            replace: true,
          });
          migrations.delete(sessionId);
          payload = {
            title: `Contexte passé à ${assistantLabel(migration.target)}`,
            body: `${sourceSession.name} continue avec ${assistantLabel(migration.target)}${usableRecap(lastMessage) ? "" : " · repris depuis l'historique"}.`,
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
    // Ecran ouvert sur cet agent: rien a annoncer. Sinon, seul l'appareil aux commandes sonne.
    const devices = watchingSession(notificationProfileId, sessionId)
      ? 0
      : await push.send(payload, notificationProfileId, activeDevice(notificationProfileId));
    response.json({ sent: true, devices });
    if (permissionRestart?.threadId) schedulePermissionRestart(sessionId, permissionRestart);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/dismiss-waiting", async (request, response, next) => {
  try { const id = request.params.id; if (!validSessionId(id) || !sessionOwned(request.profile.id, id)) return response.status(404).json({ error: "Agent introuvable." }); const current = store.get(id); if (!current) return response.status(404).json({ error: "Agent introuvable." }); promptWatcher.dismiss(id); if (current.agentState === "waiting") await store.set(id, { ...current, agentState: "available", agentStateUpdatedAt: new Date().toISOString() }); response.json({ ok: true }); } catch (error) { next(error); }
});

app.get("/api/sessions/:id/autonomy", (request, response, next) => {
  try {
    const id = request.params.id;
    if (!validSessionId(id) || !sessionVisible(request.profile.id, id)) return response.status(404).json({ error: "Agent introuvable." });
    response.set("Cache-Control", "no-store").json({ autonomy: autonomousAgents.view(id) });
  } catch (error) { next(error); }
});

app.patch("/api/sessions/:id/autonomy", async (request, response, next) => {
  try {
    const id = request.params.id;
    if (!validSessionId(id) || !sessionOwned(request.profile.id, id)) return response.status(404).json({ error: "Agent introuvable." });
    response.json({ autonomy: await autonomousAgents.update(id, request.body || {}, { projectAllowed: (projectId) => projectVisible(request.profile.id, projectId) }) });
  } catch (error) { next(error); }
});

// Read only the transcript explicitly bound to this agent; never guess by cwd.
app.get("/api/sessions/:id/conversation", async (request, response, next) => {
  try {
    const id = request.params.id;
    if (!validSessionId(id) || !sessionVisible(request.profile.id, id)) return response.status(404).json({ error: "Agent introuvable." });
    let metadata = store.get(id);
    const session = (await tmux.list()).find((item) => item.id === id);
    if (session?.assistant === "antigravity" && session.panePid) {
      const activeConv = await usage.discoverAntigravityConversation(session.panePid, session.cwd);
      if (activeConv && activeConv !== metadata?.conversationId) {
        metadata = { ...metadata, conversationId: activeConv };
        await store.set(id, metadata);
      }
    }
    const pane = await tmux.capture(id).catch(() => "");
    const state = agentStatus(metadata, metadata, promptWatcher.isWaiting(id), Date.now(), pane).state;
    const result = await readAgentConversation(metadata, { handover, agentMap, working: state === "working" });
    const quotaProvider = session?.assistant === "claude-design" ? "claude" : session?.assistant;
    const quota = ["codex", "claude", "antigravity"].includes(quotaProvider) ? providerState.get(quotaProvider) || null : null;
    const subagents = metadata.transcriptPath ? await subagentReader.list(metadata.transcriptPath) : [];
    response.set("Cache-Control", "no-store").json({ ...result, quota, subagents, autonomy: autonomousAgents.view(id), contextEvents: metadata.contextEvents || [], contextTransition: Date.now() - Date.parse(metadata.contextTransition?.startedAt || 0) < CONTEXT_TRANSITION_MAX_MS ? metadata.contextTransition : null, activity: state === "working" ? liveActivity(pane) : "" });
  } catch (error) { next(error); }
});

app.get("/api/sessions", async (request, response, next) => {
  try {
    const sessions = (await tmux.list()).filter((session) => sessionVisible(request.profile.id, session.id));
    const enriched = await Promise.all(sessions.map(async (session) => {
      let metadata = store.get(session.id) || {};
      let updatedMetadata = false;
      if (session.assistant === "codex" && !metadata.threadId) {
        const threadId = await usage.discoverCodexThread(session.panePid);
        if (threadId) {
          metadata = { ...metadata, threadId };
          updatedMetadata = true;
        }
      }
      if (["claude", "claude-design"].includes(session.assistant) && !metadata.transcriptPath) {
        const transcriptPath = await usage.discoverClaudeTranscript(session.cwd, metadata.agentSessionId);
        if (transcriptPath) {
          metadata = { ...metadata, transcriptPath };
          updatedMetadata = true;
        }
      }
      if (session.assistant === "antigravity") {
        const conversationId = await usage.discoverAntigravityConversation(session.panePid, session.cwd);
        if (conversationId && conversationId !== metadata.conversationId) {
          metadata = { ...metadata, conversationId };
          updatedMetadata = true;
        }
      }
      if (updatedMetadata) {
        await store.set(session.id, metadata);
      }
      const project = session.projectId ? projects.get(session.projectId) : null;
      const owner = profileService.resolve(session.profileId);
      const pane = await tmux.capture(session.id);
      const enrichedSession = { ...session, canEdit: session.profileId === request.profile.id, owner: { id: owner.id, name: owner.name }, project: project ? { id: session.projectId, name: project.name } : null, logoUrl: logoUrl(session, request.profile.id), agentStatus: withSubagents(agentStatus(session, metadata, promptWatcher.isWaiting(session.id), Date.now(), pane), metadata.transcriptPath ? await subagentReader.list(metadata.transcriptPath) : []), usage: await usage.get({ ...session, ...metadata }, pane) };
      return { ...enrichedSession, contextAdvice: contextAdvice(enrichedSession) };
    }));
    // Les quotas sont ceux du compte: on préserve le relevé direct (live) s'il existe.
    let codexState = providerState.get("codex");
    if (!codexState?.windows?.length || codexState.source === "session") {
      const codexWindows = new Map();
      for (const session of enriched) {
        if (session.assistant !== "codex") continue;
        for (const window of session.usage?.rateWindows || []) {
          const current = codexWindows.get(window.windowMinutes);
          const fresher = !current || String(window.resetsAt) > String(current.resetsAt);
          if (fresher) codexWindows.set(window.windowMinutes, window);
        }
      }
      for (const window of codexState?.windows || []) {
        const current = codexWindows.get(window.windowMinutes);
        const fresher = !current || String(window.resetsAt) > String(current.resetsAt);
        if (fresher) codexWindows.set(window.windowMinutes, window);
      }
      const codexQuota = [...codexWindows.values()].sort((left, right) => (left.windowMinutes || 0) - (right.windowMinutes || 0));
      if (codexQuota.length && JSON.stringify(codexQuota) !== JSON.stringify(codexState?.windows || [])) {
        await providerState.set("codex", { windows: codexQuota, source: "session", updatedAt: new Date().toISOString() });
        codexState = providerState.get("codex");
      }
    }
    response.json({
      assistants: installedAssistants,
      sessions: enriched,
      quotas: {
        codex: codexState?.windows?.length
          ? refreshExpiredQuota({ remainingPercent: codexState.windows[0].remainingPercent, resetsAt: codexState.windows[0].resetsAt, windowMinutes: codexState.windows[0].windowMinutes, windows: codexState.windows, updatedAt: codexState.updatedAt, source: codexState.source })
          : null,
        claude: refreshExpiredQuota(providerState.get("claude")) || null,
        antigravity: refreshExpiredQuota(providerState.get("antigravity")) || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/suggest-description", async (request, response, next) => {
  try {
    const name = String(request.query?.name || "").trim();
    const assistant = String(request.query?.assistant || "").trim();
    const cwd = String(request.query?.cwd || "").trim();
    const projectId = String(request.query?.projectId || "").trim();
    const project = projectId ? projects.get(projectId) : null;
    const description = await suggestAgentDescription({
      name,
      assistant,
      cwd,
      projectName: project?.name || null,
      localLlm,
    });
    response.json({ description });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", async (request, response, next) => {
  try {
    if (request.body?.projectId && !projectVisible(request.profile.id, request.body.projectId)) throw new Error("Projet introuvable.");
    if (installedAssistants[request.body?.assistant] === false) throw new Error(`${assistantLabel(request.body?.assistant)} n'est pas installé sur ce PC.`);
    const project = request.body?.projectId ? projects.get(request.body.projectId) : null;
    const shared = request.body?.shared === undefined ? Boolean(project?.shared) : Boolean(request.body.shared);
    const description = request.body?.description?.trim() || await suggestAgentDescription({
      name: request.body?.name,
      assistant: request.body?.assistant,
      model: request.body?.model,
      cwd: request.body?.cwd,
      projectName: project?.name || null,
      localLlm,
    });
    const projectLogo = request.body?.projectLogo !== undefined
      ? Boolean(request.body.projectLogo)
      : Boolean(request.body?.projectId);
    const cwd = await resolveAgentDirectory({ cwd: request.body?.cwd, name: request.body?.name, project, workspaceRoot });
    const wantsAutonomy = request.body?.autonomy?.enabled === true;
    if (wantsAutonomy && !AUTONOMY_ASSISTANTS.includes(request.body?.assistant)) throw new Error("Autonomie réservée aux agents Claude et Codex.");
    if (wantsAutonomy && request.body.autonomy.watch?.projectIds?.some((id) => !projectVisible(request.profile.id, id))) throw new Error("Projet introuvable.");
    response.status(201).json({ session: await tmux.create({ ...(request.body || {}), cwd, projectLogo, description, profileId: request.profile.id, shared, autonomy: wantsAutonomy ? newAutonomy(request.body.autonomy) : null }) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent/question-status", async (request, response, next) => { try { response.json(await aiJobs.run(AiJobs.key("questions", request.body?.questions), async () => ({ answered: await answeredQuestions(request.body?.questions) }))); } catch (error) { next(error); } });

app.post("/api/agent/recap-prompt", async (request, response, next) => {
  try {
    const text = request.body?.text ? String(request.body.text) : "";
    response.json(await aiJobs.run(AiJobs.key("recap", request.body?.kind, text), () => summarizeRequestPrompt({ text, kind: request.body?.kind, cacheFile: path.join(dataDir, "prompt-recaps.json") })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/claude-design", async (request, response, next) => {
  try {
    const callerSessionId = request.body?.callerSessionId ? String(request.body.callerSessionId) : null;
    if (callerSessionId && (!validSessionId(callerSessionId) || !sessionOwned(request.profile.id, callerSessionId))) {
      throw new Error("Agent appelant introuvable.");
    }
    const cwd = request.body?.cwd ? String(request.body.cwd) : null;
    response.json(await claudeDesignTool.run({ callerSessionId, cwd, prompt: request.body?.prompt }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-tools/agents", async (request, response, next) => {
  try {
    const agents = await agentCommunication.list({ profileId: request.profile.id });
    response.json({ agents });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-tools/agents/:target/context", async (request, response, next) => {
  try {
    const data = await agentCommunication.context(request.params.target, { profileId: request.profile.id });
    response.json(data);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/agents/:target/send", async (request, response, next) => {
  try {
    const callerSessionId = request.body?.callerSessionId ? String(request.body.callerSessionId) : null;
    const callerName = request.body?.callerName ? String(request.body.callerName) : null;
    const result = await agentCommunication.send(request.params.target, {
      message: request.body?.message,
      callerSessionId,
      callerName,
      profileId: request.profile.id,
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/agents/create", async (request, response, next) => {
  try {
    const callerSessionId = request.body?.callerSessionId ? String(request.body.callerSessionId) : null;
    const callerName = request.body?.callerName ? String(request.body.callerName) : null;
    const result = await agentCommunication.create({
      name: request.body?.name,
      assistant: request.body?.assistant,
      model: request.body?.model,
      projectId: request.body?.projectId,
      projectName: request.body?.projectName,
      cwd: request.body?.cwd,
      prompt: request.body?.prompt,
      yolo: request.body?.yolo,
      description: request.body?.description,
      callerSessionId,
      callerName,
      profileId: request.profile.id,
    });
    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/agents/:target/assign-project", async (request, response, next) => {
  try {
    const projectTarget = request.body?.project || request.body?.projectId || request.body?.projectName;
    const result = await agentCommunication.assignProject(request.params.target, projectTarget, { profileId: request.profile.id });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/agents/:target/stop", async (request, response, next) => {
  try {
    const result = await agentCommunication.stop(request.params.target, { profileId: request.profile.id });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/agent-tools/agents/:target/aliases", async (request, response, next) => {
  try {
    response.json(await agentCommunication.addAlias(request.params.target, request.body?.alias, { profileId: request.profile.id }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-tools/agents/:target/memory", async (request, response, next) => {
  try {
    response.json(await agentCommunication.readMemory(request.params.target, { profileId: request.profile.id }));
  } catch (error) { next(error); }
});

app.put("/api/agent-tools/agents/:target/memory", async (request, response, next) => {
  try {
    response.json(await agentCommunication.writeMemory(request.params.target, request.body || {}, { profileId: request.profile.id }));
  } catch (error) { next(error); }
});



app.get("/api/sessions/:id/logo", async (request, response, next) => {
  try {
    const session = store.get(request.params.id);
    if (!session?.projectLogo || !sessionVisible(request.profile.id, request.params.id)) return response.status(404).end();
    const file = (session.projectId ? await projectLogoFile(session.projectId) : null) || await projectLogos.find(session.cwd).catch(() => null);
    if (!file) return response.status(404).end();
    response.setHeader("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800");
    response.vary("Cookie"); response.vary("Authorization");
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
    const yolo = ["codex", "claude", "claude-design", "antigravity"].includes(session.assistant)
      ? (request.body?.yolo === undefined ? Boolean(current.yolo) : Boolean(request.body.yolo))
      : false;
    const projectLogo = request.body?.projectLogo === undefined ? Boolean(current.projectLogo) : Boolean(request.body.projectLogo);
    const projectId = request.body?.projectId === undefined ? current.projectId || null : request.body.projectId || null;
    const favorite = request.body?.favorite === undefined ? Boolean(current.favorite) : Boolean(request.body.favorite);
    const shared = request.body?.shared === undefined ? Boolean(current.shared) : Boolean(request.body.shared);
    const todoTracking = request.body?.todoTracking === undefined ? current.todoTracking !== false : Boolean(request.body.todoTracking);
    const description = request.body?.description === undefined
      ? (current.description || null)
      : (String(request.body.description).trim().slice(0, 1000) || null);
    if (projectId && !projectVisible(request.profile.id, projectId)) throw new Error("Projet introuvable.");
    const assistant = request.body?.assistant;
    if (assistant && assistant !== session.assistant) {
      if (!["codex", "claude", "antigravity"].includes(assistant) || !["codex", "claude", "antigravity"].includes(session.assistant)) throw new Error("Bascule réservée aux agents conversationnels.");
      if (installedAssistants[assistant] === false) throw new Error(`${assistantLabel(assistant)} n'est pas installé sur ce PC.`);
      const metadata = { ...current, name, description, yolo, projectLogo, projectId, favorite, shared, todoTracking };
      const { prompt, history } = await handoverPrompt({ session, metadata, target: assistant });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target: assistant, prompt, replace: true });
      return response.json({ session: { ...created, logoUrl: logoUrl(created) }, switched: true, history, restarted: true, pending: false });
    }
    let next = { ...current, name, description, yolo, projectLogo, projectId, favorite, shared, todoTracking };
    const permissionChanged = ["codex", "claude", "claude-design", "antigravity"].includes(session.assistant) && yolo !== Boolean(current.runningYolo);
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
const ASSISTANT_LABELS = { codex: "Codex", claude: "Claude", "claude-design": "Claude Design", antigravity: "Antigravity", shell: "Terminal" };
// Un agent a bout de quota repond son message de limite au lieu du recapitulatif demande.
const QUOTA_REPLY = /usage limit|limite d'utilisation|rate limit|individual quota reached|resource_exhausted|quota (atteint|reached|exceeded|depasse|dépassé)|try again (at|in)|upgrade (to pro|your subscription)|plan limit|out of credits/i;

function usableRecap(message) {
  const text = String(message || "").trim();
  if (text.length < 40 || QUOTA_REPLY.test(text)) return null;
  return text;
}

function assistantLabel(assistant) {
  return ASSISTANT_LABELS[assistant] || assistant;
}

function assistantIcon(assistant) {
  if (assistant === "claude-design") return "/agents/claude.png";
  return ["codex", "claude", "shell", "antigravity"].includes(assistant) ? `/agents/${assistant}.png` : null;
}

async function notificationIcon(sessionId) {
  if (!sessionId || !validSessionId(sessionId)) return null;
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (!entry.projectLogo) return assistantIcon(entry.assistant);
  const file = (entry.projectId ? await projectLogoFile(entry.projectId) : null) || await projectLogos.find(entry.cwd).catch(() => null);
  return file ? `/notification-icon/${encodeURIComponent(sessionId)}.png` : assistantIcon(entry.assistant);
}

async function sourceQuotaRemaining(session, metadata) {
  if (session.assistant === "codex") {
    const info = await usage.get({ ...session, ...metadata }, await tmux.capture(session.id));
    return Number.isFinite(info?.rateRemainingPercent) ? info.rateRemainingPercent : null;
  }
  const provider = providerState.get(session.assistant === "claude-design" ? "claude" : session.assistant);
  const values = session.assistant === "antigravity"
    ? (provider?.windows || []).map((window) => window.remainingPercent).filter((value) => Number.isFinite(value))
    : [provider?.fiveHour?.remainingPercent, provider?.sevenDay?.remainingPercent].filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

async function handoverPrompt({ session, metadata, target }) {
  const transcript = await handover.prompt({
    assistant: session.assistant,
    target,
    threadId: metadata.threadId,
    agentSessionId: metadata.agentSessionId,
    conversationId: metadata.conversationId,
    cwd: session.cwd,
    strict: true,
  });
  if (transcript) return { prompt: transcript, history: true };
  return {
    prompt: `Tu reprends le travail d'un agent ${assistantLabel(session.assistant)} dans ${session.cwd}. Aucun historique lisible n'a été retrouvé: inspecte le dépôt, le git log et les fichiers modifiés pour comprendre l'état, puis attends la prochaine demande de l'utilisateur.`,
    history: false,
  };
}

async function spawnHandoverSession({ sessionId, session, metadata, target, prompt, replace = false }) {
  let conversationHistory = [];
  if (replace) {
    await agentMemory.capture(sessionId, metadata);
    conversationHistory = (await readAgentConversation(metadata, { handover, agentMap }).catch(() => ({ messages: metadata.conversationHistory || [] }))).messages;
  }
  const created = await tmux.create({
    name: replace ? metadata.name || session.name : `${metadata.name || session.name} · ${assistantLabel(target)}`,
    assistant: target,
    cwd: session.cwd,
    replaceId: replace ? sessionId : null,
    migratedFrom: replace ? metadata.migratedFrom : sessionId,
    description: metadata.description,
    yolo: Boolean(metadata.yolo),
    projectLogo: Boolean(metadata.projectLogo),
    projectId: metadata.projectId || null,
    profileId: metadata.profileId || primaryProfileId,
    shared: Boolean(metadata.shared),
    favorite: Boolean(metadata.favorite),
    prompt,
  });
  const switchedAt = new Date().toISOString();
  await store.set(created.id, { ...store.get(created.id), ...(replace ? { conversationHistory, contextEvents: [...(metadata.contextEvents || []), { kind: "switch", from: session.assistant, to: target, at: switchedAt }].slice(-30) } : {}), contextTransition: null, switchedFrom: session.assistant, switchedAt });
  if (!replace) await store.set(sessionId, { ...store.get(sessionId), migrationState: "complete", migrationTarget: target, migratedTo: created.id });
  return { ...store.get(created.id), id: created.id, managed: true };
}

app.post("/api/sessions/:id/migrate", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const session = (await tmux.list()).find((item) => item.id === request.params.id);
    if (!session || !["codex", "claude", "antigravity"].includes(session.assistant)) throw new Error("Bascule réservée aux agents conversationnels.");
    const target = request.body?.target || (session.assistant === "codex" ? "claude" : "codex");
    if (!["codex", "claude", "antigravity"].includes(target) || target === session.assistant) throw new Error("Fournisseur cible invalide.");
    if (installedAssistants[target] === false) throw new Error(`${assistantLabel(target)} n'est pas installé sur ce PC.`);
    const metadata = store.get(session.id) || {};
    const mode = ["auto", "agent", "transcript"].includes(request.body?.mode) ? request.body.mode : "auto";
    await store.set(session.id, { ...store.get(session.id), contextTransition: { kind: "switch", from: session.assistant, to: target, startedAt: new Date().toISOString() } });
    const pending = migrations.get(session.id);
    // Bascule directe depuis l'historique des fichiers locaux par défaut (auto / transcript)
    // sans consommer de tokens sur un récapitulatif superflu.
    if (mode !== "agent" || pending) {
      if (pending) {
        clearTimeout(pending.timer);
        migrations.delete(session.id);
      }
      const { prompt, history } = await handoverPrompt({ session, metadata, target });
      const created = await spawnHandoverSession({ sessionId: session.id, session, metadata, target, prompt, replace: true });
      return response.status(201).json({ ok: true, state: "complete", mode: "transcript", history, target, session: { ...created, logoUrl: logoUrl(created) } });
    }
    const remaining = await sourceQuotaRemaining(session, metadata);
    const paneQuotaExhausted = QUOTA_REPLY.test(await tmux.capture(session.id).catch(() => ""));
    if (session.assistant === "antigravity" || paneQuotaExhausted || (Number.isFinite(remaining) && remaining <= QUOTA_EXHAUSTED_PERCENT)) {
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
          title: agentNotificationTitle(metadata.projectId ? projects.get(metadata.projectId)?.name : metadata.name, `Contexte repris par ${assistantLabel(target)}`),
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
    await tmux.submit(session.id, `Prépare passation vers ${assistantLabel(target)}. Réponds uniquement avec récapitulatif autonome et compact: objectif, décisions, fichiers modifiés, état actuel, tests, commandes utiles, blocages, prochaines étapes. N'effectue aucune autre action.`);
    response.status(202).json({ ok: true, state: "summarizing", target });
  } catch (error) {
    migrations.delete(request.params.id);
    const current = store.get(request.params.id);
    if (current?.contextTransition) await store.set(request.params.id, { ...store.get(request.params.id), contextTransition: null });
    if (current?.migrationState === "summarizing") await store.set(request.params.id, { ...store.get(request.params.id), migrationState: "failed", migrationError: error.message });
    next(error);
  }
});

// Coupure d'une tache en cours depuis n'importe quel ecran: la touche d'echappement suffit aux agents.
async function interruptSession(id) {
  const current = store.get(id);
  if (!current) throw new Error("Session Noyau introuvable.");
  await tmux.run(["send-keys", "-t", id, current.assistant === "shell" ? "C-c" : "Escape"]);
  return true;
}

app.post("/api/sessions/:id/interrupt", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    await interruptSession(request.params.id);
    response.json({ ok: true });
  } catch (error) {
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
    await tmux.restartAgent({ id: request.params.id, assistant: current.assistant, model: current.model, cwd: current.cwd, threadId, yolo: Boolean(current.yolo) });
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

// Same agent, empty context: requests, last answer and displayed history all survive.
app.post("/api/sessions/:id/fresh", async (request, response, next) => {
  try {
    const id = request.params.id;
    if (!sessionOwned(request.profile.id, id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(id);
    if (!current) throw new Error("Session Noyau introuvable.");
    if (current.assistant === "shell") throw new Error("Un terminal n'a pas de contexte à renouveler.");
    const pane = await tmux.capture(id).catch(() => "");
    const wasWorking = paneAgentState(pane) === "working" || current.agentState === "working";
    const subagents = await subagentReader.list(current.transcriptPath).catch(() => []);
    // Stop the running turn first, so its last messages reach the transcript before the process is replaced.
    if (wasWorking) {
      await interruptSession(id).catch(() => {});
      for (let attempt = 0; attempt < 8 && paneAgentState(await tmux.capture(id).catch(() => "")) === "working"; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    const { messages } = await readAgentConversation(current, { handover, agentMap, working: false });
    const git = (args) => execFileAsync("git", ["-C", current.cwd, ...args], { timeout: 5000 }).then(({ stdout }) => stdout, () => "");
    const [gitStatus, gitLog, todoView] = await Promise.all([git(["status", "--short"]), git(["log", "--oneline", "-5"]), current.projectId ? todosView(request.profile).catch(() => null) : null]);
    const todos = (todoView?.todos || []).filter((todo) => todo.projectId === current.projectId && !["done", "archived"].includes(todo.status));
    await tmux.restartAgent({ id, assistant: current.assistant, model: current.model, cwd: current.cwd, threadId: null, yolo: Boolean(current.yolo), resume: false });
    const { threadId, agentSessionId, transcriptPath, conversationId, ...kept } = store.get(id) || current;
    await store.set(id, { ...kept, conversationHistory: messages, runningYolo: Boolean(current.yolo), contextTransition: { kind: "fresh", startedAt: new Date().toISOString() }, agentState: "working", agentStateUpdatedAt: new Date().toISOString() });
    response.json({ ok: true });
    // Answered already: the new process needs some seconds before it accepts input.
    void (async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        if (attempt >= 3 && paneAgentState(await tmux.capture(id).catch(() => "")) === "available") break;
      }
      await tmux.submit(id, freshStartPrompt({ messages, name: current.name, transcriptPath: current.transcriptPath || null, wasWorking, gitStatus, gitLog, todos, subagents }));
      const latest = store.get(id) || {};
      await store.set(id, { ...latest, contextTransition: null, contextEvents: [...(latest.contextEvents || []), { kind: "fresh", at: new Date().toISOString() }].slice(-30) });
    })().catch(async (error) => {
      console.warn(`Reprise à neuf ${id}: ${error.message}`);
      await store.set(id, { ...store.get(id), contextTransition: null });
    });
  } catch (error) {
    next(error);
  }
});

async function purgeProviderHistories() {
  const home = os.homedir();
  let count = 0;

  // 1. Claude
  try {
    const pDir = path.join(home, ".claude", "projects");
    const entries = await fs.readdir(pDir, { recursive: true }).catch(() => []);
    for (const e of entries) {
      if (e.endsWith(".jsonl")) {
        await fs.unlink(path.join(pDir, e)).catch(() => {});
        count += 1;
      }
    }
    await fs.writeFile(path.join(home, ".claude", "history.jsonl"), "").catch(() => {});
    const sDir = path.join(home, ".claude", "sessions");
    for (const e of await fs.readdir(sDir).catch(() => [])) {
      await fs.rm(path.join(sDir, e), { recursive: true, force: true }).catch(() => {});
      count += 1;
    }
  } catch {}

  // 2. Codex
  try {
    const cDir = path.join(home, ".codex", "sessions");
    const entries = await fs.readdir(cDir, { recursive: true }).catch(() => []);
    for (const e of entries) {
      if (e.endsWith(".jsonl")) {
        await fs.unlink(path.join(cDir, e)).catch(() => {});
        count += 1;
      }
    }
    await fs.writeFile(path.join(home, ".codex", "history.jsonl"), "").catch(() => {});
    await fs.writeFile(path.join(home, ".codex", "session_index.jsonl"), "").catch(() => {});
    const codexRoot = path.join(home, ".codex");
    for (const f of await fs.readdir(codexRoot).catch(() => [])) {
      if (f.startsWith("thread_history_") || f.startsWith("logs_") || f.startsWith("memories_")) {
        await fs.rm(path.join(codexRoot, f), { force: true }).catch(() => {});
        count += 1;
      }
    }
  } catch {}

  // 3. Antigravity
  try {
    const agyRoot = path.join(home, ".gemini", "antigravity-cli");
    const convDir = path.join(agyRoot, "conversations");
    for (const f of await fs.readdir(convDir).catch(() => [])) {
      await fs.rm(path.join(convDir, f), { force: true }).catch(() => {});
      count += 1;
    }
    const brainDir = path.join(agyRoot, "brain");
    for (const b of await fs.readdir(brainDir).catch(() => [])) {
      await fs.rm(path.join(brainDir, b), { recursive: true, force: true }).catch(() => {});
      count += 1;
    }
    await fs.writeFile(path.join(agyRoot, "history.jsonl"), "").catch(() => {});
    for (const f of ["conversation_summaries.db", "conversation_summaries.db-shm", "conversation_summaries.db-wal"]) {
      await fs.rm(path.join(agyRoot, f), { force: true }).catch(() => {});
    }
  } catch {}

  return count;
}

app.post("/api/sessions/clear-history", async (request, response, next) => {
  try {
    const password = String(request.body?.password || "");
    if (!password) {
      return response.status(400).json({ error: "Mot de passe requis pour confirmer la suppression." });
    }
    const authenticated = profileService.authenticate(password, request.profile.id, accessToken);
    if (!authenticated) {
      return response.status(401).json({ error: "Mot de passe incorrect pour ce profil." });
    }

    const sessions = (await tmux.list()).filter((session) => sessionVisible(request.profile.id, session.id));
    let clearedCount = 0;
    await agentMemory.clearProfileContext(request.profile.id);

    for (const session of sessions) {
      const metadata = store.get(session.id) || {};
      if (metadata.cwd) await agentMemory.clearContext(session.id, metadata);

      const transcriptPath = metadata.transcriptPath || await usage.discoverClaudeTranscript(session.cwd, metadata.agentSessionId);
      if (transcriptPath) {
        try { await fs.truncate(transcriptPath, 0); } catch {}
      }

      const threadId = metadata.threadId || (session.panePid ? await usage.discoverCodexThread(session.panePid) : null);
      if (threadId) {
        const file = await usage.codexFile(threadId);
        if (file) {
          try { await fs.truncate(file, 0); } catch {}
        }
      }

      const conversationId = metadata.conversationId || (session.panePid ? await usage.discoverAntigravityConversation(session.panePid, session.cwd) : null);
      if (conversationId) {
        const transcriptFile = path.join(usage.antigravityRoot, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
        const fullTranscriptFile = path.join(usage.antigravityRoot, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
        try { await fs.truncate(transcriptFile, 0); } catch {}
        try { await fs.truncate(fullTranscriptFile, 0); } catch {}
      }

      const updatedMetadata = { ...metadata };
      delete updatedMetadata.threadId;
      delete updatedMetadata.agentSessionId;
      delete updatedMetadata.transcriptPath;
      delete updatedMetadata.conversationId;
      delete updatedMetadata.conversationHistory;
      updatedMetadata.agentState = "available";
      updatedMetadata.agentStateUpdatedAt = new Date().toISOString();
      await store.set(session.id, updatedMetadata);

      await tmux.restartAgent({
        id: session.id,
        assistant: session.assistant,
        cwd: session.cwd,
        threadId: null,
        yolo: Boolean(metadata.yolo),
        resume: false,
      }).catch(() => {});

      await tmux.clearHistory(session.id);

      clearedCount += 1;
    }

    const allArchives = await agentArchiveService.read();
    const remainingArchives = [];
    let purgedArchivesCount = 0;
    for (const item of allArchives) {
      const isTarget = item.profileId === request.profile.id || item.shared === true || (item.projectId && projectVisible(request.profile.id, item.projectId));
      if (isTarget) {
        if (item.cwd) await agentMemory.clearContext(item.id, item);
        purgedArchivesCount += 1;
        if (item.transcriptPath) {
          try { await fs.truncate(item.transcriptPath, 0); } catch {}
        }
        if (item.threadId) {
          const file = await usage.codexFile(item.threadId);
          if (file) {
            try { await fs.truncate(file, 0); } catch {}
          }
        }
      } else {
        remainingArchives.push(item);
      }
    }
    if (purgedArchivesCount > 0) {
      await agentArchiveService.write(remainingArchives);
    }
    const purgedProviderFiles = await purgeProviderHistories();

    response.json({
      ok: true,
      clearedSessions: clearedCount,
      purgedArchives: purgedArchivesCount,
      purgedProviderFiles,
      message: `Historiques effacés pour ${clearedCount} session(s), ${purgedArchivesCount} archive(s) et ${purgedProviderFiles} fichier(s) de conversation.`,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/agents/archives", async (request, response, next) => {
  try {
    response.json({ archives: await agentArchiveService.list({ profileId: request.profile.id }) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/agents/archives/:id/restore", async (request, response, next) => {
  try {
    const session = await agentArchiveService.restore(request.params.id, { tmux, profileId: request.profile.id });
    response.status(201).json({ session, archives: await agentArchiveService.list({ profileId: request.profile.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/agents/archives/:id", async (request, response, next) => {
  try {
    const archived = await agentArchiveService.get(request.params.id);
    if (archived && archived.profileId !== request.profile.id) throw new Error("Agent archivé appartient à autre profil.");
    await agentArchiveService.remove(request.params.id);
    response.json({ archives: await agentArchiveService.list({ profileId: request.profile.id }) });
  } catch (error) {
    next(error);
  }
});

// Optimisation du contexte: on tape la commande dans le pane, l'agent garde la main sur le resultat.
app.post("/api/sessions/:id/optimize", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    const mode = request.body?.mode === "clear" ? "clear" : "compact";
    const command = optimizeCommand(current.assistant, mode);
    await tmux.submit(request.params.id, command, { force: true });
    response.json({ ok: true, mode, command });
  } catch (error) {
    next(error);
  }
});

// Un agent relit ses reglages au demarrage: la conversation, elle, reprend ou elle en etait.
async function restartWithSettings(id, current) {
  try {
    await tmux.restartAgent({ id, assistant: current.assistant, cwd: current.cwd, threadId: current.agentSessionId, model: current.model, yolo: Boolean(current.yolo) });
    return true;
  } catch {
    return false;
  }
}

// Analyse du poids d'un agent: plugins, skills et serveurs MCP jamais utilises dans ce projet.
app.post("/api/sessions/:id/context-audit", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    if (!["claude", "claude-design", "codex", "antigravity"].includes(current.assistant)) throw new Error("Analyse disponible pour les agents Claude, Codex et Antigravity.");
    const result = await contextAudit.audit(current.cwd, agentSettingsFile(request.params.id), current.assistant);
    auditCatalog.set(request.params.id, result.proposals);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/context-audit/apply", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    const catalog = auditCatalog.get(request.params.id);
    if (!catalog) throw new Error("Relance l'analyse avant d'appliquer.");
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(String) : [];
    const applied = await contextAudit.apply(current.cwd, ids, catalog, agentSettingsFile(request.params.id));
    // Les reglages ne sont lus qu'au demarrage: sans relance, l'allegement resterait theorique.
    const restarted = await restartWithSettings(request.params.id, current);
    response.json({ ...applied, restarted });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/context-audit/revert", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    const reverted = await contextAudit.revert(current.cwd, agentSettingsFile(request.params.id));
    const restarted = await restartWithSettings(request.params.id, current);
    response.json({ ...reverted, restarted });
  } catch (error) {
    next(error);
  }
});

async function archiveSession(id, current) {
  if (current.core) throw new Error("Agent de base du Noyau: non archivable.");
  await agentMemory.capture(id, current);
  // On garde le fil de discussion avant de fermer, sinon la restauration repartirait de zero.
  let threadId = current.threadId || null;
  if (!threadId && current.assistant === "codex") {
    const live = (await tmux.list()).find((item) => item.id === id);
    threadId = live ? await usage.discoverCodexThread(live.panePid).catch(() => null) : null;
  }
  const archived = await agentArchiveService.archive(id, { ...current, threadId }, { reason: "closed" });
  await tmux.kill(id);
  return archived;
}

app.post("/api/sessions/:id/archive", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    const current = store.get(request.params.id);
    if (!current) throw new Error("Session Noyau introuvable.");
    const archived = await archiveSession(request.params.id, current);
    response.json({ archived, archives: await agentArchiveService.list({ profileId: request.profile.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:id", async (request, response, next) => {
  try {
    if (!sessionOwned(request.profile.id, request.params.id)) throw new Error("Agent appartient à autre profil.");
    if (store.get(request.params.id)?.core) throw new Error("Agent de base du Noyau: non supprimable.");
    // « Quitter totalement »: pas d'archive, et tout ce que l'agent a lance (hors applis graphiques) s'arrete aussi.
    if (request.query.archive === "0") {
      const { kill } = await sessionProcesses(await processTable(), request.params.id, await listPanePids(request.params.id));
      await tmux.kill(request.params.id);
      await terminateProcesses(kill);
      return response.status(204).end();
    }
    // La fermeture manuelle passe aussi par l'archive: on peut toujours revenir sur le fil de discussion.
    await agentArchiveService.archive(request.params.id, store.get(request.params.id) || {}, { reason: "closed" }).catch(() => {});
    await tmux.kill(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({ error: `Fichier trop volumineux (taille maximale autorisée : ${MAX_UPLOAD_MB} Mo).` });
  }
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 400;
  if (error.retryAfter) response.setHeader("Retry-After", String(error.retryAfter));
  response.status(status).json({ error: error.message || "Erreur serveur.", ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist"), { index: false, setHeaders: staticCacheHeaders }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) return next();
    // Asset hashe absent (rebuild) => 404, sinon le navigateur recoit du HTML comme module JS et l'app reste blanche.
    if (request.path.startsWith("/assets/") || path.extname(request.path)) return response.status(404).type("text/plain").send("Not found");
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

const voiceSockets = new WebSocketServer({ noServer: true });

// Micro du navigateur: le poste qui pilote envoie son son, la machine de Noyau transcrit.
voiceSockets.on("connection", (websocket) => {
  void voiceService.startStream().then((state) => {
    broadcastVoice({ type: "state", state });
    if (!state.listening) websocket.close();
  });
  websocket.on("message", (raw, isBinary) => { if (isBinary) voiceService.pushAudio(raw); });
  websocket.on("close", () => {
    if (voiceService.state().source !== "browser") return;
    broadcastVoice({ type: "state", state: voiceService.stop() });
  });
});

async function upgradeTerminal(request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const secure = Boolean(request.socket.encrypted);
  const nativeTicket = secure && NATIVE_ORIGINS.has(request.headers.origin) ? nativeWebSocketTickets.take(url.searchParams.get("ticket"), url.pathname) : null;
  const verified = nativeTicket || authenticated(request);
  const requestedProfileId = url.searchParams.get("profile");
  const profile = verified ? profileService.resolve(nativeTicket?.profileId || request.sessionProfileId) : null;
  const profileMatches = !requestedProfileId || requestedProfileId === profile?.id;
  if (url.pathname === "/ws/voice") {
    const allowed = secure && (nativeTicket || sameWebSocketOrigin({ origin: request.headers.origin, host: request.headers.host, secure })) && verified && profileMatches;
    if (!allowed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    request.profileId = profile.id;
    voiceSockets.handleUpgrade(request, socket, head, (websocket) => voiceSockets.emit("connection", websocket, request));
    return;
  }
  const match = url.pathname.match(/^\/ws\/terminal\/([a-zA-Z0-9_-]+)$/);
  const validOrigin = nativeTicket || sameWebSocketOrigin({ origin: request.headers.origin, host: request.headers.host, secure });
  if (!match || !secure || !validOrigin || !verified || !profileMatches || !sessionVisible(profile.id, match[1]) || !(await tmux.exists(match[1]))) {
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

// Dernier numero de frappe traite par client terminal, pour dedoublonner les renvois apres coupure.
const terminalInputSeq = new Map();
setInterval(() => {
  const limit = Date.now() - 6 * 60 * 60 * 1000;
  for (const [client, entry] of terminalInputSeq) if (entry.at < limit) terminalInputSeq.delete(client);
}, 30 * 60 * 1000).unref();

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
  const terminal = pty.spawn(tmux.binary, ["-u", "attach-session", "-t", `=${request.sessionId}`], {
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
  let socketClosed = false;
  if (!terminalClients.has(request.sessionId)) terminalClients.set(request.sessionId, new Set());
  terminalClients.get(request.sessionId).add(websocket);
  if (inputGate.pending(request.sessionId)) websocket.send(JSON.stringify({ type: "held", pending: inputGate.pending(request.sessionId) }));
  // Toute la saisie passe par tmux send-keys, dans un seul canal: avant, le texte allait au pty
  // et Entree/Retour par send-keys, et sous charge Entree doublait les dernieres lettres.
  const pendingTyping = [];
  const reply = (payload) => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify(payload));
  const drainTyping = async (leaveMobileCopyMode) => {
    const batch = pendingTyping.splice(0);
    if (socketClosed || !batch.length) return;
    let commands = [];
    let acks = [];
    let working = false;
    let lastSubmitText = "";
    const flush = async () => {
      try {
        if (commands.length) {
          await leaveMobileCopyMode();
          if (working) await setAgentState(request.sessionId, "working");
          for (const args of batchTmuxCommands(commands)) await tmux.run(args);
        }
      } finally {
        for (const payload of acks) reply(payload);
        commands = [];
        acks = [];
        working = false;
      }
    };
    for (const message of batch) {
      // Saisie numerotee: apres une coupure le client renvoie tout ce qui n'a pas ete accuse,
      // on saute ce qui est deja passe pour ne jamais taper deux fois.
      const tracked = typeof message.client === "string" && message.client.length <= 80 && Number.isSafeInteger(message.seq);
      const seen = tracked ? terminalInputSeq.get(message.client) : null;
      if (seen && message.seq <= seen.seq) {
        acks.push({ type: "ack", client: message.client, seq: seen.seq });
        continue;
      }
      // Marque avant d'ecrire: une vieille socket encore vivante ne retapera pas la meme frappe.
      if (tracked) terminalInputSeq.set(message.client, { seq: message.seq, at: Date.now() });
      const ack = tracked ? { type: "ack", client: message.client, seq: message.seq } : null;
      if (message.type === "input" && typeof message.data === "string") {
        let data = message.data.slice(0, 16384);
        const sessionMeta = store.get(request.sessionId);
        if (sessionMeta?.assistant && sessionMeta.assistant !== "shell" && data.includes("\x03")) {
          data = data.replaceAll("\x03", "");
          if (!data) continue;
        }
        commands.push(...literalKeyCommands(request.sessionId, data));
        if (/[\r\n]/.test(data)) working = true;
        const draft = draftAfterInput(data);
        if (draft !== null) inputGate.typed(request.sessionId, draft);
      } else if (message.type === "key" && specialKeys[message.key]) {
        commands.push(["send-keys", "-t", request.sessionId, specialKeys[message.key]]);
        if (message.key === "Enter") working = true;
        // The pane still decides if the agent keeps working; this only drops the remembered state.
        if (message.key === "Escape") void setAgentState(request.sessionId, "available");
        if (message.key === "Enter") inputGate.typed(request.sessionId, false);
        else if (message.key === "Backspace") inputGate.typed(request.sessionId, true);
        acks.push({ type: "key-ack", key: message.key });
      } else if (message.type === "submit" && typeof message.data === "string" && message.data.length) {
        const data = message.data.slice(0, 16384);
        lastSubmitText = data;
        commands.push(...literalKeyCommands(request.sessionId, data));
        working = true;
        inputGate.typed(request.sessionId, false);
        try { await flush(); } catch (error) { error.failedPrompt = data; throw error; }
        // Meme pause que pour une passation: l'agent doit avoir fini d'absorber le texte colle.
        await new Promise((resolve) => { setTimeout(resolve, data.length > 200 ? 600 : 350); });
        commands.push(["send-keys", "-t", request.sessionId, "C-m"]);
        acks.push({ type: "key-ack", key: "Enter" });
      }
      if (ack) acks.push(ack);
    }
    try { await flush(); } catch (error) { if (lastSubmitText) error.failedPrompt = lastSubmitText; throw error; }
  };
  websocket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      const leaveMobileCopyMode = async () => {
        if (!mobileCopyMode) return;
        mobileCopyMode = false;
        await tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]);
      };
      if (["input", "submit", "key"].includes(message.type)) {
        pendingTyping.push(message);
        if (pendingTyping.length === 1) keyQueue = keyQueue.then(() => drainTyping(leaveMobileCopyMode)).catch((error) => { reply({ type: "input-error", message: "Envoi au terminal échoué. Vérifiez le terminal avant de renvoyer.", text: error.failedPrompt || "" }); });
        if (message.type === "submit" && typeof message.data === "string" && message.data.length) trackComposerPrompt(request.sessionId, request.profileId, message.data.slice(0, 16384));
      }
      if (message.type === "scroll" && ["up", "down"].includes(message.direction)) {
        const count = Math.max(1, Math.min(80, Math.trunc(Number(message.count)) || 1));
        if (!mobileCopyMode && message.direction === "down") return;
        keyQueue = keyQueue
          .then(async () => {
            if (!mobileCopyMode) {
              if (message.direction === "up") {
                await tmux.run([
                  "copy-mode", "-t", request.sessionId,
                  ";",
                  "send-keys", "-X", "-N", String(count), "-t", request.sessionId, "scroll-up",
                ]);
                mobileCopyMode = true;
              }
              return;
            }
            if (message.direction === "up") {
              await tmux.run(["send-keys", "-X", "-N", String(count), "-t", request.sessionId, "scroll-up"]);
            } else {
              const res = await tmux.run([
                "send-keys", "-X", "-N", String(count), "-t", request.sessionId, "scroll-down",
                ";",
                "display-message", "-p", "-t", request.sessionId, "#{scroll_position}",
              ]);
              const position = Number(res?.stdout?.trim() ?? 1);
              if (position === 0) {
                await tmux.run(["send-keys", "-X", "-t", request.sessionId, "cancel"]).catch(() => {});
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
    socketClosed = true;
    terminalClients.get(request.sessionId)?.delete(websocket);
    if (!terminalClients.get(request.sessionId)?.size) terminalClients.delete(request.sessionId);
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
  console.log(`Noyau actif: ${secureServer ? "https" : "http"}://localhost:${port}`);
  for (const address of addresses) console.log(`Réseau/VPN: ${secureServer ? "https" : "http"}://${address}:${port}`);
});

if (secureServer) {
  const securePort = Number(process.env.NOYAU_HTTPS_PORT || 4243);
  const secureHost = process.env.NOYAU_HTTPS_HOST || host;
  secureServer.listen(securePort, secureHost, () => console.log(`Noyau HTTPS VPN: https://${secureHost}:${securePort}`));
}

promptWatcher.start();
claudeQuota.start();
antigravityQuota.start();
codexQuota.start();
quotaNotifier.start();
codexCapacityRetry.start();
autonomousAgents.start();
// Synchro bancaire du matin: une seule passe par profil et par jour, des 6h heure de Paris.
let morningSyncRunning = false;
async function morningBankSync() {
  if (morningSyncRunning) return;
  morningSyncRunning = true;
  try {
    const { date, hour } = parisNow();
    if (hour < 6) return;
    for (const profile of profileService.list()) {
      const runtime = await ensureProfileRuntime(profile.id);
      const state = runtime.enableBanking.store.get(AUTO_SYNC_KEY);
      if (state?.date === date) continue;
      if (!runtime.enableBanking.status().connections.length) continue;
      try {
        const result = await runtime.enableBanking.sync(null);
        const categorization = await runtime.financeService.categorizeTransactions({ month: currentMonthParis() }).catch(() => null);
        await runtime.enableBanking.store.set(AUTO_SYNC_KEY, {
          date,
          at: new Date().toISOString(),
          imported: result.imported || 0,
          updated: result.updated || 0,
          categorized: categorization?.categorized || 0,
          error: null,
        });
      } catch (error) {
        await runtime.enableBanking.store.set(AUTO_SYNC_KEY, { date, at: new Date().toISOString(), imported: 0, updated: 0, error: error.message });
        console.error(`Synchro bancaire ${profile.name}: ${error.message}`);
      }
    }
  } finally {
    morningSyncRunning = false;
  }
}

const morningSyncTimer = setInterval(() => { morningBankSync().catch(() => {}); }, 5 * 60_000);
morningSyncTimer.unref();
setTimeout(() => { morningBankSync().catch(() => {}); }, 20_000).unref();

// Scan de nuit de la carte (03:xx): le diff attend dans la carte (pastille Explorer), rien n'est appliqué seul.
let mapNightlyDay = null;
async function mapNightlyScan() {
  const now = new Date();
  const day = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
  const hour = Number(now.toLocaleString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }));
  if (hour !== 3 || mapNightlyDay === day) return;
  mapNightlyDay = day;
  const all = projects.all();
  for (const projectId of Object.keys(all)) {
    const job = agentMap.startScan(projectId, { projectId, window: "24h", visibleProjects: all, sessionVisible: () => true });
    await job.promise.catch(() => {});
  }
}
const mapNightlyTimer = setInterval(() => { mapNightlyScan().catch((error) => console.warn(`[map] scan de nuit: ${error.message}`)); }, 10 * 60_000);
mapNightlyTimer.unref();

const todoReminderTimer = setInterval(checkTodoReminders, 5 * 60_000);
todoReminderTimer.unref();
setTimeout(checkTodoReminders, 5_000).unref();
