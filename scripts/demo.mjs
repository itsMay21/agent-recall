import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "agent-recall-demo-"));
const project = join(work, "project");
const home = join(work, "home");
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
  NODE_NO_WARNINGS: "1",
};
const run = (args) =>
  execFileSync(process.execPath, [join(root, "dist/cli.js"), ...args], { env, encoding: "utf8" });
try {
  await mkdir(project, { recursive: true });
  const claude = join(
    home,
    ".claude/projects",
    project.replace(/[^A-Za-z0-9]/g, "-"),
    "claude-demo.jsonl",
  );
  const codex = join(home, ".codex/sessions/2026/10/19/rollout-demo.jsonl");
  for (const file of [claude, codex]) await mkdir(dirname(file), { recursive: true });
  await writeFile(
    claude,
    [
      {
        type: "user",
        cwd: project,
        timestamp: "2026-10-19T00:00:00Z",
        message: { content: "Investigate auth retries. TOKEN=synthetic-demo-value" },
      },
      {
        type: "assistant",
        timestamp: "2026-10-19T00:00:01Z",
        message: {
          content: [
            {
              type: "text",
              text: "The retry repeats a request after token expiry; check auth/refresh.ts before changing the policy.",
            },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  await writeFile(
    codex,
    [
      { type: "session_meta", payload: { id: "codex-demo", cwd: project } },
      {
        type: "response_item",
        timestamp: "2026-10-19T00:01:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Continue the auth retry investigation from the previous agent.",
            },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-10-19T00:01:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Read the prior evidence, then verify the current refresh implementation and tests.",
            },
          ],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  console.log("Synthetic Claude + Codex history (no personal stores read):");
  console.log(run(["sync", "--scan", "--cwd", project, "--agent", "claude-code", "codex"]).trim());
  const output = run(["read", "--cwd", project, "--grep", "auth", "--last", "10", "--json"]);
  assert(!output.includes("synthetic-demo-value"));
  console.log(output.trim());
  const again = run(["sync", "--scan", "--cwd", project, "--agent", "claude-code", "codex"]);
  assert(again.includes("indexed 0"));
  console.log(again.trim());
  const rows = (await readFile(join(project, ".agent-recall/index.jsonl"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(rows.length, 4);
  console.log(
    "Verified: 4 cross-agent rows, synthetic credential redacted, second sync adds zero. Temporary data removed.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
