// Assemble the self-contained Claude Code plugin: copy the built single-file CLI into plugin/bin/
// and the read-sessions skill into plugin/skills/, so `claude --plugin-dir ./plugin` works with no
// global install. Run via `npm run build:plugin`.

import { mkdir, copyFile, rm, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if ((await stat(s)).isDirectory()) await copyDir(s, d);
    else await copyFile(s, d);
  }
}

const binDir = join(root, "plugin", "bin");
await mkdir(binDir, { recursive: true });
await copyFile(join(root, "dist", "cli.js"), join(binDir, "cli.js"));

const skillsDir = join(root, "plugin", "skills");
await rm(skillsDir, { recursive: true, force: true });
await copyDir(join(root, "skill", "read-sessions"), join(skillsDir, "read-sessions"));

process.stdout.write("built plugin: plugin/bin/cli.js + plugin/skills/read-sessions\n");
