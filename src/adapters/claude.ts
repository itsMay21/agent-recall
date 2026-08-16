// Claude Code adapter. Native JSONL at ~/.claude/projects/<dash-cwd>/<session>.jsonl (and a flat
// ~/.claude/transcripts/ses_*.jsonl on some builds). The line schema is officially "internal and
// changes between versions", so we copy only the stable, observed shapes and skip UI/metadata lines.

import { basename, join } from "node:path";
import type { Adapter, LocateOptions, ParsedSession, RawEvent, Status } from "../sync/types.js";
import { home, exists, readJsonl, dashEncode, listDir, asString, textFromContent } from "./util.js";

const SKIP_TYPES = new Set([
  "summary",
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "queue-operation",
  "attachment",
  "file-history-snapshot",
]);

function claudeRoot(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");
}

/** Choose a representative string from tool input for a mechanical preview (no summarization). */
function pickToolPreview(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return asString(input);
  const o = input as Record<string, unknown>;
  for (const k of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
  ]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}

function blocksToEvents(
  role: "user" | "assistant" | "system",
  content: unknown,
  ts?: string,
): RawEvent[] {
  if (typeof content === "string") {
    return content.trim() ? [{ role, text: content, ...(ts ? { ts } : {}) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: RawEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b["type"];
    const withTs = ts ? { ts } : {};
    if (type === "text" && typeof b["text"] === "string") {
      out.push({ role, text: b["text"], ...withTs });
    } else if (type === "thinking") {
      const t = asString(b["thinking"]) ?? asString(b["text"]);
      if (t) out.push({ role: "thinking", text: t, ...withTs });
    } else if (type === "tool_use") {
      out.push({
        role: "tool",
        ...(typeof b["name"] === "string" ? { name: b["name"] } : {}),
        ...(pickToolPreview(b["input"]) ? { text: pickToolPreview(b["input"]) as string } : {}),
        args: b["input"],
        ...withTs,
      });
    } else if (type === "tool_result") {
      const status: Status = b["is_error"] === true ? "error" : "ok";
      out.push({
        role: "tool",
        status,
        ...(textFromContent(b["content"]) ? { text: textFromContent(b["content"]) as string } : {}),
        result: b["content"],
        ...withTs,
      });
    } else if (type === "image") {
      const source = b["source"] as Record<string, unknown> | undefined;
      const data =
        source && typeof source["data"] === "string" ? (source["data"] as string) : undefined;
      const mediaType =
        source && typeof source["media_type"] === "string"
          ? (source["media_type"] as string)
          : undefined;
      out.push({
        role,
        attachments: [
          {
            kind: "image",
            ...(mediaType ? { contentType: mediaType } : {}),
            ...(data ? { base64: data } : {}),
          },
        ],
        ...withTs,
      });
    }
  }
  return out;
}

export const claudeAdapter: Adapter = {
  id: "claude-code",

  matchPath(path: string): boolean {
    const p = path.replaceAll("\\", "/");
    return (
      p.endsWith(".jsonl") &&
      (p.includes("/.claude/projects/") || p.includes("/.claude/transcripts/"))
    );
  },

  async locate(opts: LocateOptions): Promise<string[]> {
    const root = claudeRoot(opts.env);
    const dir = join(root, "projects", dashEncode(opts.cwd));
    const out: string[] = [];
    for (const name of await listDir(dir)) {
      if (name.endsWith(".jsonl")) out.push(join(dir, name));
    }
    return out;
  },

  async parse(file: string): Promise<ParsedSession | null> {
    const events: RawEvent[] = [];
    let cwd: string | undefined;
    let gitBranch: string | undefined;

    for await (const line of readJsonl(file)) {
      const type = line["type"];
      if (typeof type !== "string" || SKIP_TYPES.has(type)) continue;
      if (!cwd && typeof line["cwd"] === "string") cwd = line["cwd"];
      if (!gitBranch && typeof line["gitBranch"] === "string") gitBranch = line["gitBranch"];

      const ts = asString(line["timestamp"]);
      const message = line["message"] as Record<string, unknown> | undefined;
      if (type === "user" || type === "assistant") {
        if (message) events.push(...blocksToEvents(type, message["content"], ts));
      } else if (type === "system") {
        const text =
          asString(line["content"]) ?? (message ? textFromContent(message["content"]) : undefined);
        if (text) events.push({ role: "system", text, ...(ts ? { ts } : {}) });
      }
    }

    if (events.length === 0) return null;
    const session = basename(file).replace(/\.jsonl$/, "");
    return {
      agent: "claude-code",
      session,
      ...(cwd ? { cwd } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      events,
      sourceFiles: [file],
    };
  },
};
