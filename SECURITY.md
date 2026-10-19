# Security policy

Agent Recall reads local coding-agent transcripts. They can contain credentials, personal data,
private source code, employer/client information, and hostile instructions.

## Boundaries

- No network, shell execution, model calls, or telemetry in the compiler. Transcript content is data.
- Known token patterns, assignment-shaped secrets, structured credential values, nested object keys,
  and metadata are redacted before index/sanitized detail writes. Typed nested images become envelopes.
- Verbatim sources in `raw/` retain original bytes and may contain secrets. Direct sync and plugin
  use create store-local ignore rules before copying raw. POSIX directories/files use `0700`/`0600`.
- `cwd` retains the absolute project path. Unknown token formats, arbitrary PII, company names, and
  private code are not comprehensively detected. Review the index before sharing. Keep the whole store
  ignored if your project's privacy policy requires it.
- Ignore rules do not untrack an already committed file, prevent `git add -f`, or protect an index
  already present in Git history. Redaction updates are not retroactive; rebuild stores when upgrading.
- A lock serializes cooperative writers and repairs interrupted final appends. This is not a database
  transaction or a sandbox. Same-user malicious processes, edited/reordered transcripts, deliberate
  filesystem races, hardware loss, and arbitrary source schema changes are outside its guarantees.
- The read skill tells consumers to treat history as untrusted evidence. It cannot enforce model
  behavior or prevent every prompt-injection response.

Supported fixes target the latest release (currently 0.2.x). Windows is not validated. Host schemas
and experimental hooks may change; use manual sync and inspect diagnostics when automation fails.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/itsMay21/agent-recall/security/advisories/new).
Include a minimal synthetic reproduction and affected version. Do not upload real credentials,
transcripts, client data, or employer material. If the private reporting form is unavailable, contact
[@itsMay21](https://github.com/itsMay21) to arrange a private report without posting the vulnerability
in a public issue. Response time depends on maintainer availability; no service-level guarantee is made.
