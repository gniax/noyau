import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";

const source = (await fs.readFile(new URL("../src/telegram-growth-chat.jsx", import.meta.url), "utf8"))
  .replace('import "./telegram-growth-chat.css";', "")
  .replace('from "react"', `from ${JSON.stringify(import.meta.resolve("react"))}`);
const { code } = await transformWithEsbuild(source, "telegram-growth-chat.jsx", { jsx: "transform" });
const { default: TelegramGrowthChat, newMessageCount } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const render = (props) => renderToStaticMarkup(React.createElement(TelegramGrowthChat, props));

test("chat renders a read-only empty state without fictional messages", () => {
  const html = render({ messages: [], state: "stopped" });
  assert.match(html, /Aucun message disponible/);
  assert.match(html, /Lecture seule/);
  assert.match(html, /Arrêté/);
  assert.doesNotMatch(html, /<textarea|contenteditable|<input/);
});

test("shared chat uses the actual module name for its heading and accessible labels", () => {
  const html = render({ title: "Activité Atlas", messages: [{ id: "1", text: "Hello", direction: "outgoing", status: "sent" }] });
  assert.match(html, /<h3>Activité Atlas<\/h3>/);
  assert.match(html, /aria-label="Messagerie Activité Atlas"/);
  assert.match(html, /aria-label="Historique des messages Activité Atlas"/);
  assert.doesNotMatch(html, /Telegram Growth/);
});

test("chat renders escaped bubbles, timestamps, targets and honest delivery statuses", () => {
  const html = render({ state: "running", messages: [
    { id: "1", sender: "Account A", chat: "@group", timestamp: "2026-10-11T10:00:00Z", direction: "outgoing", status: "pending", text: '<script>alert("x")</script>\nSecond line' },
    { id: "2", sender: "Account B", chat: "@other", timestamp: "2026-10-11T11:00:00Z", direction: "outgoing", status: "failed", text: "Retry failed" },
    { id: "3", sender: "Community", timestamp: null, direction: "incoming", status: "received", text: "Hello" },
  ] });
  assert.match(html, /role="log"/);
  assert.match(html, /aria-relevant="additions"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /tgc-outgoing/);
  assert.match(html, /tgc-incoming/);
  assert.match(html, /datetime="2026-10-11T10:00:00.000Z"/i);
  assert.match(html, /Account A/);
  assert.match(html, /@group/);
  assert.match(html, /En attente/);
  assert.match(html, /Échec d&#x27;envoi/);
  assert.match(html, /Heure inconnue/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|Message envoyé par|Livré|Lu</);
});

test("new-message indicator handles a rolling 100-message window without counting status updates", () => {
  const previous = Array.from({ length: 100 }, (_, id) => String(id));
  assert.equal(newMessageCount(previous, previous), 0);
  assert.equal(newMessageCount(previous, [...previous.slice(1), "100"]), 1);
  assert.equal(newMessageCount(previous, [...previous.slice(2), "100", "101"]), 2);
  assert.equal(newMessageCount(previous, previous.slice(1)), 0);
  assert.equal(newMessageCount([], ["1"]), 1);
});
