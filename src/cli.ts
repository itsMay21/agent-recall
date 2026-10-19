// agent-recall — thin headless command. Verbs:
//   sync --from-hook       compile the transcript named on a hook's stdin JSON
//   sync --scan [--cwd D]  find & compile all known transcripts for a project dir
//   read [--last N]        print recent index rows (debug convenience; agents read the file directly)
//   install [--agent ...]  wire session-close hooks + AGENTS.md pointer + skill into a project
//
// Design rule: `sync` must never crash the host agent. On error it warns to stderr and exits 0.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import type { HookInput } from "./sync/types.js";
import type { CompileResult } from "./sync/compile.js";
import { storePaths } from "./sync/store.js";
import { compileLocator, scanAndCompile } from "./sync/scan.js";
import { adapterForPath, adapterById } from "./adapters/registry.js";
import { runInstall } from "./install/installer.js";
import { AGENT_IDS, type AgentId, type SubagentMode } from "./sync/types.js";

import pkg from "../package.json" with { type: "json" };

const HOME = process.env.HOME || process.env.USERPROFILE || "";

function parseSubagentMode(v: string | undefined): SubagentMode {
  return v === "off" || v === "full" ? v : "calls";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      // consume following tokens until the next --flag
      let j = i + 1;
      while (j < args.length && !args[j]!.startsWith("--")) {
        out.push(args[j]!);
        j++;
      }
    }
  }
  return out;
}

function summarize(results: CompileResult[]): string {
  const indexed = results.reduce((n, r) => n + r.indexed, 0);
  const rawOnly = results.reduce((n, r) => n + (r.rawOnly ? r.added : 0), 0);
  const redacted = results.reduce((n, r) => n + r.redacted, 0);
  const sessions = results.filter((r) => r.added > 0).length;
  const reconciled = results.reduce((n, r) => n + r.reconciled, 0);
  const rawNote = rawOnly > 0 ? `; ${rawOnly} sub-agent event(s) kept raw-only` : "";
  return `indexed ${indexed} event(s) across ${sessions} session(s)${rawNote}; ${redacted} secret span(s) redacted; ${reconciled} index row(s) recovered`;
}

async function cmdSyncFromHook(args: string[]): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write("agent-recall: no hook payload on stdin\n");
    return;
  }
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stderr.write("agent-recall: hook payload was not valid JSON\n");
    return;
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input.cwd !== undefined && typeof input.cwd !== "string") ||
    (input.transcript_path !== undefined &&
      input.transcript_path !== null &&
      typeof input.transcript_path !== "string") ||
    (input.session_id !== undefined && typeof input.session_id !== "string")
  ) {
    throw new Error("invalid hook payload fields");
  }
  const projectDir = resolve(input.cwd || process.cwd());
  const selected = flagValue(args, "--agent");
  const path = input.transcript_path;

  // Path-bearing hooks (Claude/Codex/Cursor): pick the adapter by the transcript path.
  if (path) {
    const adapter = selected ? adapterById(selected as AgentId) : adapterForPath(path, process.env);
    if (!adapter) {
      process.stderr.write(`agent-recall: no adapter recognizes ${path}\n`);
      return;
    }
    // Hooks use the same default as scan (`calls`): a sub-agent transcript handed to a hook is kept
    // raw-only, never dumped into the committable index (ADR-007).
    const result = await compileLocator(adapter, path, projectDir, HOME, "calls", projectDir);
    process.stdout.write(`agent-recall: ${result ? summarize([result]) : "nothing to sync"}\n`);
    return;
  }

  // Hermes has no transcript file — its SessionEnd payload carries only a session_id. Build the
  // <db>::<session-id> handle the Hermes adapter expects (F-1.7).
  if (selected === "hermes" && input.session_id) {
    const dbPath = join(process.env.HERMES_DIR || join(HOME, ".hermes"), "state.db");
    const handle = `${dbPath}::${input.session_id}`;
    const result = await compileLocator(
      adapterById("hermes")!,
      handle,
      projectDir,
      HOME,
      "calls",
      projectDir,
    );
    process.stdout.write(`agent-recall: ${result ? summarize([result]) : "nothing to sync"}\n`);
    return;
  }

  process.stderr.write(
    "agent-recall: hook payload had no transcript_path or session_id; try `sync --scan`\n",
  );
}

