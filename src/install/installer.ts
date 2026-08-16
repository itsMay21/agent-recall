// `agent-recall install` — wire the read layer (AGENTS.md pointer + read-sessions skill) and the
// write layer (session-close hooks) into a project. Idempotent and conservative: it never rewrites a
// user's existing content, only appends a marked section or merges a hook entry. Agents whose closer
// needs user consent (Hermes) or has no session-end event (Pi) get printed guidance instead of a
// silent config edit.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { AGENTS_MARKER, AGENTS_SECTION, HOOK_CMD, README_STORE } from "./templates.js";
import { AGENT_IDS, type AgentId } from "../sync/types.js";

const TIER1: AgentId[] = ["claude-code", "codex", "cursor", "hermes", "pi"];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readOr(p: string, fallback = ""): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return fallback;
  }
}

/** Find the packaged skill/read-sessions/SKILL.md from either src (dev) or dist (built) layout. */
async function skillSource(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../..", "../../..", "../../../.."]) {
    const candidate = join(here, up, "skill", "read-sessions", "SKILL.md");
    if (await exists(candidate)) return candidate;
  }
  throw new Error("could not locate packaged skill/read-sessions/SKILL.md");
}

const log = (m: string) => process.stdout.write(`agent-recall: ${m}\n`);

async function ensureAgentsSection(projectDir: string): Promise<void> {
  const file = join(projectDir, "AGENTS.md");
  const current = await readOr(file);
  if (current.includes(AGENTS_MARKER)) {
    log("AGENTS.md already has the agent-recall section");
    return;
  }
  const next =
    current.trim() === ""
      ? AGENTS_SECTION + "\n"
      : current.replace(/\s*$/, "\n\n") + AGENTS_SECTION + "\n";
  await writeFile(file, next, "utf8");
  log(`wrote agent-recall section to ${file}`);
}

async function ensureClaudeMd(projectDir: string): Promise<void> {
  const file = join(projectDir, "CLAUDE.md");
  const current = await readOr(file);
  if (current.includes("@AGENTS.md")) return;
  const next = current.trim() === "" ? "@AGENTS.md\n" : "@AGENTS.md\n\n" + current;
  await writeFile(file, next, "utf8");
  log(`pointed ${file} at AGENTS.md`);
}

async function installSkill(destDir: string): Promise<void> {
  const src = await skillSource();
  const dir = join(destDir, "read-sessions");
  await mkdir(dir, { recursive: true });
  await copyFile(src, join(dir, "SKILL.md"));
  log(`installed read-sessions skill to ${dir}`);
}

async function ensureGitignore(projectDir: string): Promise<void> {
  const file = join(projectDir, ".gitignore");
  const current = await readOr(file);
  if (current.includes(".agent-recall/raw/")) return;
  const next =
    current.replace(/\s*$/, "\n") +
    "\n# agent-recall raw session copies (may hold secrets)\n.agent-recall/raw/\n";
  await writeFile(file, next, "utf8");
  log("added .agent-recall/raw/ to .gitignore");
}

async function ensureStoreReadme(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".agent-recall");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "README.md");
  if (!(await exists(file))) await writeFile(file, README_STORE, "utf8");
}

/** Merge our SessionEnd hook into .claude/settings.json without disturbing existing hooks. */
async function installClaudeHook(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".claude");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  const raw = await readOr(file);
  if (raw.trim()) {
    try {
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(`WARNING: ${file} is not valid JSON; leaving it and printing the hook to add manually`);
      log(
        `  add under hooks.SessionEnd: { "hooks": [ { "type": "command", "command": "${HOOK_CMD}", "timeout": 15000 } ] }`,
      );
      return;
    }
  }
  const hooks = (settings["hooks"] as Record<string, unknown>) ?? {};
  const sessionEnd = (hooks["SessionEnd"] as unknown[]) ?? [];
  const already = JSON.stringify(sessionEnd).includes(HOOK_CMD);
  if (!already) {
    sessionEnd.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 15000 }] });
  }
  hooks["SessionEnd"] = sessionEnd;
  settings["hooks"] = hooks;
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await installSkill(join(dir, "skills"));
  log(
    already
      ? ".claude/settings.json already had the hook"
      : "added SessionEnd hook to .claude/settings.json",
  );
}

