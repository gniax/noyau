import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TODO_ID = /^todo-[a-z0-9]+-[a-f0-9]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$/;
const METADATA = /\s*<!--\s*noyau:(\{.*\})\s*-->\s*$/;
const DUE_DATE = /\s+📅\s*(\d{4}-\d{2}-\d{2})\s*$/;

function cleanText(value) {
  return String(value || "").replace(/<!--.*?-->/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function validDate(value) {
  if (!DATE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function parseDocument(content) {
  const lines = String(content).split(/\r?\n/);
  const tasks = [];
  let dirty = false;
  lines.forEach((line, lineIndex) => {
    const match = line.match(TASK);
    if (!match) return;
    let body = match[4];
    let metadata = {};
    const metadataMatch = body.match(METADATA);
    if (metadataMatch) {
      try { metadata = JSON.parse(metadataMatch[1]); } catch { metadata = {}; }
      body = body.replace(METADATA, "").trimEnd();
    }
    const dueMatch = body.match(DUE_DATE);
    const dueDate = validDate(metadata.dueDate) ? metadata.dueDate : dueMatch?.[1] || null;
    if (dueMatch) body = body.replace(DUE_DATE, "").trimEnd();
    const id = TODO_ID.test(metadata.id) ? metadata.id : `todo-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const completed = match[2].toLowerCase() === "x";
    const reminderKey = completed ? null : typeof metadata.reminderKey === "string" ? metadata.reminderKey : null;
    if (id !== metadata.id || metadata.dueDate !== dueDate || metadata.reminderKey !== reminderKey) dirty = true;
    tasks.push({
      id,
      text: cleanText(body),
      completed,
      dueDate,
      projectId: typeof metadata.projectId === "string" ? metadata.projectId : null,
      reminderKey,
      lineIndex,
      prefix: `${match[1]}${match[3]}`,
    });
  });
  return { lines, tasks, dirty };
}

function renderTask(task) {
  const metadata = JSON.stringify({ id: task.id, projectId: task.projectId || null, dueDate: task.dueDate || null, reminderKey: task.reminderKey || null });
  return `${task.prefix.slice(0, -2)}${task.completed ? "x" : " "}] ${cleanText(task.text)}${task.dueDate ? ` 📅 ${task.dueDate}` : ""} <!-- noyau:${metadata} -->`;
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

  async writeDocument(document) {
    document.tasks.forEach((task) => { document.lines[task.lineIndex] = renderTask(task); });
    const temporary = `${this.file}.noyau-tmp`;
    await fs.writeFile(temporary, document.lines.join("\n"), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  payload(tasks) {
    return tasks.map(({ lineIndex, prefix, reminderKey, ...task }, order) => ({ ...task, order }));
  }

  list() {
    return this.enqueue(async () => {
      const document = await this.readDocument();
      if (document.dirty) await this.writeDocument(document);
      return this.payload(document.tasks);
    });
  }

  add({ text, dueDate = null, projectId = null }) {
    return this.enqueue(async () => {
      const value = cleanText(text);
      if (!value) throw new Error("Texte tâche requis.");
      if (dueDate && !validDate(dueDate)) throw new Error("Date limite invalide.");
      const document = await this.readDocument();
      if (document.lines.length === 1 && !document.lines[0]) document.lines = [];
      if (document.lines.length && document.lines.at(-1) !== "") document.lines.push("");
      const task = {
        id: `todo-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
        text: value,
        completed: false,
        dueDate: dueDate || null,
        projectId: projectId || null,
        reminderKey: null,
        lineIndex: document.lines.length,
        prefix: "- [] ",
      };
      document.lines.push("");
      document.tasks.push(task);
      await this.writeDocument(document);
      return this.payload([task])[0];
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
      if (changes.completed !== undefined) task.completed = changes.completed === true;
      if (changes.projectId !== undefined) task.projectId = changes.projectId || null;
      if (changes.dueDate !== undefined) {
        if (changes.dueDate && !validDate(changes.dueDate)) throw new Error("Date limite invalide.");
        task.dueDate = changes.dueDate || null;
        task.reminderKey = null;
      }
      if (task.completed) task.reminderKey = null;
      await this.writeDocument(document);
      return this.payload([task])[0];
    });
  }

  move(id, direction) {
    return this.enqueue(async () => {
      if (!TODO_ID.test(id) || !["up", "down"].includes(direction)) throw new Error("Déplacement invalide.");
      const document = await this.readDocument();
      const index = document.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error("Tâche introuvable.");
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= document.tasks.length) return this.payload(document.tasks);
      const currentLine = document.tasks[index].lineIndex;
      const targetLine = document.tasks[targetIndex].lineIndex;
      [document.lines[currentLine], document.lines[targetLine]] = [document.lines[targetLine], document.lines[currentLine]];
      await this.writeDocument(parseDocument(document.lines.join("\n")));
      return this.payload((await this.readDocument()).tasks);
    });
  }

  reminders(now = new Date()) {
    return this.enqueue(async () => {
      if (now.getHours() < 9) return [];
      const document = await this.readDocument();
      if (document.dirty) await this.writeDocument(document);
      const today = localDate(now);
      const tomorrow = shiftDate(today, 1);
      return document.tasks.filter((task) => !task.completed && task.dueDate).flatMap((task) => {
        const kind = task.dueDate === tomorrow ? "tomorrow" : task.dueDate === today ? "today" : task.dueDate < today ? "overdue" : null;
        if (!kind) return [];
        const reminderKey = `${kind}:${today}`;
        return task.reminderKey === reminderKey ? [] : [{ ...this.payload([task])[0], kind, reminderKey }];
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

export { cleanText, parseDocument, validDate };
