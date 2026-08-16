# compile spec — historical reference (⚠️ not authoritative)

> **Read this second, not first.** This is the pre-implementation research distillation. It predates
> the build and uses old names in places. **The source of truth is the code** (`src/adapters/*`) and
> [`SCHEMA.md`](SCHEMA.md) / [`DECISIONS.md`](DECISIONS.md). Where they disagree, they win. Known
> corrections since this was written:
>
> - Store dir is **`.agent-recall/`** (not `.ai/`); the binary is **`agent-recall`** (not `sessions-sync`) — ADR-001.
> - **Codex:** `response_item` is the **canonical** conversation source; `event_msg` is the derived UI
>   stream we **skip** (the opposite of §5.3 below). See `src/adapters/codex.ts`.
> - Cursor `stop` is installed **deliberately** for cloud coverage (idempotency makes it safe) — the
>   "Never hook Stop" note below applies only to per-turn normalization, not to our idempotent sync.
> - Default sub-agent mode is **`calls`** everywhere including hooks (ADR-007). §5.4–5.6 (Gemini/Grok/
>   Aider) are aspirational; those adapters are tier-2/unbuilt (ADR-004).

**For:** Mayank Saini · **Companion to:** `UNIFIED-FULL.txt` (the deep brief)
**Purpose:** The mechanical, no-LLM sanitize/compile layer for a unified session store.
This file is the *adapter + redaction spec* the skill-creator consumes. It does not re-argue
the brief (bias theory, naming, competitors) — it answers only "what do we copy, what do we
strip, what do we skip," plus the redaction rules the brief names but never specifies.

Verified against live official docs on 2026-08-15. Deltas from the brief are flagged **[Δ]**.

---

## 0. The one rule

Compile = **parse → redact → index**. No LLM in this path. If a field is absent in the
native store, it stays absent. Never infer a tool name, argv, or decision from prose.

A curated `handoff.md` (if you ever want one) is a **read-time / human** step, never `sessions-sync`.

---

## 1. Live verification (2026-08-15)

| Fact | Status | Note |
|---|---|---|
| Claude path `~/.claude/projects/<dash-cwd>/<id>.jsonl` | ✅ exact | non-alnum→`-`; >200 chars → truncate+hash |
| Claude JSONL format "internal, changes between versions" | ✅ still warned | do not treat line schema as a stable API |
| Claude `SessionEnd` carries `transcript_path` | ✅ | best official closer |
| Claude `SessionEnd` timeout | **[Δ]** | 1.5s **shared budget**, raised to your per-hook `timeout`, **max 60s**. Set `timeout: 15000`. |
| Claude write-suppression | **[Δ] new** | `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `--no-session-persistence` (per `-p` run) |
| Claude `cleanupPeriodDays` = 30 | ✅ | copy raw or lose it |
| Codex hook set | **[Δ] richer** | now also `PreToolUse`/`PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `SubagentStart/Stop`, `Stop`. Docs moved → `learn.chatgpt.com/docs/hooks` |
| Codex `SessionEnd` | ✅ | **synchronous + advisory**; `reason` currently **always `"other"`**; `transcript_path` **can be null** |
| Pi tree JSONL + `toolCall`/`toolResult` | ✅ exact | `toolResult` gained optional `usage?: Usage` **[Δ]** |
| Pi `custom` excluded from LLM context | ✅ | keep in tree, mark non-context |
| Aider `.aider.chat.history.md` in repo, markdown | ✅ | default; `--restore-chat-history` false |
| Gemini `~/.gemini/tmp/<hash>/chats/`, full tool I/O, 30-day | ✅ exact | `--list-sessions`, `--resume`, `--delete-session` |
| OpenHands `base_state.json` + `events/`; **secrets + tool outputs + skills persisted** | ✅ exact | hard-redact `base_state.json`; never commit |

Everything load-bearing in the brief survived. Build on it.

---

## 2. Tool-call & logging matrix (the direct answer)

"Which agents log tool calls?" → this is the copy-vs-skip decision per adapter.

