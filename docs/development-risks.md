# Development dependency risks

Reviewed on 2026-10-07 with `npm ci` and a full npm audit on Node.js 24. The
lockfile currently reports zero known advisories. The Action has no
`@github/local-action` dependency or local launcher. The `@aws-sdk/client-s3`
client is a runtime dependency and is bundled into the standalone Action; both
runtime and development dependency advisories must be reviewed when they appear.

Terraform output, GitHub API responses, preview receipts and S3 state are
external data. Tests use synthetic fixtures and an isolated S3-compatible
endpoint. They do not establish safety against every provider, backend or API
behavior. Keep network tests free of production credentials. Recheck advisories
and reachable paths when dependencies change or security alerts appear; update
the lockfile with npm and rerun checks and standalone bundle tests. Do not hide
findings with overrides or infer that a clean production audit covers
development tools.
