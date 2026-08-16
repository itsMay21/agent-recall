// Core contracts for the mechanical compile path. No behavior here — just the shapes every
// adapter and the compiler agree on. See docs/SCHEMA.md for the on-disk index format.

export const AGENT_IDS = ["claude-code", "codex", "cursor", "hermes", "pi"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type Role = "user" | "assistant" | "tool" | "thinking" | "system" | "event";
export type Status = "ok" | "error" | "rejected" | "superseded";

/** How sub-agent / sidechain transcripts are ingested. See docs/DECISIONS.md ADR-007. */
export type SubagentMode = "off" | "calls" | "full";

/** An attachment as an adapter hands it over: may still carry raw bytes we must hash and drop. */
export interface InputAttachment {
  kind: "image" | "binary";
  contentType?: string;
  /** base64 payload to be hashed then discarded (never stored inline). */
  base64?: string;
  /** if the adapter already knows size/hash without decoding, it may pass them. */
  bytes?: number;
  sha256?: string;
}

/** The stored, payload-free envelope for an attachment. */
export interface AttachmentEnvelope {
  kind: "image" | "binary";
  content_type?: string;
  bytes: number;
  sha256: string;
}

/** One native record after an adapter has normalized it — before redaction/hashing. */
export interface RawEvent {
  /** ISO-8601 UTC if the native record carried a time; otherwise omitted (compiler fills from mtime). */
  ts?: string;
  role: Role;
  /** tool name for role:"tool"; omit when the native store did not record a typed name. */
  name?: string;
  status?: Status;
  /** primary human-readable text (prompt line, assistant text, command string, tool stdout). */
  text?: string;
  /** typed tool arguments, kept verbatim for the raw sidecar only. */
  args?: unknown;
  /** typed tool result, kept for the raw sidecar only. */
  result?: unknown;
  attachments?: InputAttachment[];
  /** the original native `type`/marker, preserved for provenance (e.g. "compaction"). */
  nativeType?: string;
}

/** A whole transcript parsed by an adapter. */
export interface ParsedSession {
  agent: AgentId;
  session: string;
  cwd?: string;
  gitBranch?: string;
  events: RawEvent[];
  /** absolute path(s) of the native source file(s), copied verbatim into raw/. */
  sourceFiles: string[];
  /** present + "subagent" when this is a sub-agent / sidechain stream, not a top-level session. */
  origin?: "subagent";
  /** parent session id, only when the native store records a structural link (never inferred). */
  subagentOf?: string;
  /** native typed sub-agent kind (e.g. Codex source.subagent.other, Pi agent name). */
  subagentKind?: string;
}

export interface LocateOptions {
  /** project directory whose sessions we want. */
  cwd: string;
  /** home directory (overridable in tests). */
  home: string;
  /** environment (for CODEX_HOME, PI_SESSIONS_DIR, etc.). */
  env: NodeJS.ProcessEnv;
  /** whether to locate sub-agent transcripts; "off" excludes them from the returned locators. */
  subagents: SubagentMode;
}

/** The contract every per-agent adapter implements. */
export interface Adapter {
  id: AgentId;
  /** True if this adapter recognizes a transcript path handed in by a hook. `env` lets an adapter
   * honor a custom store dir (e.g. CLAUDE_CONFIG_DIR, HERMES_DIR). */
  matchPath(path: string, env?: NodeJS.ProcessEnv): boolean;
  /** Find transcript files for a cwd (used by `sync --scan`). Returns absolute paths. */
  locate(opts: LocateOptions): Promise<string[]>;
  /** Parse one transcript file. Returns null if the file is empty/unparseable (never throws for that). */
  parse(file: string): Promise<ParsedSession | null>;
}

/** A line in .agent-recall/index.jsonl (docs/SCHEMA.md). */
export interface IndexLine {
  v: 1;
  ts: string;
  agent: AgentId;
  session: string;
  seq: number;
  cwd?: string;
  git_branch?: string;
  role: Role;
  name?: string;
  status?: Status;
  preview?: string;
  raw?: string;
  ts_source?: "mtime";
  redacted?: number;
  /** "subagent" for a sub-agent stream (omitted for top-level sessions). */
  origin?: "subagent";
  /** parent session id when structurally linked. */
  subagent_of?: string;
  /** native typed sub-agent kind. */
  subagent_kind?: string;
}

/** A line in the raw sidecar events.jsonl — the index superset with full args/stdout. */
export interface RawEventLine extends IndexLine {
  text?: string;
  args?: unknown;
  result?: unknown;
  attachments?: AttachmentEnvelope[];
  native_type?: string;
}

/** Hook stdin payload shared (with minor differences) by Claude/Codex/Cursor. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
}