| Agent | Tool name+args | Tool results | Skills/rules in transcript | System prompt | Images | Verdict for compile |
|---|---|---|---|---|---|---|
| **Claude Code** | ✅ typed (`tool_use`) | ✅ (large → `tool-results/` sidecar) | ❌ CLAUDE.md re-injected; skill *use* shows as tool call | ❌ injected at API time | ⚠️ base64 → hash | **copy typed** |
| **Pi** | ✅ typed (`toolCall`) | ✅ typed (`toolResult`) | ❌ (only if a `custom_message` injected it) | ❌ | ✅ base64 → hash | **copy typed, cleanest** |
| **Codex** | ✅ | ✅ | ❌ AGENTS.md loaded not stored | ⚠️ partial (`session_meta`) | ⚠️ inline base64, can explode | **copy; filter `event_msg` vs synthetic `response_item`; don't double-count** |
| **Gemini CLI** | ✅ (`toolCalls[]`) | ✅ | ❌ GEMINI.md separate | ❌ | ⚠️ | **copy typed** |
| **OpenHands** | ✅ | ✅ (persisted) | ✅ activated skills in `base_state` | ⚠️ agent config | ⚠️ | **copy; redact HARD (secrets persisted)** |
| **Grok Build** | ✅ (`chat_history.jsonl` + ACP `updates.jsonl`) | ✅ | ⚠️ | ❌ | ❓ unverified | **copy; usage lives in `updates.jsonl`** |
| **Cline** | ✅ (`ui_messages.json` say/ask types) | ✅ | ❌ Memory Bank is project md | ❓ | ❓ | copy (two JSON files) |
| **Copilot CLI** | ✅ (`events.jsonl`) | ✅ | ❌ | ❓ | ❓ | copy |
| **Amp** (local mirror) | ✅ typed blocks | ✅ | ❌ | ❓ | ❓ | copy **only if mirror complete**; else stub (server canonical) |
| **Aider** | ⚠️ prose only (`####`/`>` lines) | ⚠️ prose | ❌ | ❌ | ❌ | **text + turn split only; do NOT synthesize typed tools** |
| **Cursor `agent-transcripts`** | ⚠️ often text-only | ⚠️ | ❌ `.cursor/rules` separate | ❌ | ⚠️ | text + pointer to `store.db`; **never invent argv** |
| **Cursor `store.db`** | ✅ graph (hex JSON) | ⚠️ | — | ❓ | ⚠️ | medium; read-only; WAL |
| **Cursor `state.vscdb`** | ✅ (`toolFormerData`) | ⚠️ mixed in bubbles | — | ❓ | ⚠️ | **hard; never write it** |
| Windsurf / Warp / Zed | ❓ private SQLite | ❓ | ❌ | ❓ | ❓ | text-only at best; hard |
| Cloud (Cursor-cloud, Cowork, Devin-cloud, ChatGPT desktop v2/v3) | — | — | — | — | — | **stub: "not on disk"** |

**Who strips / skips (the "skip logging" answer):**
- **Aider** and **Cursor `agent-transcripts`** — tools reduced to prose; no typed argv recoverable.
- **catchup** (the exporter) — *deliberately* strips tool calls; don't reuse it if you want tools.
- **System prompts** — almost never on disk anywhere. Record as absent.
- **Skills/rules/AGENTS.md/CLAUDE.md** — project files, re-injected at start; **not** transcript rows. OpenHands `base_state` is the only place "activated skills" is a session field.
- **Claude** — does **not** redact secrets; system-reminders & permission-mode granularity not stored.

---

## 3. Mechanical redaction ruleset (the missing piece)

The brief says "regex-redact secrets" but never lists the patterns. This is the whole
sanitize step — implement it as a single pass over every string field before it reaches
`index.jsonl` or `raw/.../events.jsonl`. Replace match with `«redacted:<label>»`. No LLM.

### 3.1 High-confidence token shapes (redact always)

