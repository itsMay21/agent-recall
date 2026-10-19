# Contributing to agent-recall

Thanks for helping. This project has a strict charter — read
[`docs/CHARTER.md`](docs/CHARTER.md) first. The one rule that cannot bend: **no LLM / network / exec
in the compile path.** `sync` parses, redacts, and indexes; it never summarizes or infers.

## The gate

Every change must pass before it's merged:

```bash
npm ci
npm run check      # prettier + tsc --noEmit + vitest + tsup build
npm run build:plugin
```

CI runs this gate, a dependency audit, and a history secret scan on macOS/Linux with Node 22 and 24.

## Adding or changing an adapter

Adapters live in `src/adapters/<agent>.ts` and implement the `Adapter` contract
(`src/sync/types.ts`). An adapter is **not "done"** until:

1. It ships a parse/locate test in `test/adapters.test.ts` (fixtures are inline objects in the spec;
   never commit a real transcript).
2. It copies only typed native fields — never invents a tool name, argument, or status from prose.
   If a field is absent natively, it stays absent.
3. It has a real-session evidence note in [`docs/TESTING.md`](docs/TESTING.md) (counts, timing, and
   a redaction/JSON-validity check — no secrets or real transcript bodies).

See [`archive/COMPILE-SPEC.md`](archive/COMPILE-SPEC.md) for per-agent formats and the redaction spec, and
[`docs/CONSUMPTION.md`](docs/CONSUMPTION.md) for how each agent installs.

## Coding standards

Strict TypeScript, Node ≥22.13, **zero runtime dependencies** (standard library only — dev tooling is
fine). No stubs-for-later, no dead code, no backward-compat shims, KISS. Treat every parsed transcript
as untrusted input: redact on the way in, never execute its content.

## Security-sensitive changes

Anything touching `src/sync/redact.ts` or `src/sync/scrub.ts` (secret redaction, surrogate/JSON
safety, home-path scrub) needs a canary test proving the new shape is caught, in
`test/audit-fixes.test.ts` or `test/redact.test.ts`. When in doubt, over-redact.

## Commits & PRs

Every branch is protected against force pushes and deletion. Push new commits normally;
create a new branch instead of rewriting published history. Protected topic branches are
retained even though automatic branch cleanup is enabled in repository settings.

Changes to `main` must arrive through a pull request with all four Node/OS checks and the
history secret scan passing against the current base. Resolve review conversations before
merging. The sole maintainer can merge without a second person's approval; CODEOWNERS
identifies the owner of sensitive files. No ruleset bypass is configured.

Small, focused commits with a clear message. Fill in the PR template. Reference any finding id
(e.g. `F-1.1`) or issue you're addressing.

## Release and attribution

Use only synthetic fixtures, never live transcripts or employer/client material. Contributions are
submitted under the repository's MIT license; disclose any third-party source and preserve its notice.
See [provenance](docs/PROVENANCE.md). Report vulnerabilities privately as described in SECURITY.md.

Before a release, follow [the release checklist](docs/RELEASE-READINESS.md). Build and install the
actual tarball, run the offline hook smoke check, inspect contents, audit dependencies and history,
and obtain independent review. Publish GitHub assets first; npm publishing requires separately
established scope ownership. Do not use the unrelated unscoped package name.
