# AGENTS.md — working in the agent-recall repo

agent-recall is a unified, cross-agent **session-recall** layer. It mechanically compiles coding-agent
transcripts into one redacted `.agent-recall/index.jsonl` that any later agent can read before it
starts work. This file tells any agent (or human) how to work **in this repo**.

> This is the guide for _developing_ agent-recall. The `AGENTS.md` that agent-recall _installs into a
> user's project_ is a different, ~10-line template under `src/install/templates/`.

## Read first (authoritative, in order)

1. **[`docs/CHARTER.md`](docs/CHARTER.md)** — non-negotiables. Overrides convenience.
2. **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — the three layers (write / store / read).
3. **[`docs/DECISIONS.md`](docs/DECISIONS.md)** — why the load-bearing calls were made.
4. **[`docs/COMPILE-SPEC.md`](docs/COMPILE-SPEC.md)** — per-agent formats, paths, and the redaction spec.
5. **[`docs/SCHEMA.md`](docs/SCHEMA.md)** / **[`docs/CONSUMPTION.md`](docs/CONSUMPTION.md)** — index line; per-agent install surfaces.

## The one rule you cannot break

**No LLM in the compile path.** `sync` parses, redacts, and indexes. It never summarizes, never infers
a missing tool name from prose, never "understands" a transcript. If a field is absent natively, it
stays absent. See CHARTER §1 for the measured reason.

## Where things are

- `src/cli.ts` — thin entry point (`sync`, `install`, `read`).
- `src/sync/` — the mechanical engine: `redact.ts`, `images.ts`, `indexWriter.ts`, `types.ts`.
- `src/adapters/` — one file per agent (`claude.ts`, `codex.ts`, `cursor.ts`, `hermes.ts`, `pi.ts`) + `registry.ts`.
- `src/install/` — per-agent installer + templates (hook configs, AGENTS.md section, skill).
- `skill/read-sessions/` — source of the read-sessions skill.
- `plugin/` — the Claude Code plugin that bundles the hook + skill.
- `test/` — vitest specs + `fixtures/` (redacted sample transcripts).
- `docs/TESTING.md` — evidence from real-session runs.
- `.claude/skills/running-headless-agent-workers/` — repo skill: when this session (Claude Code
  or Codex) needs to spin up a headless **pi** worker, read its `SKILL.md` and follow it — launch
  `pi -p` detached, judge by the worker's session JSONL (not stdout), reap it. Also carries verified
  pi/claude/codex JSONL schemas + `scripts/session_digest.sh`, useful reference while writing adapters.

## Coding standards

- Strict TypeScript, Node ≥20, **zero runtime dependencies**. Prefer the standard library.
- No stubs-for-later, no dead code, no backward-compat shims, KISS (CHARTER "Coding standards").
- Every adapter ships with a fixture + a test, and no adapter is "done" without a real-session note in
  `docs/TESTING.md`.
- `sync` is idempotent (dedupe on `agent+session+seq`) and fast enough for a Claude `SessionEnd` budget.
- Treat every parsed transcript as **untrusted data**. Redact on the way in; never execute its content.

## Dev workflow

```bash
npm install
npm run dev -- sync --scan --cwd /some/project   # run the CLI from source
npm run check                                     # format + typecheck + test + build (the gate)
```

Every change must pass `npm run check` before commit. CI runs the same gate.