async function installCodexHook(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".codex");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "hooks.json");
  let cfg: Record<string, unknown> = {};
  const raw = await readOr(file);
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(
        `WARNING: ${file} is not valid JSON; skipping. Add a SessionEnd command hook running: ${HOOK_CMD}`,
      );
      return;
    }
  }
  const hooks = (cfg["hooks"] as Record<string, unknown>) ?? {};
  const sessionEnd = (hooks["SessionEnd"] as unknown[]) ?? [];
  if (!JSON.stringify(sessionEnd).includes(HOOK_CMD)) {
    sessionEnd.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 15000 }] });
  }
  hooks["SessionEnd"] = sessionEnd;
  cfg["hooks"] = hooks;
  await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  log("added SessionEnd hook to .codex/hooks.json");
}

async function installCursorHook(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".cursor");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "hooks.json");
  let cfg: Record<string, unknown> = { version: 1, hooks: {} };
  const raw = await readOr(file);
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log(
        `WARNING: ${file} is not valid JSON; skipping. Add sessionEnd + stop command hooks running: ${HOOK_CMD}`,
      );
      return;
    }
  }
  if (typeof cfg["version"] !== "number") cfg["version"] = 1;
  const hooks = (cfg["hooks"] as Record<string, unknown>) ?? {};
  // sessionEnd (IDE) + stop (cloud-safe) — both idempotent because sync dedupes.
  for (const evt of ["sessionEnd", "stop"]) {
    const arr = (hooks[evt] as unknown[]) ?? [];
    if (!JSON.stringify(arr).includes(HOOK_CMD)) arr.push({ command: HOOK_CMD, type: "command" });
    hooks[evt] = arr;
  }
  cfg["hooks"] = hooks;
  await writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  await installSkill(join(dir, "skills"));
  log("added sessionEnd + stop hooks to .cursor/hooks.json");
}

export async function runInstall(args: string[]): Promise<void> {
  const cwdIdx = args.indexOf("--cwd");
  const projectDir = cwdIdx >= 0 && args[cwdIdx + 1] ? args[cwdIdx + 1]! : process.cwd();

  const requested = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") {
      let j = i + 1;
      while (j < args.length && !args[j]!.startsWith("--")) requested.add(args[j++]!);
    }
  }
  const agents: AgentId[] = requested.size ? TIER1.filter((a) => requested.has(a)) : TIER1;
  const unknown = [...requested].filter((r) => !AGENT_IDS.includes(r as AgentId));
  if (unknown.length) log(`ignoring unknown agent(s): ${unknown.join(", ")}`);

  log(`installing for: ${agents.join(", ")} in ${projectDir}`);

  // Read layer (shared): AGENTS.md pointer + a .agents/skills copy (covers Codex/Cursor/Pi/Amp).
  await ensureAgentsSection(projectDir);
  await installSkill(join(projectDir, ".agents", "skills"));
  await ensureGitignore(projectDir);
  await ensureStoreReadme(projectDir);

  for (const agent of agents) {
    switch (agent) {
      case "claude-code":
        await ensureClaudeMd(projectDir);
        await installClaudeHook(projectDir);
        break;
      case "codex":
        await installCodexHook(projectDir);
        break;
      case "cursor":
        await installCursorHook(projectDir);
        break;
      case "hermes":
        log(
          "Hermes: session-end hooks are user-level and need your consent. Add to ~/.hermes/config.yaml:",
        );
        log(
          `  hooks: { on_session_end: "${HOOK_CMD}" }   then run: hermes hooks list  (approve in ~/.hermes/shell-hooks-allowlist.json)`,
        );
        break;
      case "pi":
        log(
          "Pi has no session-end event. Run `agent-recall sync --scan` at session start, or add a Pi",
        );
        log(
          "  extension on `agent_start` that shells out to it. AGENTS.md already points Pi at the store.",
        );
        break;
    }
  }

  log(
    "done. New sessions will sync on close; run `agent-recall sync --scan` now to backfill existing ones.",
  );
}
