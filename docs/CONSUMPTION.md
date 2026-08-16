# CONSUMPTION — how each agent installs & reads

How agent-recall plugs into each harness: which file to write for the **read** layer, and which
hook/command fires the **sync** on session close. Compiled from official docs, 2026-08-16. Items
marked ⚠️ need per-version confirmation; ❌ = mechanism does not exist.

## Tier-1 (fully built + tested)

### Claude Code

- **Read:** reads `CLAUDE.md`, **not** `AGENTS.md`. Install writes `CLAUDE.md` → first line `@AGENTS.md`
  (import, max depth 4) or a symlink. Skills: `.claude/skills/<name>/SKILL.md` (project),
  `~/.claude/skills/` (user).
- **Close:** `SessionEnd` hook in `.claude/settings.json`. stdin JSON has `session_id`,
  `transcript_path`, `cwd`, `permission_mode`, `reason` (`clear|resume|logout|prompt_input_exit|
bypass_permissions_disabled|other`). **Budget: 1.5s shared, raised to per-hook `timeout`, max 60s**
  → set `timeout` and detach heavy work. `SessionStart` stdout is injected into context.
- **Plugin:** full plugin system — `.claude-plugin/plugin.json` (only `name` required); `skills/`,
  `commands/`, `hooks/hooks.json`, `.mcp.json` live at plugin **root**. Marketplace via
  `.claude-plugin/marketplace.json`. Install: `/plugin install <p>@<market>`; dev: `--plugin-dir`.
- **Memory:** first-class auto-memory at `~/.claude/projects/<project>/memory/MEMORY.md` (first
  200 lines / 25 KB auto-loaded) + `CLAUDE.md`. Externally writable (plain markdown).

### Codex CLI

- **Read:** native `AGENTS.md` (+ `AGENTS.override.md`, fallbacks via `project_doc_fallback_filenames`);
  merged root→cwd, cap `project_doc_max_bytes` = 32 KiB. Skills: `.agents/skills/` (scanned cwd→root),
  `~/.agents/skills/`, `/etc/codex/skills`.
- **Close:** `SessionEnd` hook in `.codex/config.toml` `[hooks]` or `.codex/hooks.json` (same 3-level
  schema as Claude). stdin: `session_id`, `transcript_path` (e.g. `.codex/rollout.jsonl`, may be null),
  `cwd`, `reason` (currently always `other`). Synchronous + advisory. **Do not use `notify`** — it's
  turn-level (`agent-turn-complete`), not session-end.
- **Plugin:** bundles = skills + MCP connectors; **no Claude-style CLI plugin manifest** found → install
  skill + hooks + `[mcp_servers]` separately.

### Cursor (IDE + cursor-agent CLI + cloud)

- **Read:** native `AGENTS.md` (+ nested). Rules: `.cursor/rules/*.mdc` (frontmatter `description`,
  `globs`, `alwaysApply`). Skills: `.cursor/skills/`, `.agents/skills/` (project); `~/.cursor/skills/`,
  `~/.agents/skills/` (user). `disable-model-invocation: true` makes a skill a pure slash command.
- **Close:** `.cursor/hooks.json` (project), `~/.cursor/hooks.json` (user — **not loaded in cloud**).
  Events include `sessionStart`, `sessionEnd`, `stop`, `preToolUse`, `postToolUse`, …
  **`sessionEnd` is IDE-only** ("cloud agents have no editor-lifetime session boundary"); `stop` fires
  in all environments incl. cloud. Cloud supports only `command`-type hooks. → install `sessionEnd`
  **and** `stop` (idempotent) in the **project** file for full coverage. MCP: `.cursor/mcp.json`.

### Hermes

- **Read:** native `AGENTS.md` + `MEMORY.md`/`USER.md`/`SOUL.md` (unless `--ignore-rules`). Skills:
  `~/.hermes/skills/` (auto-register as slash commands).
- **Close:** native `on_session_start` / `on_session_end` in `~/.hermes/config.yaml`. Managed via
  `hermes hooks {list,test,doctor,revoke}`; requires an entry in `~/.hermes/shell-hooks-allowlist.json`
  (**user consent** — install must print the exact command for the user to approve). Headless: `hermes -z`.
