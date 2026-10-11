import assert from "node:assert/strict";
import test from "node:test";
import { suggestAgentDescription } from "./agent-description.js";

test("suggestAgentDescription utilise les heuristiques adaptées", async () => {
  const shellDesc = await suggestAgentDescription({ name: "Laptop", assistant: "shell" });
  assert.match(shellDesc, /Terminal shell/);

  const scraperDesc = await suggestAgentDescription({ name: "Octanix Scraper", assistant: "claude", projectName: "Octanix" });
  assert.match(scraperDesc, /Scraping/);
  assert.match(scraperDesc, /Octanix/);

  const canvaDesc = await suggestAgentDescription({ name: "Canva", assistant: "codex" });
  assert.match(canvaDesc, /visuels|graphiques/);

  const noyauDesc = await suggestAgentDescription({ name: "Noyau", assistant: "antigravity", cwd: "/home/user/projects/noyau" });
  assert.match(noyauDesc, /Noyau/);
});

test("suggestAgentDescription utilise le fallback si aucun mot-clé", async () => {
  const desc = await suggestAgentDescription({ name: "Agent Inconnu", assistant: "codex", projectName: "SuperApp" });
  assert.equal(desc, "Développement et maintenance du projet SuperApp.");
});

test("suggestAgentDescription fait appel au LLM si disponible", async () => {
  const mockLlm = {
    async chat() {
      return "Supervision globale et monitoring des flux.";
    }
  };
  const desc = await suggestAgentDescription({ name: "Surveillance", assistant: "codex", localLlm: mockLlm });
  assert.equal(desc, "Supervision globale et monitoring des flux.");
});
