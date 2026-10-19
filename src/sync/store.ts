// Local store primitives. Callers hold the store lock while recovering and appending JSONL.
import { constants } from "node:fs";
import { mkdir, stat, lstat, open, rm, readFile, rename, chmod } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AgentId } from "./types.js";
import { scrubString } from "./scrub.js";
import { redactString } from "./redact.js";

export interface StorePaths {
  root: string;
  index: string;
  rawDir: string;
}
export function storePaths(projectDir: string): StorePaths {
  const root = join(projectDir, ".agent-recall");
  return { root, index: join(root, "index.jsonl"), rawDir: join(root, "raw") };
}
export function sessionRawDir(
  paths: StorePaths,
  agent: AgentId,
  session: string,
  home = "",
): string {
  return join(paths.rawDir, agent, sanitizeSegment(safeSessionId(session, home)));
}

/** Sensitive identifiers become opaque, collision-resistant keys, including in raw pointers. */
export function safeSessionId(session: string, home = ""): string {
  return redactString(session).count > 0 ||
    scrubString(session, home) !== session ||
    session.startsWith("redacted-session-")
    ? `redacted-session-${createHash("sha256").update(Buffer.from(session, "utf16le")).digest("hex")}`
    : session;
}
export function sanitizeSegment(s: string): string {
  const safe = s.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safe === s && safe.length > 0 && safe.length <= 200 && safe !== "." && safe !== "..")
    return safe;
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 16);
  return `${safe.slice(0, 180) || "session"}-${hash}`;
}
function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Refuse symlinked store directories; raw data is private even under a permissive umask. */
export async function ensureDir(dir: string): Promise<void> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`store directory is not a real directory: ${dir}`);
  } catch (err) {
    if (!missing(err)) throw err;
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await chmod(dir, 0o700);
}
export async function prepareStore(paths: StorePaths): Promise<void> {
  await ensureDir(paths.root);
  // A store-local rule also protects direct sync and plugin users who never run install.
  const ignorePath = join(paths.root, ".gitignore");
  let current = "";
  try {
    const fh = await open(ignorePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      current = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (!missing(err)) throw err;
  }
  if (!current.endsWith("raw/\n.lock\n")) {
    const temp = join(paths.root, `.ignore-${randomUUID()}`);
    const fh = await open(temp, "wx", 0o600);
    try {
      await fh.writeFile(
        current + (current && !current.endsWith("\n") ? "\n" : "") + ".ignore-*\nraw/\n.lock\n",
      );
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(temp, ignorePath);
  }
  await ensureDir(paths.rawDir);
}

/** Repair only an interrupted final append. Complete malformed records fail visibly. */
export async function recoverJsonl(file: string): Promise<void> {
  let fh;
  try {
    fh = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  try {
    await fh.chmod(0o600);
    let pending = Buffer.alloc(0);
    let goodEnd = 0;
    for await (const chunk of fh.createReadStream({ autoClose: false })) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end).toString("utf8").trim();
        if (line) {
          let row: unknown;
          try {
            row = JSON.parse(line);
          } catch {
            throw new Error(
              `corrupt complete JSONL record at byte ${goodEnd} in ${file}; restore a backup before syncing`,
            );
          }
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw new Error(`invalid JSONL object in ${file}`);
        }
        goodEnd += end + 1;
        pending = pending.subarray(end + 1);
      }
    }
    if (pending.length > 0) {
      let valid = false;
      try {
        const row: unknown = JSON.parse(pending.toString("utf8"));
        valid = !!row && typeof row === "object" && !Array.isArray(row);
      } catch {
        /* Only an invalid interrupted suffix is discarded. */
      }
      if (valid) await fh.write(Buffer.from("\n"), 0, 1, goodEnd + pending.length);
      else await fh.truncate(goodEnd);
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
}

async function* rows(file: string): AsyncGenerator<Record<string, unknown>> {
  try {
    await lstat(file);
  } catch (err) {
    if (missing(err)) return;
    throw err;
  }
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const input = fh.createReadStream();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
  }
}
export async function countLines(file: string, agent: AgentId, session: string): Promise<number> {
  let count = 0;
  for await (const row of rows(file)) {
    if (
      row["v"] !== 1 ||
      row["agent"] !== agent ||
      row["session"] !== session ||
      row["seq"] !== count
    ) {
      throw new Error(`invalid raw session identity or ordinal in ${file}; rebuild the store`);
    }
    count++;
  }
  return count;
}
/** Validate identity ordinals rather than trusting counts that can conceal duplicate rows. */
export async function sessionIndexSequences(
  indexFile: string,
  agent: AgentId,
  session: string,
): Promise<Set<number>> {
  const seqs = new Set<number>();
  for await (const row of rows(indexFile)) {
    if (row["agent"] !== agent || row["session"] !== session) continue;
    const seq = row["seq"];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seqs.has(seq))
      throw new Error(`duplicate or invalid session sequence in ${indexFile}; rebuild the store`);
    seqs.add(seq);
  }
  return seqs;
}
export interface StoreLock {
  path: string;
  token: string;
}
function ownerAlive(text: string): boolean {
  const pid = Number(text.split(" ")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function acquireLock(root: string, staleMs = 60_000): Promise<StoreLock> {
  const path = join(root, ".lock");
  const token = `${process.pid} ${randomUUID()}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const fh = await open(path, "wx", 0o600);
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return { path, token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const info = await lstat(path).catch((err: unknown) => {
        if (missing(err)) return null;
        throw err;
      });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid store lock: ${path}`);
      const owner = await readFile(path, "utf8").catch((err: unknown) => {
        if (missing(err)) return "";
        throw err;
      });
      if (Date.now() - info.mtimeMs > staleMs && !ownerAlive(owner)) {
        throw new Error(
          `stale store lock at ${path}; ensure all sync processes have stopped, remove that lock file, then retry`,
        );
      }
      await sleep(25);
    }
  }
  throw new Error(`store is busy at ${path}; retry sync after the active writer finishes`);
}
export async function releaseLock(lock: StoreLock): Promise<void> {
  if ((await readFile(lock.path, "utf8").catch(() => "")) === lock.token)
    await rm(lock.path, { force: true });
}
export async function appendJsonl(file: string, records: unknown[]): Promise<void> {
  if (!records.length) return;
  const fh = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fh.chmod(0o600);
    await fh.writeFile(records.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}
/** Atomic replacement avoids following a pre-existing destination symlink. */
export async function copySources(destDir: string, sourceFiles: string[]): Promise<void> {
  for (const src of sourceFiles) {
    const dest = join(destDir, "source-" + basename(src));
    const temp = join(dirname(dest), `.copy-${randomUUID()}`);
    const fh = await open(temp, "wx", 0o600);
    try {
      await fh.writeFile(await readFile(src));
    } finally {
      await fh.close();
    }
    await rename(temp, dest);
  }
}
