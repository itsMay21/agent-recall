<!-- Thanks for contributing. Keep PRs small and focused. -->

## What this changes

<!-- One or two sentences. Reference a finding id (F-1.1) or issue if relevant. -->

## Checklist

- [ ] `npm run check` passes (prettier + typecheck + tests + build)
- [ ] `npm run build:plugin` passes and `plugin/bin/cli.js` is regenerated (no stale bundle)
- [ ] No LLM / network / exec added to the compile path (`docs/CHARTER.md` §1)
- [ ] If redaction/scrub changed: a canary test proves the new shape is caught
- [ ] If an adapter changed: fixture + test added, and a real-session note in `docs/TESTING.md`
- [ ] Docs updated (SCHEMA / CONSUMPTION / COMPILE-SPEC / DECISIONS) if behavior changed
