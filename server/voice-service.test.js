import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VoiceService } from "./voice-service.js";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.pipe = () => {};
  child.stdin = { end: () => {}, write: () => {} };
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", 0)); };
  return child;
}

test("une phrase entendue devient une action, une phrase sans mot d'éveil est ignorée", async () => {
  const actions = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    onAction: (action) => actions.push(action),
    listAgents: () => [{ id: "noyau-codex-1", name: "Octanix" }],
    spawnFn: () => fakeChild(),
  });

  await service.handle("noyau ouvre l'agent obtenez");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "open-agent");
  assert.equal(actions[0].id, "noyau-codex-1");
  assert.equal(service.state().lastHeard.text, "noyau ouvre l'agent obtenez");

  await service.handle("il faudrait ouvrir octanix demain");
  assert.equal(actions.length, 1);
});

test("Noyau ne réagit pas à sa propre voix pendant qu'il parle", async () => {
  const actions = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    onAction: (action) => actions.push(action),
    listAgents: () => [{ id: "noyau-codex-1", name: "Octanix" }],
    spawnFn: () => fakeChild(),
  });
  service.speaking = true;
  await service.handle("noyau va sur les todos");
  assert.equal(actions.length, 0);
});

test("les lignes du transcripteur sont lues même quand elles arrivent en morceaux", async () => {
  const actions = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    onAction: (action) => actions.push(action),
    spawnFn: () => fakeChild(),
  });

  service.consume(Buffer.from('{"type":"partial","text":"noyau va"}\n{"type":"fin'));
  service.consume(Buffer.from('al","text":"noyau va sur le budget"}\n'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actions.length, 1);
  assert.equal(actions[0].view, "finances");
});

test("sans moteurs installés le micro refuse de démarrer et le dit", async () => {
  const service = new VoiceService({
    root: "/tmp/noyau-absent",
    dataDir: "/tmp/noyau-absent/.data",
    spawnFn: () => fakeChild(),
  });
  const state = await service.start();
  assert.equal(state.enabled, false);
  assert.equal(state.listening, false);
  assert.match(state.error, /voice-install/);
});

test("un alias appris rattrape un nom propre mal transcrit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-voice-alias-"));
  const actions = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: directory,
    onAction: (action) => actions.push(action),
    // Plusieurs noms voisins: sans alias, rien ne se detache.
    listAgents: () => [
      { id: "noyau-codex-1", name: "Optimo" },
      { id: "noyau-codex-2", name: "Optimo Scraper" },
      { id: "noyau-codex-3", name: "Optimo Faker" },
    ],
    spawnFn: () => fakeChild(),
  });

  await service.loadAliases();
  await service.handle("noyau ouvre l'agent obtenez");
  assert.equal(actions.at(-1).action, "unknown");

  await service.addAlias("Optimo", "obtenez");
  await service.handle("noyau ouvre l'agent obtenez");
  assert.equal(actions.at(-1).action, "open-agent");
  assert.equal(actions.at(-1).id, "noyau-codex-1");

  await fs.rm(directory, { recursive: true, force: true });
});

test("en dictée, la phrase part telle quelle dans l'agent visé", async () => {
  const dictated = [];
  const actions = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    onAction: (action) => actions.push(action),
    onDictation: (entry) => dictated.push(entry),
    listAgents: () => [{ id: "noyau-codex-1", name: "Octanix" }],
    spawnFn: () => fakeChild(),
  });

  service.dictation = "noyau-codex-1";
  await service.handle("ouvre le fichier serveur et corrige la route");
  assert.equal(actions.length, 0);
  assert.equal(dictated.length, 1);
  assert.equal(dictated[0].sessionId, "noyau-codex-1");
  assert.equal(dictated[0].text, "ouvre le fichier serveur et corrige la route");
  assert.equal(service.state().dictation, "noyau-codex-1");

  // Sans micro allume par la dictee, l'arret rend juste la parole aux commandes.
  service.stopDictation();
  assert.equal(service.state().dictation, null);
  await service.handle("ouvre le fichier serveur");
  assert.equal(dictated.length, 1);
});

