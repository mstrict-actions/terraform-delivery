import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as core from '@actions/core'
import { discoverRoots, loadConfig, terraformCommand } from './config.ts'
import type { DeliveryConfig, RootConfig } from './config.ts'
import {
  assertOwnerPR,
  latestPreview,
  parsePullRequest,
  parseReceiptPayload,
  parseWorkflowRun,
  requirePreviewIdentity,
  requireRetainedRoots,
} from './identity.ts'
import type { Binding, PullRequest, ReceiptPayload } from './identity.ts'
import { applyAll } from './operation.ts'
import type { SavedPlan } from './operation.ts'
import {
  contractHash,
  inspectPlan,
  renderScope,
  requireNoChanges,
  requireSamePlans,
  sha256,
  sign,
  verify,
} from './plan-contract.ts'
import { run, runTerraform } from './runtime.ts'
import { StateStore } from './state-store.ts'

const privateDirectory = resolve('.ci/private')
const receiptPath = '.ci/reports/preview-receipt.json'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function field(value: unknown, name: string): unknown {
  if (!object(value) || !(name in value))
    throw new Error('External response or receipt is incomplete')
  return value[name]
}
function string(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('External response or receipt is invalid')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('External response or receipt is invalid')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error('External response or receipt is invalid')
  return Array.from(value, (item: unknown): unknown => item)
}
function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`)
  return value
}
function safeFailure(error: unknown): string {
  if (!object(error) || typeof error['message'] !== 'string')
    return 'Terraform delivery failed; external details withheld'
  if (
    error['name'] === 'SyntaxError' ||
    '$metadata' in error ||
    error['name'] === 'JSONParseError'
  )
    return 'Terraform delivery failed; external response withheld'
  return error['message']
}
export class Report {
  private readonly lines: string[] = ['## Terraform delivery', '']
  add(message: string): void {
    if (this.lines.join('\n').length < 60_000) this.lines.push(message, '')
  }
  async write(): Promise<void> {
    const path = process.env['GITHUB_STEP_SUMMARY']
    if (path !== undefined && path.length > 0)
      await appendFile(path, `${this.lines.join('\n').slice(0, 65_000)}\n`)
  }
}
async function github(path: string): Promise<unknown> {
  const inputToken = core.getInput('token')
  const token = inputToken.length > 0 ? inputToken : process.env['GITHUB_TOKEN']
  if (token === undefined || token.length === 0)
    throw new Error('GitHub API token is required')
  const response = await fetch(
    `${process.env['GITHUB_API_URL'] ?? 'https://api.github.com'}/repos/${required('GITHUB_REPOSITORY')}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!response.ok)
    throw new Error(
      `GitHub verification request failed (${response.status.toString()})`,
    )
  const result: unknown = await response.json()
  return result
}
async function pages(path: string, key: string): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let page = 1; page <= 100; page++) {
    const separator = path.includes('?') ? '&' : '?'
    const payload = await github(
      `${path}${separator}per_page=100&page=${page.toString()}`,
    )
    const batch = array(field(payload, key))
    rows.push(...batch)
    if (batch.length < 100) return rows
  }
  throw new Error('GitHub API pagination was incomplete')
}
async function latestMain(config: DeliveryConfig): Promise<boolean> {
  const ref = await github(
    `/git/ref/heads/${encodeURIComponent(config.defaultBranch)}`,
  )
  return field(field(ref, 'object'), 'sha') === required('GITHUB_SHA')
}
function testedTree(): string {
  return run(['git', 'rev-parse', 'HEAD^{tree}']).trim()
}
async function binding(
  config: DeliveryConfig,
  roots: string[],
): Promise<Binding> {
  const paths = [
    ...config.identityFiles,
    ...roots.flatMap((root): string[] => [
      `${config.rootsDirectory}/${root}/.terraform.lock.hcl`,
      `${config.rootsDirectory}/${root}/root.json`,
    ]),
  ]
  const files: Record<string, string> = {}
  for (const path of paths) files[path] = sha256(await readFile(path))
  const tool: unknown = JSON.parse(run(['terraform', 'version', '-json']))
  return {
    files,
    terraform: {
      version: string(field(tool, 'terraform_version')),
      platform: string(field(tool, 'platform')),
    },
    node: process.version,
  }
}
function parseSavedPlans(
  value: Record<string, unknown>,
): Record<string, SavedPlan> {
  const result: Record<string, SavedPlan> = {}
  for (const [root, plan] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(root))
      throw new Error('Preview receipt has an invalid root')
    result[root] = {
      contract: string(field(plan, 'contract')),
      savedPlan: string(field(plan, 'savedPlan')),
      stateKey: string(field(plan, 'stateKey')),
      allowInitialState: field(plan, 'allowInitialState') === true,
      noChanges: field(plan, 'noChanges') === true,
    }
  }
  return result
}

