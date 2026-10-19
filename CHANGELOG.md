# Changelog

All notable changes to agent-recall are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## 0.2.0 — 2026-10-19

Initial public release, following the private 0.1 prototype.

- Distribute a verified GitHub tarball as `@itsmay21/agent-recall`; the unscoped npm name belongs to an unrelated project.
- Redact metadata, nested keys and structured credential values; remove typed nested image payloads.
- Protect raw writes before copying sources, use private POSIX modes, reject unsafe store paths, and preserve custom ignore rules.
- Deduplicate index identities when raw detail is missing; repair interrupted final appends and expose complete corruption or shortened sources.
- Keep live locks owned and require offline manual recovery of stale locks; return failures from manual commands while hooks remain non-blocking.
- Validate CLI args, preserve Codex system-role provenance and absent status, bound reader memory, and emit clean JSONL.
- Correct hook timeout units and host-specific setup guidance; require Node 22.13 or newer.
- Add synthetic demo, reproducible benchmark, offline distribution checks, updated dependencies and pinned CI actions.

Current limits: Cursor remains experimental; Pi needs manual sync/an extension; native-host lifecycle checks and coding-agent outcome evaluation remain outside the release evidence. Upgrades from private 0.1 stores should rebuild from original sources to rerun strengthened redaction.

## [Unreleased]

### Fixed (HEAD audit `archive/AUDIT-2026-08-16-initial.md` successor)

- **C-1**: session-close hooks now use the same `calls` sub-agent default as `sync --scan` — a
  sub-agent transcript handed to a hook is kept raw-only, never dumped into the committable index.
- **C-2**: `-h`/`--help` on any verb prints usage and never runs it (`install --help` no longer installs).
- **C-3**: installed hooks call `npx --no-install agent-recall …` so they resolve after `npm i -D`.
- **C-4**: CLI reports `indexed N … M sub-agent event(s) kept raw-only` instead of over-counting.
- **C-9**: `matchPath` honors `CLAUDE_CONFIG_DIR` / `HERMES_DIR`. **C-10**: `install --agent hermes`
  mirrors the skill into `~/.hermes/skills/`. **C-14**: Codex forks namespaced `<parent>/<id>`.
  **C-15**: Hermes tool rows no longer assert a fictional `status:"ok"`. **C-11**: Cursor slug match
  is boundary-safe and labeled experimental.
- **Docs truth**: COMPILE-SPEC demoted + banner-corrected (Codex `response_item` canonical, `.agent-recall/`
  names, `calls` default); test counts → 48; removed phantom `indexWriter.ts`/empty-fixtures claims;
  `ts_source`/image-envelope/idempotency schema fixed; SECURITY contact fixed; Apple/ACE cites sourced;
  stale root audit archived; personal paths scrubbed; README install (npm + plugin) + privacy + docs links.

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