test("couper le micro coupe aussi la dictée", async () => {
  const service = new VoiceService({ root: "/tmp/noyau", dataDir: "/tmp/noyau/.data", spawnFn: () => fakeChild() });
  service.dictation = "noyau-claude-1";
  service.dictationStartedMic = true;
  assert.equal(service.stop().dictation, null);
  assert.equal(service.dictationStartedMic, false);
});

test("la phrase en cours de reconnaissance remonte avant toute action", () => {
  const partials = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    onPartial: (entry) => partials.push(entry.text),
    spawnFn: () => fakeChild(),
  });

  service.consume(Buffer.from('{"type":"partial","text":"noyau ouvre"}\n'));
  assert.deepEqual(partials, ["noyau ouvre"]);
  assert.equal(service.state().partial, "noyau ouvre");

  // La phrase finale remplace l'apercu: l'affichage ne garde pas un morceau de texte mort.
  service.consume(Buffer.from('{"type":"final","text":"noyau ouvre octanix"}\n'));
  assert.equal(service.state().partial, "");
});

test("le micro choisi est celui qui entend vraiment quelque chose", async () => {
  const listing = "carte 0 : sofhdadsp [sof-hda-dsp], périphérique 0 : HDA Analog\ncarte 0 : sofhdadsp [sof-hda-dsp], périphérique 7 : DMIC16kHz\n";
  const levels = { "plughw:0,0": 3, "plughw:0,7": 900 };
  const unmuted = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    recordDevice: "auto",
    spawnFn: (binary, args) => {
      const child = fakeChild();
      if (binary === "amixer") {
        const dump = "Simple mixer control 'Dmic0',0\n  Capabilities: cvolume cswitch\n  Front Left: Capture 70 [100%] [off]\n";
        setTimeout(() => { child.stdout.emit("data", Buffer.from(args[2] === "sset" ? "" : dump)); child.emit("exit", 0); }, 1);
        if (args[2] === "sset") unmuted.push(args[3]);
        return child;
      }
      if (args[0] === "-l") {
        setTimeout(() => { child.stdout.emit("data", Buffer.from(listing)); child.emit("exit", 0); }, 1);
        return child;
      }
      const amplitude = levels[args[1]] || 0;
      const audio = Buffer.alloc(3200);
      for (let index = 0; index + 1 < audio.length; index += 2) audio.writeInt16LE(amplitude, index);
      setTimeout(() => child.stdout.emit("data", audio), 1);
      return child;
    },
  });

  assert.deepEqual(await service.captureDevices(), ["plughw:0,0", "plughw:0,7"]);
  assert.equal(await service.pickDevice(), "plughw:0,7");
  // Un micro coupe dans le mixeur ne rend que du silence: Noyau le rallume avant de choisir.
  assert.deepEqual(unmuted, ["Dmic0"]);
});

test("le son du navigateur alimente la transcription sans micro local", async () => {
  const spawned = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    spawnFn: (binary, args) => { spawned.push(binary); const child = fakeChild(); child.stdin = { writable: true, chunks: [], write(data) { this.chunks.push(data); }, end() {} }; return child; },
  });
  service.installed = async () => true;

  const state = await service.startStream();
  assert.equal(state.source, "browser");
  assert.equal(state.listening, true);
  // Aucun arecord: le son vient du reseau.
  assert.deepEqual(spawned, ["python3"]);

  assert.equal(service.pushAudio(Buffer.from([1, 0, 2, 0])), true);
  assert.equal(service.transcriber.stdin.chunks.length, 1);
  service.stop();
  assert.equal(service.state().source, null);
  assert.equal(service.pushAudio(Buffer.from([1, 0])), false);
});

test("la dictée demandée pendant l'ouverture du flux navigateur n'allume pas le micro hôte", async () => {
  const spawned = [];
  const service = new VoiceService({
    root: "/tmp/noyau",
    dataDir: "/tmp/noyau/.data",
    spawnFn: (binary) => { spawned.push(binary); return fakeChild(); },
  });
  service.installed = async () => true;

  const opening = service.startStream();
  const state = await service.startDictation("noyau-claude-1");
  await opening;
  assert.equal(state.source, "browser");
  assert.equal(state.listening, true);
  assert.equal(state.dictation, "noyau-claude-1");
  assert.deepEqual(spawned, ["python3"]);
});
