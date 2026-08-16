import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSession } from "../src/sync/compile.js";
import type { ParsedSession } from "../src/sync/types.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ar-compile-"));
}

function session(events: ParsedSession["events"]): ParsedSession {
  return { agent: "claude-code", session: "sess1", cwd: "/proj", events, sourceFiles: [] };
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("compileSession", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmp();
  });

  it("writes an index line per event and a raw sidecar", async () => {
    const res = await compileSession(
      session([
        { role: "user", text: "hello", ts: "2026-08-15T00:00:00.000Z" },
        {
          role: "tool",
          name: "Bash",
          text: "ls -la",
          args: { command: "ls -la" },
          ts: "2026-08-15T00:00:01.000Z",
        },
      ]),
      { projectDir: dir, fallbackTs: "2026-08-15T00:00:00.000Z" },
    );
    expect(res.added).toBe(2);
    const index = await readJsonl(join(dir, ".agent-recall", "index.jsonl"));
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({ role: "user", agent: "claude-code", seq: 0 });
    expect(index[1]).toMatchObject({ role: "tool", name: "Bash", seq: 1, preview: "ls -la" });
    // raw sidecar carries full args; index does not
    const raw = await readJsonl(
      join(dir, ".agent-recall", "raw", "claude-code", "sess1", "events.jsonl"),
    );
    expect(raw[1]!["args"]).toEqual({ command: "ls -la" });
    expect(index[1]!["args"]).toBeUndefined();
  });

  it("is idempotent — re-running adds nothing", async () => {
    const s = session([{ role: "user", text: "hi", ts: "2026-08-15T00:00:00.000Z" }]);
    await compileSession(s, { projectDir: dir, fallbackTs: "2026-08-15T00:00:00.000Z" });
    const again = await compileSession(s, {
      projectDir: dir,
      fallbackTs: "2026-08-15T00:00:00.000Z",
    });
    expect(again.added).toBe(0);
    const index = await readJsonl(join(dir, ".agent-recall", "index.jsonl"));
    expect(index).toHaveLength(1);
  });

  it("appends only new events when a transcript grows", async () => {
    await compileSession(session([{ role: "user", text: "one" }]), {
      projectDir: dir,
      fallbackTs: "2026-08-15T00:00:00.000Z",
    });
    const grown = await compileSession(
      session([
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
      ]),
      {
        projectDir: dir,
        fallbackTs: "2026-08-15T00:00:00.000Z",
      },
    );
    expect(grown.added).toBe(1);
    const index = await readJsonl(join(dir, ".agent-recall", "index.jsonl"));
    expect(index).toHaveLength(2);
    expect(index[1]).toMatchObject({ role: "assistant", seq: 1 });
  });

  it("strips image payloads to an envelope with sha256, dropping the base64", async () => {
    const b64 = Buffer.from("hello").toString("base64");
    await compileSession(
      session([
        {
          role: "user",
          text: "see image",
          attachments: [{ kind: "image", contentType: "image/png", base64: b64 }],
        },
      ]),
      { projectDir: dir, fallbackTs: "2026-08-15T00:00:00.000Z" },
    );
    const raw = await readFile(
      join(dir, ".agent-recall", "raw", "claude-code", "sess1", "events.jsonl"),
      "utf8",
    );
    expect(raw).not.toContain(b64);
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    const att = (line["attachments"] as Array<Record<string, unknown>>)[0]!;
    expect(att["bytes"]).toBe(5);
    expect(att["sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(att).not.toHaveProperty("base64");
  });

  it("truncates preview to 200 chars and flags mtime fallback when no ts", async () => {
    const long = "x".repeat(500);
    await compileSession(session([{ role: "assistant", text: long }]), {
      projectDir: dir,
      fallbackTs: "2026-08-15T09:09:09.000Z",
    });
    const index = await readJsonl(join(dir, ".agent-recall", "index.jsonl"));
    expect((index[0]!["preview"] as string).length).toBe(200);
    expect(index[0]!["ts"]).toBe("2026-08-15T09:09:09.000Z");
    expect(index[0]!["ts_source"]).toBe("mtime");
  });

  it("redacts secrets in preview and raw, and counts them", async () => {
    const res = await compileSession(
      session([
        {
          role: "tool",
          name: "Bash",
          text: "export TOKEN=ghp_" + "c".repeat(36),
          args: { v: "ghp_" + "c".repeat(36) },
        },
      ]),
      { projectDir: dir, fallbackTs: "2026-08-15T00:00:00.000Z" },
    );
    expect(res.redacted).toBeGreaterThanOrEqual(2);
    const idx = await readFile(join(dir, ".agent-recall", "index.jsonl"), "utf8");
    expect(idx).not.toContain("ghp_cccc");
  });
});
