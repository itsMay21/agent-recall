# Validation evidence

Current release checks use synthetic fixtures and isolated temporary projects. They do not need an
API key, a running agent, or access to the maintainer's personal transcript stores.

## Reproduce

```bash
npm ci
npm run check
npm run demo
npm run benchmark
npm audit
```

The gate checks formatting, strict TypeScript, Vitest regression tests, fresh CLI/plugin builds, and
installation of the actual package tarball into a temporary project. The package smoke test gives
npm a new empty cache and offline mode, invokes the installed Claude hook, checks redaction and repeat
sync, and runs an isolated plugin outside any source checkout. A Git check confirms raw is ignored.

## What is covered

| Area                | Evidence                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native parsing      | Synthetic Claude, Codex, Cursor, Pi JSONL and Hermes SQLite fixtures; compaction and child-thread fields                                                                         |
| Secret handling     | Known token canaries, quoted assignments, structured short credentials, metadata, object keys, home paths, Unicode string safety                                                 |
| Data reduction      | Index/detail split, preview size, top-level and nested typed image envelopes                                                                                                     |
| Store integrity     | Unchanged and growing sessions, index-only clone, raw-only recovery, torn final records in both files, valid missing newline, complete corruption, duplicates, shortened sources |
| Filesystem handling | Raw ignore rules before source copies, POSIX modes, dot-segment containment, refused symlinked store, preserved custom ignore rules                                              |
| Concurrency         | Five simultaneous compilers produce unique index identities; an old live lock remains owned; release cannot remove a successor token                                             |
| CLI                 | Invalid args, non-blocking hook diagnostics, help without writes, JSON-only output, filtered paging, explicit cloud-path adapter, installer preflight and idempotent merging     |
| Distribution        | Tarball provenance/content checks, clean offline scoped hook resolution, isolated ESM plugin, repeat sync                                                                        |

CI runs on Ubuntu and macOS with Node 22 and 24. A separate Gitleaks job checks fetched Git history
with a pinned scanner and checksum. Exact command outcomes and independent review are recorded in
[release readiness](RELEASE-READINESS.md).

## What these checks do not establish

- No current native-host lifecycle certification across all five products. CLI hook payloads and
  config shapes are tested; their execution inside each vendor's current product is a separate check.
- Cursor remains experimental and has no live-store validation. Pi's closer is manual or a user-written
  extension. Codex hooks remain experimental. Hermes needs manual user-level activation and consent.
- No model-based recall-quality, prompt-injection resilience, task-success, or token-savings evaluation.
- No Windows support claim, hardware-loss durability proof, hostile same-user filesystem isolation,
  arbitrary PII detection, or protection against all credential formats.
- Append-only sources are required. Same-length edits/reordering are not detected. Large sources and
  many-session backfills may consume substantial memory/time; see [benchmarks](BENCHMARKS.md).

## Historical observations

The private 2026-08-16 development record reported 48 tests and live scans of Claude, Codex, Hermes,
and Pi transcripts, including 24,522 Hermes events and idempotent re-scans. Raw transcripts were not
committed and those exact private inputs are unavailable to outside developers. These are historical
maintainer observations, not fresh release measurements or a reproducible public benchmark. Earlier
reports and format research are retained in `archive/`; current code, this report, and the release
checklist take precedence over their compatibility and performance claims.
