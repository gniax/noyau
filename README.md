# Noyau

Centre de contrôle local pour agents IA en ligne de commande. Noyau lance Codex, Claude Code et Antigravity dans des sessions `tmux`, les expose dans une interface web utilisable au clavier comme au doigt, et garde le suivi du travail (to-do, projets, budget) au même endroit.

Tout tourne sur la machine : aucun service tiers, pas de base de données, les données vivent dans des fichiers locaux et un vault Obsidian.

![Accueil](docs/screenshots/dashboard.png)

## Ce que ça fait

**Agents** — Chaque agent est une session `tmux` persistante : elle survit à la fermeture de l'onglet, au redémarrage du serveur et à la coupure réseau. Le terminal est rendu par xterm.js sur un WebSocket, avec une barre de touches pensée pour l'écran tactile (Ctrl, Alt, Échap, collage, envoi de fichier, capture du texte de l'écran).

- bascule d'un fournisseur à l'autre en gardant le contexte de la conversation ;
- quotas Codex / Claude / Antigravity relevés et affichés en continu ;
- notifications push (Web Push) quand un agent attend une réponse ;
- archivage : fermer un agent conserve son fil de discussion, une entrée « Agents archivés » le relance là où il s'était arrêté ;
- outils inter-agents : lister les agents actifs, lire leur contexte, leur transmettre une tâche.

**Projets** — Regroupent les agents par travail, sans imposer de dossier commun. Un projet peut exposer des modules décrits par un manifeste `.noyau/modules/*.json` : contrôle de services systemd, actions déclenchables, liens externes, builds Android/iOS installables depuis le téléphone, sources de connaissance.

**To-do** — Un tableau façon Trello, avec des zones personnalisables (créer, renommer, réordonner, replier), ou une liste classique.

![Tableau des tâches](docs/screenshots/todos-board.png)

- stockage en Markdown lisible à la main dans un vault Obsidian : `- [ ] texte 📅 2026-09-12 <!-- noyau:{…} -->` ;
- référence courte `*A1B2` par tâche, cliquable dans le terminal d'un agent ;
- commentaires horodatés, avec distinction entre ce que tu écris et ce qu'écrit un agent ;
- pastilles de nouveautés à trois niveaux (onglet, projet, tâche) ;
- reformulation optionnelle du texte par un LLM à la saisie.

**Suivi automatique** — Un hook `UserPromptSubmit` (Claude Code et Codex) donne à l'agent les tâches ouvertes du projet courant et lui demande de tracer chaque évolution ou bug : créer la tâche si elle n'existe pas, sinon la commenter. Quand l'agent a traité une demande, il la passe en « À tester / valider » avec la date et le commit — jamais en « Terminé », cette validation reste manuelle. Le suivi se coupe par projet et par agent.

**Budget** — Suivi de dépenses par enveloppes, catégorisation assistée par LLM, connexion bancaire optionnelle (Enable Banking) avec redirection en HTTPS local.

![Projets](docs/screenshots/projects.png)

## Architecture

```
server/      API Express + WebSocket, un module par domaine
  tmux.js            création, restauration et capture des sessions
  session-store.js   persistance JSON atomique
  todo-service.js    lecture/écriture du vault Markdown
  board-service.js   zones du tableau, réglages par profil
  module-service.js  modules projet, systemd, builds appareil
  finance-*.js       budget, banque, conseiller
src/         interface React (une application, pas de routeur)
scripts/     outils appelés par les agents (to-do, inter-agents, design)
test/        tests unitaires node:test
```

Pas de framework serveur au-delà d'Express, pas de state manager côté client, pas de dépendance de base de données. Les tests tournent avec le lanceur intégré de Node.

## Installation

Prérequis : Node 20+, `tmux`, et au moins un agent CLI installé (`codex`, `claude` ou `antigravity`).

```bash
npm install
npm run build
NOYAU_TOKEN="une-clé-longue-et-aléatoire" npm start
```

L'interface écoute sur `http://localhost:4242`. La clé d'accès est demandée à la première connexion ; elle est ensuite conservée dans `.data/access-token`.

### Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `NOYAU_TOKEN` | Clé d'accès à l'interface (obligatoire au premier lancement) |
| `PORT` / `HOST` | Écoute HTTP (par défaut `4242` / `0.0.0.0`) |
| `NOYAU_HTTPS_HOST` / `NOYAU_HTTPS_PORT` | Écoute HTTPS pour l'accès via VPN |
| `NOYAU_TLS_CERT` / `NOYAU_TLS_KEY` / `NOYAU_CA_CERT` | Certificats de l'écoute HTTPS |
| `NOYAU_DATA_DIR` | Dossier de données (par défaut `.data/`) |
| `NOYAU_WORKSPACE_ROOT` | Racine des dépôts proposés à la création d'un agent |
| `NOYAU_TODO_FILE` | Fichier Markdown du vault Obsidian |
| `NOYAU_TODO_MOUNT_URI` | Montage GVFS à effectuer si le vault est sur un NAS |

`noyau.service` fournit une unité systemd utilisateur prête à adapter, et `desktop/` les entrées pour lancer l'interface en plein écran sur un poste tactile.

### Accès depuis le téléphone

L'écoute HTTPS sert la même interface en application installable (PWA) : notifications push, terminal tactile, installation des builds iOS/Android produits par les modules. Le certificat local se télécharge depuis `/noyau-ca.cer`.

![Terminal d'un agent](docs/screenshots/terminal.png)

## Outils pour les agents

Les agents pilotés par Noyau disposent de commandes pour se coordonner et tenir le suivi :

```bash
node scripts/noyau-agent.mjs list                      # agents actifs, projet, état
node scripts/noyau-agent.mjs send "Nom" "Message"      # transmettre une tâche
node scripts/noyau-todo.mjs list                       # tâches du projet courant
node scripts/noyau-todo.mjs add "Texte"                # créer une tâche
node scripts/noyau-todo.mjs report *A1B2 "Ce qui a été fait"
```

`server/todo-track-hook.js` s'installe comme hook `UserPromptSubmit` dans `~/.claude/settings.json` et `~/.codex/hooks.json`.

## Développement

```bash
npm run dev     # serveur avec rechargement
npm test        # suite complète (node:test)
npm run build   # bundle de production
```

Les captures d'écran de ce README sont produites à partir d'une instance de démonstration : les agents, projets et tâches qui y figurent sont fictifs.

## Licence

MIT.
