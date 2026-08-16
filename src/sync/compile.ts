// The orchestrator: ParsedSession -> redact -> strip attachments -> assign seq/ts -> write raw +
// index, idempotently. This is the "no LLM" heart of the tool. Every value written here is either
// copied from the native record or derived mechanically (seq, mtime fallback, sha256, truncation).

import { join } from "node:path";
import type { ParsedSession, IndexLine, RawEventLine, RawEvent } from "./types.js";
import { redactString, redactDeep } from "./redact.js";
import { toEnvelopes } from "./images.js";
import {
  storePaths,
  sessionRawDir,
  sanitizeSegment,
  countLines,
  ensureDir,
  appendJsonl,
  copySources,
} from "./store.js";

export interface CompileOptions {
  projectDir: string;
  /** ISO time used when a native record carries no timestamp (usually the source file's mtime). */
  fallbackTs: string;
}

export interface CompileResult {
  agent: string;
  session: string;
  added: number;
  skipped: number;
  redacted: number;
}

const PREVIEW_MAX = 200;

function makePreview(text: string | undefined): { preview?: string; redacted: number } {
  if (!text) return { redacted: 0 };
  const r = redactString(text);
  const oneLine = r.value.replace(/\s+/g, " ").trim();
  if (oneLine === "") return { redacted: r.count };
  return { preview: oneLine.slice(0, PREVIEW_MAX), redacted: r.count };
}

function buildLines(
  parsed: ParsedSession,
  ev: RawEvent,
  seq: number,
  fallbackTs: string,
  rawPointer: string,
): { index: IndexLine; raw: RawEventLine; redacted: number } {
  const tsGiven = ev.ts && ev.ts.length > 0;
  const ts = tsGiven ? (ev.ts as string) : fallbackTs;

  const { preview, redacted: previewRedacted } = makePreview(ev.text);
  const argsR = ev.args === undefined ? { value: undefined, count: 0 } : redactDeep(ev.args);
  const resultR = ev.result === undefined ? { value: undefined, count: 0 } : redactDeep(ev.result);
  const textR = ev.text === undefined ? { value: undefined, count: 0 } : redactString(ev.text);
  const redacted = previewRedacted + argsR.count + resultR.count;

  const index: IndexLine = {
    v: 1,
    ts,
    agent: parsed.agent,
    session: parsed.session,
    seq,
    role: ev.role,
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    ...(parsed.gitBranch ? { git_branch: parsed.gitBranch } : {}),
    ...(ev.name ? { name: ev.name } : {}),
    ...(ev.status ? { status: ev.status } : {}),
    ...(preview ? { preview } : {}),
    raw: rawPointer,
    ...(tsGiven ? {} : { ts_source: "mtime" as const }),
    ...(redacted > 0 ? { redacted } : {}),
  };

  const envelopes = toEnvelopes(ev.attachments);
  const raw: RawEventLine = {
    ...index,
    ...(textR.value !== undefined ? { text: textR.value } : {}),
    ...(argsR.value !== undefined ? { args: argsR.value } : {}),
    ...(resultR.value !== undefined ? { result: resultR.value } : {}),
    ...(envelopes ? { attachments: envelopes } : {}),
    ...(ev.nativeType ? { native_type: ev.nativeType } : {}),
  };

  return { index, raw, redacted };
}

/**
 * Compile one parsed session into the store. Idempotent: only events beyond the session's existing
 * high-water mark (raw events.jsonl line count) are appended.
 */
export async function compileSession(
  parsed: ParsedSession,
  opts: CompileOptions,
): Promise<CompileResult> {
  const paths = storePaths(opts.projectDir);
  const rawDir = sessionRawDir(paths, parsed.agent, parsed.session);
  const rawEventsFile = join(rawDir, "events.jsonl");

  const already = await countLines(rawEventsFile);
  const total = parsed.events.length;

  if (total <= already) {
    return { agent: parsed.agent, session: parsed.session, added: 0, skipped: total, redacted: 0 };
  }

  await ensureDir(paths.root);
  await copySources(rawDir, parsed.sourceFiles);

  const indexRows: IndexLine[] = [];
  const rawRows: RawEventLine[] = [];
  let redacted = 0;

  for (let seq = already; seq < total; seq++) {
    const ev = parsed.events[seq]!;
    const rawPointer = `raw/${parsed.agent}/${sanitizeSegment(parsed.session)}/events.jsonl#${seq}`;
    const built = buildLines(parsed, ev, seq, opts.fallbackTs, rawPointer);
    indexRows.push(built.index);
    rawRows.push(built.raw);
    redacted += built.redacted;
  }

  await appendJsonl(rawEventsFile, rawRows);
  await appendJsonl(paths.index, indexRows);

  return {
    agent: parsed.agent,
    session: parsed.session,
    added: indexRows.length,
    skipped: already,
    redacted,
  };
}
