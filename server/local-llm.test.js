import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalLlm } from "./local-llm.js";

async function fixture({ large = true, small = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-llm-"));
  await fs.mkdir(path.join(directory, "llm", "build", "bin"), { recursive: true });
  await fs.writeFile(path.join(directory, "llm", "build", "bin", "llama-server"), "");
  if (large) await fs.writeFile(path.join(directory, "llm", "qwen3b.gguf"), "");
  if (small) await fs.writeFile(path.join(directory, "llm", "qwen.gguf"), "");
  return directory;
}

test("le grand modèle est choisi quand la mémoire suffit, le petit sinon", async () => {
  const directory = await fixture();
  const service = new LocalLlm({ dataDir: directory });

  service.largeModelFreeMb = 0;
  assert.match(await service.pickModel(), /qwen3b\.gguf$/);

  // Machine chargée: on retombe sur le petit plutôt que de faire ramer le poste.
  service.largeModelFreeMb = Number.MAX_SAFE_INTEGER;
  assert.match(await service.pickModel(), /qwen\.gguf$/);

  await fs.rm(directory, { recursive: true, force: true });
});

test("sans petit modèle, le grand sert quand même", async () => {
  const directory = await fixture({ small: false });
  const service = new LocalLlm({ dataDir: directory });
  service.largeModelFreeMb = Number.MAX_SAFE_INTEGER;
  assert.match(await service.pickModel(), /qwen3b\.gguf$/);
  await fs.rm(directory, { recursive: true, force: true });
});

test("sans aucun modèle le moteur se déclare absent", async () => {
  const directory = await fixture({ large: false, small: false });
  const service = new LocalLlm({ dataDir: directory });
  assert.equal(await service.pickModel(), null);
  assert.equal(await service.installed(), false);
  await fs.rm(directory, { recursive: true, force: true });
});

test("les requêtes passent une par une et le modèle s'arrête après inactivité", async () => {
  const directory = await fixture();
  const order = [];
  let healthChecks = 0;
  const service = new LocalLlm({
    dataDir: directory,
    idleMs: 20,
    spawnFn: () => ({ on: () => {}, kill: () => { order.push("stop"); } }),
    fetchFn: async (url) => {
      // Le premier appel doit trouver le serveur eteint pour qu'il soit lance.
      if (String(url).endsWith("/health")) return { ok: (healthChecks += 1) > 1 };
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push("end");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    },
  });

  await Promise.all([service.chat([{ role: "user", content: "a" }]), service.chat([{ role: "user", content: "b" }])]);
  assert.deepEqual(order.slice(0, 4), ["start", "end", "start", "end"]);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(order.includes("stop"));

  await fs.rm(directory, { recursive: true, force: true });
});
