// Cursor adapter (lossy path). Cursor keeps three unsynced stores; the only cheap, safe one is the
// write-only `agent-transcripts` JSONL under ~/.cursor/projects/<slug>/agent-transcripts/. It is
// text-only (user/assistant), with no per-line id/timestamp and no typed tool calls — the real graph
// lives in a private store.db we deliberately do not touch. So this adapter records the conversation
// text plus a pointer, and never invents tool arguments. Session id = filename stem; ts = file mtime.
//
// NOTE: untested against a live Cursor install on the build machine (no ~/.cursor present). Schema is
// from official/community reports; see docs/CONSUMPTION.md and docs/COMPILE-SPEC.md.

import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Adapter, LocateOptions, ParsedSession, RawEvent } from "../sync/types.js";
import { home, readJsonl, textFromContent } from "./util.js";

function cursorProjectsDir(env: NodeJS.ProcessEnv): string {
  const base = env.CURSOR_CONFIG_DIR || join(home(env), ".cursor");
  return join(base, "projects");
}

/** Cursor slugs a path as Users-foo-Project (leading slash dropped, non-alnum → '-'). */
function slugForCwd(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/[^A-Za-z0-9]/g, "-");
}

async function transcriptsUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    else if (e.isDirectory()) {
      // transcripts can be nested one level: <uuid>/<uuid>.jsonl
      for (const inner of await readdir(full).catch(() => [])) {
        if (inner.endsWith(".jsonl")) out.push(join(full, inner));
      }
    }
  }
  return out;
}

export const cursorAdapter: Adapter = {
  id: "cursor",

  matchPath(path: string): boolean {
    const p = path.replaceAll("\\", "/");
    return p.endsWith(".jsonl") && p.includes("/agent-transcripts/");
  },

  async locate(opts: LocateOptions): Promise<string[]> {
    const projects = cursorProjectsDir(opts.env);
    const slug = slugForCwd(opts.cwd);
    const out: string[] = [];
    let entries: Dirent[];
    try {
      entries = await readdir(projects, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Match the slugified project directory to this cwd. Timestamp-named dirs can't be matched to a
      // cwd from disk alone, so we only claim slugs that correspond to the path.
      if (e.name === slug || e.name.endsWith(slug)) {
        out.push(...(await transcriptsUnder(join(projects, e.name, "agent-transcripts"))));
      }
    }
    return out;
  },

  async parse(file: string): Promise<ParsedSession | null> {
    const events: RawEvent[] = [];
    for await (const line of readJsonl(file)) {
      const role = line["role"];
      if (role !== "user" && role !== "assistant") continue;
      const message = line["message"] as Record<string, unknown> | undefined;
      const text = textFromContent(message?.["content"]) ?? textFromContent(line["content"]);
      if (text) events.push({ role, text });
    }
    if (events.length === 0) return null;
    return {
      agent: "cursor",
      session: basename(file).replace(/\.jsonl$/, ""),
      events,
      sourceFiles: [file],
    };
  },
};
