# agent-recall — Deep Audit Report (Final)

**Date:** 2026-08-16 · **Audited head:** `2446cd4` (+ uncommitted `M AGENTS.md`) · **Auditor:** multi-pass ZCode audit (direct source review + real-session E2E + two dedicated audit agents + web verification)

---

## 1. Executive summary

agent-recall is a unified, cross-agent session-recall layer: it mechanically compiles coding-agent transcripts (Claude Code, Codex, Cursor, Hermes, Pi) into one redacted `.agent-recall/index.jsonl` that any later agent reads before starting work. This audit examined whether that promise holds — code correctness, redaction integrity, real-data behavior, documentation truthfulness, and release/contribution readiness.

**The verdict:** the engineering core is genuinely strong. The charter's non-negotiables all verify clean against the source: no LLM/network/exec/eval anywhere in the compile path, zero runtime dependencies (no `dependencies` key at all — Hermes even uses builtin `node:sqlite`), transcripts treated as untrusted data, and mechanical redaction that on real data caught **493 secret spans across ~29,000 events with zero token-shaped leaks surviving**. All four locally-testable adapters parsed live sessions end-to-end without a crash, sync proved idempotent and incrementally correct, and the quality gate (`npm run check`: format + typecheck + 30/30 tests + build) passes.

**But it is not publish-ready.** One real data-corruption bug (invalid JSON written to the index, reproduced on live Hermes data), one class of redaction bypass (multi-word quoted secret values), a crash-window that can silently and permanently drop index rows, no concurrency control despite an idempotency promise, a read layer instructed to hunt for statuses no adapter can produce, and the single most "authoritative" doc (COMPILE-SPEC) containing inverted guidance for its flagship-hard case. The contribution surface (CONTRIBUTING, SECURITY, templates, publish guard, tags) is absent, and the GitHub repo is still private, so every public-facing artifact (CI badge, plugin marketplace install, clone instructions) is currently a dead link.

Findings below are graded: **P0** (blocks publish / corrupts data), **P1** (incorrect behavior or actively misleading), **P2** (should fix), **P3** (polish).

---

## 2. Methodology

Five independent passes, cross-checked against each other:

1. **Direct full-source review** — every file in `src/` read line-by-line (`cli.ts`; `sync/{compile,store,redact,images,types}.ts`; `adapters/{claude,codex,cursor,hermes,pi,registry,util}.ts`; `install/{installer,templates}.ts`) plus all three test specs.
2. **Quality gate** — `npm install && npm run check` on Node 22: format ✓, typecheck ✓, **30/30 tests** ✓, tsup build ✓.
3. **Real-session E2E benchmark** — `sync --scan` against this machine's live stores: Claude Code (this repo's 2.3 MB project transcript), Codex (`~/.codex/sessions`, 2 rollouts), Pi (`~/.pi/agent/sessions`, 15 sessions), Hermes (`~/.hermes/state.db`, a **610 MB SQLite** with 182 sessions / ~10.4k messages; 51 matched the tested cwd). Outputs written to throwaway `tmp/` stores (deleted after the audit). Follow-up runs tested idempotency, incremental growth, hook mode (`sync --from-hook` with a real-shaped payload), and the `read` command.
4. **Dedicated audit agents** — one for documentation drift (15 doc files checked claim-by-claim against code), one for release/contribution readiness (git hygiene, npm packaging, plugin manifests, CI, contributor assets).
5. **Web verification** of every external-truth claim: Claude Code `SessionEnd` hook payload shape, Codex `.codex/hooks.json` existence and its SessionEnd timeout cap, Cursor transcript storage location, and the competitive landscape (see §16 References).

---

## 3. Charter & architecture compliance (verified good)

These were checked explicitly and hold:

- **"No LLM in the compile path"** — no `fetch`/HTTP/socket/eval/`Function()`/child_process anywhere in `src/` (the only URL strings are inert template text). Every written value is copied from the native record or derived mechanically (seq, mtime fallback, sha256, truncation).
- **Zero runtime dependencies** — `package.json` has no `dependencies` key. Node ≥20, standard library only; Hermes SQLite access via builtin `node:sqlite` loaded through a split specifier so the bundler can't rewrite it.
- **Untrusted-input discipline** — all transcript lines pass through `JSON.parse` inside try/catch (`readJsonl` skips malformed lines rather than aborting); no transcript content is ever executed; `redactDeep` rebuilds objects field-by-field into fresh objects, so crafted `__proto__` keys cannot pollute (worst case: the key is silently dropped during rebuild — no code-execution path).
- **Idempotency (at rest)** — per-session raw `events.jsonl` line count as a high-water mark; verified on real data: re-runs added 0 events for Claude and Hermes; a live-growing Pi session added exactly its 7 new events. (Caveats: see F-P1.5/1.6 for the crash-window and concurrency holes, and F-P2.12 for the mechanism-vs-docs mismatch.)
- **Image/binary stripping** — base64 payloads hashed (sha256) + sized, bytes never stored; verified in tests and in the real Claude index (no base64 blobs).
- **Store layout** — `.agent-recall/index.jsonl` (committable) + `.agent-recall/raw/` (gitignored, may hold pre-redaction vendor bytes); `install` adds the ignore rule to consumer repos; Hermes deliberately never copies the shared multi-hundred-MB `state.db` (`sourceFiles: []`).
- **Packaging internals** — committed `plugin/bin/cli.js` is byte-identical (sha-verified) to a fresh `tsup` build, carries the `100755` exec bit, and is invoked via `${CLAUDE_PLUGIN_ROOT}` so it works regardless of npm availability; `.claude-plugin/marketplace.json` and `plugin/.claude-plugin/plugin.json` are structurally valid, version-aligned (0.1.0 across all three manifests), with existing hook/skill paths; the two `SKILL.md` copies are byte-identical and regenerated by `scripts/build-plugin.mjs`.
- **Repo↔metadata consistency** — `git remote -v` == `package.json` repository == plugin manifest URLs; LICENSE (MIT) matches the license field; no secrets in tracked files (key-shape greps hit only documented fake fixtures like `AKIAIOSFODNN7EXAMPLE`).

