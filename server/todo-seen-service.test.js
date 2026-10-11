import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TodoSeenService } from "./todo-seen-service.js";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-seen-"));
  const file = path.join(directory, "todo-seen.json");
  return { file, service: new TodoSeenService({ file }) };
}

test("un todo ajouté manuellement par l'utilisateur n'affiche aucune pastille de notification", async () => {
  const { service } = await fixture();
  const userTodo = {
    id: "todo-user-1",
    text: "Tâche utilisateur",
    kind: "user",
    createdAt: new Date().toISOString(),
    activityAt: new Date().toISOString(),
    comments: [],
  };

  // Jamais vu (seenAt undefined): unread doit être 0 pour l'utilisateur
  assert.equal(service.count(userTodo, undefined), 0);

  const decorated = service.decorate([userTodo], {});
  assert.equal(decorated[0].unread, 0);
});

test("un todo créé par une IA ou un agent affiche une pastille de notification tant qu'il n'est pas vu", async () => {
  const { service } = await fixture();
  const now = new Date().toISOString();
  const agentTodo = {
    id: "todo-agent-1",
    text: "Tâche créée par l'agent",
    kind: "agent",
    createdAt: now,
    activityAt: now,
    comments: [],
  };

  // Pas encore vu
  assert.equal(service.count(agentTodo, undefined), 1);

  // Marqué comme lu
  await service.mark("profile-1", agentTodo.id, now);
  const seen = await service.seen("profile-1");
  assert.equal(service.count(agentTodo, seen[agentTodo.id]), 0);
});

test("seuls les commentaires d'agents créent des notifications non lues", async () => {
  const { service } = await fixture();
  const baseTime = new Date(Date.now() - 60_000).toISOString();
  const userCommentTime = new Date(Date.now() - 30_000).toISOString();
  const agentCommentTime = new Date().toISOString();

  const todo = {
    id: "todo-comments-1",
    text: "Discussion",
    kind: "user",
    createdAt: baseTime,
    comments: [
      { id: "c1", text: "Commentaire utilisateur", author: "Moi", kind: "user", createdAt: userCommentTime },
    ],
  };

  // Un commentaire utilisateur après seenAt ne doit pas créer de pastille
  assert.equal(service.count(todo, baseTime), 0);

  // Ajout d'un commentaire d'agent: crée 1 notification non lue
  todo.comments.push({
    id: "c2",
    text: "Rapport agent terminé",
    author: "Antigravity",
    kind: "agent",
    createdAt: agentCommentTime,
  });
  assert.equal(service.count(todo, baseTime), 1);

  // Une fois lu après le commentaire d'agent
  assert.equal(service.count(todo, agentCommentTime), 0);
});

test("une modification de statut ou activité sans commentaire d'agent ne crée pas de pastille", async () => {
  const { service } = await fixture();
  const past = new Date(Date.now() - 60_000).toISOString();
  const recent = new Date().toISOString();

  const todo = {
    id: "todo-mod-1",
    text: "Tâche déplacée",
    kind: "user",
    createdAt: past,
    activityAt: recent,
    comments: [],
  };

  assert.equal(service.count(todo, past), 0);
});
