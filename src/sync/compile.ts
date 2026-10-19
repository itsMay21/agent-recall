// The orchestrator: ParsedSession -> redact -> scrub -> strip attachments -> assign seq/ts -> write
// raw + index, idempotently and under a store lock. This is the "no LLM" heart of the tool. Every
// value written here is either copied from the native record or derived mechanically (seq, mtime
// fallback, sha256, redaction, home-path scrub, code-point truncation).

import { join } from "node:path";
import type { ParsedSession, IndexLine, RawEventLine, RawEvent } from "./types.js";
import { redactString, redactDeep } from "./redact.js";
import { previewOf, scrubString, scrubDeep } from "./scrub.js";
import { stripInlineAttachments, toEnvelopes } from "./images.js";
import {
  storePaths,
  sessionRawDir,
  sanitizeSegment,
  countLines,
  sessionIndexSequences,
  safeSessionId,
  prepareStore,
  recoverJsonl,
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
  rawOnly: boolean;
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
  const tsGiven = typeof ev.ts === "string" && Number.isFinite(Date.parse(ev.ts));
  const ts = tsGiven ? (ev.ts as string) : fallbackTs;

  // Redact secrets first, then scrub (home paths + JSON-safe surrogates). Count secret spans once,
  // over the full text/args/result — the preview is derived from the already-redacted text.
  const textR = ev.text === undefined ? { value: undefined, count: 0 } : redactString(ev.text);
  const argsR =
    ev.args === undefined
      ? { value: undefined, count: 0 }
      : redactDeep(stripInlineAttachments(ev.args));
  const resultR =
    ev.result === undefined
      ? { value: undefined, count: 0 }
      : redactDeep(stripInlineAttachments(ev.result));
  const redacted = textR.count + argsR.count + resultR.count;

  const preview = textR.value !== undefined ? previewOf(textR.value, home, PREVIEW_MAX) : "";
  const safeText = textR.value !== undefined ? scrubString(textR.value, home) : undefined;
  const safeArgs = argsR.value !== undefined ? scrubDeep(argsR.value, home) : undefined;
  const safeResult = resultR.value !== undefined ? scrubDeep(resultR.value, home) : undefined;

  const metadata = redactDeep({
    ts,
    session: safeSessionId(parsed.session, home),
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    subagentOf: parsed.subagentOf ? safeSessionId(parsed.subagentOf, home) : undefined,
    subagentKind: parsed.subagentKind,
    name: ev.name,
    nativeType: ev.nativeType,
  });
  const safe = scrubDeep(metadata.value, home);
  const identityRedactions =
    redactString(parsed.session).count +
    (parsed.subagentOf ? redactString(parsed.subagentOf).count : 0);
  const index: IndexLine = {
    v: 1,
    ts: safe.ts,
    agent: parsed.agent,
    session: safe.session,
    seq,
    role: ev.role,
    ...(metadata.value.cwd ? { cwd: scrubString(metadata.value.cwd, "") } : {}),
    ...(safe.gitBranch ? { git_branch: safe.gitBranch } : {}),
    ...(parsed.origin ? { origin: parsed.origin } : {}),
    ...(safe.subagentOf ? { subagent_of: safe.subagentOf } : {}),
    ...(safe.subagentKind ? { subagent_kind: safe.subagentKind } : {}),
    ...(safe.name ? { name: safe.name } : {}),
    ...(ev.status ? { status: ev.status } : {}),
    ...(preview ? { preview } : {}),
    raw: rawPointer,
    ...(tsGiven ? {} : { ts_source: "mtime" as const }),
    ...(redacted + metadata.count + identityRedactions > 0
      ? { redacted: redacted + metadata.count + identityRedactions }
      : {}),
  };

  const envelopes = scrubDeep(redactDeep(toEnvelopes(ev.attachments)).value, home);
  const raw: RawEventLine = {
    ...index,
    ...(safeText !== undefined ? { text: safeText } : {}),
    ...(safeArgs !== undefined ? { args: safeArgs } : {}),
    ...(safeResult !== undefined ? { result: safeResult } : {}),
    ...(envelopes ? { attachments: envelopes } : {}),
    ...(safe.nativeType ? { native_type: safe.nativeType } : {}),
  };

  return { index, raw, redacted: redacted + metadata.count + identityRedactions };
}

/** Compile under one store lock. Recover torn suffixes, and dedupe by persisted index identities
 * independently of raw files, which may be absent after cloning or deliberate local cleanup. */
export async function compileSession(
  parsed: ParsedSession,
  opts: CompileOptions,
): Promise<CompileResult> {
  const paths = storePaths(opts.projectDir);
  await prepareStore(paths);
  const lock = await acquireLock(paths.root);
  try {
    const rawDir = sessionRawDir(paths, parsed.agent, parsed.session, opts.home ?? "");
    await ensureDir(paths.rawDir);
    await ensureDir(join(paths.rawDir, parsed.agent));
    await ensureDir(rawDir);
    const rawEventsFile = join(rawDir, "events.jsonl");
    await recoverJsonl(rawEventsFile);
    await recoverJsonl(paths.index);
    const identity = safeSessionId(parsed.session, opts.home ?? "");
    const rawCount = await countLines(rawEventsFile, parsed.agent, identity);
    const rawOnly = opts.rawOnly === true;
    const indexedSeqs = await sessionIndexSequences(paths.index, parsed.agent, identity);
    const total = parsed.events.length;
    if (total < rawCount || [...indexedSeqs].some((seq) => seq >= total)) {
      throw new Error(
        "transcript shrank or session id was reused; rebuild this store from the original transcripts",
      );
    }
    const indexRows: IndexLine[] = [];
    const rawRows: RawEventLine[] = [];
    let redacted = 0;
    let reconciled = 0;
    let indexed = 0;
    for (let seq = 0; seq < total; seq++) {
      const needsRaw = seq >= rawCount;
      const needsIndex = !rawOnly && !indexedSeqs.has(seq);
      if (!needsRaw && !needsIndex) continue;
      const pointer = `raw/${parsed.agent}/${sanitizeSegment(identity)}/events.jsonl#${seq}`;
      const built = buildLines(
        parsed,
        parsed.events[seq]!,
        seq,
        opts.fallbackTs,
        opts.home ?? "",
        pointer,
      );
      if (needsRaw) rawRows.push(built.raw);
      if (needsIndex) {
        indexRows.push(built.index);
        if (seq < rawCount) reconciled++;
        else indexed++;
      }
      redacted += built.redacted;
    }
    if (rawRows.length) await copySources(rawDir, parsed.sourceFiles);
    await appendJsonl(rawEventsFile, rawRows);
    await appendJsonl(paths.index, indexRows);
    return {
      agent: parsed.agent,
      session: identity,
      added: rawRows.length,
      indexed,
      skipped: Math.min(total, rawCount),
      redacted,
      reconciled,
      rawOnly,
    };
  } finally {
    await releaseLock(lock);
  }
}
