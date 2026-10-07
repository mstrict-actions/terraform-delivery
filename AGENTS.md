# Agent guide

This repository is the public `mstrict-actions/terraform-delivery` Node.js
Action. The committed `dist/index.js` is the consumer entrypoint. Terraform
plans and state are sensitive; never print raw plan, provider, state, backend or
API data.

## Change workflow

1. Inspect branch and staged/unstaged work. Use the Node runtime in
   `package.json`; preserve unrelated changes.
2. Read the affected source, tests and configuration. Keep preview, gate,
   deployment, archive and recovery behavior aligned with `action.yml` and
   documented consumer workflows.
3. Run `npm ci`, `npm run check:ci`, `npm run build`, then rerun the tests so
   standalone bundle cases cover the new artifact. Review source and both
   tracked dist files. After committing, run `npm run check-dist` with clean
   dist files.
4. Use English Conventional Commits. If pushing, inspect CI, Version, both
   CodeQL jobs and any security alerts for the pushed commit.

Read the vendored skills before changing their areas:

- [GitHub Actions hardening](.agents/skills/github-actions-hardening/SKILL.md)
  for workflows, token permissions or trust boundaries.
- [Runtime upgrade conventions](.agents/skills/github-actions-runtime-upgrade-conventions/SKILL.md)
  for external Action versions or supported runtimes.
- [CodeQL](.agents/skills/codeql/SKILL.md) for analysis changes or alerts.
- [Writing for agents](.agents/skills/writing-for-agents/SKILL.md) for these
  instructions or skills.

[Skill provenance](.agents/README.md) records upstream sources. External Actions
use full commit SHA pins with release comments.

## Delivery invariants

Preview runs only for an owner-authored, same-repository PR. It signs a receipt
for the exact tested tree, Terraform/Node binding, roots and plan contract. Gate
accepts only the latest exact successful preview completed before the owner's
merge. Deploy verifies the receipt, required preview jobs and a fresh plan
contract before writing state. It archives and verifies state before and after
each apply. An unfinished operation blocks a later deployment until manual
reconciliation. Do not weaken these checks for convenience.

Keep Terraform stdout/stderr and raw JSON out of logs, annotations, summaries
and artifacts. Summaries expose only reviewed action scope, counts and redacted
addresses. Preserve no-change gates for migration and safe archive downloads.
Use synthetic, isolated fixtures for tests; never run against a consumer's
production state while testing this Action.

Keep lockfile and manifest synchronized with npm. Maintain strict lint and types
across source, tests and scripts; assertions and suppressions remain forbidden
except allowed const assertions. Read
[development dependency risks](docs/development-risks.md) before assessing audit
findings or changing networked local dependencies. Do not publish an npm package
or add paid automation as part of routine changes.
