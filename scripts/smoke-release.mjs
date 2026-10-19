// Exercise the distribution, not source imports. Uses only synthetic transcripts in a temp HOME.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "agent-recall-package-"));
const project = join(work, "project");
const home = join(work, "home");
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, ".codex"),
  HERMES_DIR: join(home, ".hermes"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  npm_config_offline: "true",
  npm_config_cache: join(work, "cache"),
  NODE_NO_WARNINGS: "1",
};
const exec = (cmd, args, cwd = project, extra = {}) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...extra,
  });
try {
  await mkdir(project);
  await mkdir(home);
  const packed = JSON.parse(
    exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], root),
  )[0];
  const names = packed.files.map((file) => file.path);
  for (const required of [
    "dist/cli.js",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "skill/read-sessions/SKILL.md",
    "plugin/package.json",
  ])
    assert(names.includes(required), `missing ${required}`);
  assert(!names.some((name) => /(?:^|\/)(?:\.env|node_modules|raw|archive)(?:\/|$)/.test(name)));
  await writeFile(join(project, "package.json"), '{"private":true}');
  exec("npm", [
    "install",
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--save-dev",
    join(work, packed.filename),
  ]);
  const pkg = JSON.parse(
    await readFile(join(project, "node_modules/@itsmay21/agent-recall/package.json"), "utf8"),
  );
  assert.equal(pkg.repository.url, "https://github.com/itsMay21/agent-recall.git");
  const cli = join(project, "node_modules/@itsmay21/agent-recall/dist/cli.js");
  assert.equal(exec(process.execPath, [cli, "--version"]).trim(), pkg.version);
  const installOutput = exec(process.execPath, [
    cli,
    "install",
    "--agent",
    "claude-code",
    "codex",
    "cursor",
    "--no-backfill",
  ]);
  assert(!installOutput.includes("npm i -D agent-recall"));
  assert(!installOutput.includes("npx --no-install agent-recall"));
  assert(installOutput.includes("@itsmay21/agent-recall"));
  const hook = JSON.parse(await readFile(join(project, ".claude/settings.json"), "utf8")).hooks
    .SessionEnd[0].hooks[0];
  assert.equal(hook.timeout, 15);
  assert(hook.command.includes("--package=@itsmay21/agent-recall"));
  const native = join(home, ".claude/projects/example/session.jsonl");
  await mkdir(dirname(native), { recursive: true });
  const token = "ghp_" + "X".repeat(36);
  await writeFile(
    native,
    JSON.stringify({
      type: "user",
      cwd: project,
      message: { content: `Review auth. token=${token}` },
    }) + "\n",
  );
  const payload = JSON.stringify({ cwd: project, transcript_path: native, session_id: "session" });
  const run = spawnSync(hook.command, {
    shell: true,
    cwd: project,
    env,
    input: payload,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert(run.stdout.includes("indexed 1"), run.stdout + run.stderr);
  const output = exec(process.execPath, [cli, "read", "--json"]);
  assert.equal(JSON.parse(output).role, "user");
  assert(!output.includes(token));
  const again = spawnSync(hook.command, {
    shell: true,
    cwd: project,
    env,
    input: payload,
    encoding: "utf8",
  });
  assert(again.stdout.includes("indexed 0"));
  // The plugin must also run outside the source repository and outside any ESM parent package.
  const isolated = join(work, "standalone-plugin");
  await cp(join(root, "plugin"), isolated, { recursive: true });
  const pluginRun = exec(
    process.execPath,
    [join(isolated, "bin/cli.js"), "sync", "--from-hook", "--agent", "claude-code"],
    project,
    { input: payload },
  );
  assert(pluginRun.includes("indexed 0"));
  exec("git", ["init", "-q"]);
  const ignored = exec("git", [
    "check-ignore",
    ".agent-recall/raw/claude-code/session/events.jsonl",
  ]);
  assert(ignored.includes("raw/"));
  console.log(
    JSON.stringify({
      package: packed.id,
      files: packed.entryCount,
      bytes: packed.size,
      offlineHook: true,
      isolatedPlugin: true,
      idempotent: true,
      redaction: true,
      rawIgnored: true,
    }),
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
