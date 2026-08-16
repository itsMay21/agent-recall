// Sub-agent ingestion (ADR-007): Claude sidechains + Codex forks are tagged with origin/subagent_of/
// subagent_kind; "calls" mode stores them raw-only, "full" indexes them.

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { compileSession } from "../src/sync/compile.js";
import { sanitizeSegment } from "../src/sync/store.js";
import type { ParsedSession } from "../src/sync/types.js";

async function fixture(name: string, lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-sub-"));
  const file = join(dir, name);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("Claude sub-agent sidechain", () => {
  it("tags origin/subagent_of and namespaces the session id", async () => {
    const file = await fixture("agent-a1b2c3.jsonl", [
      {
        type: "user",
        isSidechain: true,
        sessionId: "PARENT-1",
        agentId: "a1b2c3",
        message: { role: "user", content: "sub task" },
      },
      {
        type: "assistant",
        isSidechain: true,
        sessionId: "PARENT-1",
        agentId: "a1b2c3",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ]);
    const s = await claudeAdapter.parse(file);
    expect(s!.origin).toBe("subagent");
    expect(s!.subagentOf).toBe("PARENT-1");
    expect(s!.session).toBe("PARENT-1/a1b2c3");
  });
});

describe("Codex fork", () => {
  it("tags origin/subagent_of/subagent_kind from session_meta", async () => {
    const file = await fixture("rollout-f.jsonl", [
      {
        type: "session_meta",
        payload: {
          id: "019ffbec",
          cwd: "/proj",
          thread_source: "subagent",
          parent_thread_id: "019ffbc4",
          source: { subagent: { other: "guardian" } },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      },
    ]);
    const s = await codexAdapter.parse(file);
    expect(s!.origin).toBe("subagent");
    expect(s!.subagentOf).toBe("019ffbc4");
    expect(s!.subagentKind).toBe("guardian");
  });
});

describe("calls vs full storage", () => {
  const sub: ParsedSession = {
    agent: "claude-code",
    session: "P/child",
    cwd: "/proj",
    origin: "subagent",
    subagentOf: "P",
    events: [{ role: "assistant", text: "sub work" }],
    sourceFiles: [],
  };

  it("calls mode writes raw only (no index rows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-calls-"));
    const res = await compileSession(sub, {
      projectDir: dir,
      fallbackTs: "2026-08-15T00:00:00Z",
      rawOnly: true,
    });
    expect(res.added).toBe(1);
    expect(await exists(join(dir, ".agent-recall", "index.jsonl"))).toBe(false);
    const seg = sanitizeSegment("P/child");
    expect(
      await exists(join(dir, ".agent-recall", "raw", "claude-code", seg, "events.jsonl")),
    ).toBe(true);
  });

  it("full mode indexes the sub-agent stream with origin tag", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-full-"));
    await compileSession(sub, { projectDir: dir, fallbackTs: "2026-08-15T00:00:00Z" });
    const idx = (await readFile(join(dir, ".agent-recall", "index.jsonl"), "utf8")).trim();
    const row = JSON.parse(idx) as Record<string, unknown>;
    expect(row["origin"]).toBe("subagent");
    expect(row["subagent_of"]).toBe("P");
  });
});
