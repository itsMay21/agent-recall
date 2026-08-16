---
name: Feature request
about: A new adapter, flag, or capability
labels: enhancement
---

**What & why**
<!-- What should agent-recall do, and what problem does it solve? -->

**Charter check**
<!-- Does this require an LLM, network, or executing transcript content in the compile path? If yes,
it's out of scope for `sync` (see docs/CHARTER.md) — describe how it stays mechanical, or whether it
belongs at read-time instead. -->

**For a new adapter**

- Agent + where it stores transcripts on disk:
- Does the native store include typed tool calls, or only prose?
- Session-close hook available? (see docs/CONSUMPTION.md)
