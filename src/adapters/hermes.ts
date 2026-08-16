// Hermes adapter. Unlike the JSONL agents, Hermes keeps its canonical transcript in a SQLite
// database (~/.hermes/state.db) across two tables: `sessions` (id, cwd, git_branch, started_at,
// end_reason, ...) and `messages` (session_id, role, content, tool_calls, tool_name, timestamp, id
// as order). We read it read-only via Node's built-in node:sqlite — no runtime dependency — and
// never copy the (multi-hundred-MB) db into raw/; the sanitized events.jsonl is the raw record.
//
// Adapter "file" handles are `<db-path>::<session-id>`; locate() enumerates them per cwd.

import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncCtor } from "node:sqlite";
import type { Adapter, LocateOptions, ParsedSession, RawEvent, Status } from "../sync/types.js";
import { home, exists, asString, epochToIso, textFromContent } from "./util.js";

// node:sqlite is a newer builtin the bundler doesn't recognize; load it at runtime via createRequire
// with a split specifier so esbuild can't statically rewrite/resolve it as an npm package.
const nodeRequire = createRequire(import.meta.url);
type SqliteModule = { DatabaseSync: typeof DatabaseSyncCtor };
let sqlite: SqliteModule | null | undefined;
function loadSqlite(): SqliteModule | null {
  if (sqlite !== undefined) return sqlite;
  try {
    sqlite = nodeRequire("node:" + "sqlite") as SqliteModule;
  } catch {
    sqlite = null;
  }
  return sqlite;
}

function stateDbPath(env: NodeJS.ProcessEnv): string {
  const base = env.HERMES_DIR || join(home(env), ".hermes");
  return join(base, "state.db");
}

const HANDLE_SEP = "::";

function openReadonly(dbPath: string): InstanceType<typeof DatabaseSyncCtor> | null {
  const mod = loadSqlite();
  if (!mod) return null;
  try {
    return new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

interface SessionRow {
  id: string;
  cwd: string | null;
  git_branch: string | null;
  started_at: number | null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  timestamp: number | null;
}

/** Hermes `content` may be plain text or a JSON blocks array; normalize to text. */
function contentToText(content: string | null): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const t = textFromContent(parsed);
      if (t) return t;
    } catch {
      // fall through to raw string
    }
  }
  return content;
}

function toolCallsToEvents(raw: string | null, ts?: string): RawEvent[] {
  if (!raw) return [];
  let calls: unknown;
  try {
    calls = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(calls)) return [];
  const withTs = ts ? { ts } : {};
  const out: RawEvent[] = [];
  for (const c of calls) {
    if (!c || typeof c !== "object") continue;
    const call = c as Record<string, unknown>;
    const fn = (call["function"] as Record<string, unknown>) ?? call;
    const name = asString(fn["name"]);
    const argsRaw = fn["arguments"] ?? call["arguments"];
    let args: unknown = argsRaw;
    if (typeof argsRaw === "string") {
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = argsRaw;
      }
    }
    out.push({ role: "tool", ...(name ? { name } : {}), args, ...withTs });
  }
  return out;
}

export const hermesAdapter: Adapter = {
  id: "hermes",

  matchPath(path: string): boolean {
    const p = path.replaceAll("\\", "/");
    return p.includes("/.hermes/") && p.includes("state.db");
  },

  async locate(opts: LocateOptions): Promise<string[]> {
    const dbPath = stateDbPath(opts.env);
    if (!(await exists(dbPath))) return [];
    const db = openReadonly(dbPath);
    if (!db) return [];
    try {
      const rows = db
        .prepare("SELECT id FROM sessions WHERE cwd = ? AND message_count > 0 ORDER BY started_at")
        .all(opts.cwd) as Array<{ id: string }>;
      return rows.map((r) => `${dbPath}${HANDLE_SEP}${r.id}`);
    } catch {
      return [];
    } finally {
      db.close();
    }
  },

  async parse(handle: string): Promise<ParsedSession | null> {
    const idx = handle.lastIndexOf(HANDLE_SEP);
    if (idx < 0) return null; // a bare state.db path from a hook carries no session id — use --scan
    const dbPath = handle.slice(0, idx);
    const sessionId = handle.slice(idx + HANDLE_SEP.length);

    const db = openReadonly(dbPath);
    if (!db) return null;
    try {
      const session = db
        .prepare("SELECT id, cwd, git_branch, started_at FROM sessions WHERE id = ?")
        .get(sessionId) as unknown as SessionRow | undefined;
      if (!session) return null;

      const rows = db
        .prepare(
          "SELECT id, role, content, tool_calls, tool_name, reasoning, reasoning_content, timestamp FROM messages WHERE session_id = ? ORDER BY id",
        )
        .all(sessionId) as unknown as MessageRow[];

      const events: RawEvent[] = [];
      for (const m of rows) {
        const ts = typeof m.timestamp === "number" ? epochToIso(m.timestamp) : undefined;
        const withTs = ts ? { ts } : {};
        const reasoning = m.reasoning ?? m.reasoning_content;
        if (reasoning && reasoning.trim())
          events.push({ role: "thinking", text: reasoning, ...withTs });

        if (m.role === "user") {
          const text = contentToText(m.content);
          if (text) events.push({ role: "user", text, ...withTs });
        } else if (m.role === "assistant") {
          const text = contentToText(m.content);
          if (text) events.push({ role: "assistant", text, ...withTs });
          events.push(...toolCallsToEvents(m.tool_calls, ts));
        } else if (m.role === "tool") {
          const status: Status = "ok";
          events.push({
            role: "tool",
            status,
            ...(m.tool_name ? { name: m.tool_name } : {}),
            ...(contentToText(m.content) ? { text: contentToText(m.content) as string } : {}),
            result: m.content,
            ...withTs,
          });
        }
      }

      if (events.length === 0) return null;
      return {
        agent: "hermes",
        session: session.id,
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(session.git_branch ? { gitBranch: session.git_branch } : {}),
        events,
        sourceFiles: [], // never copy the shared multi-hundred-MB state.db
      };
    } catch {
      return null;
    } finally {
      db.close();
    }
  },
};
