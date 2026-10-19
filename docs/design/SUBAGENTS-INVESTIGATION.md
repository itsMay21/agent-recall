# Sub-agent / fork investigation — on-disk representation across agents

Scope: how Claude Code, Codex, Cursor, and Pi represent sub-agent (sidechain/fork) sessions on disk,
what mechanical linkage fields exist natively, and what agent-recall should do with them.
Everything below was verified against real files on this machine (2026-08-16), except Cursor
(not installed here — see below). Per CHARTER §1: nothing here requires an LLM; every field cited
is a native, typed field. Where linkage is only recoverable by text-mining prose, it is called out
as **not mechanical** and recommended to stay absent.

---

## On-disk representation

### Claude Code — `~/.claude/projects/<mangled-cwd>/`

Two layouts coexist:

1. **Separate subagent files (current, observed):**
   `~/.claude/projects/-Users-yakman-Projects-agent-recall/36b01876-3e83-4d49-95f3-a5d9928c872f/subagents/agent-a1051bdb54b838de1.jsonl`
   (8 such files for this one parent session). Every line in these files carries, natively:
   - `isSidechain: true`
   - `agentId: "a1051bdb54b838de1"` (matches the filename `agent-<agentId>.jsonl`)
   - `sessionId: "36b01876-3e83-4d49-95f3-a5d9928c872f"` — **the parent session id, on every line**
   - `parentUuid: null` on the first line, then the normal uuid/parentUuid message chain
   - same envelope fields as top-level sessions (`cwd`, `gitBranch`, `timestamp`, `type`, `version`,
     `entrypoint`, `userType`)
     Sample: first line of `agent-a1051bdb54b838de1.jsonl` is `type: "user"` with keys
     `['agentId','cwd','entrypoint','gitBranch','isSidechain','message','parentUuid','promptId','sessionId','timestamp','type','userType','uuid','version']`.

2. **Inline sidechain lines (older layout):** some sessions in
   `~/.claude/projects/-Users-yakman-Projects-example-project/` embed `isSidechain` lines directly in the
   single `<sessionId>.jsonl` (all lines `isSidechain: false` in the file checked here, but the
   field exists machine-wide; older builds wrote `true` lines inline).

**Parent side:** the parent `36b01876-….jsonl` records the spawn as a tool_use with
`name: "Agent"` and typed input `{ subagent_type, description, prompt }` (4 uses in this session;
the older `Task` name had 0 occurrences). For async agents, the tool_result text contains the
agentId ("Async agent launched successfully… agentId below") — but that is **prose**, so mapping a
specific `Agent` call to a specific `subagents/agent-<hash>.jsonl` via that text is **not
mechanical**. The structural link is the `sessionId` field inside the subagent file (child →
parent) plus `agentId` (file identity). `queue-operation` lines in the parent carry `sessionId` +
`operation` for async queueing.

### Codex — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`

Every rollout starts with a `type: "session_meta"` line whose payload natively includes:
`id`, `session_id`, `timestamp`, `cwd`, `cli_version`, `context_window`, `model_provider`,
`history_mode`, `base_instructions`, `dynamic_tools`, `originator`, `source`, `thread_source`.

**Sub-agent forks are first-class sessions** with extra typed fields (3 of 12 rollouts on this
machine). Verified example
`~/.codex/sessions/2026/08/13/rollout-2026-08-13T21-49-40-019ffbec-1381-78f3-85ff-bfa9d3742df7.jsonl`:

- `thread_source: "subagent"` (top-level sessions: `thread_source: "user"`)
- `parent_thread_id: "019ffbc4-57f7-7561-a058-dd62db5d9ed3"` — **resolves to a real parent rollout**
  (`rollout-2026-08-13T21-06-16-019ffbc4-….jsonl` in the same tree)
- `source: {"subagent": {"other": "guardian"}}` — a **typed subagent kind** (top-level: `source: "vscode"`)
- `multi_agent_version: "disabled"` (present only on forks)
- `originator: "codex_work_desktop"` (top-level: `"Codex Desktop"`)

Parent sessions orchestrate children through thread tools, visible as typed tool names in the
parent rollout: `send_message_to_thread`, `read_thread`, `read_thread_terminal`, `wait_threads`,
`list_threads`, `set_thread_title`, `set_thread_pinned`, `set_thread_archived`.
Note: Codex sessions live under date directories, not per-cwd, so `locate()` must filter by the
`payload.cwd` of `session_meta`; forks inherit the parent's cwd, so they are findable the same way.

