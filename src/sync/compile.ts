// The orchestrator: ParsedSession -> redact -> scrub -> strip attachments -> assign seq/ts -> write
// raw + index, idempotently and under a store lock. This is the "no LLM" heart of the tool. Every
// value written here is either copied from the native record or derived mechanically (seq, mtime
// fallback, sha256, redaction, home-path scrub, code-point truncation).

import { join } from "node:path";
import type { ParsedSession, IndexLine, RawEventLine, RawEvent } from "./types.js";
import { redactString, redactDeep } from "./redact.js";
import { previewOf, scrubString, scrubDeep } from "./scrub.js";
import { toEnvelopes } from "./images.js";
import {
  storePaths,
  sessionRawDir,
  sanitizeSegment,
  countLines,
  countSessionIndexRows,
  readRawRange,
  ensureDir,
  appendJsonl,
  copySources,
  acquireLock,
  releaseLock,
} from "./store.js";

export interface CompileOptions {
  projectDir: string;
  /** ISO time used when a native record carries no timestamp (usually the source file's mtime). */
  fallbackTs: string;
  /** Absolute home dir; its occurrences are rewritten to "~" in human-visible strings. Default "". */
  home?: string;
  /** when true, write only the raw sidecar (drill-down), not the committable index. Used for
   * sub-agent streams in "calls" mode — the parent's spawn call+output are already in the index. */
  rawOnly?: boolean;
}

export interface CompileResult {
  agent: string;
  session: string;
  /** events written this run (to raw; equals `indexed` unless rawOnly). */
  added: number;
  /** events written to the committable index this run (0 in rawOnly mode). */
  indexed: number;
  skipped: number;
  redacted: number;
  /** index rows regenerated from raw because a previous run was torn between the two appends. */
  reconciled: number;
}

const PREVIEW_MAX = 200;

function buildLines(
  parsed: ParsedSession,
  ev: RawEvent,
  seq: number,
  fallbackTs: string,
  home: string,
  rawPointer: string,
): { index: IndexLine; raw: RawEventLine; redacted: number } {
  const tsGiven = ev.ts && ev.ts.length > 0;
  const ts = tsGiven ? (ev.ts as string) : fallbackTs;

  // Redact secrets first, then scrub (home paths + JSON-safe surrogates). Count secret spans once,
  // over the full text/args/result — the preview is derived from the already-redacted text.
  const textR = ev.text === undefined ? { value: undefined, count: 0 } : redactString(ev.text);
  const argsR = ev.args === undefined ? { value: undefined, count: 0 } : redactDeep(ev.args);
  const resultR = ev.result === undefined ? { value: undefined, count: 0 } : redactDeep(ev.result);
  const redacted = textR.count + argsR.count + resultR.count;

  const preview = textR.value !== undefined ? previewOf(textR.value, home, PREVIEW_MAX) : "";
  const safeText = textR.value !== undefined ? scrubString(textR.value, home) : undefined;
  const safeArgs = argsR.value !== undefined ? scrubDeep(argsR.value, home) : undefined;
  const safeResult = resultR.value !== undefined ? scrubDeep(resultR.value, home) : undefined;

  const index: IndexLine = {
    v: 1,
    ts,
    agent: parsed.agent,
    session: parsed.session,
    seq,
    role: ev.role,
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    ...(parsed.gitBranch ? { git_branch: parsed.gitBranch } : {}),
    ...(parsed.origin ? { origin: parsed.origin } : {}),
    ...(parsed.subagentOf ? { subagent_of: parsed.subagentOf } : {}),
    ...(parsed.subagentKind ? { subagent_kind: parsed.subagentKind } : {}),
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
    ...(safeText !== undefined ? { text: safeText } : {}),
    ...(safeArgs !== undefined ? { args: safeArgs } : {}),
    ...(safeResult !== undefined ? { result: safeResult } : {}),
    ...(envelopes ? { attachments: envelopes } : {}),
    ...(ev.nativeType ? { native_type: ev.nativeType } : {}),
  };

  return { index, raw, redacted };
}

/** A raw sidecar line is the index line plus extra fields; strip them to recover the index row. */
function rawToIndex(row: Record<string, unknown>): Record<string, unknown> {
  const { text, args, result, attachments, native_type, ...index } = row;
  void text;
  void args;
  void result;
  void attachments;
  void native_type;
  return index;
}

/**
 * Compile one parsed session into the store, under an exclusive lock. Idempotent: only events beyond
 * the raw high-water mark are appended. If a previous run was killed between the raw append and the
 * index append (F-1.5), the missing index rows are first regenerated mechanically from the raw
 * sidecar so no row is lost.
 */
export async function compileSession(
  parsed: ParsedSession,
  opts: CompileOptions,
): Promise<CompileResult> {
  const paths = storePaths(opts.projectDir);
  const rawDir = sessionRawDir(paths, parsed.agent, parsed.session);
  const rawEventsFile = join(rawDir, "events.jsonl");

  await ensureDir(paths.root);
  const lock = await acquireLock(paths.root);
  try {
    const rawCount = await countLines(rawEventsFile);
    const rawOnly = opts.rawOnly === true;

    // Reconcile a torn previous write: raw has more rows than the index for this session. Skipped in
    // rawOnly mode (there are, by design, no index rows for this session to reconcile).
    let reconciled = 0;
    if (!rawOnly) {
      const idxCount = await countSessionIndexRows(paths.index, parsed.agent, parsed.session);
      if (idxCount < rawCount) {
        const missing = await readRawRange(rawEventsFile, idxCount, rawCount);
        await appendJsonl(paths.index, missing.map(rawToIndex));
        reconciled = missing.length;
      }
    }

    const total = parsed.events.length;
    if (total <= rawCount) {
      return {
        agent: parsed.agent,
        session: parsed.session,
        added: 0,
        indexed: 0,
        skipped: total,
        redacted: 0,
        reconciled,
      };
    }

    await copySources(rawDir, parsed.sourceFiles);

    const indexRows: IndexLine[] = [];
    const rawRows: RawEventLine[] = [];
    let redacted = 0;
    for (let seq = rawCount; seq < total; seq++) {
      const ev = parsed.events[seq]!;
      const rawPointer = `raw/${parsed.agent}/${sanitizeSegment(parsed.session)}/events.jsonl#${seq}`;
      const built = buildLines(parsed, ev, seq, opts.fallbackTs, opts.home ?? "", rawPointer);
      indexRows.push(built.index);
      rawRows.push(built.raw);
      redacted += built.redacted;
    }

    // Raw first (superset, so a tear is recoverable via reconcile), then index (unless rawOnly).
    await appendJsonl(rawEventsFile, rawRows);
    if (!rawOnly) await appendJsonl(paths.index, indexRows);

    return {
      agent: parsed.agent,
      session: parsed.session,
      added: rawRows.length,
      indexed: rawOnly ? 0 : indexRows.length,
      skipped: rawCount,
      redacted,
      reconciled,
    };
  } finally {
    await releaseLock(lock);
  }
}