export class Delivery {
  readonly config: DeliveryConfig
  readonly configPath: string
  readonly roots: Record<string, RootConfig>
  readonly report: Report
  private constructor(
    config: DeliveryConfig,
    configPath: string,
    roots: Record<string, RootConfig>,
    report: Report,
  ) {
    this.config = config
    this.configPath = configPath
    this.roots = roots
    this.report = report
  }
  static async create(configPath: string, report: Report): Promise<Delivery> {
    const config = await loadConfig(configPath)
    const roots = await discoverRoots(config)
    process.umask(0o077)
    await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
    await mkdir('.ci/reports', { recursive: true, mode: 0o700 })
    return new Delivery(config, configPath, roots, report)
  }
  private get rootNames(): string[] {
    return Object.keys(this.roots).sort()
  }
  async validateConfig(): Promise<void> {
    await Promise.all([
      readFile(this.config.backendConfig),
      readFile(this.config.toolsFile),
      ...this.config.identityFiles.map((path): Promise<Buffer> =>
        readFile(path),
      ),
    ])
    const roots = this.rootNames.join(',')
    core.setOutput('roots', roots)
    this.report.add(`Validated Terraform roots: ${roots}.`)
    core.notice(`Validated Terraform roots: ${roots}`)
  }
  private async plans(noChanges: boolean): Promise<Record<string, SavedPlan>> {
    const result: Record<string, SavedPlan> = {}
    for (const [root, metadata] of Object.entries(this.roots).sort(
      ([a], [b]): number => a.localeCompare(b),
    )) {
      const started = Date.now()
      core.startGroup(`Terraform ${root}: initialize and plan`)
      try {
        core.info(`Initializing root ${root}`)
        await runTerraform(
          terraformCommand(
            this.config,
            root,
            'init',
            '-json',
            '-reconfigure',
            '-input=false',
            '-lockfile=readonly',
            `-backend-config=${this.config.backendConfigRelative}`,
            `-backend-config=key=${metadata.stateKey}`,
          ),
        )
        const file = resolve(privateDirectory, `${root}.tfplan`)
        core.info(`Planning root ${root}; provider output is withheld`)
        await runTerraform(
          terraformCommand(
            this.config,
            root,
            'plan',
            '-json',
            '-input=false',
            '-lock-timeout=60s',
            '-detailed-exitcode',
            `-out=${file}`,
          ),
          [0, 2],
          20 * 60 * 1000,
          resolve(this.config.rootsDirectory, root),
        )
        const plan = inspectPlan(
          run(terraformCommand(this.config, root, 'show', '-json', file)),
        )
        let unchanged = true
        try {
          requireNoChanges(plan.contract)
        } catch {
          unchanged = false
        }
        if (noChanges) requireNoChanges(plan.contract)
        result[root] = {
          contract: noChanges
            ? ''
            : contractHash(
                plan.contract,
                required('TERRAFORM_DELIVERY_HMAC_KEY'),
              ),
          savedPlan: sha256(await readFile(file)),
          stateKey: metadata.stateKey,
          allowInitialState: metadata.allowInitialState,
          noChanges: unchanged,
        }
        this.report.add(renderScope(root, plan.scope))
        core.notice(
          `${root}: ${plan.summary.resourceChanges.toString()} resource and ${plan.summary.outputChanges.toString()} output changes; ${((Date.now() - started) / 1000).toFixed(1)}s`,
        )
      } finally {
        core.endGroup()
      }
    }
    return result
  }
  async checkNoChanges(): Promise<void> {
    await this.plans(true)
    this.report.add(
      'All Terraform roots have no changes, imports, moves, or drift.',
    )
    core.notice('All Terraform roots have no changes or drift')
  }
  async preview(): Promise<void> {
    const event: unknown = JSON.parse(
      await readFile(required('GITHUB_EVENT_PATH'), 'utf8'),
    )
    const pr = parsePullRequest(field(event, 'pull_request'))
    assertOwnerPR(pr, required('GITHUB_REPOSITORY'), this.config)
    if (
      run(['git', 'rev-parse', 'HEAD^1']).trim() !== pr.base.sha ||
      run(['git', 'rev-parse', 'HEAD^2']).trim() !== pr.head.sha
    )
      throw new Error('Preview checkout does not match the PR head and base')
    const baseFiles = run([
      'git',
      'ls-tree',
      '-r',
      '--name-only',
      pr.base.sha,
      this.config.rootsDirectory,
    ])
    const baseRoots = baseFiles
      .split('\n')
      .filter((path): boolean => {
        if (!path.startsWith(`${this.config.rootsDirectory}/`)) return false
        const parts = path
          .slice(this.config.rootsDirectory.length + 1)
          .split('/')
        return (
          parts.length === 2 &&
          (parts[1] === 'root.json' || parts[1] === 'versions.tf')
        )
      })
      .map((path): string =>
        path.slice(
          this.config.rootsDirectory.length + 1,
          path.indexOf('/', this.config.rootsDirectory.length + 1),
        ),
      )
    requireRetainedRoots(baseRoots, this.rootNames)
    const payload: ReceiptPayload = {
      version: 2,
      createdAt: new Date().toISOString(),
      repository: required('GITHUB_REPOSITORY'),
      workflow: this.config.previewWorkflow,
      runId: required('GITHUB_RUN_ID'),
      runAttempt: required('GITHUB_RUN_ATTEMPT'),
      pr: pr.number,
      head: pr.head.sha,
      base: pr.base.sha,
      testedTree: testedTree(),
      binding: await binding(this.config, this.rootNames),
      roots: await this.plans(false),
    }
    const receipt = {
      payload,
      signature: sign(payload, required('TERRAFORM_DELIVERY_HMAC_KEY')),
    }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    })
    this.report.add(
      `Signed preview receipt for PR #${pr.number.toString()} and run ${payload.runId}, attempt ${payload.runAttempt}.`,
    )
    core.notice('Signed preview receipt created')
  }
  private async mergedPR(): Promise<PullRequest> {
    const sha = required('GITHUB_SHA')
    const rows = await github(`/commits/${sha}/pulls?per_page=100`)
    const matches = array(rows)
      .map(parsePullRequest)
      .filter(
        (pr): boolean =>
          pr.merged_at !== null &&
          pr.merge_commit_sha === sha &&
          pr.base.ref === this.config.defaultBranch,
      )
    if (matches.length !== 1)
      throw new Error(
        'Main commit must be the merge of exactly one reviewed PR',
      )
    const prNumber = matches
      .map((match): string => match.number.toString())
      .join('')
    const pr = parsePullRequest(await github(`/pulls/${prNumber}`))
    if (pr.merged_by?.login !== this.config.owner)
      throw new Error(
        'Only the configured owner may merge infrastructure changes',
      )
    assertOwnerPR(pr, required('GITHUB_REPOSITORY'), this.config)
    return pr
  }
  async gate(): Promise<void> {
    if (!(await latestMain(this.config))) {
      core.setOutput('stale', 'true')
      this.report.add('Main advanced; stale deployment skipped.')
      core.notice('Main advanced; stale deployment skipped')
      return
    }
    const pr = await this.mergedPR()
    const candidates = (
      await pages(
        `/actions/workflows/${encodeURIComponent(this.config.previewWorkflow)}/runs?event=pull_request&head_sha=${encodeURIComponent(pr.head.sha)}`,
        'workflow_runs',
      )
    ).map(parseWorkflowRun)
    const candidate = latestPreview(candidates, pr, this.config)
    const artifacts = await pages(
      `/actions/runs/${candidate.id.toString()}/artifacts`,
      'artifacts',
    )
    const matching = artifacts.filter(
      (artifact): boolean =>
        field(artifact, 'name') ===
          `preview-receipt-${candidate.id.toString()}-${candidate.run_attempt.toString()}` &&
        field(artifact, 'expired') === false &&
        pr.merged_at !== null &&
        Date.parse(string(field(artifact, 'created_at'))) <
          Date.parse(pr.merged_at),
    )
    if (matching.length !== 1)
      throw new Error('Exact successful preview receipt artifact is missing')
    const artifactId = matching
      .map((artifact): string => number(field(artifact, 'id')).toString())
      .join('')
    core.setOutput('preview_artifact', artifactId)
    core.setOutput('stale', 'false')
    core.setOutput('preview_run', candidate.id.toString())
    core.setOutput('preview_attempt', candidate.run_attempt.toString())
    await writeFile(
      resolve(privateDirectory, 'merge.json'),
      JSON.stringify({ pr, run: candidate }),
      { mode: 0o600 },
    )
    this.report.add(
      `Owner merge of PR #${pr.number.toString()} admitted by preview run ${candidate.id.toString()}, attempt ${candidate.run_attempt.toString()}.`,
    )
    core.notice('Owner merge and latest exact preview verified')
  }
  private async validateReceipt(): Promise<ReceiptPayload> {
    const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'))
    const reviewed = parseReceiptPayload(
      verify(receipt, required('TERRAFORM_DELIVERY_HMAC_KEY')),
    )
    const merge: unknown = JSON.parse(
      await readFile(resolve(privateDirectory, 'merge.json'), 'utf8'),
    )
    const pr = parsePullRequest(field(merge, 'pr'))
    const previewRun = parseWorkflowRun(field(merge, 'run'))
    const attempt = parseWorkflowRun(
      await github(
        `/actions/runs/${previewRun.id.toString()}/attempts/${previewRun.run_attempt.toString()}`,
      ),
    )
    requirePreviewIdentity(reviewed, {
      pr,
      run: attempt,
      repository: required('GITHUB_REPOSITORY'),
      parent: run(['git', 'rev-parse', 'HEAD^1']).trim(),
      tree: testedTree(),
      binding: await binding(this.config, this.rootNames),
      config: this.config,
    })
    const jobs = await pages(
      `/actions/runs/${previewRun.id.toString()}/attempts/${previewRun.run_attempt.toString()}/jobs`,
      'jobs',
    )
    for (const name of this.config.previewJobs) {
      const matches = jobs.filter((job): boolean => field(job, 'name') === name)
      if (matches.length !== 1 || field(matches[0], 'conclusion') !== 'success')
        throw new Error(`Required preview job ${name} did not succeed`)
    }
    return reviewed
  }
  async deploy(): Promise<void> {
    if (!(await latestMain(this.config))) {
      core.setOutput('admitted', 'false')
      this.report.add('Main advanced; stale deployment skipped.')
      core.notice('Main advanced; stale deployment skipped')
      return
    }
    const reviewed = await this.validateReceipt()
    const fresh = await this.plans(false)
    requireSamePlans(parseSavedPlans(reviewed.roots), fresh)
    const store = await StateStore.create(this.configPath)
    const admitted = await applyAll(
      store,
      fresh,
      {
        sha: required('GITHUB_SHA'),
        runId: required('GITHUB_RUN_ID'),
        runAttempt: required('GITHUB_RUN_ATTEMPT'),
      },
      {
        current: (): Promise<boolean> => latestMain(this.config),
        planBytes: (root: string): Promise<Buffer> =>
          readFile(resolve(privateDirectory, `${root}.tfplan`)),
        apply: (root: string): Promise<void> =>
          runTerraform(
            terraformCommand(
              this.config,
              root,
              'apply',
              '-json',
              '-input=false',
              '-lock-timeout=60s',
              resolve(privateDirectory, `${root}.tfplan`),
            ),
            [0],
            20 * 60 * 1000,
            resolve(this.config.rootsDirectory, root),
          ),
        report: (message: string): Promise<void> => {
          this.report.add(message)
          core.notice(message)
          return Promise.resolve()
        },
      },
    )
    core.setOutput('admitted', String(admitted))
  }
  async backup(root: string): Promise<void> {
    const metadata = this.roots[root]
    if (metadata === undefined)
      throw new Error('Specify a configured Terraform root')
    const archive = await (
      await StateStore.create(this.configPath)
    ).backup(root, metadata.stateKey)
    if ('missing' in archive) throw new Error('Active state is missing')
    core.info(
      `Verified state archive ${archive.key}; checksum ${archive.sha256}`,
    )
    this.report.add(`Verified state archive for ${root}: ${archive.key}`)
  }
  async download(
    root: string,
    key: string,
    destination: string,
  ): Promise<void> {
    const metadata = this.roots[root]
    if (metadata === undefined)
      throw new Error('Specify a configured Terraform root')
    if (!key.startsWith(`history/${root}/`))
      throw new Error('Archive does not belong to the configured root')
    await (
      await StateStore.create(this.configPath)
    ).download(key, destination, metadata.stateKey)
    core.notice(
      'Verified archive downloaded with exclusive mode 0600; active state was not changed',
    )
  }
}

export async function execute(
  operation: string,
  configPath: string,
  args: string[],
): Promise<void> {
  const report = new Report()
  try {
    const delivery = await Delivery.create(configPath, report)
    if (operation === 'validate-config') await delivery.validateConfig()
    else if (operation === 'preview') await delivery.preview()
    else if (operation === 'gate') await delivery.gate()
    else if (operation === 'deploy') await delivery.deploy()
    else if (operation === 'check-no-changes') await delivery.checkNoChanges()
    else if (operation === 'backup') {
      const root = args[0]
      if (root === undefined) throw new Error('Usage: backup ROOT')
      await delivery.backup(root)
    } else if (operation === 'download') {
      const [root, key, destination] = args
      if (root === undefined || key === undefined || destination === undefined)
        throw new Error('Usage: download ROOT HISTORY_KEY NEW_OUTPUT_PATH')
      await delivery.download(root, key, destination)
    } else throw new Error('Unsupported Terraform delivery operation')
    report.add(`Operation ${operation} completed.`)
  } catch (error) {
    const message = safeFailure(error)
    report.add(`Operation ${operation} failed: ${message}`)
    core.setFailed(message)
  } finally {
    await report.write()
  }
}
