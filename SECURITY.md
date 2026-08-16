# Security Policy

agent-recall ingests coding-agent transcripts, which routinely contain secrets (API keys, tokens,
PEM blocks, credentialed URLs). Security is therefore a first-class concern.

## What the tool guarantees

- **Redaction on write.** Every string that reaches the committable index or the raw sidecar passes
  through mechanical, regex-based redaction (`src/sync/redact.ts`) covering common token families,
  assignment-shaped secrets, and credentialed URLs, followed by a home-path scrub
  (`src/sync/scrub.ts`). Redaction is lossy and one-way in the index.
- **Raw is never committed.** `.agent-recall/raw/` (verbatim, pre-redaction vendor bytes) is
  gitignored by `install`. Only the redacted `index.jsonl` is intended to be committable.
- **No execution.** Transcript content is data, never executed; there is no `eval`, shell-out, or
  network call in the compile path.

## Known limitations

Redaction is pattern-based, not exhaustive. It will not catch every secret shape (e.g. a bespoke
token format, a secret with no surrounding key word, or PII that isn't a known pattern). **Review an
index before committing it to a public repository.** Never force-add `.agent-recall/raw/` or a vendor
transcript to git.

## Reporting a vulnerability

If you find a way to make agent-recall leak a secret into the index, execute transcript content, or
corrupt the store, please report it privately:

- Open a **GitHub Security Advisory** (Security → Advisories → Report a vulnerability) on this repo, or
- email the maintainer (see `package.json` author) with `agent-recall security` in the subject.

Please include a minimal reproduction (a synthetic, non-real secret shape is fine — do **not** send
real credentials). We aim to acknowledge within a few days. Do not open a public issue for a
secret-leak vulnerability until a fix is released.
