# Verified Terraform delivery

A standalone GitHub Action for reviewing and applying multiple Terraform state
roots. It produces a signed, short-lived preview receipt for an owner-authored
pull request. On the resulting `main` merge, it checks the exact preview run and
jobs, verifies the tested tree and tool binding, replans every root, then
compares full plan contracts before applying saved plans. State snapshots are
archived and verified around each apply.

The Action runs on Node.js 24. Consumers use the committed `dist/index.js`; they
do not install this repository's npm dependencies. Terraform itself must be
installed by the calling workflow. The configured S3 backend, credentials and
state remain in the caller's control.

## Configuration

Store a repository-local JSON file, normally
`.github/config/terraform-delivery.json`:

```json
{
  "rootsDirectory": "terraform",
  "backendConfig": "terraform/backends/r2.hcl",
  "backendConfigRelative": "../backends/r2.hcl",
  "toolsFile": ".github/config/tools.json",
  "owner": "your-github-login",
  "defaultBranch": "main",
  "previewWorkflow": "infrastructure-preview.yml",
  "previewJobs": ["Terraform preview", "Ansible preview"],
  "identityFiles": [".github/config/tools.json", "terraform/backends/r2.hcl"]
}
```

Each immediate child directory under `rootsDirectory`, except `backends`, is a
Terraform root and must contain `root.json`, for example:

```json
{ "stateKey": "cloudflare/terraform.tfstate", "allowInitialState": false }
```

State keys must be unique. `allowInitialState` is for a deliberately new root
only. The backend config must include a quoted `bucket` and
`endpoints = { s3 = "..." }` entry. Put no credentials in it. The Action uses
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the same S3-compatible
backend. A matching Terraform version and platform, Node version, identity
files, lockfiles, root metadata, tree and reviewed plan contract are required
between preview and deployment.

## Operations

| Operation          | Purpose                                                                                                                         | Relevant outputs                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `validate-config`  | Check root metadata and referenced files without remote access.                                                                 | `roots`                                                       |
| `preview`          | Plan all roots on the tested PR merge ref, write `.ci/reports/preview-receipt.json`.                                            | —                                                             |
| `gate`             | Verify an owner merge and locate the exact successful preview artifact.                                                         | `stale`, `preview_artifact`, `preview_run`, `preview_attempt` |
| `deploy`           | Verify the downloaded receipt, replan, archive and apply.                                                                       | `admitted`                                                    |
| `check-no-changes` | Fail if any resource, output, import, move or drift is found.                                                                   | —                                                             |
| `backup`           | Archive an active state. Requires root name as CLI argument.                                                                    | —                                                             |
| `download`         | Download a verified archived state with mode `0600`; never writes active state. Requires root, history key and new destination. | —                                                             |

The HMAC secret is supplied as `TERRAFORM_DELIVERY_HMAC_KEY` to preview and
deploy. Use the same secret in both jobs; keep it out of artifacts and
summaries. `preview` also reads `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`,
`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`. `gate` and `deploy` require a GitHub
API token with `contents: read`, `actions: read` and `pull-requests: read`. The
`token` input or `GITHUB_TOKEN` supplies it. The receipt artifact is
intentionally nonsecret, but must be downloaded by exact ID into `.ci/reports`
for `deploy`.

Pin `uses: mstrict-actions/terraform-delivery@<full-commit-sha>` in consumer
workflows. Run `preview` only for an owner-authored PR from the same repository,
on GitHub's synthetic merge checkout with full history. Give the preview job
only read permission and `actions/upload-artifact` to publish
`preview-receipt-${{ github.run_id }}-${{ github.run_attempt }}` with a
seven-day retention. Keep other required preview jobs, including Ansible if
applicable, in the same workflow and list their exact displayed names in
`previewJobs`.

On `main` push, use a non-cancelled deployment concurrency group. Run `gate`,
download its exact artifact ID/run, then run `deploy` if `stale != 'true'`.
Later stages should require `admitted == 'true'`. Keep Terraform before
dependent stages. An unreviewed direct push, an obsolete run, an incomplete
preview, a changed plan, or a different tool/tree binding cannot apply.

## State and recovery

Each deployment writes a durable `operations/deploy/<run-id>-<attempt>.json`
record and `history/<root>/...tfstate` snapshots. It backs up all active roots
before applying any, then archives each root after its apply. An unfinished or
failed operation blocks subsequent deployment. Inspect the receipt and current
state, reconcile any partial application, and explicitly mark the operation
finished only after verification. Do not delete or overwrite operation records
to bypass this guard.

`download` verifies SHA-256, lineage, serial and source-key metadata. It refuses
an existing destination and does not restore state. Recovery decisions and
active-state restoration remain manual. Plan files under `.ci/private` are
sensitive, must not be uploaded, and are created with private permissions.
Action logs and summaries omit provider-controlled text, attribute values,
import IDs and raw state.

## Development

Use the pinned Node.js major from `package.json`, then run `npm ci`,
`npm run check:ci` and `npm run build`. Rerun tests after rebuilding to cover
the committed standalone bundle outside this repository and without
`node_modules`. After committing, `npm run check-dist` checks reproducibility.
CI also executes `uses: ./` with `validate-config`. See [AGENTS.md](AGENTS.md)
for the change and release rules.
