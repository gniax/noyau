# Noyau Rules

- Caveman full responses.
- Every change bumps SemVer in `package.json` and `package-lock.json`.
  - PATCH: fix, style, docs, tooling.
  - MINOR: backward-compatible feature.
  - MAJOR: breaking behavior/data/API.
- Keep `/version.json` and Réglages version display working.
- Run `npm test` and `npm run build` before commit.
- Conventional commits. No AI attribution/co-author.
- Never commit `.data`, secrets, certificates, logs, caches, or build output.
- Inter-agent Claude Design : si demande design/UI/UX/images via Claude Design, déléguer directement via `node scripts/claude-design-tool.mjs "DEMANDE"`.
- Inter-agents Noyau : pour créer un agent, lister les agents actifs, lire leur contexte, leur assigner un projet, les arrêter ou transmettre des messages/tâches à un autre agent, utiliser `node scripts/noyau-agent.mjs [create --name <nom> --prompt <tâche> | assign <agent> <projet> | stop <agent> | list | read <nom> | send <nom> <message>]` (ou skill `noyau-agents` / `noyau-agent-create`). Par défaut, un agent créé hérite du projet et de la permission yolo/dangerous. Ne jamais dire qu'un agent n'existe pas sans avoir listé via cet outil.
- Fichiers partagés Noyau & Livrables (RÈGLE STRICTE) :
  - **LE CODE SOURCE NE DOIT JAMAIS ÊTRE MIS DANS LES FICHIERS PARTAGÉS** :
    - Toute modification de code, nouvelle version, page, script ou composant s'écrit et se modifie **directement dans le dépôt Git / codebase du projet**.
    - **INTERDICTION FORMELLE** de déposer des fichiers de code source (`.html`, `.js`, `.ts`, `.php`, `.py`, `.css`, etc.) ou des versions de code dans les Fichiers Partagés Noyau (`noyau-file.mjs`).
  - **Usage exclusif des Fichiers Partagés** :
    - Réservé **UNIQUEMENT** aux médias et documents finaux non-code (images PNG/JPG, vidéos, maquettes graphiques visuelles, exports CSV, PDF, présentations PPTX) destinés à l'utilisateur.
    - **INTERDICTION FORMELLE** d'envoyer à l'utilisateur des chemins locaux machine ou temporaires (ex: `/tmp/...`, `file:///...`, chemins absolus locaux du PC) pour ces médias/documents : les déposer dans les Fichiers Partagés via `node scripts/noyau-file.mjs put <chemin-source> [nom-destination] [projet]` (ou via skill `noyau-files` ou copie dans `$(node scripts/noyau-file.mjs path [projet])`).
    - Confirmer ensuite simplement à l'utilisateur que le fichier est disponible dans la section « Fichiers » de son projet sur Noyau avec son nom de fichier.
    - Commandes utiles : `node scripts/noyau-file.mjs [list | put <fichier> | get <nom> | path | delete <nom>] [projet]`.
- Suivi systématique Todos (outil : `node scripts/noyau-todo.mjs [list | add <texte> | comment <ref> <texte> | prompt <ref> <texte> | report <ref> <modifs> | status <ref> review | find <recherche>]`, référence courte `*XXXX` visible sur chaque carte et cliquable dans la conversation) : pour chaque prompt utilisateur demandant une évolution ou un bug :
  - Si nouvelle tâche : créer/ajouter automatiquement un todo dans le projet/dossier concerné.
  - Dès qu'une tâche est traitée/corrigée par l'agent : utiliser `report <ref> "modifications effectuées"` — il ajoute un commentaire daté avec le commit courant puis passe la tâche au statut « À tester / valider » (`status: review`, `[/]`). Ne JAMAIS marquer un todo comme terminé (`status: done`, `[x]`) tant que l'utilisateur ne l'a pas lui-même validé dans la colonne « À tester » (si la section « À valider » est désactivée/off, `report` passe automatiquement la tâche en `done`).
  - Si la tâche existe déjà : ajouter un commentaire horodaté **très concis** (une phrase, 200 caractères maximum) sur le todo existant.

