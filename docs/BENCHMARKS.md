# BENCHMARKS — does it actually work, and is it fast enough?

Measured on real, live agent stores (macOS, Node 22, 2026-08-16). Numbers are reproducible with
`agent-recall sync --scan --cwd <project> --store <scratch>`; nothing here is synthetic. Transcript
bodies are never shown — only aggregate counts.

## Throughput on real stores

| Agent       | Source store                                                             | Sessions | Events       | Secret spans redacted | Wall time |
| ----------- | ------------------------------------------------------------------------ | -------- | ------------ | --------------------- | --------- |
| claude-code | `~/.claude/projects/…` (2.3 MB JSONL)                                    | 1        | 486          | 9                     | ~1.0 s    |
| codex       | `~/.codex/sessions/**` (rollout JSONL)                                   | 2        | 495          | 9                     | ~1.5 s    |
| pi          | `~/.pi/agent/sessions/…relay-dev…`                                       | 14–15    | ~1,720–3,630 | 105–179               | ~3.4 s    |
| hermes      | `~/.hermes/state.db` (**610 MB SQLite**, 51 cwd-matched sessions of 182) | 51       | 24,522       | 312                   | ~8.3 s    |

Total across a real cross-agent project: **~29,000 events** compiled from four different vendor
formats (JSONL, date-partitioned rollouts, and a 610 MB SQLite DB) into one interchange file.

- **Per-session hook cost is sub-second** once warm — well inside the Claude `SessionEnd` budget
  (1.5–60 s) and the Codex cap (3 s). The multi-second totals above are one-time `--scan` backfills
  over dozens of sessions, not per-close cost.
- **Idempotent:** re-running a scan adds **0** events (verified on Claude and Hermes); a live-growing
  Pi session appended exactly its new events and nothing else.

## Safety, measured

- **Redaction held:** across the ~29k real events, a token-shaped scan of every produced index
  (`sk-…`, `ghp_…`, `AKIA…`, `xox?-…`, `AIza…`, PEM, JWT) found **0 leaks**.
- **No home-path leakage:** after the `$HOME → ~` scrub, **0** of the `preview` fields in the Pi
  index contained the absolute home path (380 were rewritten to `~/…`); the `cwd` field is preserved
  by design.
- **Valid interchange:** every produced line is strict-JSON valid (jq/Go/Rust), including previews cut
  mid-emoji — verified by a round-trip test over the store.

## Why this is helpful (the evidence behind the design)

The point isn't just speed — it's giving the _next_ agent the right amount of prior context:

- Dumping a previous agent's full raw history into the next one is measurably **worse than starting
  fresh** (Apple SSPM: 71% task completion on full history vs 79% with no memory vs **96%** with a
  selective index). agent-recall ships the selective middle path — a compact, redacted index — and
  keeps the raw available for on-demand drill-down.
- Having an LLM summarize the store on the way in is **also** a regression (ACE: one monolithic rewrite
  dropped accuracy below the no-adaptation baseline). So the compile path stays mechanical — no model,
  ever.

The result: one command, sub-second per session, produces a redacted, jq-valid, searchable log that
any later agent (Claude, Codex, Cursor, Hermes, Pi) reads with `grep`/`Read` before it starts — so it
doesn't re-propose a rejected design or re-walk a dead path.

## Reproduce

```bash
npm run check                 # 41 tests incl. redaction canaries + strict-JSON round-trip
node dist/cli.js sync --scan --cwd /path/to/project --store /tmp/ar-demo
node dist/cli.js read --grep <topic> --last 20 --cwd /tmp/ar-demo   # token-lean, filtered
```
