// Reproducible synthetic evidence. No personal agent stores or model calls.
import { performance } from "node:perf_hooks";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { compileSession } from "../src/sync/compile.js";
import type { ParsedSession } from "../src/sync/types.js";
const work = await mkdtemp(join(tmpdir(), "ar-bench-"));
const count = 5000;
const ts = "2026-10-19T00:00:00.000Z";
const events: ParsedSession["events"] = Array.from({ length: count }, (_, seq) => ({
  role: seq % 2 === 0 ? "user" : "assistant",
  ts,
  text: `Auth investigation ${seq}: review retry policy and current tests. ${seq % 20 === 0 ? "TOKEN=synthetic-benchmark-value" : ""}`,
}));
const trials = [];
try {
  for (let i = 0; i < 3; i++) {
    const project = join(work, `trial-${i}`);
    const session: ParsedSession = {
      agent: "codex",
      session: "synthetic",
      cwd: "/example/project",
      events,
      sourceFiles: [],
    };
    const start = performance.now();
    const result = await compileSession(session, { projectDir: project, fallbackTs: ts });
    const compileMs = performance.now() - start;
    const repeat = performance.now();
    const again = await compileSession(session, { projectDir: project, fallbackTs: ts });
    const repeatMs = performance.now() - repeat;
    assert.equal(result.indexed, count);
    assert.equal(again.indexed, 0);
    assert.equal(again.added, 0);
    const file = join(project, ".agent-recall/index.jsonl");
    const text = await readFile(file, "utf8");
    assert(!text.includes("synthetic-benchmark-value"));
    assert.equal(text.trim().split("\n").length, count);
    const read = performance.now();
    const output = execFileSync(
      process.execPath,
      ["dist/cli.js", "read", "--cwd", project, "--grep", "auth", "--last", "20", "--json"],
      { encoding: "utf8" },
    );
    const readMs = performance.now() - read;
    assert.equal(output.trim().split("\n").length, 20);
    trials.push({
      compile_ms: +compileMs.toFixed(2),
      repeat_ms: +repeatMs.toFixed(2),
      filtered_cli_read_ms: +readMs.toFixed(2),
      index_bytes: (await stat(file)).size,
    });
  }
  const project = join(work, "hook");
  await mkdir(project);
  const native = join(work, "rollout.jsonl");
  await writeFile(
    native,
    [
      { type: "session_meta", payload: { id: "hook-demo", cwd: project } },
      ...events.slice(0, 100).map((ev) => ({
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "message",
          role: ev.role,
          content: [{ type: "input_text", text: ev.text }],
        },
      })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const hookStart = performance.now();
  const hook = execFileSync(
    process.execPath,
    ["dist/cli.js", "sync", "--from-hook", "--agent", "codex"],
    { input: JSON.stringify({ cwd: project, transcript_path: native }), encoding: "utf8" },
  );
  assert(hook.includes("indexed 100"));
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: platform(),
        arch: arch(),
        synthetic_events: count,
        trials,
        cold_cli_hook_100_events_ms: +(performance.now() - hookStart).toFixed(2),
        scope:
          "synthetic compiler + local CLI; no live host lifecycle or agent outcome measurement",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
