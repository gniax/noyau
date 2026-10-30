# Stable agent identities

`node scripts/noyau-agent.mjs list` exposes:

- `id`: persistent, provider-neutral public identity (`noyau-agent-…`). Use it in project instructions and inter-agent calls.
- `assistant`: current engine, independent of the identity.
- `sessionId`: technical tmux session name. Legacy sessions may still contain an engine name here.
- `aliases`: verified historical IDs, accepted by `send`, `read`, `assign`, and `stop`.

Engine switches respawn the first pane in the existing tmux session instead of creating and deleting agent identities. The public identity, aliases, creation date, project and core protections survive. Provider-specific conversation IDs are cleared before the new conversation is recorded. Delayed hooks from the previous engine are ignored.

At startup, existing agents acquire a neutral identity and aliases from their explicit `migratedFrom` lineage. Identities and aliases persist in the session store and survive archive/restore. Stable IDs and aliases also work when opening an agent in the web application.

## Repairing older references

Older Noyau versions deleted predecessor metadata during a switch. An immediate `migratedFrom` reference can be recovered automatically; older links with no remaining record cannot safely be inferred from names or projects. After verifying ownership of an old ID, its owner can register it explicitly:

```sh
node scripts/noyau-agent.mjs alias <stable-id> <verified-old-id>
```

Existing IDs belonging to another agent are rejected, including agents private to another profile. Ambiguous IDs fail rather than selecting one target. Unknown Noyau IDs never fall back to fuzzy name, project or directory matching. Profile visibility and core-agent stop protections still apply through aliases.
