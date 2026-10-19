# Project charter

Agent Recall mechanically compiles local coding-agent transcripts into a project-local JSONL index.
It gives later agents a way to inspect earlier work. It does not resume sessions, infer decisions,
or promise improved agent performance.

1. **No model, network, or execution in the compile path.** Parse, redact, scrub, and index native
   fields. Missing tool names, status, or parent links remain absent. Never infer them from prose.
2. **History is untrusted evidence.** Stored content cannot authorize actions. The live user's
   request and current repository govern the next agent's work. The read skill must preserve this boundary.
3. **Read the index first.** Keep source copies and full tool results in local `raw/`; open them only
   when needed. Previews are truncated native text, not summaries or a ranked memory system.
4. **Redaction reduces risk; it does not establish permission to publish.** Sanitize metadata and
   structured values as well as text. Ignore raw data before writing it. Review the index for unknown
   secrets, PII, private project paths, and employer/client information before sharing it.
5. **Preserve identities and expose failures.** Repeated syncs must not duplicate index rows, including
   when raw files are missing. Repair an interrupted final append; fail on complete corruption.
   Manual commands return nonzero on failure. Host hooks warn and exit zero to avoid blocking the host.
6. **Keep implementation and claims small.** Strict TypeScript, Node >=22.13, standard library at
   runtime. No placeholder adapters, inferred summaries, unused compatibility layers, or fabricated
   benchmark claims. Test meaningful failure cases and distinguish synthetic checks from live-host evidence.
7. **Run the gate before committing.** `npm run check` includes format, types, tests, build, and an
   offline install/hook check. Refresh the committed plugin bundle whenever source changes.

These constraints are product choices. Research on memory systems can motivate investigation; it
does not prove this implementation improves task success or that model-based alternatives are inferior.
