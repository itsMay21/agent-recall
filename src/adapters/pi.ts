// Pi coding-agent adapter. Official tree JSONL at
// ~/.pi/agent/sessions/--<dash-cwd>--/<ts>_<uuid>.jsonl. Cleanest schema of the set: typed
// session / message / toolCall / toolResult entries. `custom` entries are excluded from LLM
// context and we mark them accordingly (we still skip them from the conversational index).

import { basename, join } from "node:path";
import type { Adapter, LocateOptions, ParsedSession, RawEvent, Status } from "../sync/types.js";
import { home, readJsonl, listDir, asString, textFromContent } from "./util.js";

function piSessionsDir(env: NodeJS.ProcessEnv): string {
  if (env.PI_SESSIONS_DIR) return env.PI_SESSIONS_DIR;
  const base = env.PI_CODING_AGENT_DIR || join(home(env), ".pi", "agent");
  return join(base, "sessions");
}

/** Pi encodes a cwd as --<path-with-slashes-as-dashes>-- (leading slash dropped). */
function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
}

function pickPreview(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return asString(args);
  const o = args as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}

function assistantBlocks(content: unknown, ts?: string): RawEvent[] {
  if (typeof content === "string")
    return content.trim() ? [{ role: "assistant", text: content, ...(ts ? { ts } : {}) }] : [];
  if (!Array.isArray(content)) return [];
  const withTs = ts ? { ts } : {};
  const out: RawEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b["type"];
    if (type === "text" && typeof b["text"] === "string") {
      out.push({ role: "assistant", text: b["text"], ...withTs });
    } else if (type === "thinking") {
      const t = asString(b["text"]) ?? asString(b["thinking"]);
      if (t) out.push({ role: "thinking", text: t, ...withTs });
    } else if (type === "toolCall") {
      out.push({
        role: "tool",
        ...(typeof b["name"] === "string" ? { name: b["name"] } : {}),
        ...(pickPreview(b["arguments"]) ? { text: pickPreview(b["arguments"]) as string } : {}),
        args: b["arguments"],
        ...withTs,
      });
    }
  }
  return out;
}

export const piAdapter: Adapter = {
  id: "pi",

  matchPath(path: string): boolean {
    const p = path.replaceAll("\\", "/");
    return (
      p.endsWith(".jsonl") &&
      (p.includes("/.pi/agent/sessions/") || p.includes("/.omp/agent/sessions/"))
    );
  },

  async locate(opts: LocateOptions): Promise<string[]> {
    const dir = join(piSessionsDir(opts.env), encodeCwd(opts.cwd));
    const out: string[] = [];
    for (const name of await listDir(dir)) {
      if (name.endsWith(".jsonl")) out.push(join(dir, name));
    }
    return out;
  },

  async parse(file: string): Promise<ParsedSession | null> {
    const events: RawEvent[] = [];
    let cwd: string | undefined;
    let session: string | undefined;

    for await (const line of readJsonl(file)) {
      const type = line["type"];
      const ts = asString(line["timestamp"]);
      if (type === "session") {
        if (typeof line["cwd"] === "string") cwd = line["cwd"];
        if (typeof line["id"] === "string") session = line["id"];
      } else if (type === "message") {
        const message = line["message"] as Record<string, unknown> | undefined;
        if (!message) continue;
        const role = message["role"];
        if (role === "user") {
          const text = textFromContent(message["content"]);
          if (text) events.push({ role: "user", text, ...(ts ? { ts } : {}) });
        } else if (role === "assistant") {
          events.push(...assistantBlocks(message["content"], ts));
        } else if (role === "toolResult") {
          const status: Status = message["isError"] === true ? "error" : "ok";
          events.push({
            role: "tool",
            status,
            ...(typeof message["toolName"] === "string" ? { name: message["toolName"] } : {}),
            ...(textFromContent(message["content"])
              ? { text: textFromContent(message["content"]) as string }
              : {}),
            result: message["content"],
            ...(ts ? { ts } : {}),
          });
        }
      } else if (
        type === "model_change" ||
        type === "thinking_level_change" ||
        type === "compaction"
      ) {
        events.push({ role: "event", nativeType: type as string, ...(ts ? { ts } : {}) });
      }
      // `custom` and any unknown types are intentionally skipped from the conversational index.
    }

    if (events.length === 0) return null;
    return {
      agent: "pi",
      session: session ?? basename(file).replace(/\.jsonl$/, ""),
      ...(cwd ? { cwd } : {}),
      events,
      sourceFiles: [file],
    };
  },
};
