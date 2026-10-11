import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Au-dela de 20 taches, perdre plus de 80 % d'un coup ressemble a une lecture ratee, pas a un tri.
const MASS_LOSS_MIN_TASKS = 20;
const MASS_LOSS_RATIO = 0.2;

function countTaskLines(content) {
  return (String(content || "").match(/^\s*- \[.\]/gm) || []).length;
}

const execFileAsync = promisify(execFile);
const TODO_ID = /^todo-[a-z0-9]+-[a-f0-9]{6}$/;
const FOLDER_ID = /^folder-[a-z0-9]+-[a-f0-9]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK = /^(\s*[-*]\s+\[)([ xX/?\-])(\]\s+)(.*)$/;
const HEADING = /^(#{1,6}\s+)(.*)$/;
const METADATA = /\s*<!--\s*noyau:(\{.*\})\s*-->\s*$/;
const DUE_DATE = /(?:\s+📅\s*|\s+⏳\s*|\s+\[due::\s*|\s+\bdue:\s*|\s+#due\/)(\d{4}-\d{2}-\d{2})\b\s*\]?/i;
const STATUS_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ROOT_FOLDER = "root";
const ROOT_NAME = "Sans dossier";

function newId(kind) {
  return `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function cleanText(value) {
  return String(value || "").replace(/<!--.*?-->/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function cleanCommentText(value) {
  return String(value || "").replace(/<!--.*?-->/g, "").replace(/[\r\n]+/g, "\n").trim().slice(0, 2000);
}

function validDate(value) {
  if (!DATE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validStatus(value) {
  return typeof value === "string" && STATUS_ID.test(value);
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length > 30) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function readMetadata(body) {
  const match = body.match(METADATA);
  if (!match) return { metadata: {}, body };
  try {
    return { metadata: JSON.parse(match[1]), body: body.replace(METADATA, "").trimEnd() };
  } catch {
    return { metadata: {}, body: body.replace(METADATA, "").trimEnd() };
  }
}

function parseDocument(content) {
  const lines = String(content).split(/\r?\n/);
  const tasks = [];
  const folders = [];
  let dirty = false;
  let currentFolder = ROOT_FOLDER;
  lines.forEach((line, lineIndex) => {
    const heading = line.match(HEADING);
    if (heading) {
      // Un titre Markdown fait office de dossier: Obsidian reste lisible a la main.
      const { metadata, body } = readMetadata(heading[2]);
      const id = FOLDER_ID.test(metadata.folderId) ? metadata.folderId : newId("folder");
      const projectId = typeof metadata.projectId === "string" ? metadata.projectId : null;
      const parentId = typeof metadata.parentId === "string" ? metadata.parentId : null;
      if (id !== metadata.folderId || metadata.projectId !== projectId || (metadata.parentId || null) !== parentId) dirty = true;
      folders.push({ id, name: cleanText(body) || "Dossier", projectId, parentId, lineIndex, prefix: heading[1] });
      currentFolder = id;
      return;
    }
    const match = line.match(TASK);
    if (!match) return;
    const { metadata, body: withoutMetadata } = readMetadata(match[4]);
    let body = withoutMetadata;
    const dueMatch = body.match(DUE_DATE);
    const dueDate = validDate(metadata.dueDate) ? metadata.dueDate : dueMatch?.[1] || null;
    if (dueMatch) body = body.replace(DUE_DATE, "").trimEnd();
    const id = TODO_ID.test(metadata.id) ? metadata.id : newId("todo");
    const rawMark = match[2];
    const isDone = rawMark.toLowerCase() === "x";
    const isReview = rawMark === "/" || rawMark === "?";
    // Les colonnes personnalisees vivent dans la metadonnee: le Markdown garde une case lisible a la main.
    const status = validStatus(metadata.status)
      ? metadata.status
      : (isDone ? "done" : isReview ? "review" : "todo");
    const completed = status === "done";
    const priority = ["high", "medium", "low"].includes(metadata.priority)
      ? metadata.priority
      : body.includes("🔴") || /#(urgent|p1|haute|high)\b|crash|plante|arrêt\s+brutal|faille|sécurité/i.test(body)
        ? "high"
        : body.includes("🟢") || /#(p3|basse|low)\b/i.test(body)
          ? "low"
          : "medium";
    const reminderKey = completed ? null : typeof metadata.reminderKey === "string" ? metadata.reminderKey : null;
    const completedAt = completed && validTimestamp(metadata.completedAt) ? metadata.completedAt : null;
    const activityAt = validTimestamp(metadata.activityAt) ? metadata.activityAt : null;
    const comments = Array.isArray(metadata.comments)
      ? metadata.comments.filter((c) => c && typeof c.text === "string" && c.text.trim()).map((c) => {
          let text = cleanCommentText(c.text);
          let author = typeof c.author === "string" && c.author ? cleanText(c.author).slice(0, 50) : null;
          let kind = c.kind === "agent" || c.authorKind === "agent" ? "agent" : (c.kind === "user" || c.authorKind === "user" ? "user" : null);

          // Rétrocompatibilité : détection des anciens commentaires qui contenaient les demandes du user
          const promptMatch = text.match(/^(?:\d{1,2}\/\d{1,2}\/\d{2,4}[^·]*·\s*)?demandé à nouveau\s*:\s*(.+)$/i);
          if (promptMatch) {
            text = promptMatch[1].trim();
            kind = "user";
            if (!author || author === "Noyau" || author === "Laptop") author = "Moi";
          } else if (!kind) {
            const lower = (author || "").toLowerCase();
            if (["antigravity", "codex", "claude", "agent"].includes(lower)) {
              kind = "agent";
            } else {
              kind = "user";
            }
          }

          return {
            id: typeof c.id === "string" && c.id ? c.id : newId("comment"),
            text,
            createdAt: validTimestamp(c.createdAt) ? c.createdAt : new Date().toISOString(),
            ...(author ? { author } : {}),
            kind,
          };
        })
      : [];
    const createdAt = validTimestamp(metadata.createdAt) ? metadata.createdAt : null;
    const isAgent = metadata.kind === "agent" || metadata.authorKind === "agent";
    const kind = isAgent ? "agent" : "user";
    const author = typeof metadata.author === "string" && metadata.author ? cleanText(metadata.author).slice(0, 50) : null;
    const assignee = typeof metadata.assignee === "string" && metadata.assignee ? cleanText(metadata.assignee).slice(0, 50) : null;
    const shared = typeof metadata.shared === "boolean" ? metadata.shared : false;
    if (id !== metadata.id || metadata.dueDate !== dueDate || metadata.reminderKey !== reminderKey || (metadata.completedAt || null) !== completedAt || metadata.status !== status || (metadata.priority || null) !== priority || (metadata.shared || false) !== shared || (metadata.assignee || null) !== assignee) dirty = true;
    tasks.push({
      id,
      text: cleanText(body),
      completed,
      completedAt,
      activityAt,
      createdAt,
      status,
      priority,
      comments,
      dueDate,
      projectId: typeof metadata.projectId === "string" ? metadata.projectId : null,
      folderId: currentFolder,
      reminderKey,
      kind,
      author,
      assignee,
      shared,
      lineIndex,
      prefix: `${match[1]}${match[3]}`,
    });
  });
  return { lines, tasks, folders, dirty };
}

function renderTask(task) {
  const status = task.status === "done" || task.completed ? "done" : validStatus(task.status) ? task.status : "todo";
  const isDone = status === "done";
  const isReview = status === "review";
  const mark = isDone ? "x" : isReview ? "/" : " ";
  const metadataObj = {
    id: task.id,
    projectId: task.projectId || null,
    dueDate: task.dueDate || null,
    reminderKey: task.reminderKey || null,
    completedAt: task.completedAt || null,
    activityAt: task.activityAt || null,
    status,
  };
  if (task.priority) metadataObj.priority = task.priority;
  if (task.createdAt) metadataObj.createdAt = task.createdAt;
  if (task.kind === "agent") metadataObj.kind = "agent";
  if (task.author) metadataObj.author = task.author;
  if (task.assignee) metadataObj.assignee = task.assignee;
  if (task.shared) metadataObj.shared = true;
  if (Array.isArray(task.comments) && task.comments.length > 0) {
    metadataObj.comments = task.comments;
  }
  const metadata = JSON.stringify(metadataObj);
  return `${task.prefix.slice(0, -2)}${mark}] ${cleanText(task.text)}${task.dueDate ? ` 📅 ${task.dueDate}` : ""} <!-- noyau:${metadata} -->`;
}

function renderFolder(folder) {
  const metadataObj = { folderId: folder.id, projectId: folder.projectId || null };
  if (folder.parentId) metadataObj.parentId = folder.parentId;
  const metadata = JSON.stringify(metadataObj);
  const prefix = folder.prefix || (folder.parentId ? "### " : "## ");
  return `${prefix}${folder.name} <!-- noyau:${metadata} -->`;
}

async function defaultMount(uri) {
  if (!uri) return;
  try {
    await execFileAsync("/usr/bin/gio", ["mount", uri], { timeout: 15_000 });
  } catch (error) {
    if (/déjà monté|already mounted/i.test(String(error.stderr || error.message || ""))) return;
    throw error;
  }
}

export class TodoService {
  constructor({ file, mountUri = null, mount = defaultMount }) {
    this.file = path.resolve(file);
    this.mountUri = mountUri;
    this.mount = mount;
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async resolvedFile() {
    const candidates = [this.file];
    if (this.file.includes(".local")) {
      candidates.push(this.file.replace(".local", ""));
    } else if (this.file.includes("server=")) {
      candidates.push(this.file.replace(/(server=[^,]+)(,)/, "$1.local$2"));
    }
    for (const candidate of candidates) {
      try {
        await fs.access(candidate, constants.R_OK | constants.W_OK);
        return candidate;
      } catch {}
    }
    return candidates[0];
  }

  async ensureDirectory() {
    const filePath = await this.resolvedFile();
    const directory = path.dirname(filePath);
    try {
      await fs.access(directory, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (!this.mountUri) throw error;
      await this.mount(this.mountUri);
      const recheckPath = await this.resolvedFile();
      await fs.access(path.dirname(recheckPath), constants.R_OK | constants.W_OK);
    }
  }

  async readDocument() {
    await this.ensureDirectory();
    const filePath = await this.resolvedFile();
    try {
      return parseDocument(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Un montage NAS fatigue repond ENOENT alors que le fichier existe: on remonte et on relit
      // avant de conclure a une liste vide, sinon les taches disparaissent de l'interface.
      if (this.mountUri) {
        await this.mount(this.mountUri).catch(() => {});
        const retryPath = await this.resolvedFile();
        try {
          return parseDocument(await fs.readFile(retryPath, "utf8"));
        } catch (retry) {
          if (retry.code !== "ENOENT") throw retry;
        }
      }
      const siblings = await fs.readdir(path.dirname(filePath)).catch(() => null);
      if (siblings === null) throw new Error("dossier du vault illisible");
      if (siblings.includes(path.basename(filePath))) throw new Error("fichier présent mais illisible");
      const recovered = await this.recoverFile(filePath, siblings);
      if (recovered !== null) return parseDocument(recovered);
      return parseDocument("");
    }
  }

  renderLines(document) {
    document.tasks.forEach((task) => { document.lines[task.lineIndex] = renderTask(task); });
    document.folders.forEach((folder) => { document.lines[folder.lineIndex] = renderFolder(folder); });
    return document.lines;
  }

  // Incident 11/10: un renommage SMB rate a laisse le fichier absent, relu vide puis ecrase.
  // Une copie laissee par une ecriture precedente vaut toujours mieux qu'une liste vide.
  async recoverFile(filePath, siblings) {
    const candidates = [];
    for (const suffix of [".noyau-tmp", ".noyau-prev"]) {
      if (!siblings.includes(`${path.basename(filePath)}${suffix}`)) continue;
      const candidate = `${filePath}${suffix}`;
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.size > 0) candidates.push({ candidate, mtime: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { candidate } of candidates) {
      const content = await fs.readFile(candidate, "utf8").catch(() => "");
      if (!countTaskLines(content)) continue;
      await fs.copyFile(candidate, filePath);
      console.warn(`Todo: ${filePath} absent, restauré depuis ${path.basename(candidate)}.`);
      return content;
    }
    return null;
  }

  // Ecriture atomique avec copie de l'etat precedent et refus d'une chute brutale du nombre de taches.
  async replaceFile(content, { allowShrink = false } = {}) {
    const filePath = await this.resolvedFile();
    let previous = null;
    try {
      previous = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Todo illisible avant écriture, rien n'est écrit: ${error.message}`);
    }
    if (previous !== null && !allowShrink) {
      const before = countTaskLines(previous);
      const after = countTaskLines(content);
      if (before >= MASS_LOSS_MIN_TASKS && after < before * MASS_LOSS_RATIO) {
        throw new Error(`Écriture todo refusée: ${before} tâches deviendraient ${after}. Fichier laissé intact.`);
      }
    }
    if (previous) await fs.writeFile(`${filePath}.noyau-prev`, previous, { mode: 0o600 });
    const temporary = `${filePath}.noyau-tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (error) {
        // gvfs SMB renvoie parfois EEXIST sur un renommage qui remplace: on reessaie sans supprimer la cible.
        if (error.code !== "EEXIST" || attempt >= 2) throw error;
        await new Promise((resolve) => { setTimeout(resolve, 400 * (attempt + 1)); });
      }
    }
  }

  async saveLines(lines) {
    await this.replaceFile(lines.join("\n"));
  }

  async writeDocument(document) {
    await this.saveLines(this.renderLines(document));
  }

  // Ecrit des lignes deja reordonnees puis relit: les index de lignes restent coherents.
  async saveAndRead(lines) {
    await this.saveLines(lines);
    return this.readDocument();
  }

  sectionEnd(document, folderId) {
    const index = document.folders.findIndex((folder) => folder.id === folderId);
    if (index < 0) return document.folders[0]?.lineIndex ?? document.lines.length;
    const next = document.folders[index + 1];
    let end = next ? next.lineIndex : document.lines.length;
    // On garde la ligne vide qui precede le titre suivant: le Markdown reste aere dans Obsidian.
    while (end > 0 && document.lines[end - 1] === "") end -= 1;
    return end;
  }

  folderTasks(document, folderId) {
    return document.tasks.filter((task) => task.folderId === folderId);
  }

  dropLine(document, folderId) {
    const tasks = this.folderTasks(document, folderId);
    return tasks.length ? tasks.at(-1).lineIndex + 1 : this.sectionEnd(document, folderId);
  }

  // Une tache ne doit jamais se coller au titre suivant: on repousse le titre d'une ligne vide.
  insertTaskLine(lines, at, line) {
    lines.splice(at, 0, ...(HEADING.test(lines[at] || "") ? [line, ""] : [line]));
    return lines;
  }

  relocate(document, task, targetLine) {
    const lines = this.renderLines(document);
    const [line] = lines.splice(task.lineIndex, 1);
    return this.insertTaskLine(lines, targetLine > task.lineIndex ? targetLine - 1 : targetLine, line);
  }

  payload(document) {
    const folders = [
      ...document.folders.map(({ lineIndex, prefix, ...folder }) => ({
        ...folder,
        parentId: folder.parentId || null,
      })),
      { id: ROOT_FOLDER, name: ROOT_NAME, projectId: null, parentId: null },
    ];
    const todos = document.tasks.map(({ lineIndex, prefix, reminderKey, ...task }, order) => ({
      ...task,
      status: task.status || (task.completed ? "done" : "todo"),
      comments: task.comments || [],
      priority: task.priority || null,
      order,
    }));
    return { todos, folders };
  }

  taskPayload(document, id) {
    const task = document.tasks.find((item) => item.id === id);
    if (!task) return null;
    const { lineIndex, prefix, reminderKey, ...payload } = task;
    return {
      ...payload,
      status: task.status || (task.completed ? "done" : "todo"),
      comments: task.comments || [],
      priority: task.priority || null,
    };
  }

  // Localisation d'une tache ou d'un dossier: sert a router une action vers le bon profil.
  find(id) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) return null;
      return { id, folderId: task.folderId, projectId: document.folders.find((item) => item.id === task.folderId)?.projectId || null };
    });
  }

  folder(id) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      return document.folders.find((item) => item.id === id) || null;
    });
  }

  list() {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      if (document.dirty) await this.writeDocument(document);
      return this.payload(document);
    });
  }

  // Un projet = un dossier: on cree ce qui manque et on garde les noms alignes.
  syncProjectFolders(projects = []) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      let lines = this.renderLines(document);
      let changed = document.dirty;
      for (const project of projects) {
        const folder = document.folders.find((item) => item.projectId === project.id && !item.parentId);
        if (folder) {
          const name = cleanText(project.name) || folder.name;
          if (folder.name !== name) {
            folder.name = name;
            lines[folder.lineIndex] = renderFolder(folder);
            changed = true;
          }
          continue;
        }
        if (lines.length && lines.at(-1) !== "") lines.push("");
        const created = { id: newId("folder"), name: cleanText(project.name) || "Projet", projectId: project.id, parentId: null, lineIndex: lines.length, prefix: "## " };
        lines.push(renderFolder(created));
        document.folders.push(created);
        changed = true;
      }
      if (!changed) return this.payload(document);
      return this.payload(await this.saveAndRead(lines));
    });
  }

  addFolder({ name, projectId = null, parentId = null }) {
    return this.enqueue(async () => {
      const value = cleanText(name);
      if (!value) throw new Error("Nom dossier requis.");
      const document = await this.readDocument();
      const parent = parentId ? document.folders.find((f) => f.id === parentId) : null;
      let targetProjectId = projectId || null;
      let checkParent = parent;
      while (checkParent) {
        if (checkParent.projectId) {
          targetProjectId = checkParent.projectId;
          break;
        }
        checkParent = checkParent.parentId ? document.folders.find((f) => f.id === checkParent.parentId) : null;
      }
      if (document.folders.some((folder) =>
        (folder.parentId || null) === (parent?.id || null) &&
        folder.name.toLowerCase() === value.toLowerCase()
      )) {
        throw new Error("Dossier déjà présent.");
      }
      const lines = this.renderLines(document);
      const prefix = parent ? "### " : "## ";
      const folderObj = {
        id: newId("folder"),
        name: value,
        projectId: targetProjectId,
        parentId: parent?.id || null,
        prefix,
      };
      if (parent) {
        const insertAt = this.sectionEnd(document, parent.id);
        if (lines[insertAt - 1] !== "") {
          lines.splice(insertAt, 0, "", renderFolder(folderObj));
        } else {
          lines.splice(insertAt, 0, renderFolder(folderObj));
        }
      } else {
        if (lines.length && lines.at(-1) !== "") lines.push("");
        lines.push(renderFolder(folderObj));
      }
      return this.payload(await this.saveAndRead(lines));
    });
  }

  renameFolder(id, name) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === id);
      if (!folder) throw new Error("Dossier introuvable.");
      if (folder.projectId && !folder.parentId) throw new Error("Dossier de projet: renommer le projet.");
      const value = cleanText(name);
      if (!value) throw new Error("Nom dossier requis.");
      folder.name = value;
      await this.writeDocument(document);
      return this.payload(document);
    });
  }

  // Suppression sans perte: les taches du dossier repartent dans le parent ou hors dossier.
  removeFolder(id, { force = false } = {}) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === id);
      if (!folder) throw new Error("Dossier introuvable.");
      if (folder.projectId && !folder.parentId && !force) throw new Error("Dossier de projet: supprimer le projet.");
      const lines = this.renderLines(document);
      const moved = this.folderTasks(document, id).map((task) => ({ line: lines[task.lineIndex], lineIndex: task.lineIndex }));
      const removed = new Set([folder.lineIndex, ...moved.map((item) => item.lineIndex)]);
      const kept = lines.filter((line, index) => !removed.has(index));
      const targetEnd = folder.parentId
        ? this.sectionEnd(document, folder.parentId)
        : kept.findIndex((line) => HEADING.test(line));
      const insertAt = targetEnd < 0 ? kept.length : targetEnd;
      kept.splice(insertAt, 0, ...moved.map((item) => item.line));
      return this.payload(await this.saveAndRead(kept));
    });
  }

  add({ text, dueDate = null, projectId = null, folderId = null, status = "todo", priority = "medium", kind = "user", author = null, shared = false, assignee = null }) {
    return this.enqueue(async () => {
      const value = cleanText(text);
      if (!value) throw new Error("Texte tâche requis.");
      if (dueDate && !validDate(dueDate)) throw new Error("Date limite invalide.");
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === folderId)
        || (projectId ? document.folders.find((item) => item.projectId === projectId) : null);
      const target = folder?.id || ROOT_FOLDER;
      const id = newId("todo");
      const st = validStatus(status) ? status : "todo";
      const prio = priority === null ? null : (["high", "medium", "low"].includes(priority) ? priority : "medium");
      const completed = st === "done";
      const now = new Date().toISOString();
      const completedAt = completed ? now : null;
      const task = {
        id,
        text: value,
        completed,
        completedAt,
        activityAt: now,
        createdAt: now,
        status: st,
        priority: prio,
        comments: [],
        dueDate: dueDate || null,
        projectId: folder ? folder.projectId || projectId || null : projectId || null,
        reminderKey: null,
        kind: kind === "agent" ? "agent" : "user",
        author: author ? cleanText(author).slice(0, 50) : null,
        assignee: assignee ? cleanText(assignee).slice(0, 50) : null,
        shared: Boolean(shared),
        prefix: "- [] ",
      };
      const lines = this.insertTaskLine(this.renderLines(document), this.dropLine(document, target), renderTask(task));
      const next = await this.saveAndRead(lines);
      return { ...this.payload(next), todo: this.taskPayload(next, id) };
    });
  }

  update(id, changes) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id)) throw new Error("Tâche invalide.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      if (changes.text !== undefined) {
        const text = cleanText(changes.text);
        if (!text) throw new Error("Texte tâche requis.");
        task.text = text;
      }
      let destination = null;
      if (changes.folderId !== undefined) {
        const folder = document.folders.find((item) => item.id === changes.folderId);
        if (changes.folderId && changes.folderId !== ROOT_FOLDER && !folder) throw new Error("Dossier introuvable.");
        destination = folder?.id || ROOT_FOLDER;
        task.projectId = folder ? folder.projectId : task.projectId;
      }
      if (changes.projectId !== undefined) {
        task.projectId = changes.projectId || null;
        // Le projet pilote le dossier: la tache suit son projet sans manipulation supplementaire.
        const projectFolder = task.projectId ? document.folders.find((item) => item.projectId === task.projectId) : null;
        if (projectFolder) destination = projectFolder.id;
        else if (changes.folderId === undefined && document.folders.some((item) => item.id === task.folderId && item.projectId)) destination = ROOT_FOLDER;
      }
      if (changes.dueDate !== undefined) {
        if (changes.dueDate && !validDate(changes.dueDate)) throw new Error("Date limite invalide.");
        task.dueDate = changes.dueDate || null;
        task.reminderKey = null;
      }
      if (changes.priority !== undefined) {
        task.priority = ["high", "medium", "low"].includes(changes.priority) ? changes.priority : null;
      }
      if (changes.shared !== undefined) {
        task.shared = Boolean(changes.shared);
      }
      if (changes.assignee !== undefined) {
        task.assignee = changes.assignee ? cleanText(changes.assignee).slice(0, 50) : null;
      }
      let completedNow = false;
      if (changes.status !== undefined && validStatus(changes.status)) {
        const prevStatus = task.status;
        task.status = changes.status;
        if (task.status === "done") {
          task.completed = true;
          task.completedAt = task.completedAt || new Date().toISOString();
          task.reminderKey = null;
          completedNow = !task.completed || prevStatus !== "done";
        } else {
          task.completed = false;
          task.completedAt = null;
        }
      } else if (changes.completed !== undefined && changes.completed !== task.completed) {
        task.completed = changes.completed === true;
        task.status = task.completed ? "done" : "todo";
        task.completedAt = task.completed ? new Date().toISOString() : null;
        completedNow = task.completed;
      }
      if (task.completed) task.reminderKey = null;
      if (changes.comments !== undefined && Array.isArray(changes.comments)) {
        task.comments = changes.comments.filter((c) => c && typeof c.text === "string" && c.text.trim()).map((c) => ({
          id: typeof c.id === "string" && c.id ? c.id : newId("comment"),
          text: cleanCommentText(c.text),
          createdAt: validTimestamp(c.createdAt) ? c.createdAt : new Date().toISOString(),
          ...(typeof c.author === "string" && c.author ? { author: cleanText(c.author).slice(0, 50) } : {}),
          kind: c.kind === "agent" || c.authorKind === "agent" ? "agent" : "user",
        }));
      }
      // Toute modification vaut activite: la tache remonte dans les vues triees par recence.
      task.activityAt = new Date().toISOString();
      // Tache barree: elle descend au bas de son dossier, hors du champ de travail.
      const targetFolder = destination || (completedNow ? task.folderId : null);
      if (!targetFolder) {
        await this.writeDocument(document);
        return { ...this.payload(document), todo: this.taskPayload(document, id) };
      }
      const lines = this.relocate(document, task, this.dropLine(document, targetFolder));
      const next = await this.saveAndRead(lines);
      return { ...this.payload(next), todo: this.taskPayload(next, id) };
    });
  }

  addComment(id, { text, author = null, kind = "user" }) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id)) throw new Error("Tâche invalide.");
      const clean = cleanCommentText(text);
      if (!clean) throw new Error("Texte commentaire requis.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      if (!Array.isArray(task.comments)) task.comments = [];
      const comment = {
        id: newId("comment"),
        text: clean,
        createdAt: new Date().toISOString(),
        ...(author ? { author: cleanText(author).slice(0, 50) } : {}),
        kind: kind === "agent" ? "agent" : "user",
      };
      task.comments.push(comment);
      task.activityAt = comment.createdAt;
      await this.writeDocument(document);
      return { ...this.payload(document), todo: this.taskPayload(document, id), comment };
    });
  }

  removeComment(id, commentId) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id)) throw new Error("Tâche invalide.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      task.comments = (task.comments || []).filter((c) => c.id !== commentId);
      await this.writeDocument(document);
      return { ...this.payload(document), todo: this.taskPayload(document, id) };
    });
  }

  remove(id) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id)) throw new Error("Tâche invalide.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      const lines = this.renderLines(document);
      lines.splice(task.lineIndex, 1);
      return this.payload(await this.saveAndRead(lines));
    });
  }

  move(id, direction) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id) || !["up", "down", "top", "bottom"].includes(direction)) throw new Error("Déplacement invalide.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      const siblings = this.folderTasks(document, task.folderId);
      const index = siblings.findIndex((item) => item.id === id);
      const targetLine = direction === "up" ? siblings[index - 1]?.lineIndex
        : direction === "down" ? (siblings[index + 1] ? siblings[index + 1].lineIndex + 1 : undefined)
        : direction === "top" ? siblings[0]?.lineIndex
        : siblings.at(-1).lineIndex + 1;
      if (targetLine === undefined || targetLine === task.lineIndex || targetLine === task.lineIndex + 1) return this.payload(document);
      return this.payload(await this.saveAndRead(this.relocate(document, task, targetLine)));
    });
  }

  // Glisser-deposer: la tache vient se poser juste avant une autre, ou en fin de dossier.
  placeBefore(id, beforeId = null) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id)) throw new Error("Tâche invalide.");
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Tâche introuvable.");
      const siblings = this.folderTasks(document, task.folderId);
      const reference = beforeId ? siblings.find((item) => item.id === beforeId) : null;
      if (beforeId && !reference) throw new Error("Tâche cible introuvable.");
      const targetLine = reference ? reference.lineIndex : siblings.at(-1).lineIndex + 1;
      if (targetLine === task.lineIndex || targetLine === task.lineIndex + 1) return this.payload(document);
      return this.payload(await this.saveAndRead(this.relocate(document, task, targetLine)));
    });
  }

  reminders(now = new Date()) {
    return this.enqueue(async () => {
      if (now.getHours() < 9) return [];
      const document = await this.readDocument();
      if (document.dirty) await this.writeDocument(document);
      const today = localDate(now);
      const tomorrow = shiftDate(today, 1);
      const todos = this.payload(document).todos;
      return document.tasks.filter((task) => !task.completed && task.dueDate).flatMap((task) => {
        const kind = task.dueDate === tomorrow ? "tomorrow" : task.dueDate === today ? "today" : task.dueDate < today ? "overdue" : null;
        if (!kind) return [];
        const reminderKey = `${kind}:${today}`;
        return task.reminderKey === reminderKey ? [] : [{ ...todos.find((item) => item.id === task.id), kind, reminderKey }];
      });
    });
  }

  markReminded(id, reminderKey) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const task = document.tasks.find((item) => item.id === id);
      if (!task || task.completed) return false;
      task.reminderKey = String(reminderKey).slice(0, 40);
      await this.writeDocument(document);
      return true;
    });
  }

  readRaw() {
    return this.enqueue(async () => {
      await this.ensureDirectory();
      const filePath = await this.resolvedFile();
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
      }
    });
  }

  saveRaw(raw) {
    return this.enqueue(async () => {
      if (typeof raw !== "string") throw new Error("Contenu markdown requis.");
      await this.ensureDirectory();
      await this.replaceFile(raw);
      return this.payload(await this.readDocument());
    });
  }
}

export { countTaskLines, cleanText, parseDocument, renderTask, validDate, ROOT_FOLDER };
