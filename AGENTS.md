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
- Inter-agents Noyau : pour lister les agents actifs, lire leur contexte ou transmettre des messages/tâches à un autre agent, utiliser `node scripts/noyau-agent.mjs [list | read <nom> | send <nom> <message>]` (ou skill `noyau-agents`). Ne jamais dire qu'un agent n'existe pas sans avoir listé via cet outil.
- Suivi systématique Todos (outil : `node scripts/noyau-todo.mjs [list | add <texte> | comment <ref> <texte> | status <ref> review | find <recherche>]`, référence courte `#XXXX` visible sur chaque carte) : pour chaque prompt utilisateur demandant une évolution ou un bug :
  - Si nouvelle tâche : créer/ajouter automatiquement un todo dans le projet/dossier concerné.
  - Dès qu'une tâche est traitée/corrigée par l'agent : la passer impérativement au statut « À tester / valider » (`status: review`, `[/]`). Ne JAMAIS marquer un todo comme terminé (`status: done`, `[x]`) tant que l'utilisateur ne l'a pas lui-même validé dans la colonne « À tester ».
  - Si la tâche existe déjà : ajouter un commentaire horodaté sur le todo existant pour tracer l'évolution, le contexte et les modifications effectuées afin de ne rien oublier.

