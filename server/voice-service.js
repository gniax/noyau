import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCommand } from "./voice-commands.js";

// Mode micro de Noyau: arecord alimente un transcripteur Vosk, les phrases entendues
// deviennent des actions. Tout reste local, rien ne sort de la machine.
export class VoiceService {
  constructor({
    root,
    dataDir,
    onAction = () => {},
    onDictation = () => {},
    onPartial = () => {},
    listAgents = () => [],
    listProjects = () => [],
    recordBinary = "arecord",
    recordDevice = process.env.NOYAU_VOICE_DEVICE || "auto",
    pythonBinary = "python3",
    playBinary = "aplay",
    mixerBinary = "amixer",
    spawnFn = spawn,
    now = () => new Date(),
  }) {
    this.root = path.resolve(root);
    this.voiceDir = path.join(path.resolve(dataDir), "voice");
    this.onAction = onAction;
    this.onDictation = onDictation;
    this.onPartial = onPartial;
    this.listAgents = listAgents;
    this.listProjects = listProjects;
    this.recordBinary = recordBinary;
    this.recordDevice = recordDevice;
    this.pythonBinary = pythonBinary;
    this.playBinary = playBinary;
    this.mixerBinary = mixerBinary;
    this.spawnFn = spawnFn;
    this.now = now;
    this.recorder = null;
    this.transcriber = null;
    this.enabled = false;
    this.speaking = false;
    this.lastHeard = null;
    this.lastAction = null;
    // Phrase en cours de reconnaissance: elle s'affiche pendant qu'on parle, avant toute action.
    this.partial = "";
    this.error = null;
    this.buffer = "";
    this.aliasFile = path.join(path.resolve(dataDir), "voice-aliases.json");
    this.aliases = {};
    // Dictee: la parole part telle quelle dans un agent, sans mot d'appel ni commande.
    this.dictation = null;
    this.dictationStartedMic = false;
    // Micro retenu a la derniere ecoute des entrees disponibles.
    this.device = null;
    // « local »: micro de la machine. « browser »: son envoye par le navigateur qui pilote.
    this.source = null;
    this.streamStarting = null;
  }

