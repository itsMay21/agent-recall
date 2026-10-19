import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  mkdir,
  symlink,
  utimes,
  open,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { compileSession } from "../src/sync/compile.js";
import {
  acquireLock,
  releaseLock,
  safeSessionId,
  sanitizeSegment,
  sessionRawDir,
  recoverJsonl,
  storePaths,
} from "../src/sync/store.js";
import { redactDeep, redactString } from "../src/sync/redact.js";
import { compileLocator, scanAndCompile } from "../src/sync/scan.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import type { ParsedSession } from "../src/sync/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ar-release-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ts = "2026-10-19T00:00:00.000Z";
const sample = (extra: Partial<ParsedSession> = {}): ParsedSession => ({
  agent: "claude-code",
  session: "test",
  events: [
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
  ],
  sourceFiles: [],
  ...extra,
});
const rows = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
const options = () => ({ projectDir: dir, fallbackTs: ts });

describe("privacy boundaries", () => {
  it("redacts secrets in metadata, structured keys, short credential values and nested results", async () => {
    const secret = "ghp_" + "Z".repeat(36);
    const session = sample({
      session: secret,
      cwd: `/projects/${secret}`,
      gitBranch: secret,
      subagentOf: secret,
      subagentKind: secret,
      events: [
        {
          role: "tool",
          name: secret,
          ts: secret,
          nativeType: secret,
          args: { password: "abc", clientSecret: "custom-value", [secret]: "ordinary" },
          result: [{ authorization: "plain-credential" }],
        },
      ],
    });
    await compileSession(session, options());
    const paths = storePaths(dir);
    for (const file of [
      paths.index,
      join(sessionRawDir(paths, session.agent, session.session), "events.jsonl"),
    ]) {
      const data = await readFile(file, "utf8");
      for (const value of [secret, '"abc"', "custom-value", "plain-credential"])
        expect(data).not.toContain(value);
    }
    expect((await rows(paths.index))[0].session).toBe(safeSessionId(secret));
    expect((await compileSession(session, options())).added).toBe(0);
  });
  it("does not trust a redaction-marker prefix with appended credential bytes", () => {
    const secret = "«redacted:value»actual-private-password";
    expect(JSON.stringify(redactDeep({ password: secret }).value)).not.toContain(
      "actual-private-password",
    );
    expect(redactString(`password="${secret}"`).value).not.toContain("actual-private-password");
    expect(redactString(`Bearer ${secret}`).value).not.toContain("actual-private-password");
  });
  it("retains JSON object keys safely, including __proto__, and redaction is idempotent", () => {
    const value = JSON.parse('{"__proto__":{"password":"short"},"ordinary":true}');
    const redacted = redactDeep(value).value;
    expect(Object.prototype.hasOwnProperty.call(redacted, "__proto__")).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("short");
    const once = redactString("Authorization: Bearer my-custom-credential").value;
    expect(redactString(once)).toEqual({ value: once, count: 0 });
  });
  it("protects raw files for direct sync, before copying source bytes", async () => {
    execFileSync("git", ["init", "-q", dir]);
    const source = join(dir, "source.jsonl");
    await writeFile(source, "private original bytes");
    await compileSession(sample({ sourceFiles: [source] }), options());
    const raw = join(dir, ".agent-recall/raw/claude-code/test/source-source.jsonl");
    expect(execFileSync("git", ["check-ignore", raw], { cwd: dir, encoding: "utf8" })).toContain(
      "source-source.jsonl",
    );
    expect((await stat(raw)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(raw))).mode & 0o777).toBe(0o700);
  });
  it.each([".", "..", "", "../escape", "a/b", "a:b"])(
    "contains hostile session id %j in one directory",
    (id) => {
      expect([".", "..", ""]).not.toContain(sanitizeSegment(id));
      expect(dirname(sessionRawDir(storePaths(dir), "codex", id))).toBe(
        join(dir, ".agent-recall/raw/codex"),
      );
    },
  );
  it("preserves custom store ignore rules and reinforces raw protection", async () => {
    await mkdir(join(dir, ".agent-recall"));
    const file = join(dir, ".agent-recall/.gitignore");
    await writeFile(file, "index.jsonl\n!raw/\n");
    await compileSession(sample(), options());
    const content = await readFile(file, "utf8");
    expect(content).toContain("index.jsonl");
    expect(content.endsWith("raw/\n.lock\n")).toBe(true);
  });
  it("refuses a symlinked store rather than copying secrets outside it", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(dir, ".agent-recall"));
    await expect(compileSession(sample(), options())).rejects.toThrow("real directory");
  });
  it("strips images nested inside Claude and Pi-shaped tool results", async () => {
    const payload = Buffer.from("private-image-pixels").toString("base64");
    await compileSession(
      sample({
        events: [
          {
            role: "tool",
            result: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: payload } },
              { type: "image", mimeType: "image/png", data: payload },
              { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } },
            ],
          },
        ],
      }),
      options(),
    );
    const raw = await readFile(
      join(dir, ".agent-recall/raw/claude-code/test/events.jsonl"),
      "utf8",
    );
    expect(raw).not.toContain(payload);
    const result = JSON.parse(raw).result;
    expect(result).toHaveLength(3);
    for (const envelope of result) {
      expect(envelope.bytes).toBe(20);
      expect(envelope.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("durable identity and recovery", () => {
  it("rebuilds deleted raw data without duplicating a committed index", async () => {
    await compileSession(sample(), options());
    await rm(join(dir, ".agent-recall/raw"), { recursive: true });
    const result = await compileSession(sample(), options());
    expect(result.added).toBe(2);
    expect(result.indexed).toBe(0);
    expect(await rows(storePaths(dir).index)).toHaveLength(2);
  });
  it.each(["index.jsonl", "raw/claude-code/test/events.jsonl"])(
    "recovers a partial final append in %s without loss or duplication",
    async (relative) => {
      await compileSession(sample(), options());
      const file = join(dir, ".agent-recall", relative);
      const original = await readFile(file, "utf8");
      const first = original.indexOf("\n") + 1;
      await writeFile(file, original.slice(0, first + 20));
      await compileSession(sample(), options());
      expect(await rows(file)).toHaveLength(2);
      expect((await compileSession(sample(), options())).added).toBe(0);
      expect(await rows(storePaths(dir).index)).toHaveLength(2);
    },
  );
  it("retains a valid final record missing only its newline", async () => {
    await compileSession(sample(), options());
    const file = storePaths(dir).index;
    await writeFile(file, (await readFile(file, "utf8")).trimEnd());
    expect((await compileSession(sample(), options())).indexed).toBe(0);
    expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
  });
  it("fails on complete corruption, duplicate identities and shrinking sources", async () => {
    await compileSession(sample(), options());
    const file = storePaths(dir).index;
    const original = await readFile(file, "utf8");
    await writeFile(file, original + "broken\n");
    await expect(compileSession(sample(), options())).rejects.toThrow("corrupt complete");
    await writeFile(file, original + original.split("\n")[0] + "\n");
    await expect(compileSession(sample(), options())).rejects.toThrow("duplicate");
    await writeFile(file, original);
    await expect(compileSession(sample({ events: [] }), options())).rejects.toThrow("shrank");
  });
  it("serializes concurrent compilers without duplicate ordinals", async () => {
    await Promise.all(Array.from({ length: 5 }, () => compileSession(sample(), options())));
    expect(await rows(storePaths(dir).index)).toHaveLength(2);
  });
  it("preserves valid final bytes if the newline write runs out of disk space", async () => {
    const file = join(dir, "valid.jsonl");
    const original = JSON.stringify({ v: 1, seq: 0 });
    await writeFile(file, original);
    const fh = await open(file, "r+");
    const proto = Object.getPrototypeOf(fh);
    await fh.close();
    const spy = vi
      .spyOn(proto, "write")
      .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    try {
      await expect(recoverJsonl(file)).rejects.toThrow("disk full");
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("reclaims an old empty lock left between creation and token write", async () => {
    const root = join(dir, ".agent-recall");
    await mkdir(root);
    await writeFile(join(root, ".lock"), "");
    await utimes(join(root, ".lock"), new Date(0), new Date(0));
    const lock = await acquireLock(root, 1);
    await releaseLock(lock);
  });
  it("keeps distinct session identities after home and Unicode sanitation", async () => {
    const home = "/Users/tester";
    const ids = [`${home}/s`, "~/s", "bad\uD800", "bad\uD801", "bad�"];
    for (const id of ids) await compileSession(sample({ session: id }), { ...options(), home });
    const indexed = await rows(storePaths(dir).index);
    expect(new Set(indexed.map((row) => row.session)).size).toBe(ids.length);
    expect(indexed).toHaveLength(ids.length * 2);
    for (const row of indexed)
      expect(await stat(join(dir, ".agent-recall", row.raw.split("#")[0]))).toBeTruthy();
  });
  it("rejects valid JSON with an invalid raw ordinal", async () => {
    await compileSession(sample(), options());
    const file = join(dir, ".agent-recall/raw/claude-code/test/events.jsonl");
    const data = await rows(file);
    data[0].seq = 5;
    await writeFile(file, data.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(compileSession(sample(), options())).rejects.toThrow("invalid raw");
  });
  it("keeps a live lock even if old and releases only its own token", async () => {
    await mkdir(join(dir, ".agent-recall"));
    const root = join(dir, ".agent-recall");
    const lock = await acquireLock(root);
    await utimes(lock.path, new Date(0), new Date(0));
    await expect(acquireLock(root, 1)).rejects.toThrow("busy");
    await writeFile(lock.path, `${process.pid} successor`);
    await releaseLock(lock);
    expect(await readFile(lock.path, "utf8")).toContain("successor");
  });
});

describe("adapter source evidence", () => {
  it("refuses mismatched projects even when encoded directory names collide", async () => {
    const file = join(dir, "session.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "user", cwd: "/other/project", message: { content: "unrelated" } }) +
        "\n",
    );
    await expect(
      compileLocator(claudeAdapter, file, dir, dir, "calls", "/wanted/project"),
    ).rejects.toThrow("cross-project");
  });
  it("keeps Codex system roles and never invents success from tool-output prose", async () => {
    const file = join(dir, "rollout-test.jsonl");
    await writeFile(
      file,
      [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "system context" }],
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", output: "Process exited with code 1" },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", output: { success: false } },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const parsed = await codexAdapter.parse(file);
    expect(parsed!.events[0]!.role).toBe("system");
    expect(parsed!.events[1]!.status).toBeUndefined();
    expect(parsed!.events[2]!.status).toBe("error");
  });
  it("ignores JSON scalars in vendor transcripts", async () => {
    const file = join(dir, "session.jsonl");
    await writeFile(
      file,
      "null\n42\n[]\n" + JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n",
    );
    expect((await claudeAdapter.parse(file))!.events).toHaveLength(1);
  });
  it("reports scan errors through the caller's diagnostic callback", async () => {
    const errors: string[] = [];
    await mkdir(join(dir, ".claude/projects/-wanted"), { recursive: true });
    await writeFile(
      join(dir, ".claude/projects/-wanted/test.jsonl"),
      JSON.stringify({ type: "user", cwd: "/other", message: { content: "hello" } }) + "\n",
    );
    const result = await scanAndCompile({
      cwd: "/wanted",
      storeDir: dir,
      home: dir,
      env: { HOME: dir },
      agents: ["claude-code"],
      onError: (m) => errors.push(m),
    });
    expect(result).toHaveLength(0);
    expect(errors.join()).toContain("cross-project");
  });
});
