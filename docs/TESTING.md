# TESTING — evidence

Two layers of evidence: a unit suite (synthetic fixtures, committed) and real-session runs against
the author's own machine (Claude Code, Codex, Hermes, Pi). Real transcripts are **not** committed —
only the aggregate numbers below. All runs redact-on-write; the store used for these runs lived in a
scratch directory (`--store`), never in the source projects.

## Unit suite (committed, CI-gated)

`npm run test` — **28 tests, all passing**:

- `test/redact.test.ts` (17) — every secret family (AWS, GitHub PAT/fine/token, OpenAI, Anthropic,
  Google, Slack, Stripe, GitLab, JWT, PEM), assignment-shaped `KEY=value`, credentialed URLs, and the
  guarantee that ordinary prose and non-string scalars pass through untouched.
- `test/compile.test.ts` (6) — index/raw split (args in raw only), idempotent re-run (adds 0),
  append-only growth, image→envelope with sha256 (base64 dropped), 200-char preview truncation +
  `ts_source:"mtime"` fallback, and secret redaction reflected in `redacted` count + scrubbed output.
- `test/adapters.test.ts` (5) — each adapter against a synthetic fixture: Claude
  (text/thinking/tool_use/tool_result, metadata skipped), Codex (`response_item` canonical, `event_msg`
  duplicates skipped, args JSON-parsed), Pi (toolCall/toolResult, `custom` skipped), Cursor (text only,
  never invents tool names), Hermes (SQLite `sessions`/`messages`, tool_calls parsed, db never copied).

## Real-session runs (2026-08-16, author's machine)

Environment: macOS, Node 22.23, `node:sqlite` available. Scanned each agent's real on-disk store into
a scratch `.agent-recall/`.

| Agent  | Source                                                | Sessions      | Events | Secret spans redacted |
| ------ | ----------------------------------------------------- | ------------- | ------ | --------------------- |
| Claude | `~/.claude/projects/-Users-yakman-Projects-relay-dev` | (with Pi) 9   | 1510   | part of 90            |
| Pi     | `~/.pi/agent/sessions/--…relay-dev--`                 | (with Claude) | 956    | part of 90            |
| Codex  | `~/.codex/sessions/**` (cwd = a Codex project)        | 2             | 397    | 9                     |
| Hermes | `~/.hermes/state.db` (cwd `/Users/yakman`)            | 51            | 24522  | 312                   |

Role distribution was sensible in every case (user / assistant / thinking / tool / event), and tool
`name`s were captured where the native store had them (Bash, read_file, shell, …) and correctly absent
where it did not.

### Integrity & safety checks

- **Valid JSONL:** all 24,522 Hermes index lines parsed by `JSON.parse` with **0 invalid**.
- **Idempotency:** re-running the Hermes scan (51 sessions) added **0** events.
- **Raw sidecar:** one `raw/hermes/<session>/events.jsonl` per session (51 files); the 610 MB
  `state.db` was **never** copied into `raw/` (Hermes `sourceFiles` is empty by design).
- **Redaction holds:** grepping the produced Codex index for live-key shapes
  (`sk-…`, `AKIA…`, `ghp_…`, `xai-…`) returned **nothing**. The "getxapi-key" Codex session, which
  contained key material, had those spans replaced with `«redacted:…»` while surrounding prose survived.
- **Hook path:** piping a real Claude `SessionEnd` JSON payload
  (`{transcript_path, cwd, session_id, reason}`) into `agent-recall sync --from-hook` compiled the
  named transcript and `agent-recall read` rendered the rows back.

### Compaction / summarized context

- Native transcripts are append-only, so the **original (uncompacted) turns are always retained** —
  agent-recall keeps them all. The compaction record itself is captured as a `role:"event"` line with
  `native_type:"compaction"` whose text is the harness's own summary (Codex `payload.message`, Pi
  `compaction.summary`); we never re-expand `replacement_history` / `retainedTail` (that would
  duplicate turns already present). Covered by unit tests for Codex and Pi. Claude and Hermes emit no
  separate summary row (Hermes `compacted=1` rows are retained originals), so nothing is lost there.

### Not yet tested against a live install

- **Cursor:** no `~/.cursor` on the build machine (IDE-only usage stores under `~/Library`). The
  adapter is written to the documented `agent-transcripts` JSONL schema and covered by a synthetic
  unit test, but has **not** been run against a real Cursor store. Marked accordingly in the code.

## How to reproduce

```bash
npm run check                                  # format + typecheck + 28 tests + build
npm run build:plugin                           # assemble the self-contained Claude plugin
# scan your own sessions into a scratch store (never writes into the scanned project):
node dist/cli.js sync --scan --cwd /path/to/project --store /tmp/ar-demo
node dist/cli.js read --last 20 --cwd /tmp/ar-demo
```