---

## 4. Findings — P0 (blocks publish / corrupts data)

### F-0.1 The GitHub repository is private

Every public-facing artifact is dead until this changes: the CI badge, `claude plugin marketplace add itsMay21/agent-recall`, clone/`gh` install paths, and the README's links. Issues are enabled but Discussions disabled.
**Fix:** Settings → General → Danger Zone → Change visibility → Public; optionally enable Discussions. Zero code impact.

### F-0.2 Invalid JSON is written to the index (real corruption, reproduced on live data)

`makePreview` (`src/sync/compile.ts:40`) truncates previews with `oneLine.slice(0, 200)` — a slice of **UTF-16 code units**, which can cut an emoji surrogate pair in half. `JSON.stringify` then emits the orphaned half as a `\ud83c`-style escape, which is invalid JSON per spec. Node's `JSON.parse` and CPython's `json.loads` happen to tolerate lone surrogates — which is exactly why the 30-test suite passes — but strict consumers do not: **`jq` fails parsing the entire Hermes index file** (observed at line 1617, an assistant message about an "INR research report" whose preview was cut mid-🎯). Any consumer built on jq/Rust/Go JSON parsers sees a broken interchange file, defeating the product's core promise.

The same class of risk exists for `text`/`args`/`result` strings copied from sources that may themselves contain unpaired surrogates (SQLite-backed Hermes content in particular).

**Fix:** sanitize on write for every string that reaches either file — pair-aware truncation (don't split a surrogate pair at the 200 boundary) _and_ replacement of unpaired surrogates with U+FFFD across preview/text/args/result. Add a regression test that jq-parses every produced line (a strict round-trip Node can't provide on its own).

---

## 5. Findings — P1 (incorrect behavior / actively misleading)

### F-1.1 Redaction bypass: quoted multi-word secret values leak verbatim

`ASSIGNMENT_RE` (`src/sync/redact.ts:47`) captures the value as `[^\s'"]{6,}` with an optional quote — a pattern that cannot span spaces. So `{"api_key": "hunter2 boogaloo"}` (7+ chars including a space, quoted) **fails to match and is written unredacted** to both the index preview and the raw sidecar. Single-word quoted values (`"supersecretvalue123"`) are caught — the test suite only exercises that form.
**Fix:** when the opening quote is present, allow spaces up to the closing quote (`(['"])([^"']{6,}?)\3`); keep the space-free branch for unquoted values. Add canary tests for multi-word quoted secrets.

### F-1.2 README's install command silently skips Claude Code

`README.md:51`: `npx agent-recall install --agent claude codex cursor hermes pi`. The valid AgentId is `claude-code` (`src/sync/types.ts:4`); `runInstall` filters unknown ids, logs one "ignoring unknown agent(s): claude" line, and proceeds — so a user following the README verbatim never wires the flagship agent's SessionEnd hook while believing all five were installed.
**Fix:** correct the README ids, and make the installer resilient: accept `claude` as an alias for `claude-code` (and warn loudly when a requested id matched nothing at all).

### F-1.3 COMPILE-SPEC's Codex guidance is inverted

`docs/COMPILE-SPEC.md` §5.3/§2 instruct extenders: "`type=event_msg / user_message` → real user text … `type=response_item` → **SYNTHETIC/duplicate** context — DO NOT double-count." The adapter (`src/adapters/codex.ts`) does the exact **opposite** — and the adapter is right: the conversation canonically lives in `response_item` lines (message / reasoning / function_call / …), while `event_msg` is the derived UI stream that duplicates the text. The adapter's header comment, `test/adapters.test.ts`, and `docs/TESTING.md` all agree with the code. AGENTS.md ranks COMPILE-SPEC as authoritative doc #4 — anyone extending the Codex adapter "per the spec" builds it backwards and double-counts every message.
**Fix:** rewrite §5.3 and §2 to match the implemented (and correct) reality.

### F-1.4 The read layer is told to hunt for statuses no adapter can produce

`docs/SCHEMA.md` ("Rules"), both `SKILL.md` copies (step 3), and the AGENTS.md section that `install` writes into consumer repos all direct reading agents to prioritize `status:"rejected"` / `status:"superseded"` ("paths that were closed"). But the `Status` type's `rejected`/`superseded` values are **never emitted by any adapter** — every status assignment in claude/codex/pi/hermes adapters produces only `"ok"` or `"error"`. The product's flagship reading guidance chases signal that cannot exist, which both wastes agent attention and erodes trust in the rest of the guidance.
**Fix:** decide the semantics — either (a) remove the statuses and the guidance until a mechanical producer exists, or (b) define mechanical producers (e.g., a Claude `tool_result` superseded by a retried call — requires a defensible non-LLM rule). Option (a) is charter-safe and immediate.