### Cursor — not installed on this machine

No `~/.cursor` and no `~/Library/Application Support/Cursor/` exist here, so nothing could be
verified locally. Per `docs/COMPILE-SPEC.md` (§ format table + § honest gaps), Cursor's surfaces
are: `agent-transcripts` (text-only; tools reduced to prose — no typed argv, hence no typed spawn
records), `store.db` (graph in hex-encoded JSON), and `state.vscdb` (`toolFormerData`; **never
write it**). Cursor is already listed last in the build order, and cloud/Cowork is a stub
("not on disk"). **No sub-agent linkage claims are made for Cursor** until verified on a machine
that has it.

### Pi — `~/.pi/agent/sessions/<mangled-cwd>/`

Two layers:

1. **Top-level sessions:** `<ISO-ts>_<session-id>.jsonl`, head line
   `{"type":"session","version":3,"id","timestamp","cwd"}` (verified: this investigator's own
   session file). Every subsequent line carries `id`/`parentId` — a native message DAG
   (`model_change`, `thinking_level_change`, `message` all have `parentId`). No `parent` session
   field exists on top-level session lines — linkage is not stored here.

2. **Sub-agent artifacts (pi-subagents extension):** sibling directory
   `~/.pi/agent/sessions/<mangled-cwd>/subagent-artifacts/` with per-run quadruples:
   `<runId>_<agent>_<idx>_input.md`, `_meta.json`, `_output.md`, `_transcript.jsonl`
   (verified: `--Users-yakman-Projects-example-project--/subagent-artifacts/06777f03_reviewer_0_*`).
   - `_transcript.jsonl` records are self-describing:
     `{"version":1,"recordType":"message","source":"foreground","runId":"06777f03","agent":"reviewer","childIndex":0,"cwd","ts","timestamp","sourceEventType","role","text"}` —
     so run id, agent name, and child index are **native typed fields**.
   - `_meta.json` natively carries: `runId`, `agent`, `task`, `exitCode`, `processSignal`,
     `model`, `attemptedModels`, `modelAttempts`, `usage` (tokens + cost), `toolCount`,
     `durationMs`, `transcriptPath`, `acceptance`, `effects`.
   - **Parent attribution is weak:** the artifacts dir is per-cwd (shared by all sessions in that
     cwd), and no parent-session field is recorded in meta or transcript. The extension sets
     `PI_SUBAGENT_PARENT_SESSION` in the child env for permission forwarding
     (`pi-subagents/src/extension/index.ts:728`, `src/runs/shared/pi-args.ts:99`) but does not
     persist it in the artifacts. Grepping `runId` across the cwd's session files matched **two**
     different parent sessions (`2026-08-14T16-36-46-478Z_01a00122-….jsonl` and
     `2026-08-14T17-30-38-674Z_01a00153-….jsonl`) — attribution by content search is ambiguous and
     therefore **not mechanical**; it must not be encoded as a confident parent link.

### Current agent-recall behavior

`grep -i 'sidechain|subagent|parent' src/adapters/{claude,codex,pi}.ts` → no matches. Adapters
today ignore all of the above; `ParsedSession` (`src/sync/types.ts`) has no parent/origin fields,
and `IndexLine` (`v, ts, agent, session, seq, cwd, git_branch, role, name, status, preview, raw,
ts_source, redacted`) cannot express sub-agent relationships at all.

---

## Recommended data model for agent-recall

Keep the index event-grained (it already is) and **denormalize session-level sub-agent metadata as
optional fields on every line** — no new line type, no second file, trivially filterable by any
consumer reading `index.jsonl` line-by-line.

Add to `ParsedSession` (adapter output) and mirror onto `IndexLine` / `RawEventLine`:

```ts
// src/sync/types.ts (additions)
export type SessionOrigin = "user" | "subagent";

interface ParsedSession {
  // …existing fields…
  origin?: SessionOrigin; // omit = "user" (back-compat with existing index lines)
  parent?: {
    // only when natively, structurally recorded
    agent: AgentId; // same-agent parents only observed so far
    session: string; // parent session id
  };
  subagentKind?: string; // native typed kind only: Codex source.subagent.other
  // ("guardian"); Claude subagent_type only if a typed link exists;
  // pi agent name ("reviewer")
  spawnKey?: string; // child-stream identity: Claude agentId, Codex thread id,
  // pi `${runId}:${agent}:${childIndex}`
}
```

