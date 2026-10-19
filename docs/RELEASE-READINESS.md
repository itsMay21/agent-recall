# Release readiness — 0.2.0

Assessment date: 2026-10-19. No maturity score is assigned. This is a small, early release with tested
mechanical behavior and explicit host limitations, not a claim of universal integration certification.

## Starting point

The existing private repository at `itsMay21/agent-recall`, head `d444888`, had 62 tracked files,
48 passing tests in six specs, a successful format/types/build gate, and seven vulnerable development
packages (3 moderate, 2 high, 2 critical). It had an MIT license attributed to Mayank Saini and no
release. Agent Expression is a separate public project. A baseline record and command logs are also
saved locally outside the release source.

Independent architecture review identified a registry-name collision, metadata redaction gaps,
unprotected direct raw writes, raw-deletion duplicate rows, torn append recovery errors, incorrect
hook timeout units, outdated host guidance, invented Codex status/role fields, nested image retention,
and lock/compatibility gaps. This release addresses those findings and adds reproducible evidence.

## Gates

- [x] Repository identity, original work, and owner authorization established.
- [x] Existing MIT license retained; provenance reviewed with no material ownership blocker found.
- [x] Runtime remains dependency-free; unrelated unscoped npm package removed from install paths.
- [x] Targeted privacy, recovery, CLI, installer, and distribution regressions added.
- [x] Setup, supported-host limits, migration, removal, and public contribution guidance documented.
- [x] Final local gate, tarball contents, demo, and dependency audit recorded below.
- [x] Final fetched-history scan and current release-material inspection completed.
- [x] Independent release review completed with all material findings resolved.
- [x] Remote CI passed for the reviewed source revision.
- [x] Reviewed tarball and checksum procedure prepared; publication authorized only after the gates above.

## Release record

Local candidate validation: Node 22.23.2 / npm 10.9.8 / macOS arm64. `npm run check` passed:
format, strict types, **88 tests across seven specs**, bundled CLI/plugin, and an offline package test
with real generated hook execution. `npm audit --json` returned **0 vulnerabilities**. Demo passed
with four synthetic cross-agent rows, credential redaction and zero duplicate rows on repeat. The
fresh bundle matches `plugin/bin/cli.js` byte for byte. Benchmark measurements are in BENCHMARKS.md.

Gitleaks 8.30.1 scanned all 16 initially fetched commits (496,162 bytes). One fake Slack-token fixture
was reviewed and excluded by its exact fingerprint; the rerun reported no leaks. The release commit
and remote CI will also be scanned before publication. No private transcript bodies or employer/client
assets were found. Existing MIT authorship and the independent provenance review support publication.

Reviewed source: `b138e5630b0af40341c1a8d46d756b50d583b2e5`. Independent gpt-6-astra review at
high reasoning effort approved publication after reproducing and checking the substantive fixes.
The main agent's post-lock-change gate included the offline package smoke check. Final history scan:
18 commits, 706,711 bytes, no findings after the exact synthetic-fixture exception.

[Remote CI for the reviewed source](https://github.com/itsMay21/agent-recall/actions/runs/39196760429)
passed Ubuntu/macOS × Node 22/24 plus the fetched-history secret scan. The final readiness-record commit
changes documentation only. The [GitHub release](https://github.com/itsMay21/agent-recall/releases/tag/v0.2.0)
is the publication record and contains the install tarball and SHA256SUMS. npm publication is not part
of this release.

## Explicit limits

Cursor is experimental; Pi collection is manual/user-extension; Codex hooks are experimental; Hermes
activation is manual. Native-host lifecycle execution is not certified by CLI smoke checks. Regex
redaction is incomplete for unknown secrets and PII; absolute cwd remains. Append-only sources are
required. No coding-agent outcome improvement is measured. See TESTING.md and SECURITY.md.
