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
the next one is measurably _worse than starting fresh_ (Apple SSPM, [arXiv:2607.09493](https://arxiv.org/abs/2607.09493): 71% full-history vs 79% no-memory
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

| Agent       | Ingest                  | Close trigger       | Read layer                       |
| ----------- | ----------------------- | ------------------- | -------------------------------- |
| Claude Code | ✅                      | `SessionEnd` hook   | `CLAUDE.md`→`@AGENTS.md` + skill |
| Codex       | ✅                      | `SessionEnd` hook   | native `AGENTS.md` + skill       |
| Hermes      | ✅                      | `on_session_end`    | native `AGENTS.md` + skill       |
| Pi          | ✅                      | sync-on-start       | native `AGENTS.md` + skill       |
| Cursor      | ⚠️ experimental (lossy) | `sessionEnd`/`stop` | native `AGENTS.md` + skill       |

Cursor is experimental — the adapter is written to the documented `agent-transcripts` schema but not
yet validated against a live `~/.cursor` store. Gemini CLI, OpenCode, Goose, Cline, Amp, and others are
documented as tier-2 in [`docs/CONSUMPTION.md`](docs/CONSUMPTION.md).

## What it is not

| Not…                   | Because                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- |
| an MCP memory server   | No runtime process; it writes a file on session close. Agents `Read` it directly.      |
| cross-vendor resume    | Tool trees don't survive translation — you get the _record_, not a replayable session. |
| an LLM memory gardener | No model in the compile path. Nothing is summarized, ranked, or invented.              |

## Install

**Claude Code (plugin) — no PATH, no npm:**

```bash
claude plugin marketplace add itsMay21/agent-recall   # requires the repo to be public
claude plugin install agent-recall@agent-recall
```

The plugin's `SessionEnd` hook runs the bundled binary directly (`node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js"`).

**Everyone else (npm):** install the CLI locally, then wire it into the project.

```bash
npm i -D agent-recall
npx agent-recall install --agent claude-code codex hermes pi   # (cursor is experimental)
```

`install` writes the session-close hook config, an `AGENTS.md` pointer (and `CLAUDE.md` shim), the
`read-sessions` skill, and backfills existing sessions. The installed hooks call
`npx --no-install agent-recall …`, which resolves the local (or global) binary — so **the `npm i -D`
step is required** for hooks to run on close. See [`docs/CONSUMPTION.md`](docs/CONSUMPTION.md).

## Privacy

Raw vendor transcripts contain plaintext secrets. agent-recall **never commits raw**
(`.agent-recall/raw/` is gitignored) and redacts every field — tool args and stdout included — before it
reaches the index, and rewrites your home dir to `~` in previews. **The `cwd` field keeps the absolute
project path**, so review an index before committing it to a _public_ repo. Redaction is pattern-based,
not exhaustive — see [`SECURITY.md`](SECURITY.md) and [`docs/CHARTER.md`](docs/CHARTER.md) §5.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the three layers · [`docs/SCHEMA.md`](docs/SCHEMA.md) — the index line
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — ADRs · [`docs/CHARTER.md`](docs/CHARTER.md) — non-negotiables
- [`docs/CONSUMPTION.md`](docs/CONSUMPTION.md) — how each agent installs · [`docs/TESTING.md`](docs/TESTING.md) / [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — evidence
- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md)

## Status

Early (v0.1). The compile engine is well-tested (48 tests, verified on real Claude/Codex/Hermes/Pi
sessions); Cursor is experimental. See [`docs/DECISIONS.md`](docs/DECISIONS.md).

## License

MIT © Mayank Saini
