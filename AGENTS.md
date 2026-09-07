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

