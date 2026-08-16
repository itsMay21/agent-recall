// Regression tests for the audit findings (AUDIT-REPORT.md). Each test is named with its finding id.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactString } from "../src/sync/redact.js";
import { sanitizeJsonString, previewOf, scrubHome } from "../src/sync/scrub.js";
import { sanitizeSegment } from "../src/sync/store.js";
import { compileSession } from "../src/sync/compile.js";
import type { ParsedSession } from "../src/sync/types.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function session(
  events: ParsedSession["events"],
  over: Partial<ParsedSession> = {},
): ParsedSession {
  return { agent: "claude-code", session: "s", cwd: "/proj", events, sourceFiles: [], ...over };
}
async function lines(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
}

describe("F-1.1 redaction: multi-word quoted secret values", () => {
  it("redacts a quoted value that contains spaces", () => {
    const { value, count } = redactString('{"api_key": "hunter2 boogaloo extra"}');
    expect(count).toBeGreaterThanOrEqual(1);
    expect(value).not.toContain("hunter2 boogaloo extra");
    expect(value).toContain("api_key");
  });
  it("still redacts single-word unquoted values", () => {
    const { value } = redactString("password=supersecretvalue123");
    expect(value).not.toContain("supersecretvalue123");
  });
});

describe("F-2.3 redaction: bare 40-char AWS secret near 'aws'", () => {
  it("redacts a 40-char secret adjacent to the word aws", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40 chars, fake
    const { value, count } = redactString(`aws_secret_access_key = "${secret}"`);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(value).not.toContain(secret);
  });
});

describe("F-0.2 surrogate / strict-JSON safety", () => {
  it("replaces a lone surrogate with U+FFFD", () => {
    const bad = "hello \uD83C world"; // high surrogate with no low
    expect(LONE_SURROGATE.test(bad)).toBe(true);
    const fixed = sanitizeJsonString(bad);
    expect(LONE_SURROGATE.test(fixed)).toBe(false);
    expect(fixed).toContain("�");
  });
  it("preview truncation never splits an emoji surrogate pair", () => {
    const s = "🎯".repeat(300); // 300 astral code points, each a surrogate pair
    const p = previewOf(s, "", 200);
    expect(LONE_SURROGATE.test(p)).toBe(false);
    expect(Array.from(p).length).toBe(200);
  });
  it("compiled lines contain no lone surrogates even when text is cut mid-emoji", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-surr-"));
    const text = "x".repeat(199) + "🎯" + "y".repeat(50); // boundary lands inside the pair
    await compileSession(session([{ role: "assistant", text }]), {
      projectDir: dir,
      fallbackTs: "2026-08-15T00:00:00Z",
    });
    for (const file of ["index.jsonl", "raw/claude-code/s/events.jsonl"]) {
      for (const line of await lines(join(dir, ".agent-recall", file))) {
        expect(LONE_SURROGATE.test(line)).toBe(false);
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});

describe("F-2.4 home-path scrub", () => {
  it("rewrites $HOME to ~ in preview/text but leaves cwd intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-home-"));
    const home = "/Users/tester";
    await compileSession(
      session([{ role: "user", text: `look at ${home}/proj/file.ts please` }], {
        cwd: `${home}/proj`,
      }),
      { projectDir: dir, fallbackTs: "2026-08-15T00:00:00Z", home },
    );
    const idx = JSON.parse((await lines(join(dir, ".agent-recall", "index.jsonl")))[0]!) as Record<
      string,
      unknown
    >;
    expect(idx["preview"]).toContain("~/proj/file.ts");
    expect(idx["preview"]).not.toContain(home);
    expect(idx["cwd"]).toBe(`${home}/proj`); // cwd is deliberately preserved
  });
  it("scrubHome is a no-op for empty home", () => {
    expect(scrubHome("/Users/x", "")).toBe("/Users/x");
  });
});

describe("F-1.5 crash-window reconcile", () => {
  it("regenerates index rows from raw when the index is short of the raw sidecar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ar-recon-"));
    const s = session([
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
    ]);
    const opts = { projectDir: dir, fallbackTs: "2026-08-15T00:00:00Z" };
    await compileSession(s, opts);
    // Simulate a tear: raw keeps its 2 lines, but the index lost them.
    await writeFile(join(dir, ".agent-recall", "index.jsonl"), "", "utf8");
    const again = await compileSession(s, opts);
    expect(again.added).toBe(0);
    expect(again.reconciled).toBe(2);
    const idx = await lines(join(dir, ".agent-recall", "index.jsonl"));
    expect(idx).toHaveLength(2);
    // reconciled rows are valid index lines (no raw-only fields)
    const row = JSON.parse(idx[1]!) as Record<string, unknown>;
    expect(row["seq"]).toBe(1);
    expect(row).not.toHaveProperty("text");
  });
});

describe("F-2.2 sanitizeSegment collision resistance", () => {
  it("gives two ids that sanitize identically distinct segments", () => {
    const a = sanitizeSegment("sess/one");
    const b = sanitizeSegment("sess:one"); // both naive-map to sess-one
    expect(a).not.toBe(b);
  });
  it("leaves a clean id untouched", () => {
    expect(sanitizeSegment("00893aaf-19fa-41d2")).toBe("00893aaf-19fa-41d2");
  });
});