| Label | Pattern (PCRE, illustrative) |
|---|---|
| `aws-access-key` | `\b(A3T[A-Z0-9]\|AKIA\|AGPA\|AIDA\|AROA\|AIPA\|ANPA\|ANVA\|ASIA)[A-Z0-9]{16}\b` |
| `aws-secret` | `(?i)aws.{0,20}?['"][0-9a-zA-Z/+]{40}['"]` |
| `github-pat` | `\bghp_[A-Za-z0-9]{36}\b` · `\bgithub_pat_[A-Za-z0-9_]{22,255}\b` |
| `github-oauth/app/refresh` | `\bgh[osur]_[A-Za-z0-9]{36,}\b` |
| `openai` | `\bsk-[A-Za-z0-9_-]{20,}\b` · `\bsk-proj-[A-Za-z0-9_-]{20,}\b` |
| `anthropic` | `\bsk-ant-[A-Za-z0-9_-]{20,}\b` |
| `google-api` | `\bAIza[0-9A-Za-z\-_]{35}\b` |
| `google-oauth` | `\bya29\.[0-9A-Za-z\-_]+\b` |
| `slack` | `\bxox[baprs]-[0-9A-Za-z-]{10,}\b` |
| `stripe` | `\b[rs]k_live_[0-9a-zA-Z]{24,}\b` |
| `gitlab-pat` | `\bglpat-[0-9A-Za-z\-_]{20,}\b` |
| `npm` | `\bnpm_[A-Za-z0-9]{36}\b` |
| `jwt` | `\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b` |
| `pem-block` | `-----BEGIN (?:RSA \|EC \|OPENSSH \|PGP \|DSA \|ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END[^-]+-----` |
| `slack-webhook` | `https://hooks\.slack\.com/services/T[0-9A-Za-z]+/B[0-9A-Za-z]+/[0-9A-Za-z]+` |

### 3.2 Assignment-shaped secrets (redact the value, keep the key name)

Catches `.env`-style and inline config that the fixed shapes miss:

```
(?i)\b(api[_-]?key|secret|token|password|passwd|pwd|auth|bearer|
       client[_-]?secret|private[_-]?key|access[_-]?key|
       db[_-]?pass|connection[_-]?string)\b\s*[:=]\s*['"]?([^\s'"]{6,})['"]?
```
→ keep group 1 (the label), replace group 2 with `«redacted»`.

### 3.3 URLs with inline credentials

```
\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp)://
   [^\s:@/]+:([^\s:@/]+)@
```
→ redact the password segment only; keep scheme/host so the pointer stays useful.

### 3.4 Rules that keep it mechanical

- **Never** entropy-guess a whole message away — only redact matched spans, so structure survives.
- Redact in a **copy**; keep byte-offset provenance in `raw/` if you want auditability, but the
  raw copy is gitignored so it may hold the pre-redaction bytes — decide per privacy posture (see §7).
- Run the same pass over **tool args and tool stdout**, not just user/assistant text — that's where
  Claude/OpenHands leak keys.
- Redaction is **lossy and one-way** in the index; that is intended.
- Ship the pattern list as data (a table), so adding a vendor token shape is a one-line change.

---

## 4. Image / binary handling (mechanical)

Every agent that inlines base64 (Pi, Codex, Claude, Gemini) will explode the index otherwise.
Uniform rule: **drop the payload, keep the envelope.**

```json
{ "kind": "image", "content_type": "image/png", "bytes": 20481,
  "sha256": "…", "raw": ".ai/raw/<agent>/<id>/blob-000.bin" }
```

- Compute `sha256` over the decoded bytes; store the blob under `raw/` (gitignored) only if you
  want it recoverable; otherwise store hash+size alone.
- Codex `compacted` records can embed full PNG data-URLs (10 GB rollouts reported) — strip these first.

---

## 5. First-adapter field maps

Build in this order (easy → hard, best hooks first). Each maps native → index line.

### 5.1 Claude Code — `SessionEnd.transcript_path` → sync
```
line.type=user/assistant    → role, message.content (flatten text)
  content[].type=tool_use   → role:"tool", name, input→preview(truncate)
  content[].type=tool_result→ status: ok|error (isError), preview
line.type=summary           → skip (leaf pointer, not content)
line.type=file-history-*    → skip (diffs live in raw)
fields: uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, message.usage
sidecars: tool-results/, agent-*.jsonl (subagents), file-history/
gotchas: glob BOTH ~/.claude/projects/<id>.jsonl AND ~/.claude/transcripts/ses_*.jsonl
```

### 5.2 Pi — official tree JSONL (easiest)
```
type=session   → session meta (id, cwd, ts, version)
type=message   → walk parentId leaf→root; role user|assistant|toolResult
type=toolCall  → name, arguments
type=toolResult→ toolName, isError→status, content, usage?
type=bashExecution → command, exitCode; excludeFromContext(!!) → mark non-context
type=compaction→ typed marker; DO NOT call a model
type=custom    → keep, mark excludeFromContext=true
path: ~/.pi/agent/sessions/--<dash-cwd>--/<ts>_<uuid>.jsonl (+ ~/.omp for Oh My Pi)
never copy ~/.pi/agent/auth.json
```

