import { canonical } from './plan-contract.ts'
import type { DeliveryConfig } from './config.ts'

export interface PullRequest {
  number: number
  user: { login: string }
  head: { sha: string; repo: { full_name: string } }
  base: { sha: string; ref: string; repo: { full_name: string } }
  merged_at: string | null
  merge_commit_sha: string | null
  merged_by: { login: string } | null
}
export interface WorkflowRun {
  id: number
  run_attempt: number
  head_sha: string
  head_repository: { full_name: string }
  repository: { full_name: string }
  event: string
  path: string
  created_at: string
  updated_at: string
  conclusion: string | null
  pull_requests: { number: number }[]
}
export interface Binding {
  files: Record<string, string>
  terraform: { version: string; platform: string }
  node: string
}
export interface ReceiptPayload {
  version: 2
  createdAt: string
  repository: string
  workflow: string
  runId: string
  runAttempt: string
  pr: number
  head: string
  base: string
  testedTree: string
  binding: Binding
  roots: Record<string, unknown>
}
export function parseReceiptPayload(value: unknown): ReceiptPayload {
  if (field(value, 'version') !== 2)
    throw new Error('Unsupported preview receipt format; run a new preview')
  const rawBinding = field(value, 'binding')
  const rawTerraform = field(rawBinding, 'terraform')
  const rawFiles = field(rawBinding, 'files')
  const rawRoots = field(value, 'roots')
  if (!object(rawFiles) || !object(rawRoots))
    throw new Error('Preview receipt binding or root set is invalid')
  const files: Record<string, string> = {}
  for (const [name, digest] of Object.entries(rawFiles))
    files[name] = string(digest)
  return {
    version: 2,
    createdAt: string(field(value, 'createdAt')),
    repository: string(field(value, 'repository')),
    workflow: string(field(value, 'workflow')),
    runId: string(field(value, 'runId')),
    runAttempt: string(field(value, 'runAttempt')),
    pr: integer(field(value, 'pr')),
    head: string(field(value, 'head')),
    base: string(field(value, 'base')),
    testedTree: string(field(value, 'testedTree')),
    binding: {
      files,
      terraform: {
        version: string(field(rawTerraform, 'version')),
        platform: string(field(rawTerraform, 'platform')),
      },
      node: string(field(rawBinding, 'node')),
    },
    roots: rawRoots,
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function field(value: unknown, key: string): unknown {
  if (!object(value) || !(key in value))
    throw new Error('GitHub API or receipt identity is incomplete')
  return value[key]
}
function string(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('GitHub API or receipt identity is invalid')
  return value
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value)
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('GitHub API or receipt identity is invalid')
  return value
}
function repo(value: unknown): { full_name: string } {
  return { full_name: string(field(value, 'full_name')) }
}
export function parsePullRequest(value: unknown): PullRequest {
  const head = field(value, 'head')
  const base = field(value, 'base')
  const mergedBy = field(value, 'merged_by')
  return {
    number: integer(field(value, 'number')),
    user: { login: string(field(field(value, 'user'), 'login')) },
    head: {
      sha: string(field(head, 'sha')),
      repo: repo(field(head, 'repo')),
    },
    base: {
      sha: string(field(base, 'sha')),
      ref: string(field(base, 'ref')),
      repo: repo(field(base, 'repo')),
    },
    merged_at: nullableString(field(value, 'merged_at')),
    merge_commit_sha: nullableString(field(value, 'merge_commit_sha')),
    merged_by:
      mergedBy === null ? null : { login: string(field(mergedBy, 'login')) },
  }
}
export function parseWorkflowRun(value: unknown): WorkflowRun {
  const pullRequests = field(value, 'pull_requests')
  if (!Array.isArray(pullRequests))
    throw new Error('GitHub workflow association is invalid')
  return {
    id: integer(field(value, 'id')),
    run_attempt: integer(field(value, 'run_attempt')),
    head_sha: string(field(value, 'head_sha')),
    head_repository: repo(field(value, 'head_repository')),
    repository: repo(field(value, 'repository')),
    event: string(field(value, 'event')),
    path: string(field(value, 'path')),
    created_at: string(field(value, 'created_at')),
    updated_at: string(field(value, 'updated_at')),
    conclusion:
      field(value, 'conclusion') === null
        ? null
        : string(field(value, 'conclusion')),
    pull_requests: pullRequests.map((item: unknown): { number: number } => ({
      number: integer(field(item, 'number')),
    })),
  }
}
export function assertOwnerPR(
  pr: PullRequest,
  repository: string,
  config: DeliveryConfig,
): void {
  if (
    pr.user.login !== config.owner ||
    pr.head.repo.full_name !== repository ||
    pr.base.repo.full_name !== repository ||
    pr.base.ref !== config.defaultBranch
  )
    throw new Error(
      'Secret preview requires an owner-authored same-repository PR into the configured branch',
    )
}
export function requireRetainedRoots(
  baseRoots: string[],
  nextRoots: string[],
): void {
  if (baseRoots.some((root): boolean => !nextRoots.includes(root)))
    throw new Error(
      'Managed Terraform roots require explicit state retirement before removal',
    )
}
export function isPreviewRun(
  run: WorkflowRun,
  pr: PullRequest,
  config: DeliveryConfig,
): boolean {
  return (
    run.head_sha === pr.head.sha &&
    run.head_repository.full_name === pr.head.repo.full_name &&
    run.repository.full_name === pr.base.repo.full_name &&
    run.event === 'pull_request' &&
    run.path === `.github/workflows/${config.previewWorkflow}`
  )
}
export function latestPreview(
  runs: WorkflowRun[],
  pr: PullRequest,
  config: DeliveryConfig,
): WorkflowRun {
  if (pr.merged_at === null) throw new Error('PR has not been merged')
  const mergedAt = pr.merged_at
  const eligible = runs
    .filter(
      (run): boolean =>
        isPreviewRun(run, pr, config) &&
        Date.parse(run.created_at) < Date.parse(mergedAt),
    )
    .sort((a, b): number => {
      const difference = Date.parse(b.created_at) - Date.parse(a.created_at)
      return difference === 0 ? b.id - a.id : difference
    })
  const latest = eligible[0]
  if (latest === undefined)
    throw new Error('No exact PR preview exists before merge')
  if (
    latest.pull_requests.some((item): boolean => item.number !== pr.number) ||
    latest.conclusion !== 'success' ||
    Date.parse(latest.updated_at) >= Date.parse(pr.merged_at)
  )
    throw new Error('Latest exact PR preview was not successful before merge')
  return latest
}
export function requirePreviewIdentity(
  reviewed: unknown,
  context: {
    pr: PullRequest
    run: WorkflowRun
    repository: string
    parent: string
    tree: string
    binding: Binding
    config: DeliveryConfig
    now?: number
  },
): void {
  const { pr, run, repository, parent, tree, binding, config } = context
  if (pr.merged_at === null) throw new Error('PR has not been merged')
  const created = Date.parse(string(field(reviewed, 'createdAt')))
  const completed = Date.parse(run.updated_at)
  const merged = Date.parse(pr.merged_at)
  const age = (context.now ?? Date.now()) - created
  if (
    ![created, completed, merged].every(Number.isFinite) ||
    age < 0 ||
    age > 7 * 86400000 ||
    created > completed ||
    created >= merged ||
    completed >= merged ||
    field(reviewed, 'version') !== 2 ||
    run.conclusion !== 'success' ||
    run.event !== 'pull_request' ||
    String(field(reviewed, 'runId')) !== String(run.id) ||
    String(field(reviewed, 'runAttempt')) !== String(run.run_attempt) ||
    field(reviewed, 'repository') !== repository ||
    field(reviewed, 'workflow') !== config.previewWorkflow ||
    field(reviewed, 'pr') !== pr.number ||
    field(reviewed, 'head') !== pr.head.sha ||
    field(reviewed, 'base') !== parent ||
    field(reviewed, 'testedTree') !== tree ||
    canonical(field(reviewed, 'binding')) !== canonical(binding)
  )
    throw new Error(
      'Preview receipt does not match the exact merged and tested tree',
    )
}
