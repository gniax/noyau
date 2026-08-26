import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TODO_ID = /^todo-[a-z0-9]+-[a-f0-9]{6}$/;
const FOLDER_ID = /^folder-[a-z0-9]+-[a-f0-9]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;
const HEADING = /^(#{1,6}\s+)(.*)$/;
const METADATA = /\s*<!--\s*noyau:(\{.*\})\s*-->\s*$/;
const DUE_DATE = /\s+📅\s*(\d{4}-\d{2}-\d{2})\s*$/;
const ROOT_FOLDER = "root";
const ROOT_NAME = "Sans dossier";

function newId(kind) {
  return `${kind}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function cleanText(value) {
  return String(value || "").replace(/<!--.*?-->/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function validDate(value) {
  if (!DATE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
      if (id !== metadata.folderId || metadata.projectId !== projectId) dirty = true;
      folders.push({ id, name: cleanText(body) || "Dossier", projectId, lineIndex, prefix: heading[1] });
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
    const completed = match[2].toLowerCase() === "x";
    const reminderKey = completed ? null : typeof metadata.reminderKey === "string" ? metadata.reminderKey : null;
    const completedAt = completed && validTimestamp(metadata.completedAt) ? metadata.completedAt : null;
    if (id !== metadata.id || metadata.dueDate !== dueDate || metadata.reminderKey !== reminderKey || (metadata.completedAt || null) !== completedAt) dirty = true;
    tasks.push({
      id,
      text: cleanText(body),
      completed,
      completedAt,
      dueDate,
      projectId: typeof metadata.projectId === "string" ? metadata.projectId : null,
      folderId: currentFolder,
      reminderKey,
      lineIndex,
      prefix: `${match[1]}${match[3]}`,
    });
  });
  return { lines, tasks, folders, dirty };
}

function renderTask(task) {
  const metadata = JSON.stringify({ id: task.id, projectId: task.projectId || null, dueDate: task.dueDate || null, reminderKey: task.reminderKey || null, completedAt: task.completedAt || null });
  return `${task.prefix.slice(0, -2)}${task.completed ? "x" : " "}] ${cleanText(task.text)}${task.dueDate ? ` 📅 ${task.dueDate}` : ""} <!-- noyau:${metadata} -->`;
}

function renderFolder(folder) {
  const metadata = JSON.stringify({ folderId: folder.id, projectId: folder.projectId || null });
  return `${folder.prefix}${folder.name} <!-- noyau:${metadata} -->`;
}

async function defaultMount(uri) {
  if (!uri) return;
  await execFileAsync("/usr/bin/gio", ["mount", uri], { timeout: 15_000 });
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

  async ensureDirectory() {
    const directory = path.dirname(this.file);
    try {
      await fs.access(directory, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (!this.mountUri) throw error;
      await this.mount(this.mountUri);
      await fs.access(directory, constants.R_OK | constants.W_OK);
    }
  }

  async readDocument() {
    await this.ensureDirectory();
    try {
      return parseDocument(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Un montage NAS fatigue repond ENOENT alors que le fichier existe: on remonte et on relit
      // avant de conclure a une liste vide, sinon les taches disparaissent de l'interface.
      if (this.mountUri) {
        await this.mount(this.mountUri).catch(() => {});
        try {
          return parseDocument(await fs.readFile(this.file, "utf8"));
        } catch (retry) {
          if (retry.code !== "ENOENT") throw retry;
        }
      }
      const siblings = await fs.readdir(path.dirname(this.file)).catch(() => null);
      if (siblings === null) throw new Error("dossier du vault illisible");
      if (siblings.includes(path.basename(this.file))) throw new Error("fichier présent mais illisible");
      return parseDocument("");
    }
  }

  renderLines(document) {
    document.tasks.forEach((task) => { document.lines[task.lineIndex] = renderTask(task); });
    document.folders.forEach((folder) => { document.lines[folder.lineIndex] = renderFolder(folder); });
    return document.lines;
  }

  async saveLines(lines) {
    const temporary = `${this.file}.noyau-tmp`;
    await fs.writeFile(temporary, lines.join("\n"), { mode: 0o600 });
    await fs.rename(temporary, this.file);
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
      ...document.folders.map(({ lineIndex, prefix, ...folder }) => folder),
      { id: ROOT_FOLDER, name: ROOT_NAME, projectId: null },
    ];
    const todos = document.tasks.map(({ lineIndex, prefix, reminderKey, ...task }, order) => ({ ...task, order }));
    return { todos, folders };
  }

  taskPayload(document, id) {
    return this.payload(document).todos.find((task) => task.id === id) || null;
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
        const folder = document.folders.find((item) => item.projectId === project.id);
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
        const created = { id: newId("folder"), name: cleanText(project.name) || "Projet", projectId: project.id, lineIndex: lines.length, prefix: "## " };
        lines.push(renderFolder(created));
        document.folders.push(created);
        changed = true;
      }
      if (!changed) return this.payload(document);
      return this.payload(await this.saveAndRead(lines));
    });
  }

  addFolder({ name, projectId = null }) {
    return this.enqueue(async () => {
      const value = cleanText(name);
      if (!value) throw new Error("Nom dossier requis.");
      const document = await this.readDocument();
      if (document.folders.some((folder) => folder.name.toLowerCase() === value.toLowerCase())) throw new Error("Dossier déjà présent.");
      const lines = this.renderLines(document);
      if (lines.length && lines.at(-1) !== "") lines.push("");
      lines.push(renderFolder({ id: newId("folder"), name: value, projectId: projectId || null, prefix: "## " }));
      return this.payload(await this.saveAndRead(lines));
    });
  }

  renameFolder(id, name) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === id);
      if (!folder) throw new Error("Dossier introuvable.");
      if (folder.projectId) throw new Error("Dossier de projet: renommer le projet.");
      const value = cleanText(name);
      if (!value) throw new Error("Nom dossier requis.");
      folder.name = value;
      await this.writeDocument(document);
      return this.payload(document);
    });
  }

  // Suppression sans perte: les taches du dossier repartent hors dossier.
  removeFolder(id) {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === id);
      if (!folder) throw new Error("Dossier introuvable.");
      if (folder.projectId) throw new Error("Dossier de projet: supprimer le projet.");
      const lines = this.renderLines(document);
      const moved = this.folderTasks(document, id).map((task) => ({ line: lines[task.lineIndex], lineIndex: task.lineIndex }));
      const removed = new Set([folder.lineIndex, ...moved.map((item) => item.lineIndex)]);
      const kept = lines.filter((line, index) => !removed.has(index));
      const rootEnd = kept.findIndex((line) => HEADING.test(line));
      const insertAt = rootEnd < 0 ? kept.length : rootEnd;
      kept.splice(insertAt, 0, ...moved.map((item) => item.line));
      return this.payload(await this.saveAndRead(kept));
    });
  }

  add({ text, dueDate = null, projectId = null, folderId = null }) {
    return this.enqueue(async () => {
      const value = cleanText(text);
      if (!value) throw new Error("Texte tâche requis.");
      if (dueDate && !validDate(dueDate)) throw new Error("Date limite invalide.");
      const document = await this.readDocument();
      const folder = document.folders.find((item) => item.id === folderId)
        || (projectId ? document.folders.find((item) => item.projectId === projectId) : null);
      const target = folder?.id || ROOT_FOLDER;
      const id = newId("todo");
      const task = {
        id,
        text: value,
        completed: false,
        completedAt: null,
        dueDate: dueDate || null,
        projectId: folder ? folder.projectId || projectId || null : projectId || null,
        reminderKey: null,
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
      let completedNow = false;
      if (changes.completed !== undefined && changes.completed !== task.completed) {
        task.completed = changes.completed === true;
        task.completedAt = task.completed ? new Date().toISOString() : null;
        completedNow = task.completed;
      }
      if (task.completed) task.reminderKey = null;
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
}

export { cleanText, parseDocument, validDate, ROOT_FOLDER };
