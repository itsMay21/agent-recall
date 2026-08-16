// Shared scan/compile logic used by both `sync --scan` and the `install` backfill. Locating and
// compiling every existing transcript for a project is exactly the backfill step: it loads the
// history that predates the hook, once, at setup. Future sessions are then handled incrementally by
// the session-close hooks. Because compile is idempotent, running this repeatedly is safe.

import { stat } from "node:fs/promises";
import type { Adapter, AgentId, SubagentMode } from "./types.js";
import { compileSession, type CompileResult } from "./compile.js";
import { ADAPTERS, adapterById } from "../adapters/registry.js";

async function fallbackTsFor(locator: string): Promise<string> {
  const filePart = locator.includes("::") ? locator.slice(0, locator.lastIndexOf("::")) : locator;
  try {
    const s = await stat(filePart);
    return new Date(s.mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Parse + compile one adapter locator (a file path, or a Hermes `<db>::<session>` handle). `subagents`
 * decides how a sub-agent stream is stored: "calls" → raw sidecar only (drill-down), "full" → indexed
 * as a linked session, "off" → skipped. Top-level sessions are always indexed.
 */
export async function compileLocator(
  adapter: Adapter,
  locator: string,
  storeDir: string,
  home: string,
  subagents: SubagentMode = "full",
): Promise<CompileResult | null> {
  const parsed = await adapter.parse(locator);
  if (!parsed) return null;
  const isSub = parsed.origin === "subagent";
  if (isSub && subagents === "off") return null;
  const fallbackTs = await fallbackTsFor(locator);
  return compileSession(parsed, {
    projectDir: storeDir,
    fallbackTs,
    home,
    rawOnly: isSub && subagents === "calls",
  });
}

export interface ScanOptions {
  /** project dir whose sessions we locate. */
  cwd: string;
  /** where the store is written (defaults to cwd for real use; differs only for tests). */
  storeDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** restrict to these adapters; empty/undefined = all. */
  agents?: AgentId[];
  /** sub-agent ingestion mode (default "calls"). */
  subagents?: SubagentMode;
  /** called with each non-fatal error so the caller can report it. */
  onError?: (msg: string) => void;
}

/** Locate and compile every known transcript for a project. Returns per-session results. */
export async function scanAndCompile(opts: ScanOptions): Promise<CompileResult[]> {
  const adapters = opts.agents?.length
    ? opts.agents.map((id) => adapterById(id)).filter((a): a is Adapter => Boolean(a))
    : ADAPTERS;
  const subagents: SubagentMode = opts.subagents ?? "calls";

  const results: CompileResult[] = [];
  for (const adapter of adapters) {
    let locators: string[] = [];
    try {
      locators = await adapter.locate({
        cwd: opts.cwd,
        home: opts.home,
        env: opts.env,
        subagents,
      });
    } catch (err) {
      opts.onError?.(`${adapter.id} locate failed: ${(err as Error).message}`);
      continue;
    }
    for (const loc of locators) {
      try {
        const r = await compileLocator(adapter, loc, opts.storeDir, opts.home, subagents);
        if (r) results.push(r);
      } catch (err) {
        opts.onError?.(`${adapter.id} parse failed for ${loc}: ${(err as Error).message}`);
      }
    }
  }
  return results;
}
