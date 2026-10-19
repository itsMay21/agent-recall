# Provenance and license review

Reviewed for the initial public release on 2026-10-19.

The existing repository was located at `itsMay21/agent-recall`, not recreated from Agent Expression.
The original MIT license names Mayank Saini, who authorized this release. All human-authored commits
in fetched history identify that copyright holder; other fetched commits are Dependabot updates.
The review found no conflicting license, vendored third-party runtime source, client ownership notice,
or employer source/assets in this repository. This is evidence from the available repository, not a
universal statement about rights beyond it. The independent release advisor found no ownership decision
that required holding publication.

The CLI has zero runtime package dependencies and imports Node builtins. Development tooling is locked
in `package-lock.json`, remains under its respective upstream licenses, and is not shipped as a dependency
of the release tarball. The plugin bundle is generated from this repository's source. No company logos,
third-party screenshots, real transcript fixtures, or generated launch art are part of the software package.
Vendor names identify supported formats and imply no endorsement.

Tests use synthetic inline fixtures. Historical live-session documents retain aggregate observations,
not raw bodies. Local usernames/project labels in current documentation have been generalized. Git
history includes the author's existing commit attribution and earlier documentation; review found no
actual credential or private employer/client material requiring a history rewrite. One Gitleaks finding
was a fixed fake Slack-token fixture; `.gitleaksignore` names only that exact historical fingerprint.

Research references informed earlier design discussion. They are not a license for source copied here,
and no claim is made that their experiments evaluate Agent Recall. See the revised charter and current
validation report for the claims this release actually makes.

The release package uses the name `@itsmay21/agent-recall` to distinguish it from an unrelated unscoped
npm package. It is distributed as a GitHub tarball. Future npm publication requires establishing scope
control and publisher credentials; no npm ownership or publication is implied by this release.