### F-1.5 Crash window between the two appends permanently drops index rows

`compileSession` (`src/sync/compile.ts:124-125`) appends the raw sidecar first, then the index. If the process dies between the two `appendFile`s (hook timeout kill, crash, disk full), the raw file already has N lines while the index has fewer than N rows for that session. On the next sync, the high-water mark is derived from the **raw** count — so the missing index rows are never written. Silent, permanent index gap; the raw pointer targets exist but nothing in the index points at them. (Same family: `appendFile` is not atomic — a mid-write crash can tear the final line, which `countLines` then counts as complete.)
**Fix:** reconcile on entry — count the session's rows in `index.jsonl` (they carry `agent`+`session`); if fewer than the raw count, regenerate the missing index lines mechanically from the raw sidecar (raw is a strict superset of index: strip `text`/`args`/`result`/`attachments`/`native_type`).

### F-1.6 No concurrency control despite the idempotency promise

Two overlapping syncs for the same session — a `SessionEnd` hook racing a manual `sync --scan`, or two hooks from two agents closing in the same project — both read the same high-water mark, both append events N..M, producing duplicated rows in both files. Nothing in the store detects or prevents it. The charter advertises idempotency; this is the hole in it.
**Fix:** a per-session (or per-store) lockfile created with `O_EXCL`, carrying pid+timestamp, with stale-lock stealing (e.g. >60s) and brief retry — dependency-free and proportionate.

### F-1.7 The Hermes hook flow cannot work as installed

`install --agent hermes` prints consent instructions to wire `agent-recall sync --from-hook` into `~/.hermes/config.yaml`. But Hermes hook payloads carry no `transcript_path` (there is no transcript file — the store is `state.db`), and `cmdSyncFromHook` (`src/cli.ts:75-101`) ignores `session_id` entirely. A bare `state.db` path parses to null (`parse` requires the `<db>::<session-id>` handle), so the hooked command can never sync the session that just closed. Hermes recall works only via `--scan`, which the install output doesn't say.
**Fix:** in `cmdSyncFromHook`, when no adapter recognizes a path but `session_id` is present, construct the Hermes handle (`$HERMES_DIR/state.db::<id>`) and compile that; adjust the install guidance to match.

### F-1.8 `--user` is advertised but implemented nowhere

CLI usage (`src/cli.ts:182`) documents `install [--user]`; `runInstall` parses only `--cwd` and `--agent`. A user-level install silently behaves as a project install. `docs/ARCHITECTURE.md` §3.3/§4 and `docs/DECISIONS.md` ADR-005 additionally promise a `~/.hermes/skills/` mirror "on request" that does not exist.
**Fix:** implement (`--user` → skill into `~/.agents/skills`, hook guidance for user-scope config) or remove from help text and both docs.

---

## 6. Findings — P2 (should fix)

### Correctness / robustness

