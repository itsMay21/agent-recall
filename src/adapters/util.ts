// Shared, dependency-free helpers for adapters: JSONL streaming, path encoding, mtime, fs probes.

import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

export function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Stream a JSONL file, yielding one parsed object per non-blank line. Malformed lines are skipped. */
export async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t === "") continue;
    try {
      yield JSON.parse(t) as Record<string, unknown>;
    } catch {
      // tolerate a bad line rather than aborting the whole transcript
    }
  }
}

/** Claude/Pi-style path encoding: non-alphanumeric characters become '-'. */
export function dashEncode(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** List directory entries (names only); empty array if the dir is missing. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Convert an epoch number (seconds or milliseconds) to an ISO string. */
export function epochToIso(n: number): string {
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

/** Coerce an unknown value to a trimmed string, or undefined. */
export function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Flatten an Anthropic/OpenAI-style content value (string | array of typed blocks) into plain text,
 * concatenating only the human-readable text blocks. Non-text blocks are ignored here (tool_use etc.
 * are handled by the adapter as their own events).
 */
export function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
      else if (typeof b["text"] === "string" && b["type"] === undefined) parts.push(b["text"]);
    } else if (typeof block === "string") {
      parts.push(block);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}
