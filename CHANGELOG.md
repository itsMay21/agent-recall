# Changelog

All notable changes to agent-recall are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Setup backfill**: `install` loads pre-existing sessions once (shared `scanAndCompile`), so history
  that predates the hook is recalled; future sessions are handled by the close hooks. `--no-backfill`
  to skip.
- **Token-lean `read`**: `--grep`, `--session`, `--role`, `--agent`, `--offset`, `--json` — search and
  page the index without loading it all into context.
- Compaction summaries are captured as `native_type:"compaction"` events (Codex `payload.message`, Pi
  `compaction.summary`); original uncompacted turns are always retained.

### Fixed (audit `AUDIT-REPORT.md`)

- **F-0.2** invalid JSON from split surrogate pairs — new scrub pass yields jq/Go/Rust-valid output.
- **F-1.1 / F-2.3** redaction bypasses — quoted multi-word secrets, JSON-quoted keys, and bare
  AWS secrets near `aws` are now caught.
- **F-2.4** home-path leakage — `$HOME` rewritten to `~` in preview/text (cwd kept intact).
- **F-1.5** crash-window index loss — torn writes reconcile from the raw sidecar.
- **F-1.6** no concurrency control — per-store `O_EXCL` lock.
- **F-1.7** Hermes hook flow — `session_id`-only payloads build the `<db>::<session>` handle.
- **F-2.2** session-id path collisions — hash suffix when sanitization changes the id.
- **F-1.2 / F-1.4 / F-1.8 / F-2.5 / F-2.7** installer alias + errors, dropped unproducible-status
  guidance, removed phantom `--user`, Codex 3 s timeout, repo gitignore holes.

## [0.1.0] — 2026-08-16

Initial release: mechanical cross-agent session compile to `.agent-recall/index.jsonl` (Claude Code,
Codex, Cursor, Hermes, Pi), the `read-sessions` skill, and a self-contained Claude Code plugin. No LLM
in the compile path; zero runtime dependencies.
