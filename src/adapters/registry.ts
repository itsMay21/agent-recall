import type { Adapter, AgentId } from "../sync/types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { hermesAdapter } from "./hermes.js";
import { piAdapter } from "./pi.js";

export const ADAPTERS: Adapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  hermesAdapter,
  piAdapter,
];

export function adapterById(id: AgentId): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

/** Pick the adapter that recognizes a transcript path handed in by a hook. */
export function adapterForPath(path: string, env?: NodeJS.ProcessEnv): Adapter | undefined {
  return ADAPTERS.find((a) => a.matchPath(path, env));
}
