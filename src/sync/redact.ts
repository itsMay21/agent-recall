// Mechanical secret redaction. This is the whole "sanitize" step of the compile path — a single
// pass over every string field before it reaches the index or the raw sidecar. It is regex-only:
// no entropy heuristics that could blank whole messages, no LLM. See archive/COMPILE-SPEC.md §3.
//
// A match is replaced by a marker that preserves structure: «redacted:<label>». Assignment-shaped
// secrets keep the key name and redact only the value; credentialed URLs keep scheme/host and redact
// only the password.

const isMarker = (s: string) => /^«redacted:[a-z0-9-]+»$/.test(s);

const MARK = (label: string) => `«redacted:${label}»`;

interface TokenRule {
  label: string;
  re: RegExp; // must be global
}

// High-confidence token shapes (redact the whole match). Ordered most-specific first.
const TOKEN_RULES: TokenRule[] = [
  {
    label: "pem",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END[^-]+-----/g,
  },
  {
    label: "aws-akid",
    re: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
  },
  // A bare 40-char AWS secret is indistinguishable from base64/hashes, so we only redact one that
  // appears near the word "aws" (the spec pattern). Redacts the whole "aws …'SECRET'" span.
  {
    label: "aws-secret",
    re: /aws[\s\S]{0,40}?['"][0-9a-zA-Z/+]{40}['"]/gi,
  },
  { label: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { label: "github-fine", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { label: "github-token", re: /\bgh[osur]_[A-Za-z0-9]{36,}\b/g },
  { label: "openai-proj", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { label: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "openai", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "google-api", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "google-oauth", re: /\bya29\.[0-9A-Za-z_-]+/g },
  { label: "slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  {
    label: "slack-webhook",
    re: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Za-z]+\/B[0-9A-Za-z]+\/[0-9A-Za-z]+/g,
  },
  { label: "stripe", re: /\b[rs]k_live_[0-9a-zA-Z]{24,}\b/g },
  { label: "gitlab-pat", re: /\bglpat-[0-9A-Za-z_-]{20,}\b/g },
  { label: "xai", re: /\bxai-[A-Za-z0-9_-]{20,}\b/g },
  { label: "npm", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Assignment-shaped secrets: keep the key, redact the value. Two value forms: a quoted value may
// contain spaces up to its closing quote (F-1.1 — the old space-free class leaked multi-word quoted
// secrets); an unquoted value runs to the next whitespace/quote.
const ASSIGNMENT_RE =
  /\b(api[_-]?key|secret|token|password|passwd|pwd|auth|bearer|client[_-]?secret|private[_-]?key|access[_-]?key|db[_-]?pass|connection[_-]?string)\b['"]?(\s*[:=]\s*)(?:(['"])([^\r\n]{6,}?)\3|([^\s'"]{6,}))/gi;

// URLs carrying inline credentials: redact only the password segment.
const URL_CRED_RE =
  /\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp):\/\/[^\s:@/]+:)([^\s:@/]+)(@)/g;

export interface RedactResult {
  value: string;
  count: number;
}

/** Redact secrets in a single string. Returns the scrubbed value and how many spans were replaced. */
export function redactString(input: string): RedactResult {
  if (!input) return { value: input, count: 0 };
  let out = input;
  let count = 0;

  for (const rule of TOKEN_RULES) {
    out = out.replace(rule.re, () => {
      count++;
      return MARK(rule.label);
    });
  }

  out = out.replace(/\b(Bearer\s+)([^\s"']+)/gi, (match, prefix: string, token: string) => {
    if (isMarker(token)) return match;
    count++;
    return prefix + MARK("value");
  });

  out = out.replace(
    ASSIGNMENT_RE,
    (
      match,
      key: string,
      sep: string,
      quote: string | undefined,
      quoted: string | undefined,
      bare: string | undefined,
    ) => {
      if (isMarker(quoted ?? bare ?? "")) return match;
      count++;
      // group 3 (quote) present ⇒ quoted value: keep the quotes around the marker; else unquoted.
      return quote
        ? `${key}${sep}${quote}${MARK("value")}${quote}`
        : `${key}${sep}${MARK("value")}`;
    },
  );

  out = out.replace(URL_CRED_RE, (match, pre: string, pw: string, at: string) => {
    if (isMarker(pw)) return match;
    count++;
    return `${pre}${MARK("value")}${at}`;
  });

  return { value: out, count };
}

/** Recursively redact every string inside an arbitrary JSON-ish value. */
export function redactDeep<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactString(v);
      count += r.count;
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => {
          const safeKey = redactString(k);
          count += safeKey.count;
          const normalized = k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
          const sensitive =
            /(?:^|[_-])(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|auth|client[_-]?secret|private[_-]?key|access[_-]?key|connection[_-]?string)$/.test(
              normalized,
            );
          if (
            sensitive &&
            val !== null &&
            val !== undefined &&
            val !== "" &&
            !(typeof val === "string" && isMarker(val))
          ) {
            count++;
            return [safeKey.value, MARK("value")];
          }
          return [safeKey.value, walk(val)];
        }),
      );
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
