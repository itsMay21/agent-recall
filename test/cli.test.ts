// End-to-end tests through the real CLI entrypoint (src/cli.ts via tsx). Covers the audit's
// entrypoint gaps: C-1 (hook default = calls), C-2 (install --help is not an install), exit codes.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CLI = join(ROOT, "src", "cli.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
function runCli(args: string[], input = ""): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(TSX, [CLI, ...args], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    if (input) p.stdin.write(input);
    p.stdin.end();
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("CLI entrypoint", () => {
  it("C-2: `install --help` prints usage and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-help-"));
    const r = await runCli(["install", "--help", "--cwd", dir, "--no-backfill"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
    expect(await exists(join(dir, ".agent-recall"))).toBe(false);
  }, 20000);

  it("unknown command exits 2 with usage", async () => {
    const r = await runCli(["foobar"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain("Usage:");
  }, 20000);

  it("C-1: a sub-agent transcript from a hook is kept raw-only (no index rows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-hook-"));
    // Synthetic Claude sub-agent sidechain under a .claude/projects/ path so matchPath accepts it.
    const side = join(dir, ".claude", "projects", "proj", "PARENT", "subagents", "agent-x.jsonl");
    await mkdir(join(side, ".."), { recursive: true });
    await writeFile(
      side,
      [
        JSON.stringify({
          type: "user",
          isSidechain: true,
          sessionId: "PARENT",
          agentId: "x",
          message: { role: "user", content: "sub" },
        }),
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          sessionId: "PARENT",
          agentId: "x",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const store = join(dir, "store");
    await mkdir(store, { recursive: true });
    const payload = JSON.stringify({ transcript_path: side, cwd: store, session_id: "hooktest" });
    const r = await runCli(["sync", "--from-hook"], payload);
    expect(r.code).toBe(0);
    // calls mode: sub-agent thread goes to raw/ only — the index file must not be created.
    expect(await exists(join(store, ".agent-recall", "index.jsonl"))).toBe(false);
    expect(await exists(join(store, ".agent-recall", "raw"))).toBe(true);
  }, 20000);
});