- **Memory:** `MEMORY.md` + `hermes memory`.

### Pi

- **Read:** native `AGENTS.md` (`~/.pi/agent/AGENTS.md` → parents → cwd; `AGENTS.override.md` replaces).
  Skills: `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`.
- **Close:** ⚠️ **no `session_start`/`session_end` event.** Closest is `agent_end` (per prompt/turn) via
  a TS extension `pi.on(...)`. Strategy: sync-on-next-start via a small extension on `agent_start`, or
  rely on `agent-recall sync --scan`. Env `PI_SESSION_FILE`/`PI_SESSION_ID` are exposed to bash tools.
- **Trust:** `~/.pi/agent/trust.json` prompts before loading project resources.

## Tier-2 (stub / later PR) — reference

| Agent                | Read layer                                     | Session-close hook                                                                                      | Notes                                                                      |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Gemini CLI           | `GEMINI.md` (AGENTS.md via `context.fileName`) | `SessionEnd` hook in `settings.json` / extension `hooks/hooks.json`                                     | 30-day retention; verify headless firing                                   |
| OpenCode             | native `AGENTS.md`                             | `session.idle` plugin event (JS/TS)                                                                     | ⚠️ await-before-exit bug #16879                                            |
| Goose                | `.goosehints`, `AGENTS.md`                     | `SessionEnd` in Open-Plugins `hooks.json` (`~/.agents/plugins/<n>/hooks/hooks.json`)                    | context files need `--with-builtin developer`                              |
| Cline                | `.clinerules/`, `AGENTS.md`                    | ext: **no clean completion event** (only `TaskCancel`/`PostToolUse`); SDK: `run_end`/`session_shutdown` | ext hooks macOS/Linux only; Memory Bank is a prompt convention, not native |
| Amp                  | `AGENTS.md` (CLAUDE.md fallback)               | ⚠️ `session.start` yes, **no `session.end`** — approximate via `agent.end`/`tool.result`                | server is canonical; local mirror may be a stub                            |
| Kimi CLI             | `AGENTS.md`                                    | ⚠️ hooks in `kimi.plugin.json` (event set unverified)                                                   | two products: kimi-cli (Py) vs kimi-code (TS)                              |
| Qwen Code            | `QWEN.md`, `AGENTS.md`                         | ⚠️ `/hooks` exists; session-end unverified                                                              | Gemini-CLI fork                                                            |
| Crush                | `CRUSH.md`, `AGENTS.md`                        | ⚠️ "preliminary" hooks in `crush.json`                                                                  | also reads `.claude/skills`, `.cursor/skills`                              |
| Antigravity          | `AGENTS.md` > `GEMINI.md`                      | ❌ IDE, no documented session-lifecycle hook                                                            | install pattern likely N/A                                                 |
| ZCode (GLM)          | `~/.zcode/AGENTS.md` + workspace               | ❓ unverified                                                                                           | third-party docs only                                                      |
| DeepSeek "Deep Code" | AGENTS.md-class                                | ❓ unverified                                                                                           | Agent Skills supported                                                     |

**Ambiguous source names:** "go" → almost certainly **Goose**. "t3" → no known coding CLI; candidates
T3 Chat (not a coding agent) / Trae (ByteDance IDE). Confirm before scoping.

## Design consequences

- **One `AGENTS.md`** is read natively by Codex, Cursor, Pi, Hermes, Amp, OpenCode, Goose, Cline, Kimi,
  Qwen, Crush → it is the highest-coverage read vector. Claude needs the `CLAUDE.md`→`@AGENTS.md` shim.
- **One `.agents/skills/read-sessions/`** covers Codex, Cursor, Pi, Amp (and Crush). Claude needs a
  `.claude/skills/` copy; Hermes needs `~/.hermes/skills/`.
- **`stop`-class over-firing is fine** because `sync` is idempotent — so Cursor `stop` and Pi scan are
  safe closers where a clean session-end event is missing.
- **Do not target internally-managed memory** (Cursor Memories, Codex state-DB): no external write API.
  Emit `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`-class files instead, which are plain and auto-loaded.