### 5.3 Codex — rollout JSONL
```
first line: type=session_meta (cwd is INSIDE payload, not top-level)
type=event_msg / user_message  → real user text (payload.message)
type=event_msg / agent_message → real assistant text
type=response_item             → SYNTHETIC/duplicate context — DO NOT double-count
tool/exec items                → map separately
type=compacted                 → strip embedded PNGs first (§4)
path: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (default ~/.codex)
optional live capture: PostToolUse hook now exists [Δ] — but copy-on-close is simpler
```

### 5.4 Gemini CLI
```
messages[].type = user|gemini|info
messages[].toolCalls[] = {id,name,args,result,status,displayName}
messages[].thoughts[]  = reasoning (keep or drop by policy)
path: ~/.gemini/tmp/<sha256(abs cwd)>/chats/session-<ts>-<id>.json(l)
30-day timer → copy off it
```

### 5.5 Grok Build
```
chat_history.jsonl → turns (user/assistant/thinking/tool)
updates.jsonl      → ACP session/update; usage (params.update.usage, costUsdTicks)
summary.json       → cwd/title (git_root_dir / info.cwd; snake_case now)
path: ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/
never copy ~/.grok/auth.json
```

### 5.6 Aider (already in repo — text only)
```
split on "# aider chat started at <ts>"  → session boundary
"####" line  → user turn
body         → assistant
">" line     → tool/meta (prose; NO typed argv)
path: <repo>/.aider.chat.history.md
```

---

## 6. Hook wiring

| Agent | Closer | Wire to |
|---|---|---|
| Claude Code | `SessionEnd` (real) | `.claude/settings.json` → `bin/sessions-sync --from-hook`, `timeout:15000` |
| Codex | `SessionEnd` (sync, advisory) | Codex hooks config → same command; expect `reason:"other"`, `transcript_path` may be null |
| Cursor **IDE** | `sessionEnd` (real) | `.cursor/hooks.json` → same command |
| Cursor CLI / cloud | ❌ unreliable | do NOT depend on it — use `--scan` fallback |
| Pi / Gemini / Grok / Aider / OpenHands | no close hook | `bin/sessions-sync --scan` on next `SessionStart`, or manual/CI (SpecStory pattern) |

**Never hook `Stop`** — it fires every turn; you'd write a file per reply.
`sessions-sync` must be **idempotent** on `agent + session + native-line-id`.

---

## 7. Privacy posture (decide once)

- `.ai/raw/` → **gitignored** always. It may hold pre-redaction bytes.
- `.ai/index.jsonl` → committable **only after** the §3 pass proves clean; default to gitignore until then.
- Critical never-copy files: Grok/Pi `auth.json`, OpenHands `base_state.json` (secrets), Amp `secrets.json`, Cursor `state.vscdb` (never write, prefer never commit).
- Optional CI gate: `gitleaks`/`ggshield` on the committed index as belt-and-suspenders.

---

## 8. Honest gaps (unchanged from brief; low value for first adapters)

Cursor-cloud on-disk layout · Windsurf `cascade.sessionData` schema · Warp `warp.sqlite` tables ·
Continue session field list · Devin CLI transcript fields · Grok image handling ·
whether Codex writes reasoning to rollout when `hide_agent_reasoning` set · Antigravity encrypted `.pb`.

All are "hard/private/reverse-engineered" tiers — the design already says **stub them and print
"not on disk."** Don't block the build on closing these.

---

## 9. Minimal build order

1. `bin/sessions-sync` — Claude `transcript_path` only: copy → §3 redact → §4 images → append `.ai/index.jsonl` + write `.ai/raw/`.
2. `.gitignore` → `.ai/raw/`.
3. `read-sessions` SKILL.md (<80 lines; the walk; bodies are untrusted data).
4. 10-line AGENTS.md pointer.
5. Then Pi, Codex, Gemini, Grok, Aider. Cursor last. Cloud = stub.

Do not start with a TUI, a cloud backend, or an LLM gardener.
