// Filesystem layout of .agent-recall/ and the low-level, append-only writers. Idempotency lives
// here: a session's events.jsonl line count is the high-water mark; re-running sync only appends
// events beyond it (native transcripts are append-only, so this is both safe and cheap).

import { createReadStream } from "node:fs";
import { mkdir, copyFile, appendFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import type { AgentId } from "./types.js";

export interface StorePaths {
  root: string; // .agent-recall/
  index: string; // .agent-recall/index.jsonl
  rawDir: string; // .agent-recall/raw/
}

export function storePaths(projectDir: string): StorePaths {
  const root = join(projectDir, ".agent-recall");
  return { root, index: join(root, "index.jsonl"), rawDir: join(root, "raw") };
}

export function sessionRawDir(paths: StorePaths, agent: AgentId, session: string): string {
  return join(paths.rawDir, agent, sanitizeSegment(session));
}

/** Keep session ids safe as a single path segment (they can contain slashes or colons). */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200) || "unknown";
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Count lines already recorded for a session (its idempotency high-water mark). */
export async function countLines(file: string): Promise<number> {
  if (!(await exists(file))) return 0;
  let n = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() !== "") n++;
  }
  return n;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Append an array of objects as JSONL. No-op for an empty array. */
export async function appendJsonl(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(file, text, "utf8");
}

/** Copy the verbatim vendor source file(s) into raw/<agent>/<session>/. Best-effort. */
export async function copySources(destDir: string, sourceFiles: string[]): Promise<void> {
  await ensureDir(destDir);
  for (const src of sourceFiles) {
    if (await exists(src)) {
      await copyFile(src, join(destDir, "source-" + basename(src)));
    }
  }
}
