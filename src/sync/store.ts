// Filesystem layout of .agent-recall/ and the low-level, append-only writers. Idempotency lives
// here: a session's events.jsonl line count is the high-water mark; re-running sync only appends
// events beyond it (native transcripts are append-only, so this is both safe and cheap).

import { createReadStream } from "node:fs";
import { mkdir, copyFile, appendFile, stat, open, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
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

/**
 * Keep session ids safe as a single path segment (they can contain slashes or colons). When
 * sanitization would change the id or truncate it, append a short hash of the original so two
 * distinct ids can't collide onto one raw dir and corrupt the high-water mark (F-2.2).
 */
export function sanitizeSegment(s: string): string {
  const safe = s.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safe === s && safe.length <= 200) return safe || "unknown";
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `${safe.slice(0, 180) || "session"}-${hash}`;
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

/** Count index rows already written for one session (used to reconcile a torn/partial write). */
export async function countSessionIndexRows(
  indexFile: string,
  agent: AgentId,
  session: string,
): Promise<number> {
  if (!(await exists(indexFile))) return 0;
  let n = 0;
  const rl = createInterface({ input: createReadStream(indexFile), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as { agent?: string; session?: string };
      if (o.agent === agent && o.session === session) n++;
    } catch {
      // ignore a torn/partial final line
    }
  }
  return n;
}

/** Read raw sidecar lines in [from, to) and parse them (used to regenerate missing index rows). */
export async function readRawRange(
  file: string,
  from: number,
  to: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  if (!(await exists(file))) return out;
  let i = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    if (i >= from && i < to) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // skip a torn line
      }
    }
    i++;
  }
  return out;
}

/**
 * Acquire an exclusive per-store lock so two overlapping syncs (a hook racing a manual scan, or two
 * agents closing in one project) cannot interleave appends. O_EXCL create; steals a lock older than
 * `staleMs`; bounded retry. Dependency-free.
 */
export async function acquireLock(root: string, staleMs = 60_000): Promise<string> {
  const lockPath = join(root, ".lock");
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(`${process.pid} ${Date.now()}`);
      await fh.close();
      return lockPath;
    } catch {
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock vanished between our create-attempt and stat — retry immediately
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error(`could not acquire store lock at ${lockPath}`);
}

export async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
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
