# Shared per-agent memory

The terminal's **🧠 Mémoire commune** button opens durable notes and the saved recovery context. The same stable agent ID uses the same memory across Codex, Claude and Antigravity, including archive/restore. Storage lives privately under `.data/agent-memory`, outside Git, separated by agent, owner profile and assigned project/workspace.

## What is retained

- Durable notes: decisions, constraints, current state and next steps, up to 32,000 characters. Every engine is instructed to update them before completing work or changing context.
- Automatic recovery points: the six most recent completed Codex/Claude responses, bounded to 3,000 characters each. Antigravity has no completion hook here; its identified transcript is captured at switch/restart/archive instead.
- Last switch snapshot: a bounded excerpt of the identified conversation. Missing conversation identifiers do not fall back to another agent's latest conversation in the same directory.
- Legacy Claude project memory: bounded copies of the assigned workspace's native `memory/*.md` files, clearly labeled as a shared project source, never confused with private per-agent notes. Up to 12 files / 20,000 characters are imported or refreshed at launch/read; originals are never changed.

Memory does not reconstruct unknown past conversations or preserve an unlimited transcript. Automatic excerpts are historical data, not new commands or production authorization. Durable notes remain the source for long-term decisions.

## Launch and context recovery

Create, engine switch, manual restart and boot restore all attach a bounded memory excerpt and instructions to reread/update it. No active agents are forcibly restarted when this feature is deployed.
With shared memory enabled, an unidentified conversation starts fresh with that agent's memory rather than resuming an arbitrary `--last` / `--continue` conversation belonging to another agent.

- Claude: `--append-system-prompt`, preserving native instructions and auto-memory.
- Codex: additional [`developer_instructions`](https://developers.openai.com/codex/config-reference). If a custom developer-instructions setting already exists, Noyau preserves it and supplies memory as an initial context message instead.
- Antigravity: the specific memory directory is added with `--add-dir` and memory is supplied through `--prompt-interactive`, also on resume.

After compaction, engines are instructed to reread the persistent memory; this is not a guarantee that a model will remember every unsaved detail. No extra model is called to summarize conversations.

## Agent commands

```sh
node scripts/noyau-agent.mjs memory <stable-id|old-id|self> read
node scripts/noyau-agent.mjs memory <stable-id|old-id|self> note "Decision or recovery point"
node scripts/noyau-agent.mjs memory <stable-id|old-id|self> set "Replacement durable notes"
```

`self` requires `NOYAU_SESSION_ID`; it never guesses by workspace. Edits are owner-only; a viewer of a shared agent can read its memory but cannot change its notes. Concurrent appends are serialized, and the editor rejects stale revisions rather than overwriting newer notes.

Never put passwords, keys or tokens in memory. Some obvious credential patterns are redacted automatically, but this is best-effort, not a secret-management system. Files use private permissions (directories 700, files 600). Purging conversation history also removes automatic snapshots/recovery points, including former project scopes owned by that profile; deliberately authored notes and native Claude project memory remain separate and are retained.
