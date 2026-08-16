// Codex CLI adapter. Rollout JSONL at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
// Grounded in a real rollout: the conversation lives in `response_item` lines (message / reasoning /
// function_call / function_call_output / custom_tool_call*). `event_msg` is the derived UI stream and
// duplicates that text, so we skip it to avoid double-counting. cwd is inside session_meta.payload.

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Adapter, LocateOptions, ParsedSession, RawEvent, Status } from "../sync/types.js";
import { home, readJsonl, asString } from "./util.js";

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(home(env), ".codex");
}

/** Extract plain text from a Codex content array (input_text / output_text / text blocks). */
function codexText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      const t = b["type"];
      if (
        (t === "text" || t === "input_text" || t === "output_text" || t === "summary_text") &&
        typeof b["text"] === "string"
      ) {
        parts.push(b["text"]);
      }
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

function pickPreview(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return asString(args);
  const o = args as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "path", "pattern", "query", "input"]) {
    if (typeof o[k] === "string") return o[k] as string;
    if (Array.isArray(o[k]))
      return (o[k] as unknown[]).filter((x) => typeof x === "string").join(" ");
  }
  return undefined;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function responseItemToEvent(payload: Record<string, unknown>, ts?: string): RawEvent | null {
  const withTs = ts ? { ts } : {};
  const type = payload["type"];
  switch (type) {
    case "message": {
      const role = payload["role"] === "assistant" ? "assistant" : "user";
      const text = codexText(payload["content"]);
      return text ? { role, text, ...withTs } : null;
    }
    case "reasoning": {
      const text = codexText(payload["summary"]) ?? codexText(payload["content"]);
      return text ? { role: "thinking", text, ...withTs } : null;
    }
    case "function_call":
    case "custom_tool_call": {
      const args = parseArgs(payload["arguments"] ?? payload["input"]);
      return {
        role: "tool",
        ...(typeof payload["name"] === "string" ? { name: payload["name"] } : {}),
        ...(pickPreview(args) ? { text: pickPreview(args) as string } : {}),
        args,
        ...withTs,
      };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const output = payload["output"];
      const text =
        typeof output === "string"
          ? output
          : codexText((output as Record<string, unknown>)?.["content"]);
      const isError =
        (output &&
          typeof output === "object" &&
          (output as Record<string, unknown>)["success"] === false) ||
        false;
      const status: Status = isError ? "error" : "ok";
      return { role: "tool", status, ...(text ? { text } : {}), result: output, ...withTs };
    }
    default:
      return null;
  }
}

async function* walkRollouts(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkRollouts(full);
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) yield full;
  }
}

async function firstLineCwd(file: string): Promise<{ cwd?: string; session?: string }> {
  for await (const line of readJsonl(file)) {
    if (line["type"] === "session_meta") {
      const payload = line["payload"] as Record<string, unknown> | undefined;
      return {
        ...(payload && typeof payload["cwd"] === "string" ? { cwd: payload["cwd"] } : {}),
        ...(payload && typeof (payload["id"] ?? payload["session_id"]) === "string"
          ? { session: (payload["id"] ?? payload["session_id"]) as string }
          : {}),
      };
    }
    return {};
  }
  return {};
}

export const codexAdapter: Adapter = {
  id: "codex",

  matchPath(path: string): boolean {
    const p = path.replaceAll("\\", "/");
    return p.endsWith(".jsonl") && p.includes("/sessions/") && p.includes("/rollout-");
  },

  async locate(opts: LocateOptions): Promise<string[]> {
    const dir = join(codexHome(opts.env), "sessions");
    const out: string[] = [];
    for await (const file of walkRollouts(dir)) {
      const meta = await firstLineCwd(file);
      if (meta.cwd === opts.cwd) out.push(file);
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
      const payload = line["payload"] as Record<string, unknown> | undefined;
      if (type === "session_meta" && payload) {
        if (typeof payload["cwd"] === "string") cwd = payload["cwd"];
        const id = payload["id"] ?? payload["session_id"];
        if (typeof id === "string") session = id;
      } else if (type === "response_item" && payload) {
        const ev = responseItemToEvent(payload, ts);
        if (ev) events.push(ev);
      } else if (type === "compacted") {
        events.push({ role: "event", nativeType: "compacted", ...(ts ? { ts } : {}) });
      }
    }

    if (events.length === 0) return null;
    return {
      agent: "codex",
      session: session ?? fileStem(file),
      ...(cwd ? { cwd } : {}),
      events,
      sourceFiles: [file],
    };
  },
};

function fileStem(file: string): string {
  const base = file.replaceAll("\\", "/").split("/").pop() ?? file;
  return base.replace(/\.jsonl$/, "");
}
