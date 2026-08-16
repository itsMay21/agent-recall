# SCHEMA — `.agent-recall/index.jsonl`

One JSON object per line. Append-only. Redacted. Safe to `Read`/`Grep` by any agent. No field is
ever written by a model — every value is copied from the native transcript or derived mechanically.

## Index line

```json
{
  "v": 1,
  "ts": "2026-08-15T14:04:02.000Z",
  "agent": "claude-code",
  "session": "00893aaf-19fa-41d2-8238-13269b9b3ca0",
  "seq": 142,
  "cwd": "/path/to/repo",
  "git_branch": "main",
  "role": "tool",
  "name": "Bash",
  "status": "ok",
  "preview": "rg SessionEnd",
  "raw": "raw/claude-code/00893aaf/events.jsonl#142"
}
```

## Fields

| Field        | Type                                                                 | Required | Meaning                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`          | number                                                               | yes      | Schema version. Currently `1`.                                                                                                                            |
| `ts`         | string (ISO-8601, UTC)                                               | yes      | Event time from the native record; falls back to file mtime only if the record has none, flagged by `ts_source`.                                          |
| `agent`      | string                                                               | yes      | Adapter id: `claude-code` \| `codex` \| `cursor` \| `hermes` \| `pi`.                                                                                     |
| `session`    | string                                                               | yes      | Native session id (or filename stem when the vendor has none, e.g. Cursor transcripts).                                                                   |
| `seq`        | number                                                               | yes      | 0-based ordinal of this event within the session, as agent-recall emitted it. Used for idempotency together with `agent`+`session`.                       |
| `cwd`        | string                                                               | no       | Project directory the session ran in, when the native store records it.                                                                                   |
| `git_branch` | string                                                               | no       | Branch at event time, when recorded.                                                                                                                      |
| `role`       | `user` \| `assistant` \| `tool` \| `thinking` \| `system` \| `event` | yes      | Normalized role. `event` = a typed native marker (compaction, model change) kept for context.                                                             |
| `name`       | string                                                               | no       | Tool name for `role:"tool"`. **Absent when the native store did not record a typed tool name** (e.g. Cursor prose transcripts, Aider). Never invented.    |
| `status`     | `ok` \| `error` \| `rejected` \| `superseded`                        | no       | Only when the native file, or a later mechanical event, states it. Absent otherwise.                                                                      |
| `preview`    | string                                                               | no       | A truncated (≤ 200 char) copy of a native text field — first line of the prompt, the command string, etc. **Truncation only; never a summary.** Redacted. |
| `raw`        | string                                                               | no       | Pointer into the gitignored raw copy: `raw/<agent>/<session>/events.jsonl#<seq>`.                                                                         |
| `ts_source`  | `native` \| `mtime`                                                  | no       | Present and `mtime` only when `ts` was derived from file modification time because the record had no timestamp.                                           |
| `redacted`   | number                                                               | no       | Count of spans redacted in this line's fields. Present only when > 0. Lets a reader know a value was scrubbed.                                            |

## Rules

- **Copy typed fields; never invent.** If Cursor's JSONL has no tool args, `name` is absent — the row
  still records that an assistant/tool turn happened, with a `raw` pointer.
- **`preview` is truncation, not summarization.** Take the native string, cut to ≤200 chars, redact.
- **`status` is evidence-only.** `superseded`/`rejected` appear only when the native record encodes it
  (e.g. a rejected tool permission) or a later mechanical event supersedes an earlier one.
- **Images/binaries never inline.** They are replaced by an envelope in `raw/events.jsonl`
  (`{kind:"image", content_type, bytes, sha256, raw}`) and do not produce an index line of their own
  unless they were their own turn; the index carries only the envelope's existence, never base64.
- **Idempotency key:** `(agent, session, seq)`. Re-running `sync` over an unchanged transcript appends
  nothing new.

## Raw sidecar — `.agent-recall/raw/<agent>/<session>/`

- `source` — verbatim vendor file(s). Gitignored. May contain pre-redaction bytes.
- `events.jsonl` — the sanitized, typed, redacted events (superset of the index fields: full tool
  args and stdout live here, opened only on demand). Gitignored by default.
