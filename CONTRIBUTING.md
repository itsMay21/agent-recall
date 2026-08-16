# Contributing to agent-recall

Thanks for helping. This project has a strict charter — read
[`docs/CHARTER.md`](docs/CHARTER.md) first. The one rule that cannot bend: **no LLM / network / exec
in the compile path.** `sync` parses, redacts, and indexes; it never summarizes or infers.

## The gate

Every change must pass before it's merged:

```bash
npm install
npm run check      # prettier + tsc --noEmit + vitest + tsup build
npm run build:plugin
```

CI (`.github/workflows/ci.yml`) runs the same on Node 20 and 22.

## Adding or changing an adapter

Adapters live in `src/adapters/<agent>.ts` and implement the `Adapter` contract
(`src/sync/types.ts`). An adapter is **not "done"** until:

1. It ships a fixture under `test/fixtures/` (redacted) **and** a parse/locate test in
   `test/adapters.test.ts`.
2. It copies only typed native fields — never invents a tool name, argument, or status from prose.
   If a field is absent natively, it stays absent.
3. It has a real-session evidence note in [`docs/TESTING.md`](docs/TESTING.md) (counts, timing, and
   a redaction/JSON-validity check — no secrets or real transcript bodies).

See [`docs/COMPILE-SPEC.md`](docs/COMPILE-SPEC.md) for per-agent formats and the redaction spec, and
[`docs/CONSUMPTION.md`](docs/CONSUMPTION.md) for how each agent installs.

## Coding standards

Strict TypeScript, Node ≥20, **zero runtime dependencies** (standard library only — dev tooling is
fine). No stubs-for-later, no dead code, no backward-compat shims, KISS. Treat every parsed transcript
as untrusted input: redact on the way in, never execute its content.

## Security-sensitive changes

Anything touching `src/sync/redact.ts` or `src/sync/scrub.ts` (secret redaction, surrogate/JSON
safety, home-path scrub) needs a canary test proving the new shape is caught, in
`test/audit-fixes.test.ts` or `test/redact.test.ts`. When in doubt, over-redact.

## Commits & PRs

Small, focused commits with a clear message. Fill in the PR template. Reference any finding id
(e.g. `F-1.1`) or issue you're addressing.
