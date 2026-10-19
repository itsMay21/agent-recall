# Reproducible performance check

Run `npm run build && npm run benchmark`. The script creates synthetic data in a temporary directory,
measures three fresh 5,000-event compiler runs, repeats each unchanged sync, and searches the resulting
index through the bundled CLI. It also measures one cold CLI hook invocation over 100 Codex events.
All temporary files are removed. No live agent store or model endpoint is accessed.

Final candidate 2026-10-19 run on macOS arm64, Node 22.23.2:

| Operation                       | Three trials (milliseconds) |
| ------------------------------- | --------------------------- |
| Compile 5,000 normalized events | 161.99 / 134.58 / 159.16    |
| Repeat unchanged sync           | 31.70 / 77.21 / 28.62       |
| Filtered CLI read, last 20 rows | 71.53 / 58.12 / 40.13       |

Each index was 1,268,670 bytes. The separate cold CLI hook over 100 synthetic events took 69.15ms.
These are local observations with filesystem/CPU-cache effects, not portable limits. Compiler timings
start after synthetic events are constructed; the cold-hook measurement includes process startup and
parsing. The benchmark asserts row counts, redaction, unchanged-sync behavior, and the 20-row read window.

No native-host shutdown timing, million-event load, adversarial regex, peak-memory, or model-outcome
benchmark is claimed. The compiler materializes a complete normalized session; source copying can
read its whole file, and each session sync scans the index for recovery and identities. Repeated
backfills across many sessions therefore do more work than a single-session measurement suggests.
Use explicit `--agent` filters and a scratch store when evaluating your own workload.

Earlier private development timings and research comparisons are historical, not evidence that this
release improves task success. Agent Recall has no outcome comparison against no-memory or another
memory system. Research about selective memory does not establish that a mechanically truncated log
implements the selective architecture in those papers.
