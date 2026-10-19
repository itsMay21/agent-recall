# Architecture

Agent Recall has a mechanical writer, a file interchange, and a read skill. It has no server or agent
reasoning loop. The CLI is the supported API; TypeScript source exports are internal.

```text
native transcript → adapter → compileSession → local raw + shared index
                                                   ↓
                                       read CLI / Read / Grep
```

## Adapters

`src/adapters/` locates and parses five native formats into `ParsedSession` events. Claude, Codex,
Pi, and Cursor use JSONL; Hermes reads a SQLite database read-only with the Node builtin. No database
is copied. Unknown vendor records are skipped. Malformed JSON lines are skipped so a growing vendor
file can be read; complete malformed records in our own store are errors.

`scanAndCompile` normalizes the requested project path and checks any parsed native `cwd` before
writing. This prevents encoded-directory collisions from mixing projects. Cursor supplies no native
cwd, so its project association relies on its encoded directory. Hooks include an explicit adapter
id because valid host transcript paths differ across local and cloud environments.

## Compiler and privacy boundary

`src/sync/compile.ts` redacts text, structured args/results, metadata, and nested object keys. Known
credential keys redact their entire nonempty value, including short values. Sensitive session ids
become a deterministic hash to retain identity without placing tokens in an index or raw pointer.
Home paths in text become `~`; `cwd` retains its absolute path but still passes secret redaction and
JSON string sanitization. Typed inline image blocks become hashes, sizes, and content-type envelopes.
Verbatim source files remain unchanged in ignored `raw/`.

No field contains an inferred decision. Codex developer messages normalize to `system`; output without
a typed success flag has no status. Preview text is whitespace-collapsed and truncated to 200 Unicode
code points. Native compaction summaries are recorded as events, never expanded or generated here.

## Store and restart behavior

```text
.agent-recall/
  .gitignore                 # raw/ and .lock, created even without install
  index.jsonl                # redacted; human review required before sharing
  raw/<agent>/<session>/
    source-<basename>        # verbatim vendor bytes, may contain secrets
    events.jsonl            # sanitized detail, including full tool args/results
```

The store uses one exclusive file lock. A live owner's lock is not reclaimed based on age. Stale locks
from dead or incomplete owners are reported after 60 seconds and require offline manual removal;
automatic deletion races between reclaimers and is deliberately disabled. Other writers wait at most
about 750ms, then report that the store is busy. Release compares the owner token. Directories are `0700`, files `0600` on
POSIX systems; symlinked store directories and destination event files are refused. This is local
privacy hygiene, not isolation from another process with the same user privileges.

Under the lock, the compiler validates complete JSONL records and repairs interrupted suffixes before
appending. Raw rows are flushed before index rows; missing index ordinals are regenerated from the
current parsed source. Persisted `(agent, session, seq)` identities prevent duplicates when raw files
were removed or an index was cloned. A shortened transcript or duplicate index ordinal fails visibly.
This is restart recovery, not a transactional database or a guarantee against hardware/filesystem loss.

Sources must be append-only: same-length edits and reordered vendor events are not detected. Back up
important stores and rebuild from original sources after schema changes or source rewriting. Sync parses
a whole session, scans the index, and keeps that session's normalized events in memory; large multi-session
backfills can be costly. The benchmark measures this explicitly. No constant-time incremental parser is claimed.

## Read behavior and instruction boundary

`read` streams the index through filters, retaining a bounded ring of `last + offset` matched rows.
Each argument is limited to 100,000. Output follows append order, not a timestamp sort. JSON mode emits
only objects, one per line. Missing stores are reported on stderr; permission and I/O failures return
nonzero. Malformed lines encountered by the reader are skipped; sync will expose complete corruption.

The installer appends a short marked `AGENTS.md` pointer and copies the read skill. Claude also gets a
`CLAUDE.md` import. A plugin carries the read skill independently. Instructions ask agents to inspect
history as evidence, search sparingly, and resolve disagreements against current code and tests. This
instruction boundary has no model-outcome evaluation; the compiler cannot enforce how a model uses text.

## Distribution

A bundled ESM CLI and the skill ship in `@itsmay21/agent-recall` tarballs on GitHub Releases. The
unscoped npm name is unrelated; no registry publication is claimed. A separate self-contained Claude
plugin carries its own ESM package declaration. CI builds both, compares the committed plugin, and
installs the tarball into an isolated project before invoking the actual hook offline.