  // Les noms propres sortent deformes du modele: on retient ce que l'utilisateur associe.
  async loadAliases() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.aliasFile, "utf8"));
      this.aliases = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.aliases = {};
    }
    return this.aliases;
  }

  async addAlias(targetName, heard) {
    const name = String(targetName || "").trim();
    const spoken = String(heard || "").trim().toLowerCase();
    if (!name || !spoken) throw new Error("Alias vocal incomplet.");
    const current = new Set(this.aliases[name] || []);
    current.add(spoken);
    this.aliases = { ...this.aliases, [name]: [...current].slice(0, 12) };
    await fs.mkdir(path.dirname(this.aliasFile), { recursive: true }).catch(() => {});
    await fs.writeFile(this.aliasFile, JSON.stringify(this.aliases, null, 2), "utf8");
    return this.aliases;
  }

  withAliases(entries) {
    return entries.map((entry) => ({ ...entry, aliases: this.aliases[entry.name] || [] }));
  }

  get modelPath() {
    return path.join(this.voiceDir, "vosk-model-small-fr-0.22");
  }

  get piperBinary() {
    return path.join(this.voiceDir, "piper", "piper");
  }

  get voicePath() {
    return path.join(this.voiceDir, "voices", "fr_FR-siwis-medium.onnx");
  }

  async installed() {
    const targets = [this.modelPath, this.piperBinary, this.voicePath];
    const checks = await Promise.all(targets.map((target) => fs.stat(target).then(() => true).catch(() => false)));
    return checks.every(Boolean);
  }

  state() {
    return {
      enabled: this.enabled,
      listening: Boolean(this.transcriber),
      speaking: this.speaking,
      lastHeard: this.lastHeard,
      lastAction: this.lastAction,
      partial: this.partial,
      device: this.device,
      source: this.source,
      dictation: this.dictation,
      error: this.error,
    };
  }

  // La prise casque et le micro numerique cohabitent: seul l'un des deux entend quelque chose.
  async captureDevices() {
    const listing = await new Promise((resolve) => {
      let output = "";
      let child = null;
      try {
        child = this.spawnFn(this.recordBinary, ["-l"], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve("");
        return;
      }
      child.stdout?.on("data", (chunk) => { output += chunk.toString("utf8"); });
      child.on("error", () => resolve(""));
      child.on("exit", () => resolve(output));
    });
    const devices = [];
    for (const match of listing.matchAll(/^(?:carte|card)\s+(\d+)[^\n]*?(?:p[ée]riph[ée]rique|device)\s+(\d+)/gim)) {
      devices.push(`plughw:${match[1]},${match[2]}`);
    }
    return devices;
  }

  // Niveau sonore moyen d'un peripherique: un micro debranche rend un silence parfait.
  async deviceLevel(device, milliseconds = 700) {
    return new Promise((resolve) => {
      let child = null;
      const chunks = [];
      try {
        child = this.spawnFn(this.recordBinary, ["-D", device, "-q", "-f", "S16_LE", "-c", "1", "-r", "16000", "-t", "raw"], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve(0);
        return;
      }
      // Le peripherique reste pris tant que la sonde n'a pas rendu la main: on attend sa sortie.
      const measure = () => {
        const audio = Buffer.concat(chunks);
        let total = 0;
        for (let index = 0; index + 1 < audio.length; index += 2) {
          const sample = audio.readInt16LE(index);
          total += sample * sample;
        }
        const count = Math.floor(audio.length / 2);
        return count ? Math.round(Math.sqrt(total / count)) : 0;
      };
      child.stdout?.on("data", (chunk) => chunks.push(chunk));
      child.on("error", () => resolve(0));
      child.on("exit", () => resolve(measure()));
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* deja parti */ }
        // Sortie tardive ou absente: on ne bloque pas le demarrage du micro.
        setTimeout(() => resolve(measure()), 400);
      }, milliseconds);
    });
  }

  // Sortie brute d'un utilitaire ALSA, sans faire echouer le micro si l'outil manque.
  async mixerOutput(args) {
    return new Promise((resolve) => {
      let output = "";
      let child = null;
      try {
        child = this.spawnFn(this.mixerBinary, args, { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve("");
        return;
      }
      child.stdout?.on("data", (chunk) => { output += chunk.toString("utf8"); });
      child.on("error", () => resolve(""));
      child.on("exit", () => resolve(output));
    });
  }

  // Un micro coupe dans le mixeur ne rend que du silence: on rallume les entrees eteintes.
  async enableCapture(card) {
    const dump = await this.mixerOutput(["-c", String(card)]);
    const blocks = dump.split(/^Simple mixer control /m).slice(1);
    const restored = [];
    for (const block of blocks) {
      const name = block.match(/^'(.+)',(\d+)/);
      if (!name || !/cswitch/.test(block) || !/Capture .*\[off\]/.test(block)) continue;
      await this.mixerOutput(["-c", String(card), "sset", name[1], "cap"]);
      restored.push(name[1]);
    }
    return restored;
  }

  async pickDevice() {
    if (this.recordDevice && this.recordDevice !== "auto") return this.recordDevice;
    const devices = await this.captureDevices();
    for (const card of new Set(devices.map((device) => device.split(":")[1].split(",")[0]))) {
      await this.enableCapture(card);
    }
    let best = { device: devices[0] || "default", level: -1 };
    for (const device of devices) {
      const level = await this.deviceLevel(device);
      if (level > best.level) best = { device, level };
    }
    // Le pilote met un instant a liberer l'entree sondee: sans ce repos, l'ouverture reelle echoue.
    if (devices.length) await new Promise((resolve) => { setTimeout(resolve, 350); });
    return best.device;
  }

  async start() {
    if (this.transcriber) return this.state();
    if (!(await this.installed())) {
      this.error = "Moteurs vocaux absents: lancer scripts/voice-install.sh.";
      this.enabled = false;
      return this.state();
    }
    this.error = null;
    this.enabled = true;
    await this.loadAliases();

    this.source = "local";
    const recordArgs = ["-q", "-f", "S16_LE", "-c", "1", "-r", "16000", "-t", "raw"];
    const device = await this.pickDevice();
    if (device) recordArgs.unshift("-D", device);
    this.device = device;
    this.recorder = this.spawnFn(this.recordBinary, recordArgs, { stdio: ["ignore", "pipe", "ignore"] });
    this.transcriber = this.spawnFn(this.pythonBinary, [path.join(this.root, "scripts", "voice-listener.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NOYAU_VOICE_MODEL: this.modelPath },
    });

    this.recorder.stdout.pipe(this.transcriber.stdin);
    this.recorder.on("error", (error) => this.fail(`Micro indisponible: ${error.message}`));
    // Un micro deja pris par une autre application sort en erreur: le dire vaut mieux qu'un silence.
    this.recorder.on("exit", (code) => { if (this.enabled && code) this.fail(`Micro ${device} indisponible: entrée occupée.`); });
    this.transcriber.on("error", (error) => this.fail(`Transcription indisponible: ${error.message}`));
    this.transcriber.stdout.on("data", (chunk) => this.consume(chunk));
    this.transcriber.on("exit", () => { if (this.enabled) this.fail("Transcription arrêtée."); });
    return this.state();
  }

  // Micro du navigateur: le son arrive par le reseau, seule la transcription tourne ici.
  // C'est ce qui permet de piloter Noyau depuis un autre poste que celui qui l'heberge.
  // La dictee est demandee juste apres l'ouverture du flux: elle attend ce demarrage au lieu d'allumer le micro hote.
  startStream() {
    if (!this.streamStarting) this.streamStarting = this.openStream().finally(() => { this.streamStarting = null; });
    return this.streamStarting;
  }

  async openStream() {
    if (this.transcriber && this.source === "browser") return this.state();
    // Passer du micro hote au navigateur garde l'agent en dictee.
    const dictation = this.dictation;
    if (this.transcriber) this.stop();
    this.dictation = dictation;
    if (!(await this.installed())) {
      this.error = "Moteurs vocaux absents: lancer scripts/voice-install.sh.";
      this.enabled = false;
      return this.state();
    }
    this.error = null;
    this.enabled = true;
    this.source = "browser";
    this.device = null;
    await this.loadAliases();
    this.transcriber = this.spawnFn(this.pythonBinary, [path.join(this.root, "scripts", "voice-listener.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NOYAU_VOICE_MODEL: this.modelPath },
    });
    this.transcriber.on("error", (error) => this.fail(`Transcription indisponible: ${error.message}`));
    this.transcriber.stdout.on("data", (chunk) => this.consume(chunk));
    this.transcriber.on("exit", () => { if (this.enabled) this.fail("Transcription arrêtée."); });
    return this.state();
  }

  pushAudio(chunk) {
    if (this.source !== "browser" || !this.transcriber?.stdin?.writable) return false;
    // Ce que Noyau dit ne doit pas revenir par le micro distant.
    if (this.speaking) return true;
    this.transcriber.stdin.write(Buffer.from(chunk));
    return true;
  }

  // Dictee sur un agent: on allume le micro au besoin et on l'eteint en repartant si on l'avait allume.
  async startDictation(sessionId) {
    const target = String(sessionId || "").trim();
    if (!target) throw new Error("Agent de dictée manquant.");
    if (this.streamStarting) await this.streamStarting;
    const wasListening = Boolean(this.transcriber);
    if (!wasListening) {
      const state = await this.start();
      if (!state.listening) return this.state();
      this.dictationStartedMic = true;
    }
    this.dictation = target;
    return this.state();
  }

  stopDictation() {
    this.dictation = null;
    if (this.dictationStartedMic) {
      this.dictationStartedMic = false;
      return this.stop();
    }
    return this.state();
  }

  fail(message) {
    this.error = message;
    this.stop();
  }

  stop() {
    this.enabled = false;
    this.dictation = null;
    this.dictationStartedMic = false;
    this.partial = "";
    for (const child of [this.recorder, this.transcriber]) {
      try { child?.kill("SIGTERM"); } catch { /* deja parti */ }
    }
    this.recorder = null;
    this.transcriber = null;
    this.source = null;
    return this.state();
  }

  consume(chunk) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch { continue; }
      if (payload.type === "error") this.fail(payload.message);
      if (payload.type === "partial") {
        this.partial = String(payload.text || "");
        this.onPartial({ text: this.partial, at: this.now().toISOString() });
        continue;
      }
      if (payload.type !== "final" || !payload.text) continue;
      this.partial = "";
      void this.handle(payload.text);
    }
  }

  async handle(text) {
    // Ce que dit Piper ne doit pas se relancer en boucle dans le micro.
    if (this.speaking) return null;
    // En dictee, la phrase est le message: aucun mot d'appel, aucune commande a reconnaitre.
    if (this.dictation) {
      const spoken = String(text || "").trim();
      if (!spoken) return null;
      this.lastHeard = { text: spoken, at: this.now().toISOString() };
      const dictated = { action: "dictate", sessionId: this.dictation, text: spoken, at: this.now().toISOString() };
      this.lastAction = dictated;
      await this.onDictation(dictated);
      return dictated;
    }
    // La liste peut demander tmux: on l'attend plutot que de viser une entree morte.
    const [agents, projects] = await Promise.all([this.listAgents(), this.listProjects()]);
    const command = parseCommand(text, {
      agents: this.withAliases(agents || []),
      projects: this.withAliases(projects || []),
    });
    if (!command) return null;
    this.lastHeard = { text, at: this.now().toISOString() };
    this.lastAction = { ...command, at: this.now().toISOString() };
    if (command.action === "stop-listening") {
      await this.say("J'arrête d'écouter.");
      this.stop();
      return command;
    }
    await this.onAction(command);
    return command;
  }

  async say(text) {
    const clean = String(text || "").trim().slice(0, 400);
    if (!clean) return false;
    if (!(await fs.stat(this.piperBinary).then(() => true).catch(() => false))) return false;
    this.speaking = true;
    try {
      await new Promise((resolve, reject) => {
        const piper = this.spawnFn(this.piperBinary, ["--model", this.voicePath, "--output_raw"], { stdio: ["pipe", "pipe", "ignore"] });
        const player = this.spawnFn(this.playBinary, ["-q", "-r", "22050", "-f", "S16_LE", "-t", "raw", "-"], { stdio: ["pipe", "ignore", "ignore"] });
        piper.stdout.pipe(player.stdin);
        piper.on("error", reject);
        player.on("error", reject);
        player.on("exit", resolve);
        piper.stdin.end(clean);
      });
      return true;
    } catch {
      return false;
    } finally {
      // On laisse le micro se calmer avant de reprendre: sinon Noyau s'entend parler.
      setTimeout(() => { this.speaking = false; }, 250);
    }
  }
}
