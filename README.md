# agent-recall

**A unified, cross-agent session-recall layer.** When a coding-agent session ends, agent-recall
mechanically ingests that vendor's native transcript for your project, sanitizes it, and appends it to
one line-oriented store — `.agent-recall/index.jsonl` — that **any** later agent (Claude Code, Codex,
Cursor, Hermes, Pi, …) can read before it starts, so it doesn't re-propose a rejected design or
re-walk a dead path.

> **Read, not resume.** agent-recall gives the next agent the _anthropology_ of what happened — not a
> faithful cross-vendor resume (tool trees don't survive translation). And there is **no LLM in the
> compile path**: it parses, redacts, and indexes. Nothing is summarized or guessed.

## Why

Every coding agent stores its sessions in its own format, in its own home-directory location, and none
of them can see what the others did in your project. Dumping a previous agent's full raw history into
the next one is measurably _worse than starting fresh_ (Apple SSPM: 71% full-history vs 79% no-memory
vs 96% selective). agent-recall keeps the raw safe and gives the next agent a compact, redacted index —
the selective middle path — plus a skill that teaches it to treat history as evidence, not orders.

## How it works

```
WRITE                          STORE                        READ
agent session-close hook  →    .agent-recall/index.jsonl  →  AGENTS.md pointer
runs `agent-recall sync`       (redacted, committable)       + read-sessions skill
(parse → redact → index)       raw/  (gitignored)            (agents just Read the JSONL)
```

The **write** side is one tiny headless command that each agent's session-close hook calls. The
**read** side needs nothing installed — agents read the JSONL directly. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Supported agents (tier-1)

| Agent       | Ingest     | Close trigger       | Read layer                       |
| ----------- | ---------- | ------------------- | -------------------------------- |
| Claude Code | ✅         | `SessionEnd` hook   | `CLAUDE.md`→`@AGENTS.md` + skill |
| Codex       | ✅         | `SessionEnd` hook   | native `AGENTS.md` + skill       |
| Cursor      | ✅ (lossy) | `sessionEnd`/`stop` | native `AGENTS.md` + skill       |
| Hermes      | ✅         | `on_session_end`    | native `AGENTS.md` + skill       |
| Pi          | ✅         | sync-on-start       | native `AGENTS.md` + skill       |

Gemini CLI, OpenCode, Goose, Cline, Amp, and others are documented as tier-2 in
[`docs/CONSUMPTION.md`](docs/CONSUMPTION.md).

## Install (preview)

```bash
# In your project:
npx agent-recall install --agent claude-code codex cursor hermes pi
```

This writes the session-close hook config, an `AGENTS.md` pointer (and `CLAUDE.md` shim), and the
`read-sessions` skill for each named agent. Claude users can instead install the bundled plugin.

## Privacy

Raw vendor transcripts contain plaintext secrets. agent-recall **never commits raw**
(`.agent-recall/raw/` is gitignored) and redacts every field — including tool args and stdout — before
it reaches the index. See [`docs/CHARTER.md`](docs/CHARTER.md) §5.

## Status

Early. Under active construction. See [`docs/DECISIONS.md`](docs/DECISIONS.md) for what's settled and
[`docs/TESTING.md`](docs/TESTING.md) for real-session evidence.

## License

MIT © Mayank Saini
