// agent-recall — thin headless command. Verbs:
//   sync --from-hook       compile the transcript named on a hook's stdin JSON
//   sync --scan [--cwd D]  find & compile all known transcripts for a project dir
//   read [--last N]        print recent index rows (debug convenience; agents read the file directly)
//   install [--agent ...]  wire session-close hooks + AGENTS.md pointer + skill into a project
//
// Design rule: `sync` must never crash the host agent. On error it warns to stderr and exits 0.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { HookInput } from "./sync/types.js";
import type { CompileResult } from "./sync/compile.js";
import { storePaths } from "./sync/store.js";
import { compileLocator, scanAndCompile } from "./sync/scan.js";
import { adapterForPath, adapterById } from "./adapters/registry.js";
import { runInstall } from "./install/installer.js";
import { AGENT_IDS, type AgentId, type SubagentMode } from "./sync/types.js";

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
  const added = results.reduce((n, r) => n + r.added, 0);
  const redacted = results.reduce((n, r) => n + r.redacted, 0);
  const sessions = results.filter((r) => r.added > 0).length;
  return `synced ${added} event(s) across ${sessions} session(s); ${redacted} secret span(s) redacted`;
}

async function cmdSyncFromHook(): Promise<void> {
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
  const projectDir = input.cwd || process.cwd();
  const path = input.transcript_path;

  // Path-bearing hooks (Claude/Codex/Cursor): pick the adapter by the transcript path.
  if (path) {
    const adapter = adapterForPath(path);
    if (!adapter) {
      process.stderr.write(`agent-recall: no adapter recognizes ${path}\n`);
      return;
    }
    const result = await compileLocator(adapter, path, projectDir, HOME);
    process.stdout.write(`agent-recall: ${result ? summarize([result]) : "nothing to sync"}\n`);
    return;
  }

  // Hermes has no transcript file — its SessionEnd payload carries only a session_id. Build the
  // <db>::<session-id> handle the Hermes adapter expects (F-1.7).
  if (input.session_id) {
    const dbPath = join(process.env.HERMES_DIR || join(HOME, ".hermes"), "state.db");
    const handle = `${dbPath}::${input.session_id}`;
    const result = await compileLocator(adapterById("hermes")!, handle, projectDir, HOME);
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

  const results = await scanAndCompile({
    cwd: projectDir,
    storeDir,
    home: HOME,
    env: process.env,
    agents: only,
    subagents,
    onError: (msg) => process.stderr.write(`agent-recall: ${msg}\n`),
  });
  process.stdout.write(
    `agent-recall: ${summarize(results)} in ${join(storeDir, ".agent-recall")}\n`,
  );
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

  const matched: Record<string, unknown>[] = [];
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
      matched.push(o);
    }
  } catch {
    process.stdout.write("agent-recall: no store at " + index + "\n");
    return;
  }

  // Window: newest-first paging. --offset skips from the newest end, --last takes that many.
  const end = matched.length - offset;
  const start = Math.max(0, end - last);
  const page = matched.slice(start, Math.max(start, end));
  if (matched.length === 0) {
    process.stdout.write("agent-recall: no matching rows\n");
    return;
  }
  process.stdout.write(
    `# ${matched.length} match(es); showing ${page.length} (offset ${offset})\n`,
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
    process.stdout.write(parts.filter((x) => x !== "" && x !== undefined).join("  ") + "\n");
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
      "                                        search & page the index (token-lean; never loads it all)",
      "  agent-recall install [--agent ID ...] [--cwd DIR] [--no-backfill]   wire hooks + read layer + backfill",
      "",
      `  agents: ${AGENT_IDS.join(", ")}`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "sync":
      if (rest.includes("--from-hook")) await cmdSyncFromHook();
      else await cmdScan(rest);
      break;
    case "read":
      await cmdRead(rest);
      break;
    case "install":
      await runInstall(rest);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      process.stderr.write(`agent-recall: unknown command '${cmd}'\n`);
      usage();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`agent-recall: ${(err as Error).stack || err}\n`);
  // sync must not kill the host agent; other commands may surface a nonzero code.
  if (process.argv[2] !== "sync") process.exitCode = 1;
});