async function cmdScan(args: string[]): Promise<void> {
  const projectDir = flagValue(args, "--cwd") || process.cwd();
  // --store lets the store live somewhere other than the scanned project (centralized store, or tests).
  const storeDir = flagValue(args, "--store") || projectDir;
  const only = multiFlag(args, "--agent") as AgentId[];
  const subagents = parseSubagentMode(flagValue(args, "--subagents"));

  let failures = 0;
  const results = await scanAndCompile({
    cwd: projectDir,
    storeDir,
    home: HOME,
    env: process.env,
    agents: only,
    subagents,
    onError: (msg) => {
      failures++;
      process.stderr.write(`agent-recall: ${msg}\n`);
    },
  });
  process.stdout.write(
    `agent-recall: ${summarize(results)} in ${join(storeDir, ".agent-recall")}\n`,
  );
  if (failures) process.exitCode = 1;
}

// Token-lean, filterable read so a consumer never has to load the whole index into context.
// Filters (grep/session/role/agent) apply first; then a window (--last N, --offset M).
async function cmdRead(args: string[]): Promise<void> {
  const projectDir = flagValue(args, "--cwd") || process.cwd();
  const lastRaw = Number(flagValue(args, "--last") || "20");
  const last = Number.isFinite(lastRaw) && lastRaw > 0 ? Math.floor(lastRaw) : 20;
  const offsetRaw = Number(flagValue(args, "--offset") || "0");
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const grep = flagValue(args, "--grep")?.toLowerCase();
  const sessionFilter = flagValue(args, "--session");
  const roleFilter = flagValue(args, "--role");
  const agentFilter = flagValue(args, "--agent");
  const topLevel = args.includes("--top-level");
  const subagentOf = flagValue(args, "--subagent-of");
  const jsonOut = args.includes("--json");
  const { index } = storePaths(projectDir);

  const capacity = last + offset;
  const tail: Record<string, unknown>[] = [];
  let matchedCount = 0;
  try {
    const rl = createInterface({ input: createReadStream(index), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (grep && !line.toLowerCase().includes(grep)) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (sessionFilter && o["session"] !== sessionFilter) continue;
      if (roleFilter && o["role"] !== roleFilter) continue;
      if (agentFilter && o["agent"] !== agentFilter) continue;
      if (topLevel && o["origin"] === "subagent") continue;
      if (subagentOf && o["subagent_of"] !== subagentOf) continue;
      tail[matchedCount % capacity] = o;
      matchedCount++;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    process.stderr.write("agent-recall: no store at " + index + "\n");
    return;
  }
  const kept = Math.min(matchedCount, capacity);
  const first = matchedCount > capacity ? matchedCount % capacity : 0;
  const matched = Array.from({ length: kept }, (_, i) => tail[(first + i) % capacity]!);

  // Window: newest-first paging. --offset skips from the newest end, --last takes that many.
  const end = matched.length - offset;
  const start = Math.max(0, end - last);
  const page = matched.slice(start, Math.max(start, end));
  if (matched.length === 0) {
    if (!jsonOut) process.stdout.write("agent-recall: no matching rows\n");
    return;
  }
  if (!jsonOut)
    process.stdout.write(
      `# ${matchedCount} match(es); showing ${page.length} (offset ${offset})\n`,
    );
  for (const o of page) {
    if (jsonOut) {
      process.stdout.write(JSON.stringify(o) + "\n");
      continue;
    }
    const parts = [
      o["ts"],
      o["agent"],
      o["session"],
      o["role"],
      o["name"] ?? "",
      o["status"] ?? "",
      o["preview"] ?? "",
    ];
    process.stdout.write(
      parts
        .filter((x) => x !== "" && x !== undefined)
        .map((x) => String(x).replace(/[\u0000-\u001f\u007f-\u009f]/g, "�"))
        .join("  ") + "\n",
    );
  }
}

function usage(): void {
  process.stdout.write(
    [
      "agent-recall — unified cross-agent session recall",
      "",
      "Usage:",
      "  agent-recall sync --from-hook          compile the transcript named on a hook's stdin JSON",
      "  agent-recall sync --scan [--cwd DIR] [--store DIR] [--agent ID ...] [--subagents off|calls|full]",
      "                                        find & compile a project's transcripts (subagents default: calls)",
      "  agent-recall read [--grep S] [--session ID] [--role R] [--agent ID] [--top-level] [--subagent-of ID] [--last N] [--offset M] [--json]",
      "                                        search & page the index (streams the index; bounded result window)",
      "  agent-recall install [--agent ID ...] [--cwd DIR] [--no-backfill]   wire hooks + read layer + backfill",
      "",
      `  agents: ${AGENT_IDS.join(", ")}`,
      "",
    ].join("\n"),
  );
}

function validateArgs(cmd: string, args: string[]): void {
  const valueFlags = new Set(
    cmd === "sync"
      ? ["--cwd", "--store", "--agent", "--subagents"]
      : cmd === "install"
        ? ["--cwd", "--agent"]
        : [
            "--cwd",
            "--last",
            "--offset",
            "--grep",
            "--session",
            "--role",
            "--agent",
            "--subagent-of",
          ],
  );
  const booleanFlags = new Set(
    cmd === "sync"
      ? ["--scan", "--from-hook"]
      : cmd === "install"
        ? ["--no-backfill"]
        : ["--json", "--top-level"],
  );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (booleanFlags.has(arg)) continue;
    if (!valueFlags.has(arg)) throw new Error(`unknown argument '${arg}' for ${cmd}`);
    const values: string[] = [];
    do {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) break;
      values.push(next);
      i++;
    } while (arg === "--agent" && cmd !== "read");
    if (!values.length) throw new Error(`${arg} requires a value`);
    if (
      arg === "--agent" &&
      values.some(
        (v) =>
          !AGENT_IDS.includes((v === "claude" && cmd === "install" ? "claude-code" : v) as AgentId),
      )
    )
      throw new Error(`unknown agent; choose ${AGENT_IDS.join(", ")}`);
    if (arg === "--subagents" && !["off", "calls", "full"].includes(values[0]!))
      throw new Error("--subagents must be off, calls or full");
    if (
      ["--last", "--offset"].includes(arg) &&
      (!/^\d+$/.test(values[0]!) ||
        Number(values[0]) > 100000 ||
        (arg === "--last" && Number(values[0]) === 0))
    )
      throw new Error(`${arg} must be an integer ${arg === "--last" ? "1" : "0"}..100000`);
    if (
      arg === "--role" &&
      !["user", "assistant", "tool", "thinking", "system", "event"].includes(values[0]!)
    )
      throw new Error("invalid --role");
  }
  if (cmd === "sync") {
    if (args.includes("--scan") === args.includes("--from-hook"))
      throw new Error("choose exactly one of --scan or --from-hook");
    if (
      args.includes("--from-hook") &&
      args.some((v) => ["--cwd", "--store", "--subagents"].includes(v))
    )
      throw new Error(
        "hook project comes from stdin; --cwd, --store and --subagents apply to --scan only",
      );
    if (args.includes("--from-hook") && multiFlag(args, "--agent").length > 1)
      throw new Error("hooks accept one --agent");
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version") {
    process.stdout.write(pkg.version + "\n");
    return;
  }
  // Help is global: `-h`/`--help`/`help` on ANY verb prints usage and never runs the verb (C-2 —
  // `install --help` must not perform a live install).
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    usage();
    return;
  }
  if (["sync", "read", "install"].includes(cmd)) {
    try {
      validateArgs(cmd, rest);
    } catch (err) {
      process.stderr.write(`agent-recall: ${(err as Error).message}\n`);
      process.exitCode = rest.includes("--from-hook") ? 0 : 2;
      return;
    }
  }
  switch (cmd) {
    case "sync":
      if (rest.includes("--from-hook")) await cmdSyncFromHook(rest);
      else await cmdScan(rest);
      break;
    case "read":
      await cmdRead(rest);
      break;
    case "install":
      await runInstall(rest);
      break;
    default:
      process.stderr.write(`agent-recall: unknown command '${cmd}'\n`);
      usage();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`agent-recall: ${(err as Error).message || err}\n`);
  // sync must not kill the host agent; other commands may surface a nonzero code.
  if (!(process.argv[2] === "sync" && process.argv.includes("--from-hook"))) process.exitCode = 1;
});
