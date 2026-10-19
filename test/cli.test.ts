// End-to-end tests through the real CLI entrypoint (src/cli.ts via tsx). Covers the audit's
// entrypoint gaps: C-1 (hook default = calls), C-2 (install --help is not an install), exit codes.

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, stat, readFile, rm } from "node:fs/promises";
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

describe("release CLI contracts", () => {
  it.each([
    ["sync", "--scan", "--subagents", "everything"],
    ["sync", "--scan", "--agent", "typo"],
    ["sync", "--scan", "--cwd"],
    ["read", "--last", "-2"],
    ["read", "--offset", "Infinity"],
    ["install", "--agent", "codex", "--surprise"],
  ])("rejects invalid arguments before writes: %j", async (...args) => {
    const r = await runCli(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/requires|unknown|must be/);
  });
  it("prints valid JSONL only and pages after filtering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-read-"));
    try {
      await mkdir(join(dir, ".agent-recall"));
      const data = Array.from({ length: 100 }, (_, seq) => ({
        v: 1,
        ts: "2026-10-19T00:00:00Z",
        agent: "codex",
        session: "s",
        role: seq % 2 ? "assistant" : "user",
        seq,
      }));
      await writeFile(
        join(dir, ".agent-recall/index.jsonl"),
        data.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      const r = await runCli([
        "read",
        "--cwd",
        dir,
        "--role",
        "user",
        "--last",
        "3",
        "--offset",
        "2",
        "--json",
      ]);
      expect(r.code).toBe(0);
      expect(
        r.stdout
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s).seq),
      ).toEqual([90, 92, 94]);
      const empty = await runCli(["read", "--cwd", dir, "--agent", "pi", "--json"]);
      expect(empty.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("fails visibly for manual scan errors while malformed hooks remain non-blocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-fail-"));
    try {
      const source = join(dir, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), "s.jsonl");
      // Explicit --agent lets a host hand over arbitrary native transcript paths.
      const hook = await runCli(
        ["sync", "--from-hook", "--agent", "claude-code"],
        JSON.stringify({ transcript_path: source, cwd: dir }),
      );
      expect(hook.code).toBe(0);
      expect(hook.stderr).toBeTruthy();
      await writeFile(join(dir, ".agent-recall"), "not a directory");
      const manual = await runCli([
        "install",
        "--cwd",
        dir,
        "--agent",
        "claude-code",
        "--no-backfill",
      ]);
      expect(manual.code).toBe(1);
      const malformed = await runCli(["sync", "--from-hook"], "null");
      expect(malformed.code).toBe(0);
      expect(malformed.stderr).toContain("invalid hook");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves existing hooks and rejects invalid configurations before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-install-"));
    try {
      await mkdir(join(dir, ".codex"));
      const file = join(dir, ".codex/hooks.json");
      await writeFile(file, '{"hooks":{"SessionEnd":"not-an-array"}}');
      const fail = await runCli(["install", "--cwd", dir, "--agent", "codex", "--no-backfill"]);
      expect(fail.code).toBe(1);
      expect(await exists(join(dir, "AGENTS.md"))).toBe(false);
      await writeFile(
        file,
        JSON.stringify({
          hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo existing" }] }] },
        }),
      );
      for (let i = 0; i < 2; i++)
        expect(
          (await runCli(["install", "--cwd", dir, "--agent", "codex", "--no-backfill"])).code,
        ).toBe(0);
      const hooks = JSON.parse(await readFile(file, "utf8")).hooks.SessionEnd;
      expect(hooks).toHaveLength(2);
      expect(hooks[0].hooks[0].command).toBe("echo existing");
      expect(hooks[1].hooks[0].timeout).toBe(3);
      expect(hooks[1].hooks[0].command).toContain("--package=@itsmay21/agent-recall");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("accepts the documented Codex workspace hook path with explicit adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-cli-cloud-"));
    try {
      const file = join(dir, "rollout.jsonl");
      await writeFile(
        file,
        [
          { type: "session_meta", payload: { cwd: dir, id: "cloud" } },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "a cloud request" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      const hook = await runCli(
        ["sync", "--from-hook", "--agent", "codex"],
        JSON.stringify({ cwd: dir, transcript_path: file }),
      );
      expect(hook.code).toBe(0);
      expect(hook.stdout).toContain("indexed 1");
      expect(await exists(join(dir, ".agent-recall/index.jsonl"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
