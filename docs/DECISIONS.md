# DECISIONS (ADRs)

Short, dated records of the load-bearing calls. Newest first.

## ADR-008 — Initial public distribution and reliability contract (2026-10-19)

Use GitHub release tarballs with package identity `@itsmay21/agent-recall`; the unscoped npm name is
owned by another project. Registry publication is deferred until scope ownership is established.
Raise the runtime floor to Node 22.13 to support the SQLite adapter without the Node 20 caveat.

Protect raw writes in the compiler, sanitize metadata and structured credentials, and deduplicate
against persisted index identities independently of raw files. Recover only interrupted final appends;
fail on complete corruption or shortened sources. Manual failures return nonzero; hooks warn and stay
non-blocking. Keep same-length source rewriting and native-host lifecycle certification explicit limits.

Correct hook timeout units and host guidance. Pi is manual collection in this release, Cursor remains
experimental, and research references do not establish this project's effect on agent outcomes.

The records below describe earlier decisions; ADR-008 and current architecture supersede their raw
line-count, Node 20, unscoped package, and Pi lifecycle claims.

## ADR-007 — Sub-agent ingestion: tag mechanically, default `calls` (2026-08-16)

**Decision:** Sub-agent / sidechain streams are ingested behind `sync --subagents off|calls|full`,
default **`calls`**. Detection is mechanical, from native typed fields only (Claude `isSidechain` +
`sessionId` + `agentId`; Codex `thread_source:"subagent"` + `parent_thread_id` + `source.subagent.other`).
A sub-agent session is namespaced `<parentSession>/<spawnKey>` and tagged `origin`/`subagent_of`/
`subagent_kind`. `calls` writes the sub-agent thread to `raw/` only (drill-down) — the parent's spawn
call+output are already in the index; `full` also indexes the stream; `off` ignores it. `read`
gains `--top-level` and `--subagent-of`.
**Why:** Owner chose "calls default + drill-down". Sub-agent work is often the most exploratory/
rejected-path-heavy (worth recalling), but indexing every sub-agent event by default bloats the index
and risks double-counting, so the lightweight default keeps the index clean while raw preserves the
full thread. Pi (`subagent-artifacts/`, parent attribution ambiguous → omit parent) and Cursor
(no local data) are deferred; see `docs/design/SUBAGENTS-INVESTIGATION.md`.
**Status:** accepted; Claude + Codex implemented and verified on real data (TESTING.md).

## ADR-006 — Mechanical memory digest is optional and extraction-only (2026-08-16)

**Decision:** A per-project memory digest (`.agent-recall/decisions.md`) is a deferred, off-by-default
module that only _extracts_ typed `rejected`/`superseded` events — no prose synthesis, no LLM.
**Why:** Agents natively read `AGENTS.md`/`CLAUDE.md`, so emitting a digest is high-leverage, but
summarization is a charter violation (ACE/Apple evidence). Extraction stays mechanical; summarization,
if ever wanted, is a separate explicit read-time step. **Status:** deferred to v2.

## ADR-005 — Read layer = one AGENTS.md + one .agents/skills skill, with shims (2026-08-16)

**Decision:** The universal read vector is a ~10-line `AGENTS.md` section (native to Codex/Cursor/Pi/
Hermes/Amp) plus a `read-sessions` skill at `.agents/skills/` (native to Codex/Cursor/Pi/Amp). The
`install` command adds a `CLAUDE.md`→`@AGENTS.md` shim and a `.claude/skills/` copy for Claude, and a
`~/.hermes/skills/` copy for Hermes.
**Why:** Research showed `AGENTS.md` and `.agents/skills/` have the widest native coverage; Claude is
the only tier-1 agent that reads neither by default, so it gets thin shims rather than a parallel essay.
**Status:** accepted.

## ADR-004 — Tier-1 = Claude, Codex, Cursor, Hermes, Pi (2026-08-16)

**Decision:** Fully build + test adapters for these five now; everything else (Gemini, OpenCode, Goose,
Cline, Amp, Kimi, Qwen, Crush, …) is a documented tier-2 stub or later PR.
**Why:** User selection + the requirement to test against real Claude/Codex/Hermes sessions. Pi is the
cleanest schema (cheap win); Cursor is the hardest (included deliberately to prove the lossy path).
**Status:** accepted. Cursor ships as the lossy `agent-transcripts` JSONL adapter with a `store.db`
pointer; full Composer fidelity is out of scope for v1.

## ADR-003 — One headless command, not a service or per-agent scripts (2026-08-16)

**Decision:** The compile logic is a single command (`agent-recall sync` / `install`), invoked by each
agent's session-close hook. Not an MCP server, not inlined per agent.
**Why:** Every tier-1 closer is a shell-command slot, so a command is the native interface they share;
one implementation satisfies DRY; the read path needs no command at all (agents read the JSONL). An MCP
server can't fire on close and adds a runtime process. **Status:** accepted (challenged and reasoned;
see ARCHITECTURE §1).

## ADR-002 — TypeScript / Node, zero runtime dependencies (2026-08-16)

**Decision:** Implement in strict TypeScript on Node ≥20, bundled to a single-file `dist/cli.js`, with
**no runtime dependencies**. Dev tooling: tsup, tsx, vitest, prettier.
**Why:** Matches the owner's house style, npm-distributable, best fit for the Claude plugin ecosystem,
and the compile path is just parsing + regex. Zero runtime deps keeps install friction near zero and
avoids native-module pain (Cursor `store.db` SQLite is deferred; tier-1 uses JSONL/markdown only).
**Status:** accepted. Reconsider a Go single-binary build only if Node-on-user-machine proves a barrier.

## ADR-001 — Store directory is `.agent-recall/`, interchange is `index.jsonl` (2026-08-16)

**Decision:** Per-project store lives at `.agent-recall/`; the interchange file is
`.agent-recall/index.jsonl`; raw copies under `.agent-recall/raw/` (gitignored).
**Why:** Owner pick. Unambiguous, matches the project name, unclaimed by other tools (avoids convx's
`.ai/history/` collision). JSONL because every agent has Read/Grep; SQLite would need a client.
**Status:** accepted.

---

### Standing non-decisions (things we deliberately will NOT do)

- No LLM in the compile path (CHARTER §1). No cross-vendor resume (CHARTER §4). No committing raw
  transcripts (CHARTER §5). No 400-line AGENTS.md essay. No TUI/cloud/observability-backend scope.