Per-agent mechanical extraction (field → model):

| Field            | Claude                            | Codex                                              | Pi                                  | Cursor     |
| ---------------- | --------------------------------- | -------------------------------------------------- | ----------------------------------- | ---------- |
| `origin`         | `isSidechain === true`            | `thread_source === "subagent"`                     | file lives in `subagent-artifacts/` | unverified |
| `parent.session` | `sessionId` on subagent lines     | `parent_thread_id` (verify it resolves; else omit) | **omit** (ambiguous, see above)     | unverified |
| `subagentKind`   | — (not structurally linked; omit) | `source.subagent.other`                            | `agent` field in transcript/meta    | unverified |
| `spawnKey`       | `agentId`                         | rollout `session_id`                               | `runId`+`agent`+`childIndex`        | unverified |

Session id in the index: a sub-agent stream must not collide with its parent's `session`. Use
`session = "<parentSessionId>/<spawnKey>"` (e.g. `36b01876-…/a1051bdb54b838de1`,
`019ffbec-…` for Codex where the rollout id is already unique). The dedupe key
(`agent + session + seq` / native-line-id) then works unchanged and `sync` stays idempotent.

Charter compliance: every field above is copied verbatim from a native typed field; nothing is
inferred from prose; absent stays absent (Claude `subagentKind`, Pi `parent`).

---

## Depth options + CLI flag

One flag, three modes, plus a depth cap for nesting (a subagent spawning a subagent — Codex
`thread_source` chains make this possible):

```
agent-recall sync [--subagents=skip|link|inline] [--subagent-depth=N]   # default: link, depth 2
```

- **`skip`** — index only `origin: "user"` sessions. Subagent files are located (so `--scan`
  still sees them for mtime purposes) but produce no index lines. Smallest index; today's behavior.
- **`link`** (default) — index each sub-agent stream as its own session (`session =
parent/spawnKey`) carrying `origin: "subagent"`, `parent`, `subagentKind`. Consumers get the
  relationship without reading child bodies; `read` can filter `--top-level` or
  `--with-subagents`.
- **`inline`** — additionally fold child events into the parent's event stream: child events keep
  their own `seq` from the child file but are also reachable under the parent session via the
  `parent` field. Concretely: same lines, plus `read <parentSession>` recurses one level. (True
  interleaved re-sequencing would require inventing a global order — not mechanical — so inline is
  implemented as read-time recursion, never as rewritten `seq`.)
- **`--subagent-depth=N`** — cap recursion when locating nested streams (Claude `subagents/` dirs
  are flat today; Codex forks nest via `parent_thread_id` chains). `0` ≡ `skip`.