- **F-2.1 Claude subagent transcripts and externalized tool results are invisible.** Newer Claude Code stores sidechains in `<session>/subagents/*.jsonl` and big tool outputs in `<session>/tool-results/*.txt` (verified on disk: 4 subagent files / 325 lines and 2 tool-result files for this repo's single session). `locate()` (`src/adapters/claude.ts:115-123`) only takes `*.jsonl` files directly in the project dir — subagent work, often the most exploratory/rejected-path-heavy work, is unreachable by recall. COMPILE-SPEC §5.1 even lists these sidecars as "gotchas" — then the adapter ignores them. Also per that spec, `~/.claude/transcripts/ses_*.jsonl` is matched by `matchPath` (hook input) but never scanned by `locate`.
- **F-2.2 `sanitizeSegment` collisions corrupt the high-water mark.** `store.ts:27-29` maps any non-`[A-Za-z0-9._-]` char to `-` and truncates to 200. Two distinct session ids that differ only in replaced characters (or beyond byte 200) share one raw dir → one shared `events.jsonl` → interleaved events from two sessions and a garbage high-water mark. Low probability with UUID-shaped ids, nonzero with hermes/other schemes.
  **Fix:** when sanitization changes the string, append a short hash of the original id.
- **F-2.3 Spec's `aws-secret` pattern was never implemented.** COMPILE-SPEC §3.1 promises `(?i)aws.{0,20}?['"][0-9a-zA-Z/+]{40}['"]`; `redact.ts` has no such rule. A bare 40-char AWS secret key (no assignment-shaped key word adjacent) passes through unredacted — the assignment regex can't match inside it either. Security-relevant spec gap. All 14 _other_ spec patterns are implemented.
- **F-2.4 Home-path leakage at scale in the "committable" index.** Real-data counts of previews containing `/Users/yakman`: Claude 196/486, Codex 64/495, Pi 1022/3630, Hermes 134+ (strict count blocked by F-0.2). The `cwd` field legitimately carries the absolute path, but previews reproduce it in ~30–50% of lines — usernames and project layout ship to whatever repo commits the index.
  **Fix (policy decision):** mechanically replace `$HOME` prefix with `~` in preview/text/raw strings (keep `cwd` intact), or explicitly document the index as machine-local.
- **F-2.5 Codex SessionEnd timeout is out of spec.** Installer writes `timeout: 15000` for `.codex/hooks.json`, but current Codex docs cap SessionEnd at **3 s (1 s default)**; the hook can be killed mid-compile → torn writes (see F-1.5). Codex hooks also currently require opting in (`codex -c features.codex_hooks=true`) — unmentioned by the installer.
  **Fix:** use ≤3000 for Codex (sync is sub-second per session once warm), and print the feature-flag note in install output.
- **F-2.6 `matchPath` ignores `CLAUDE_CONFIG_DIR`.** `locate()` honors `CLAUDE_CONFIG_DIR` but `matchPath` (`claude.ts:107-113`) requires a literal `/.claude/projects/` substring — hook-triggered syncs break for custom-config users.
- **F-2.7 `.gitignore` holes in this repo.** Only `**/.agent-recall/raw/` is ignored; this repo's own `.agent-recall/index.jsonl` (a 213 KB file materialized during testing) and `tmp/` are untracked-but-committable with one `git add .` — despite the gitignore's own comment "this tool's own repo does not ship a store."
  **Fix:** add `/.agent-recall/` and `/tmp/`.
- **F-2.8 Cursor adapter assumptions look guessed.** `locate()` requires the `agent-transcripts/` subpath under `~/.cursor/projects/<slug>`; forum/agentgrep evidence indicates desktop Cursor transcripts live directly under the project dir and the newer Cursor CLI (`cursor-agent`) keeps them in a **separate XDG-style home** the adapter never checks. `endsWith(slug)` suffix matching can also over-match sibling projects whose names share a suffix. The adapter's own NOTE admits it's untested against a live install. Needs real-device validation or an explicit "experimental" label in docs.
- **F-2.9 Hermes `locate()` misses cwd-less sessions.** 131 of 182 real sessions have an empty `cwd` and are unreachable. Consider `--all` or fuzzy attribution with user confirmation.
- **F-2.10 Documentation contradictions & stale mechanisms (condensed from the full drift audit):**
  - COMPILE-SPEC says "**Never hook `Stop`** — it fires every turn"; installer + CONSUMPTION + ARCHITECTURE ship `stop` for Cursor (deliberately, for cloud coverage, exploiting idempotency). Direct contradiction.
  - COMPILE-SPEC still says `.ai/index.jsonl`, `.ai/raw/` (§0/§7/§9) and names the binary `bin/sessions-sync` — the store was renamed `.agent-recall/` (ADR-001) and the binary is `agent-recall`. The spec predates both and was never updated.
  - COMPILE-SPEC §5.4–5.6 spec field maps for Gemini/Grok/Aider; ADR-004 descoped them. Aspirational text presented as spec.
  - Idempotency mechanism: docs (AGENTS.md, CHARTER, COMPILE-SPEC §6/§9, SCHEMA.md) promise dedupe on `agent+session+seq` / "native-line-id"; the code implements a raw line-count high-water mark. Equivalent for append-only sources; not the documented mechanism (see F-2.12).
  - `docs/ARCHITECTURE.md` §3.1 names `stripImages()` / `indexWriter.append()` — neither exists (actual: `toEnvelopes`, `appendJsonl` orchestrated by `compileSession`); AGENTS.md maps `src/sync/` as `redact.ts, images.ts, indexWriter.ts, types.ts` (actual: `compile.ts`, `store.ts`, `redact.ts`, `images.ts`, `types.ts` — `indexWriter.ts` never existed); says templates live in `src/install/templates/` (it's `templates.ts`).
  - `docs/SCHEMA.md` envelope shows a `raw` field never written; COMPILE-SPEC §4's example JSON likewise.
  - ARCHITECTURE §3.2 says raw contains "`source` — verbatim vendor file(s)"; code writes `source-<basename>`.
  - `docs/TESTING.md` says "28 tests, all passing … adapters (5)" — actual 30 (adapters 7; the two compaction tests postdate the doc).
  - AGENTS.md says `test/fixtures/` holds "redacted sample transcripts" and CHARTER says "every adapter ships with a fixture + a test" — `test/fixtures/` **exists but is empty**; all fixtures are inline objects in the test files.
  - Pi per spec §5.2: `bashExecution` → tool event, `custom` → keep-and-mark; adapter simply skips both (TESTING.md agrees with the code; the spec disagrees with both).
- **F-2.11 Plugin-bundle drift is unguarded.** CI runs `build:plugin` (which regenerates `plugin/bin/cli.js`) but never checks the result — a stale committed bundle would pass CI silently. Currently byte-identical (verified), so this is prevention: add `git diff --exit-code -- plugin/` after the build step.
- **F-2.12 Seq alignment is trusting.** The high-water scheme assumes an adapter's event array is byte-stable across versions. If event filtering ever changes (new event type included, ordering tweak), `seq` numbering shifts and new appends misalign with old rows — silently. Consider a per-session parse-version marker; on mismatch, re-compile the session (append-only store can tolerate a full re-sync under a new session suffix or a rewrite).

### Release / contribution readiness

- **F-2.13** No CONTRIBUTING.md, SECURITY.md, CHANGELOG.md, `.github/ISSUE_TEMPLATE/`, or PR template. SECURITY matters disproportionately here: the tool ingests transcripts containing secrets.
- **F-2.14** No `prepublishOnly` — `npm publish` isn't forced through `npm run check`.
- **F-2.15** Personal path in tracked files: `docs/TESTING.md:31-33` embeds `/Users/yakman` (twice).
- **F-2.16** AGENTS.md's uncommitted edit references `.claude/skills/running-headless-agent-workers/`, which `.gitignore:20` (`.claude/`) keeps out of the repo — cloners are told to read a file that won't exist. Force-add the skill (with a `!.claude/skills/` exception) or drop the reference.
- **F-2.17** No git tags (should have `v0.1.0`); main has 2 commits; AGENTS.md's "CI runs the same gate" slightly overclaims (CI is a superset — adds `build:plugin`).
- **F-2.18** README as a landing page: no CI badge (add post-public), no concrete plugin install command (`claude plugin marketplace add itsMay21/agent-recall` + `claude plugin install agent-recall@agent-recall`), and "writes the session-close hook config … for each named agent" overstates Hermes/Pi (guidance text only).

---

## 7. Findings — P3 (polish)

- CLI: `read --last NaN` on garbage; unknown flags silently ignored in `sync --scan`; an all-invalid `--agent` list syncs nothing without a peep; `--store` (used by TESTING.md) missing from `usage()`.
- Claude adapter drops images nested inside `tool_result` content arrays (only top-level `image` blocks are enveloped); `textFromContent(b["content"])` computed twice per tool_result.
- Codex: `local_shell_call` / `web_search_call` response-item types silently dropped (present in newer rollouts).
- `redacted` count excludes raw-text redactions when the preview is empty — undercount in the `redacted` field.
- Hermes on Node <22.5: `node:sqlite` unavailable → adapter silently yields nothing (engines says ≥20; deserves a one-line warning).
- `ts_source` documented as `native | mtime`; code only writes `mtime` (absent when native). Spec labels differ from code markers (`aws-access-key` vs `aws-akid`, `pem-block` vs `pem`, `github-oauth` vs `github-token`) — matters to anyone grepping markers; `google-oauth`, `slack-webhook`, `npm` rules lack tests.
- CHARTER §6 describes a "not on disk" message nothing prints; tier-2 adapters are docs-only fiction.
- Perf: adapters accumulate the full event array in memory (fine at MB scale; a 100 MB transcript would be heavy); Codex `locate()` opens the first line of every rollout on disk per scan; Hermes no-op re-sync costs 14.3 s (full recount over 51 sessions) — could persist per-session cursors.
- `build-plugin.mjs` relies on `copyFile` preserving mode; an explicit `chmod 0o755` would be deterministic. npm tarball ships `dist/cli.js` and `plugin/bin/cli.js` (44.5 KB twice) — fine if intentional, worth a comment.

---

## 8. Real-session benchmark (2026-08-16, this machine)

| Agent       | Source store                                                             | Sessions | Events synced | Secret spans redacted | Wall time | Idempotent re-run                                                  |
| ----------- | ------------------------------------------------------------------------ | -------- | ------------- | --------------------- | --------- | ------------------------------------------------------------------ |
| claude-code | `~/.claude/projects/-Users-yakman-Projects-agent-recall/` (2.3 MB JSONL) | 1        | 486           | 9                     | 1.0 s     | 0 added ✓                                                          |
| codex       | `~/.codex/sessions/**` (2 rollouts)                                      | 2        | 495           | 2                     | 1.5 s     | —                                                                  |
| pi          | `~/.pi/agent/sessions/--Users-yakman-Projects-relay-dev--/`              | 15       | 3,630         | 179                   | 3.4 s     | +7 events from a live-growing session ✓ (incremental append exact) |
| hermes      | `~/.hermes/state.db` (610 MB SQLite; 51 cwd-matching sessions of 182)    | 51       | 24,522        | 312                   | 8.3 s     | 0 added ✓ (14.3 s no-op cost)                                      |

Per-agent notes from the produced indexes:

- **Role distributions are sane** (tool-heavy, as real sessions are): Claude 312 tool / 88 thinking / 73 assistant / 13 user; Codex 372/51/44/27 + 1 compaction event; Pi 2331 tool / 628 thinking / 556 assistant / 83 user / 31 events / 1 system; Hermes 1252 tool / 47 user / 236 assistant / 81 thinking (jq-broken partial count).
- **Timestamps fully native**: `ts_source:"mtime"` fallback count was **0** in all four indexes.
- **Token-shaped secret scan** (`sk-…`, `ghp_`, `AKIA…`, `xox?`, `AIza…`, PEM blocks, JWT shapes) over all four full indexes: **0 hits**.
- **Compaction handling verified in the wild**: Codex index contains a `native_type:"compaction"` event row; Pi likewise (31 event rows include compactions and model changes).
- **Hook mode** (`sync --from-hook`) with a real-shaped Claude `SessionEnd` payload: compiled correctly and printed the accurate summary line. **`read --last 3`** renders sensible human output.
- **Raw sidecar size**: 4.1 MB for the 2.3 MB Claude transcript (superset: index fields + full args/result/text per line) — expected, worth documenting as a ~1.8× factor.
- **Consumer-compat**: `jq` rejects the full Hermes index (F-0.2). Node and CPython parse it. One malformed line poisons whole-file processing for strict consumers.

---

## 9. Adapter-by-adapter assessment

**Claude Code** (`src/adapters/claude.ts`) — Parses real 2.3 MB transcripts cleanly: user/assistant messages (string + block-array content), `thinking` blocks, `tool_use` (args preserved, smart preview from command/file_path/pattern/…), `tool_result` (status from `is_error`), top-level `image` blocks (enveloped), system lines, cwd/gitBranch capture, and a sensible SKIP_TYPES set (summary, file-history-snapshot, queue-operation, …). Gaps: subagents + tool-results sidecars and `~/.claude/transcripts/` never scanned (F-2.1); tool_result-nested images dropped; `matchPath` vs `CLAUDE_CONFIG_DIR` (F-2.6). The "internal, changes between versions" caveat in the header is honest and the conservative skip-list approach is right.

**Codex** (`src/adapters/codex.ts`) — Canonical-source choice (`response_item`) is correct and well-tested; `arguments` JSON-string parsing, reasoning summaries (summary_text), compaction capture without re-expanding `replacement_history` (recent commit; verified against real rollout). Gaps: `local_shell_call`/`web_search_call` dropped; `locate()` reads the first line of every rollout on disk (O(all sessions) per scan — fine at 12 files, slow at hundreds); first-line-must-be-`session_meta` assumption is fragile across versions.

**Pi** (`src/adapters/pi/pi.ts`) — The cleanest schema and it shows: typed session/message/toolCall/toolResult entries, compaction summary capture, model_change events, `custom` skipped by design. Real 15-session backfill worked first try including incremental growth. `encodeCwd` (`--<path-with-dashes>--`) verified against real directory names on disk.

**Hermes** (`src/adapters/hermes.ts`) — The boldest adapter: reads the canonical 610 MB SQLite store read-only via builtin `node:sqlite`, never copies it, uses `<db>::<session-id>` handles, `ORDER BY id` message ordering, JSON-blocks-or-plain content normalization, tool_calls expansion, reasoning columns → thinking events, compacted rows deliberately retained ("keep the uncompacted history" — the repo's most recent commit's promise, holds). Survived the full 51-session/24.5k-event backfill. Gaps: hook flow broken (F-1.7), cwd-less sessions unreachable (F-2.9), and its content produced the F-0.2 surrogate bug (which is the _writer's_ fault, not the adapter's).

**Cursor** (`src/adapters/cursor.ts`) — Honest about being lossy (text-only, mtime timestamps, no invented tools) and flagged untested in its own header. Path assumptions look partially wrong per external evidence (F-2.8). This is the one adapter that should either get a real-device validation pass or an explicit experimental label before publish.

**Registry/util** — Ordering and path-matching are sound (no overlap in `matchPath` domains); `readJsonl`'s skip-don't-abort malformed-line policy is the right untrusted-input posture; `dashEncode`/`epochToIso` correct.

---

## 10. Redaction: spec vs implementation matrix

| Spec pattern (COMPILE-SPEC §3)                  | Implemented?                 | Notes                                                   |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| pem-block                                       | ✓                            | Lazy-match to END marker; verified vs fake key in tests |
| aws-access-key-id                               | ✓                            | All 8 AKIA-family prefixes                              |
| github-pat / github-oauth / github-refresh      | ✓                            | `ghp_`, `github_pat_`, `gh[osur]_`                      |
| openai / openai-proj / anthropic                | ✓                            | `sk-`, `sk-proj-`, `sk-ant-`                            |
| google-api-key / google-oauth                   | ✓ / ✓ (untested)             |                                                         |
| slack-token / slack-webhook                     | ✓ / ✓ (untested)             |                                                         |
| stripe / gitlab / npm / jwt                     | ✓                            |                                                         |
| assignment-shaped (`api_key=…`, `secret: …`, …) | ✓ but bypassable             | F-1.1: quoted multi-word values escape                  |
| credentialed URLs                               | ✓                            | Password-only redaction, scheme/host kept               |
| **aws-secret (40-char)**                        | **✗ missing**                | F-2.3                                                   |
| home paths / emails                             | not in spec, not implemented | F-2.4 policy decision                                   |

Marker labels differ from spec text (code: `aws-akid`, `pem`, `github-token`; spec: `aws-access-key`, `pem-block`, `github-oauth`) — irrelevant to safety, relevant to greppers. Structural choices are good: key-name preservation for assignments, scheme/host preservation for URLs, no entropy heuristics that could blank prose (charter-compliant).

---

## 11. Security & privacy assessment

- **Ingestion safety:** every native line passes through guarded `JSON.parse`; no eval family; no shell-outs; regexes are linear (no nested-quantifier ReDoS shapes found); `redactDeep` rebuilds into fresh objects (no prototype-pollution path; crafted `__proto__` keys are dropped, worst case data loss not code exec).
- **Secret handling on write:** index previews and raw strings all pass `redactString`/`redactDeep` — the mechanical guarantee held against 29k real events for token shapes. The known holes are F-1.1 (multi-word quoted values) and F-2.3 (bare AWS secrets), plus whatever isn't in the pattern families at all (emails, home paths, connection strings without schemes — policy decisions, F-2.4).
- **Raw store containment:** `raw/` holds verbatim pre-redaction vendor bytes by design; `install` adds the gitignore rule; this repo's own gitignore misses its own `/.agent-recall/` root (F-2.7). The README-store template warns correctly.
- **Hook execution model:** the plugin invokes `node ${CLAUDE_PLUGIN_ROOT}/bin/cli.js` (pinned, no PATH dependence, no npx fetch); `sync` exits 0 on all errors by design so it can't kill a host session — correct posture, and stderr still informs.
- **Biggest residual privacy question:** the committable index leaks usernames/paths in previews at the rates measured in F-2.4. Decide before anyone commits an index to a public repo.

---

## 12. Test coverage analysis

**Well covered:** redaction token families (17 cases incl. PEM, assignments, credentialed URLs, prose non-redaction); index-vs-raw field split; idempotency at rest; growth append; image stripping (hash/size, no base64); preview truncation + mtime fallback; per-adapter happy paths incl. Codex event_msg de-dup, both compaction behaviors, Hermes via in-memory SQLite with a faithful schema.

**Coverage map:** `sync/redact.ts` strong · `sync/compile.ts` good · `sync/store.ts` partial (no torn-line/collision tests) · `sync/images.ts` good · adapters parse() good / **locate() only Hermes** / **matchPath none** · `adapters/util.ts` partial · `install/*` **none** · `cli.ts` **none** (no e2e through the actual entrypoint) · registry none.

**Missing tests, prioritized:**

1. **Strict-JSON round-trip of written stores** (jq or equivalent) — would have caught F-0.2.
2. **Redaction canaries**: multi-word quoted values (F-1.1), bare 40-char AWS secrets (F-2.3), emails/home paths per chosen policy.
3. **Crash-window & concurrency**: kill between appends → next run reconciles; two parallel compiles → no duplicates (F-1.5/1.6).
4. **Adapter edges**: matchPath matrix (incl. `CLAUDE_CONFIG_DIR`), locate() for claude/codex/pi/cursor, Claude system lines + tool_result images + `is_error:true`, Codex `local_shell_call`/`web_search_call`, pi `model_change`, real-format files under `test/fixtures/` (currently empty despite AGENTS.md/CHARTER claiming populated fixtures — the repo's own standard, violated).
5. **Installer**: idempotency (run twice → no duplicate hook entries/settings), what it writes where, hermes/pi guidance paths.
6. **CLI e2e** via the real entrypoint against a fixture tree (arg parsing, exit codes, `--from-hook` incl. the hermes session_id path once F-1.7 is fixed).

---

## 13. Documentation drift (full list)

Verified-consistent: SCHEMA.md's 14 index fields match `IndexLine` exactly (names, optionality, casing, enums, raw-pointer format); CLAUDE.md is a pure `@AGENTS.md` import (same mechanism install writes); the two SKILL.md copies byte-identical; npm scripts/AGENTS.md/TESTING.md command claims all exist in code; version 0.1.0 and repo URL consistent across package.json/plugin/marketplace/LICENSE.

Drift, by severity — details in F-1.3 (inverted Codex guidance), F-1.4 (unproducible statuses), F-1.8 (`--user`), F-2.10 (`.ai/` rename remnants, `sessions-sync` binary name, Stop-hook contradiction, `indexWriter.ts`/`stripImages()`/`templates/` phantom names, envelope `raw` field, `source-` naming, `~/.hermes/skills/` promise, TESTING.md's 28-vs-30, empty fixtures claim, Pi bashExecution/custom), F-2.16 (`.claude/` gitignored but referenced), P3 (ts_source `native`, label names, CHARTER's "not on disk", §5.4–5.6 fictional adapters, `--store` undocumented, README blanket install claim).

The pattern: **ARCHITECTURE/SCHEMA/TESTING track the code well; COMPILE-SPEC is the wrongest file in the repo** — it reads like a pre-implementation design doc that was never reconciled after ADR-001 (rename) and the Codex ground-truth work. Since AGENTS.md ranks it as authoritative #4, reconciling it is documentation-P1.

---

## 14. GitHub & contribution readiness

Present and correct: MIT LICENSE matching metadata; CI on Node 20/22 with npm cache running the full gate **plus** `build:plugin` (a superset — fine, but then AGENTS.md's "CI runs the same gate" should say so); valid, version-aligned plugin manifests; byte-fresh committed plugin bundle with exec bit; clean `npm pack --dry-run` (all `files` entries exist, no strays); tsup emits ESM + shebang for the bin; AGENTS.md's dev-workflow commands all work as written; no secrets in tracked files.

Missing for "contribution-ready": CONTRIBUTING.md (point at `npm run check` as the gate, fixture-per-adapter standard, adapter checklist incl. real-session note in TESTING.md — the rules exist in AGENTS.md/CHARTER but not in a contributor-facing entry point), SECURITY.md (secret-bearing-input tooling needs a vulnerability-reporting policy), CHANGELOG.md, issue/PR templates, `prepublishOnly`, a `v0.1.0` tag, a public repo (F-0.1), CI-badge + concrete plugin-install instructions in the README, and the TESTING.md personal-path scrub (F-2.15).

---

## 15. Ecosystem landscape & positioning

Existing tools in the adjacent space: [coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search) (unified TUI/CLI indexing 11+ providers — human-facing search), [Contextify](https://news.ycombinator.com/item?id=48777790) (indexes Claude+Codex sessions into one local DB for cross-pollination), [claude-grep](https://claude-grep.vercel.app/) (phrase-search Claude history), [claude-code-transcripts](https://simonw.substack.com/p/a-new-way-to-extract-detailed-transcripts) (transcript → HTML), plus DIY session-search skills. All are **human search tools over central stores**.

agent-recall's defensible niche is different and worth stating sharply in the README: **per-project, mechanically redacted, agent-readable recall wired into the session lifecycle** — write on SessionEnd (hook), read before work starts (AGENTS.md pointer + skill), no LLM anywhere, committable interchange format. No surveyed tool does the install-into-the-project + read-layer wiring.

Natural extensions consistent with the charter: **Gemini CLI / Aider / OpenCode-Amp adapters** (next three by usage); **Cursor-CLI's separate home dir**; **subagent/sidechain ingestion** (F-2.1 — biggest recall-quality win); **retention/pruning + `doctor`** (validate every index line parses, seq continuity, orphan raw dirs, store size caps); **`read --grep`** for humans; **`--user`-level read-layer install** into `~/.agents/skills`.

---

## 16. Recommended fix order

1. **User decisions:** repo visibility (F-0.1); home-path redaction policy (F-2.4); fate of `rejected`/`superseded` (F-1.4); whether Cursor ships labeled experimental (F-2.8).
2. **Same-day code fixes:** surrogate sanitization + strict-JSON test (F-0.2); assignment-regex bypass + canaries (F-1.1); README agent ids + alias (F-1.2); crash-window reconcile (F-1.5); session lock (F-1.6).
3. **This week:** COMPILE-SPEC rewrite (F-1.3, F-2.10 — single highest-leverage doc fix); Hermes hook flow (F-1.7); `--user` implement-or-remove (F-1.8); aws-secret rule (F-2.3); Codex timeout + feature-flag note (F-2.5); gitignore holes (F-2.7); CONTRIBUTING/SECURITY/templates + `prepublishOnly` + tag (F-2.13/2.14); `.claude/` skill resolution (F-2.16).
4. **Next:** subagent ingestion (F-2.1); sanitizeSegment hashing (F-2.2); Cursor real-device validation (F-2.8); fixtures dir + the six missing test families (§12); plugin-drift CI guard (F-2.11); hermes cwd-less fallback (F-2.9).

---

## 17. References

**External verification (web):**

- Claude Code hooks — SessionEnd payload (`session_id`, `transcript_path`, `cwd`, `hook_event_name`), settings.json shape: [official hooks docs](https://docs.anthropic.com/en/docs/claude-code/hooks), [implementation-level guide](https://hidekazu-konishi.com/entry/claude_code_hooks_complete_guide.html), [feature issue #4318](https://github.com/anthropics/claude-code/issues/4318), [lifecycle hooks overview](https://claudefa.st/blog/tools/hooks/session-lifecycle-hooks), [hooks explained](https://blakecrosley.com/blog/claude-code-hooks-explained), [30 examples](https://www.morphllm.com/claude-code-hooks)
- Codex hooks — `.codex/hooks.json` project config, SessionEnd 1s default / 3s max timeout, experimental `features.codex_hooks` flag: [official hooks docs](https://learn.chatgpt.com/docs/hooks), [discussion #2150](https://github.com/openai/codex/discussions/2150), [community reference](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference), [execution context](https://symposium.dev/design/agent-details/codex-cli.html)
- Cursor transcript storage — `~/.cursor/projects/` JSONL, dual-home layout for Cursor CLI: [forum: accessing transcripts](https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311), [agentgrep Cursor CLI notes](https://agentgrep.org/backends/cursor-cli/), [observability feature request](https://forum.cursor.com/t/richer-agent-transcripts-lifecycle-data-for-observability-langfuse-stop-hooks/166592), [cursor-history tool](https://github.com/nick-fullpath/cursor-history)
- Landscape: [coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search), [Contextify (HN)](https://news.ycombinator.com/item?id=48777790), [claude-grep](https://claude-grep.vercel.app/), [claude-code-transcripts](https://simonw.substack.com/p/a-new-way-to-extract-detailed-transcripts), [Claude sessions docs](https://code.claude.com/docs/en/sessions)

**In-repo cross-references for fix work:** `src/sync/compile.ts:40` (F-0.2), `src/sync/compile.ts:124-125` (F-1.5), `src/sync/redact.ts:47` (F-1.1), `src/sync/store.ts:27-29` (F-2.2), `src/cli.ts:75-101,182` (F-1.7/1.8), `src/adapters/claude.ts:107-123` (F-2.1/2.6), `src/install/installer.ts:129-154` (F-2.5), `README.md:51` (F-1.2), `.gitignore` (F-2.7), `docs/COMPILE-SPEC.md` §2/§5.3/§7/§9 (F-1.3/2.10), `docs/TESTING.md:31-33` (F-2.15).

---

_Audit artifacts (tmp/ stores, benchmark outputs, repo-root test store) were removed after verification. No source, doc, or config files were modified during this audit; `AUDIT-REPORT.md` is the only file added._
