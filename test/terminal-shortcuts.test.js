import assert from "node:assert/strict";
import test from "node:test";
import { shouldCopyTerminal } from "../src/terminal-shortcuts.js";

test("Ctrl+C copie sélection terminal au lieu d'envoyer SIGINT", () => {
  assert.equal(shouldCopyTerminal({
    event: { key: "c", ctrlKey: true },
    targetInField: false,
    browserSelectionCollapsed: true,
    terminalSelection: "texte choisi",
  }), true);
});

test("Ctrl+C sans sélection reste disponible pour interrompre commande", () => {
  assert.equal(shouldCopyTerminal({
    event: { key: "c", ctrlKey: true },
    targetInField: false,
    browserSelectionCollapsed: true,
    terminalSelection: "",
  }), false);
});

test("copie navigateur et champs ne sont pas détournés", () => {
  assert.equal(shouldCopyTerminal({
    event: { key: "c", metaKey: true },
    targetInField: true,
    browserSelectionCollapsed: true,
    terminalSelection: "texte choisi",
  }), false);
  assert.equal(shouldCopyTerminal({
    event: { key: "c", ctrlKey: true },
    targetInField: false,
    browserSelectionCollapsed: false,
    terminalSelection: "texte choisi",
  }), false);
});