`read` side: `agent-recall read [--with-subagents]` (default off = today's output) and
`agent-recall read <session>#<spawnKey>` addressing for a single child stream.

---

## Risks

1. **Double-indexing Claude's two layouts.** Older sessions inline `isSidechain:true` lines in the
   parent file; current ones use `subagents/agent-*.jsonl`. If both are parsed as streams, the
   same logical events index twice. Mitigation: route by rule — inline sidechain lines are skipped
   when depth allows, separate files are the stream — and rely on `agent+session+seq` dedupe as
   the backstop.
2. **Ambiguous Pi parentage is real, not hypothetical.** runId `06777f03` greps out of **two**
   parent session files. Encoding a guessed parent would violate the charter. Keep `parent` absent
   for Pi until the extension persists `PI_SUBAGENT_PARENT_SESSION` (or the session head records
   spawned run ids) in the artifacts.
3. **Dangling parents.** A subagent file can outlive its parent (parent pruned, or hook fired for
   the child only). `parent` must be treated as advisory: `read` and dedupe never require the
   parent line to exist.
4. **Index growth.** One Claude session here spawned 8 subagents × ~87 lines ≈ 700 extra lines.
   With `link` as default this multiplies index size several-fold for heavy orchestrator sessions;
   `--subagents=skip` must remain a first-class escape hatch, and `read` defaults to top-level.
5. **Codex parent resolution cost.** `parent_thread_id` → parent rollout requires a scan of
   `~/.codex/sessions/**` (date-partitioned). Cache the id→file map per sync run; if unresolved,
   keep `origin: "subagent"` and omit `parent`.
6. **Untrusted-content surface grows.** Subagent transcripts (and Pi `meta.json` `task` strings)
   are attacker-controlled input like any transcript; they must pass through the same
   redaction/hash pipeline. Never render `task`/`prompt` text beyond the existing `preview`
   truncation; Pi `meta.json` `usage.cost` etc. stays out of the index unless SCHEMA.md says
   otherwise.
7. **Prose traps.** Claude's async tool_result embeds agentId in text; Codex parents mention
   threads in `send_message_to_thread` args. Both are off-limits for linkage (charter: never infer
   from prose). Only the typed fields listed in the model above are used.
8. **Cursor unknowns.** Claims about `store.db`/`state.vscdb` sub-agent structure would be
   unverified guessing; keep Cursor stubbed for this feature (consistent with COMPILE-SPEC
   "honest gaps" and "Cursor last").

---

## Concrete next steps for the adapters

1. **Types first** (`src/sync/types.ts`): add `origin`, `parent`, `subagentKind`, `spawnKey` to
   `ParsedSession` + `IndexLine`/`RawEventLine`; extend `docs/SCHEMA.md` with the three optional
   fields and the `<parentSessionId>/<spawnKey>` session-id rule. All optional → existing indexes
   stay valid.
2. **Claude adapter** (`src/adapters/claude.ts`):
   - `locate()`: also return `<sessionId>/subagents/agent-*.jsonl`.
   - `parse()`: on a subagents file, set `origin: "subagent"`, `parent.session` from the line-level
     `sessionId`, `spawnKey` from `agentId`, and `session = sessionId + "/" + agentId`.
   - Parent files: skip inline `isSidechain:true` lines (record count skipped, like other skips).
   - Do NOT extract `subagent_type` from `Agent` tool_use into the child record (no typed
     call→file link). It already lands in the parent stream as ordinary tool args.
3. **Codex adapter** (`src/adapters/codex.ts`):
   - Read the `session_meta` first line; `origin` from `thread_source`; when `parent_thread_id`
     exists, resolve against the rollout map and set `parent` (omit if unresolved);
     `subagentKind` from `source.subagent.other` (guard against `source` being a plain string).
   - Build the id→rollout map once per `locate()` scan (`~/.codex/sessions/**` by
     `session_meta.payload.id`).
4. **Pi adapter** (`src/adapters/pi.ts`):
   - `locate()`: include `subagent-artifacts/*_transcript.jsonl` (+ sibling `_meta.json`).
   - `parse()`: `origin: "subagent"`, `spawnKey = runId:agent:childIndex` (typed fields on every
     record), `subagentKind` from `agent`, `session = <dir-context>/<spawnKey>`; **omit `parent`**
     (ambiguous; documented in SCHEMA.md as a known absence).
   - Map `recordType: "message"` + `role` onto `RawEvent` roles; `sourceEventType` → `nativeType`.
5. **CLI + read**: implement `--subagents=skip|link|inline`, `--subagent-depth=N`,
   `read --with-subagents`; default `link`/`2`.
6. **Fixtures + tests** (`test/fixtures/`, vitest): one redacted fixture per agent —
   `36b01876-…/subagents/agent-a1051bdb54b838de1.jsonl` (Claude), the `019ffbec` guardian fork
   (Codex), `06777f03_reviewer_0_{meta,transcript}` (Pi) — covering: link fields, skip mode,
   dedupe across both Claude layouts, dangling parent, ambiguous-Pi-parent omission.
7. **docs/TESTING.md**: add a real-session note citing the exact files above (paths under
   `~/.claude/projects/-Users-yakman-Projects-agent-recall/…`, `~/.codex/sessions/2026/08/13/…`,
   `~/.pi/agent/sessions/--Users-yakman-Projects-example-project--/subagent-artifacts/…`), per the
   "no adapter done without a real-session note" rule.
8. **Cursor**: no work until verifiable — needs a machine with Cursor installed; until then the
   adapter keeps its existing behavior and SCHEMA.md marks sub-agent fields "not on disk /
   unverified" for `cursor`.
