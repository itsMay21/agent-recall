import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { piAdapter } from "../src/adapters/pi.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { hermesAdapter } from "../src/adapters/hermes.js";
import type { RawEvent } from "../src/sync/types.js";

// Load node:sqlite the same way the adapter does (so the bundler/vite can't rewrite the specifier),
// but tolerate its absence on Node < 22.5 — the Hermes suite is skipped there.
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: typeof DatabaseSyncCtor | undefined;
try {
  ({ DatabaseSync } = nodeRequire("node:" + "sqlite") as { DatabaseSync: typeof DatabaseSyncCtor });
} catch {
  // node:sqlite unavailable on this runtime
}
const hasSqlite = Boolean(DatabaseSync);

async function fixture(name: string, lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ar-fix-"));
  const file = join(dir, name);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return file;
}

const roles = (evs: RawEvent[]) => evs.map((e) => e.role);
const names = (evs: RawEvent[]) => evs.filter((e) => e.name).map((e) => e.name);

describe("claude adapter", () => {
  it("flattens text/thinking/tool_use/tool_result and skips metadata", async () => {
    const file = await fixture("abc.jsonl", [
      { type: "user", cwd: "/proj", gitBranch: "main", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", is_error: false, content: [{ type: "text", text: "out" }] },
          ],
        },
      },
      { type: "summary", summary: "x" },
      { type: "queue-operation", operation: "enqueue" },
    ]);
    const s = await claudeAdapter.parse(file);
    expect(s).not.toBeNull();
    expect(s!.cwd).toBe("/proj");
    expect(s!.gitBranch).toBe("main");
    expect(roles(s!.events)).toEqual(["user", "assistant", "thinking", "tool", "tool"]);
    expect(names(s!.events)).toEqual(["Bash"]);
    expect(s!.events.find((e) => e.name === "Bash")!.text).toBe("ls");
    expect(s!.events.at(-1)!.status).toBe("ok");
  });
});

describe("codex adapter", () => {
  it("uses response_item as canonical and skips event_msg duplicates", async () => {
    const file = await fixture("rollout-x.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-08-15T00:00:00Z",
        payload: { id: "cx1", cwd: "/proj" },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: '{"command":"ls -la"}' },
      },
      { type: "response_item", payload: { type: "function_call_output", output: "done" } },
      { type: "event_msg", payload: { type: "agent_message", message: "DUPLICATE_TEXT" } },
    ]);
    const s = await codexAdapter.parse(file);
    expect(s!.session).toBe("cx1");
    expect(s!.cwd).toBe("/proj");
    expect(roles(s!.events)).toEqual(["user", "assistant", "tool", "tool"]);
    const call = s!.events.find((e) => e.name === "shell")!;
    expect(call.args).toEqual({ command: "ls -la" });
    expect(call.text).toBe("ls -la");
    // event_msg text must not appear (no double counting)
    expect(JSON.stringify(s!.events)).not.toContain("DUPLICATE_TEXT");
  });
});

describe("pi adapter", () => {
  it("parses session header, toolCall/toolResult, and skips custom", async () => {
    const file = await fixture("2026_pi.jsonl", [
      { type: "session", id: "pi1", cwd: "/proj", timestamp: "2026-08-15T00:00:00Z" },
      { type: "message", message: { role: "user", content: "hi" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "read_file", arguments: { file_path: "a.ts" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read_file",
          isError: false,
          content: [{ type: "text", text: "body" }],
        },
      },
      { type: "custom", data: {} },
    ]);
    const s = await piAdapter.parse(file);
    expect(s!.session).toBe("pi1");
    expect(roles(s!.events)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(names(s!.events)).toEqual(["read_file", "read_file"]);
    expect(s!.events.find((e) => e.role === "tool" && e.name === "read_file")!.text).toBe("a.ts");
  });
});

describe("cursor adapter (lossy)", () => {
  it("captures user/assistant text but no typed tools", async () => {
    const file = await fixture("uuid.jsonl", [
      { role: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "yo" }] } },
    ]);
    const s = await cursorAdapter.parse(file);
    expect(roles(s!.events)).toEqual(["user", "assistant"]);
    expect(names(s!.events)).toEqual([]); // never invents tool names
    expect(s!.session).toBe("uuid");
  });
});

describe.skipIf(!hasSqlite)("hermes adapter (sqlite)", () => {
  it("locates by cwd and parses messages/tool_calls from state.db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-hermes-"));
    const db = new DatabaseSync!(join(dir, "state.db"));
    db.exec(
      "CREATE TABLE sessions (id TEXT, cwd TEXT, git_branch TEXT, started_at REAL, message_count INTEGER);" +
        "CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, reasoning TEXT, reasoning_content TEXT, timestamp REAL);",
    );
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(
      "h1",
      "/proj",
      "main",
      1_700_000_000,
      3,
    );
    const ins = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run(1, "h1", "user", "hi", null, null, null, null, 1_700_000_000);
    ins.run(
      2,
      "h1",
      "assistant",
      "on it",
      JSON.stringify([{ function: { name: "bash", arguments: '{"command":"ls"}' } }]),
      null,
      null,
      null,
      1_700_000_001,
    );
    ins.run(3, "h1", "tool", "output text", null, "bash", null, null, 1_700_000_002);
    db.close();

    const env = { ...process.env, HERMES_DIR: dir };
    const handles = await hermesAdapter.locate({ cwd: "/proj", home: dir, env });
    expect(handles).toHaveLength(1);
    const s = await hermesAdapter.parse(handles[0]!);
    expect(s!.agent).toBe("hermes");
    expect(s!.cwd).toBe("/proj");
    expect(roles(s!.events)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(names(s!.events)).toContain("bash");
    expect(s!.sourceFiles).toEqual([]); // never copies the db
  });
});
