# Agent Recall

**Carry useful history between coding agents.**

Agent Recall turns local coding-agent transcripts into a searchable, redacted JSONL index in your
project. A later agent can read what was tried, inspect the original evidence when needed, and check
it against the current code.

[![CI](https://github.com/itsMay21/agent-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/itsMay21/agent-recall/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```text
Claude · Codex · Hermes · Pi · Cursor
                  ↓ parse, redact, index
       .agent-recall/index.jsonl
                  ↓ read and search
          your next agent session
```

There is no model call, background service, telemetry, or network request in the compiler. It copies
and truncates native fields; it does not summarize decisions or replay another agent's session.
Read-side guidance treats stored text as untrusted evidence, never instructions.

## Try it

Requires **Node 22.13 or newer**, npm, and macOS or Linux. No runtime dependencies.

```bash
git clone https://github.com/itsMay21/agent-recall.git
cd agent-recall
npm ci
npm run check
npm run demo
```

The demo uses synthetic Claude and Codex sessions in a temporary directory, shows redaction and
cross-agent search, then confirms that a second sync adds nothing. It does not read your own sessions.

## Install in a project

Download `itsmay21-agent-recall-0.2.0.tgz` from the [v0.2.0 release](https://github.com/itsMay21/agent-recall/releases/tag/v0.2.0)
and check its SHA-256 against `SHA256SUMS`. In the project where you want recall:

```bash
npm install --save-dev /path/to/itsmay21-agent-recall-0.2.0.tgz
npx --no-install --package=@itsmay21/agent-recall -- agent-recall install --agent claude-code codex --no-backfill
```

Then load existing history explicitly:

```bash
npx --no-install --package=@itsmay21/agent-recall -- agent-recall sync --scan --agent claude-code codex
npx --no-install --package=@itsmay21/agent-recall -- agent-recall read --grep auth --last 10
```

The package identity is **`@itsmay21/agent-recall`**, distributed here as a release tarball. It is not
published to npm. The unscoped npm package `agent-recall` belongs to an unrelated project; use the
commands above. Installed hooks specify the scoped identity and disable package downloads.

Without `--no-backfill`, installation scans existing sessions for the selected agents. It appends a
marked `AGENTS.md` section, installs the `read-sessions` skill, adds ignore rules, and merges host hook
configuration. Existing hooks remain intact. [Setup details and activation](docs/CONSUMPTION.md).

**Claude Code plugin:**

```bash
claude plugin marketplace add itsMay21/agent-recall
claude plugin install agent-recall@agent-recall
```

The plugin bundles the CLI and read skill, and runs a Claude SessionEnd hook without npm. Plugin-only
installation does not add the project pointer or backfill history. Run a manual scan to catch up after
a timed-out hook; Claude's plugin SessionEnd budget can be only 1.5 seconds.

## Compatibility

| Source      | Transcript support                                       | Automatic collection                                            |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Claude Code | JSONL, typed tools, sidechains                           | Installer or plugin SessionEnd hook                             |
| Codex       | Local rollout JSONL, tools, compaction, linked subagents | Experimental SessionEnd hook; host feature opt-in may be needed |
| Hermes      | Read-only `state.db` through `node:sqlite`               | Manual user-level hook setup and consent                        |
| Pi          | Session JSONL, tools, compaction                         | Manual scan or your own lifecycle extension                     |
| Cursor      | Experimental, lossy text JSONL                           | Experimental `sessionEnd` / `stop` hooks                        |

Synthetic adapter and real CLI tests run in CI. Earlier private live-source checks are documented as
historical evidence; they are not a current host certification. Cursor has no live-store validation.
Hook payloads and transcript schemas can change. [Evidence and limits](docs/TESTING.md).

## What gets stored

```json
{
  "v": 1,
  "ts": "2026-10-19T00:00:00Z",
  "agent": "codex",
  "session": "demo",
  "seq": 0,
  "role": "user",
  "preview": "Investigate the auth retry",
  "raw": "raw/codex/demo/events.jsonl#0"
}
```

Each row includes a native text preview of at most 200 code points, optional tool name and recorded
status, and a pointer to local detail. `read --json` emits JSONL without a prose header. Filters run
before `--last` / `--offset`; paging follows append order, which can differ from event time after a
backfill. Agents can also read the file directly without installing this CLI.

Subagents default to `--subagents calls`: their detail stays local in `raw/`. Use `full` to index their
streams or `off` to exclude them. [Schema](docs/SCHEMA.md) · [Architecture](docs/ARCHITECTURE.md).

## Privacy and reliability

Known secret patterns are redacted from text, metadata, nested keys, and structured credential
values. Home paths in text become `~`; **`cwd` still records your absolute project path**. Arbitrary
PII and unknown secret formats can survive. Review the index before sharing it.

Verbatim source copies live in `raw/` and can contain secrets. Direct sync and plugin hooks create
store-local Git ignore rules before copying them. Store directories and files use POSIX permissions
`0700` / `0600`. Git ignore rules do not remove files already tracked or prevent a force-add.

A per-store lock serializes writers. Interrupted final JSONL appends are repaired; complete corruption
and shortened transcripts fail visibly. Re-syncing after an index-only clone restores local detail
without duplicating index identities. Sources must remain append-only. Filesystem permissions do not
isolate the tool from malicious processes running as your own user.

[Security policy](SECURITY.md) · [Upgrade, troubleshooting, and removal](docs/CONSUMPTION.md).

## Development and evidence

- `npm run check` — format, types, tests, build, and a clean offline package/hook smoke check.
- `npm run benchmark` — reproducible synthetic compile/search timings; no external agent or API key.
- [Release readiness](docs/RELEASE-READINESS.md), [validation](docs/TESTING.md), [benchmarks](docs/BENCHMARKS.md).
- [Contributing](CONTRIBUTING.md), [decisions](docs/DECISIONS.md), [provenance](docs/PROVENANCE.md), [changelog](CHANGELOG.md).

Agent Recall has not been evaluated for improvements in coding-agent task success. Its tests establish
mechanical behavior and distribution checks, not that an agent will make better decisions.

MIT © 2026 Mayank Saini.
