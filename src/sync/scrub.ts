// Post-redaction "sanitize on write" pass applied to every string that reaches the index or raw
// sidecar. Two jobs, both mechanical:
//
//  1. JSON safety — replace unpaired UTF-16 surrogates with U+FFFD so the produced line is valid
//     JSON for strict consumers (jq, Go, Rust). Node/CPython tolerate lone surrogates; jq does not,
//     and a single bad line poisons whole-file processing. Preview truncation is code-point aware so
//     it never splits a surrogate pair at the boundary.
//  2. Home-path scrub — rewrite the absolute home directory to "~" in human-visible strings so the
//     committable index doesn't ship the user's username / project layout. The `cwd` field is left
//     intact by the caller (it is the one field meant to carry the absolute path).

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace any unpaired surrogate with the Unicode replacement character. */
export function sanitizeJsonString(s: string): string {
  return s.replace(LONE_SURROGATE, "�");
}

/** Rewrite the absolute home directory to "~" everywhere it appears. No-op for an empty/short home. */
export function scrubHome(s: string, home: string): string {
  if (!home || home.length < 3) return s;
  return s.split(home).join("~");
}

/** Full per-string scrub: home paths then JSON-safety. Order is irrelevant (disjoint), home first. */
export function scrubString(s: string, home: string): string {
  return sanitizeJsonString(scrubHome(s, home));
}

/** Collapse whitespace, scrub, and truncate to `max` code points without splitting a surrogate pair. */
export function previewOf(s: string, home: string, max = 200): string {
  const scrubbed = scrubString(s, home).replace(/\s+/g, " ").trim();
  const points = Array.from(scrubbed); // iterates by code point, so pairs stay whole
  return points.length <= max ? scrubbed : points.slice(0, max).join("");
}

/** Recursively scrub every string inside an arbitrary JSON-ish value (for tool args/results). */
export function scrubDeep<T>(value: T, home: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v, home);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [scrubString(k, home), walk(val)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}
