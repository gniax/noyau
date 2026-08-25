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
import { PromptWatcher } from "./prompt-watcher.js";
import { ClaudeQuotaService } from "./claude-quota.js";
import { ModuleService } from "./module-service.js";

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
const providerState = new SessionStore(path.join(dataDir, "provider-state.json"));
await providerState.load();
const claudeQuota = new ClaudeQuotaService({ store: providerState });
const push = new PushService({ dataDir });
await push.load();
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
const tmux = new TmuxController({
  store,
  workspaceRoot,
  codexBinary: process.env.CODEX_BIN || (await commandPath("codex")),
  claudeBinary: process.env.CLAUDE_BIN || (await commandPath("claude")),
});
const promptWatcher = new PromptWatcher({ tmux, push });
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function logoUrl(session) {
  return session.projectLogo ? `/api/sessions/${encodeURIComponent(session.id)}/logo` : null;
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

app.use("/api", (request, response, next) => {
  if (!authenticated(request)) return response.status(401).json({ error: "Non autorisé." });
  next();
});

app.get("/api/config", (_request, response) => response.json({ workspaceRoot }));

app.get("/api/weather", async (request, response, next) => {
  try {
    const latitude = Number(request.query.latitude);
    const longitude = Number(request.query.longitude);
    if (request.query.latitude === undefined || request.query.longitude === undefined || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return response.status(400).json({ error: "Position météo invalide." });
    }
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
    const existing = sessionId && validSessionId(sessionId) ? store.get(sessionId) : null;
    let metadata = existing;
    if (existing) {
      metadata = {
        ...existing,
        threadId: source === "codex" ? event["thread-id"] || existing.threadId : existing.threadId,
        transcriptPath: source === "claude" ? event.transcript_path || existing.transcriptPath : existing.transcriptPath,
        agentSessionId: source === "claude" ? event.session_id || existing.agentSessionId : existing.agentSessionId,
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
    let payload = null;
    if (completion) {
      payload = {
        title: `${source === "codex" ? "Codex" : "Claude"} a terminé`,
        body: lastMessage || "Réponse prête.",
        tag: `${source}-${event["thread-id"] || event.session_id || "complete"}`,
      };
    }
    if (source === "claude" && event.hook_event_name === "Notification") {
      payload = {
        title: event.title || "Claude attend",
        body: event.message || "Action demandée.",
        tag: `claude-${event.session_id || "attention"}-${event.notification_type || "notification"}`,
      };
    }
    if (!payload) return response.status(202).json({ sent: false });
    if (completion && sessionId && migrations.has(sessionId)) {
      const migration = migrations.get(sessionId);
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
      return { ...session, project: project ? { id: session.projectId, name: project.name } : null, logoUrl: logoUrl(session), usage: await usage.get({ ...session, ...metadata }, await tmux.capture(session.id)) };
    }));
    const codexUsage = enriched.find((session) => session.assistant === "codex" && Number.isFinite(session.usage?.rateRemainingPercent))?.usage;
    response.json({
      sessions: enriched,
      quotas: {
        codex: codexUsage ? { remainingPercent: codexUsage.rateRemainingPercent, resetsAt: codexUsage.rateResetsAt, windowMinutes: codexUsage.rateWindowMinutes } : null,
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

app.post("/api/sessions/:id/migrate", async (request, response, next) => {
  try {
    const session = (await tmux.list()).find((item) => item.id === request.params.id);
    if (!session || !["codex", "claude"].includes(session.assistant)) throw new Error("Migration réservée aux agents Codex/Claude.");
    const target = request.body?.target || (session.assistant === "codex" ? "claude" : "codex");
    if (!["codex", "claude"].includes(target) || target === session.assistant) throw new Error("Agent cible invalide.");
    if (migrations.has(session.id)) throw new Error("Migration déjà en cours.");
    migrations.set(session.id, { target, startedAt: new Date().toISOString() });
    await store.set(session.id, { ...store.get(session.id), migrationState: "summarizing", migrationTarget: target, migratedTo: null });
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
  response.status(400).json({ error: error.message || "Erreur serveur." });
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
  let keyQueue = Promise.resolve();
  const terminal = pty.spawn(tmux.binary, ["attach-session", "-t", `=${request.sessionId}`], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
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
      if (message.type === "input" && typeof message.data === "string") {
        terminal.write(message.data.slice(0, 16384));
      }
      if (message.type === "submit" && typeof message.data === "string" && message.data.length) {
        const data = message.data.slice(0, 16384);
        keyQueue = keyQueue
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, "-l", data]))
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, "C-m"]))
          .then(() => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify({ type: "key-ack", key: "Enter" })))
          .catch(() => {});
      }
      if (message.type === "key" && specialKeys[message.key]) {
        keyQueue = keyQueue
          .then(() => tmux.run(["send-keys", "-t", request.sessionId, specialKeys[message.key]]))
          .then(() => websocket.readyState === websocket.OPEN && websocket.send(JSON.stringify({ type: "key-ack", key: message.key })))
          .catch(() => {});
      }
      if (message.type === "resize") terminal.resize(Math.max(20, Math.min(300, Number(message.cols))), Math.max(5, Math.min(120, Number(message.rows))));
    } catch {
      websocket.send(JSON.stringify({ type: "error", message: "Message invalide." }));
    }
  });
  websocket.on("close", () => terminal.kill());
});

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
