# Setup, host integration, and troubleshooting

Use Node >=22.13 and npm on macOS or Linux. Hermes also needs `node:sqlite` enabled. Windows is not
validated by this release. Hooks and vendor schemas are version-sensitive; the manual scan is the
common collection path.

## Install from this release

Download the tarball and `SHA256SUMS` from [v0.2.0](https://github.com/itsMay21/agent-recall/releases/tag/v0.2.0).
Verify the checksum using `shasum -a 256` (macOS) or `sha256sum` (Linux), then install in your project:

```bash
npm install --save-dev /path/to/itsmay21-agent-recall-0.2.0.tgz
npx --no-install --package=@itsmay21/agent-recall -- agent-recall install --agent claude-code codex --no-backfill
```

This is an unpublished scoped package distributed as a GitHub release artifact. Do not install the
unrelated unscoped npm package. Hooks use an explicit scoped package and `--no-install`, so a missing
local binary warns rather than downloading code during session shutdown. Keep the local dependency
installed wherever hooks execute; a global install is not the documented path.

Use the same `npx --no-install --package=@itsmay21/agent-recall -- agent-recall` prefix for commands
below, or use `node /absolute/path/to/dist/cli.js` from a built source checkout.

## Installer writes

`install --agent <ids> --cwd /your/project` accepts `claude-code`, `codex`, `cursor`, `hermes`, and
`pi` (`claude` is an install alias). Omit `--agent` to select all five. Existing configuration is
validated before writes; invalid hooks produce an error. Existing hook entries and project text are
preserved. Reinstalling does not duplicate the marked pointer or hooks.

The shared read layer is `.agents/skills/read-sessions/SKILL.md` plus a marked `AGENTS.md` section.
Raw ignore rules are added to project `.gitignore`; sync additionally creates `.agent-recall/.gitignore`.
Hermes selection also copies the read skill to `$HERMES_DIR/skills`, or `~/.hermes/skills`.
Without `--no-backfill`, existing selected-agent sessions for this project are ingested immediately.

## Collection by host

| Host        | Installed integration                                                        | Activation or remaining work                                                                                       |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `.claude/settings.json` SessionEnd; Claude read skill and `CLAUDE.md` import | Restart the host and inspect hooks. Configured timeout is 15 **seconds**. Host shutdown budgets can be shorter.    |
| Codex       | `.codex/hooks.json` SessionEnd, explicit `--agent codex`                     | Experimental host feature; `codex -c features.codex_hooks=true` where supported. Timeout is 3 **seconds**.         |
| Cursor      | `.cursor/hooks.json` `sessionEnd` and `stop`, explicit `--agent cursor`      | Experimental payload/JSONL integration. Enable transcript export in the host. Null transcript paths warn and skip. |
| Hermes      | Read skill plus printed hook guidance                                        | Add the user-level hook below and approve it in the foreground host.                                               |
| Pi          | Read pointer/skill plus printed guidance                                     | Run a scan manually or write a lifecycle extension. No extension is installed.                                     |

Hermes guidance uses a list of command objects:

```yaml
hooks:
  on_session_end:
    - command: "npx --no-install --package=@itsmay21/agent-recall -- agent-recall sync --from-hook --agent hermes"
      timeout: 15
```

Approve the hook through Hermes's documented first-use consent flow. It must run from a project that
has the package installed. A session id is used to select messages from its read-only state database.

Pi supports `session_start` and `session_shutdown` extension events. A manual `sync --scan --agent pi`
is the supported path in this release; writing an extension is optional and not claimed as completed setup.

Primary host references (reviewed 2026-10-19): [Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks), [Hermes hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks),
[Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[Cursor hooks](https://cursor.com/docs/agent/hooks).

## Claude plugin

```bash
claude plugin marketplace add itsMay21/agent-recall
claude plugin install agent-recall@agent-recall
```

The plugin uses `node "${CLAUDE_PLUGIN_ROOT}/bin/cli.js"` and needs Node, but no npm dependency.
It ships a read skill and SessionEnd hook; it does not run the project installer or backfill. Claude
plugin SessionEnd can have a total budget of 1.5 seconds regardless of the configured timeout. After
an interrupted hook, catch up with a manual scan. Native-host timing is not certified by our CLI smoke test.

## Manual collection and reading

```bash
agent-recall sync --scan --cwd /your/project --agent claude-code codex
agent-recall sync --scan --cwd /your/project --store /private/scratch --subagents full
agent-recall read --cwd /private/scratch --grep auth --role assistant --last 20
agent-recall read --cwd /private/scratch --last 20 --offset 20 --json
```

Here `agent-recall` means the installed CLI invoked with the prefix above. `--store` affects only scan
output, not the source project. Hook project selection comes from stdin and is checked against native
`cwd` where present. Hook dispatch accepts an explicit `--agent` because cloud transcript paths can
be arbitrary. A missing/null transcript path is not guessed to be a Hermes session.

`--subagents calls` is the default: child threads stay in raw detail. `full` includes their index rows;
`off` skips them. Changing from full to calls/off does not delete rows previously indexed. Reads can
use `--top-level` or `--subagent-of ID`. Parents with multiple children return all matching children.

## Troubleshooting and upgrading

- **No sessions found:** verify the exact absolute project path and environment overrides. Claude uses
  `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME`; Hermes uses `HERMES_DIR`; Pi uses `PI_SESSIONS_DIR` or
  `PI_CODING_AGENT_DIR`; Cursor scan uses `CURSOR_CONFIG_DIR`. Some stores may be remote or unavailable.
- **Hook exits successfully but nothing appears:** hooks deliberately warn and exit zero. Read stderr,
  verify the package is installed, then run a manual scan (which returns nonzero on errors).
- **Busy store:** wait for the current writer and retry. A dead owner's lock is reclaimable after
  60 seconds. Do not delete a live writer's lock.
- **Corrupt/shortened store:** preserve a backup, move the entire `.agent-recall` directory aside, and
  rebuild from original vendor sources. Do not edit rows during sync. Same-length source rewrites are
  not detected. Recovery repairs only a torn final record, not arbitrary history damage.
- **Upgrade from private 0.1 builds:** back up the store and rebuild it into a fresh directory. This
  reruns strengthened redaction over all rows; sync does not retroactively scrub already committed rows.
  Review and remove any sensitive material from Git history separately. Reinstall hooks to pick up the
  scoped package command; remove old unscoped `agent-recall sync --from-hook` entries yourself.
- **Need privacy beyond regex:** keep the entire `.agent-recall/` directory ignored. The index may hold
  arbitrary PII, private project names, and absolute `cwd` even after known secrets are redacted.

To remove: delete this tool's hook entries, the marked `AGENTS.md` section, installed read-sessions
skill copies, and any added `CLAUDE.md` import you no longer need; uninstall the local package. Keep or
remove your store according to your own retention needs. Uninstalling does not erase vendor transcripts
or sensitive material already committed to Git. Never remove other tools' hook entries or instructions.
