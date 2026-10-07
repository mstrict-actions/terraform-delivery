import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as core from '@actions/core'
import { Delivery, execute, Report } from '../src/delivery.ts'
import { sign } from '../src/plan-contract.ts'
import { run, runTerraform } from '../src/runtime.ts'

const synthetic = vi.hoisted(
  (): {
    plan: string
    archives: string[]
    receipts: string[]
    downloads: string[]
    mainSha: string
    api: Map<string, unknown>
    failingPath: string
    missingArchive: boolean
  } => ({
    plan: JSON.stringify({ format_version: '1.2', complete: true }),
    archives: [],
    receipts: [],
    downloads: [],
    mainSha: 'merge',
    api: new Map<string, unknown>(),
    failingPath: '',
    missingArchive: false,
  }),
)
vi.mock('@actions/core', (): Record<string, unknown> => ({
  getInput: vi.fn((): string => ''),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  warning: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}))
vi.mock('../src/runtime.ts', (): Record<string, unknown> => ({
  run: vi.fn(),
  runTerraform: vi.fn(),
}))
vi.mock('../src/state-store.ts', (): Record<string, unknown> => ({
  StateStore: class {
    static create(): Promise<unknown> {
      return Promise.resolve(new this())
    }
    assertReconciled(): Promise<void> {
      return Promise.resolve()
    }
    backup(
      root: string,
    ): Promise<
      | { key: string; sha256: string; serial: number; lineage: string }
      | { missing: true; stateKey: string }
    > {
      synthetic.archives.push(root)
      if (synthetic.missingArchive)
        return Promise.resolve({
          missing: true,
          stateKey: `${root}/state.tfstate`,
        })
      return Promise.resolve({
        key: `history/${root}/archive.tfstate`,
        sha256: 'hash',
        serial: 1,
        lineage: 'lineage',
      })
    }
    put(key: string, body: string): Promise<void> {
      expect(key).toContain('operations/deploy/')
      synthetic.receipts.push(body)
      return Promise.resolve()
    }
    download(key: string): Promise<void> {
      synthetic.downloads.push(key)
      return Promise.resolve()
    }
  },
}))

const pr = {
  number: 7,
  user: { login: 'owner' },
  head: { sha: 'head', repo: { full_name: 'owner/repo' } },
  base: { sha: 'base', ref: 'main', repo: { full_name: 'owner/repo' } },
  merged_at: '2026-10-05T11:00:00Z',
  merge_commit_sha: 'merge',
  merged_by: { login: 'owner' },
}
const workflowRun = {
  id: 12,
  run_attempt: 2,
  head_sha: 'head',
  head_repository: { full_name: 'owner/repo' },
  repository: { full_name: 'owner/repo' },
  event: 'pull_request',
  path: '.github/workflows/preview.yml',
  created_at: '2026-10-05T09:00:00Z',
  updated_at: '2026-10-05T10:30:00Z',
  conclusion: 'success',
  pull_requests: [],
}
function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}
function githubResponse(url: URL): Response {
  const path = url.pathname
  if (path === synthetic.failingPath) return new Response('', { status: 500 })
  if (synthetic.api.has(path)) return response(synthetic.api.get(path))
  if (path.endsWith('/git/ref/heads/main'))
    return response({ object: { sha: synthetic.mainSha } })
  if (path.endsWith('/commits/merge/pulls')) return response([pr])
  if (path.endsWith('/pulls/7')) return response(pr)
  if (path.endsWith('/actions/workflows/preview.yml/runs'))
    return response({ workflow_runs: [workflowRun] })
  if (path.endsWith('/actions/runs/12/artifacts'))
    return response({
      artifacts: [
        {
          id: 99,
          name: 'preview-receipt-12-2',
          expired: false,
          created_at: '2026-10-05T10:31:00Z',
        },
      ],
    })
  if (path.endsWith('/actions/runs/12/attempts/2')) return response(workflowRun)
  if (path.endsWith('/actions/runs/12/attempts/2/jobs'))
    return response({
      jobs: [
        { name: 'Terraform preview', conclusion: 'success' },
        { name: 'Ansible preview', conclusion: 'success' },
      ],
    })
  return new Response('', { status: 404 })
}

beforeEach(async (): Promise<void> => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
  synthetic.plan = JSON.stringify({ format_version: '1.2', complete: true })
  synthetic.archives.length = 0
  synthetic.receipts.length = 0
  synthetic.downloads.length = 0
  synthetic.mainSha = 'merge'
  synthetic.api.clear()
  synthetic.failingPath = ''
  synthetic.missingArchive = false
  vi.clearAllMocks()
  vi.mocked(core.getInput).mockReturnValue('')
  await mkdir('.ci/private', { recursive: true })
  await mkdir('.ci/reports', { recursive: true })
  await writeFile(
    '.ci/private/event.json',
    JSON.stringify({
      pull_request: {
        ...pr,
        merged_at: null,
        merged_by: null,
        merge_commit_sha: null,
      },
    }),
  )
  await writeFile('.ci/reports/test-summary.md', '')
  vi.stubEnv('GITHUB_EVENT_PATH', resolve('.ci/private/event.json'))
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo')
  vi.stubEnv('GITHUB_SHA', 'merge')
  vi.stubEnv('GITHUB_RUN_ID', '12')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
  vi.stubEnv('TERRAFORM_DELIVERY_HMAC_KEY', 'synthetic-signing-key')
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-token')
  vi.stubEnv('GITHUB_STEP_SUMMARY', resolve('.ci/reports/test-summary.md'))
  vi.mocked(run).mockImplementation((command: string[]): string => {
    if (command[0] === 'git') {
      if (command.includes('HEAD^1')) return 'base\n'
      if (command.includes('HEAD^2')) return 'head\n'
      if (command.includes('HEAD^{tree}')) return 'tree\n'
      if (command.includes('ls-tree'))
        return 'tests/fixtures/terraform/root/root.json\ntests/fixtures/terraform/root/main.tf\n'
    }
    if (command.includes('version'))
      return JSON.stringify({
        terraform_version: '1.16.5',
        platform: 'linux_amd64',
      })
    if (command.includes('show')) return synthetic.plan
    return ''
  })
  vi.mocked(runTerraform).mockImplementation(
    async (command: string[]): Promise<void> => {
      const output = command.find((part): boolean => part.startsWith('-out='))
      if (output !== undefined) await writeFile(output.slice(5), 'saved-plan')
    },
  )
  vi.stubGlobal('fetch', (input: unknown): Promise<Response> => {
    return Promise.resolve(githubResponse(new URL(String(input))))
  })
})
afterEach((): void => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('synthetic end-to-end delivery contract', (): void => {
  it('previews, verifies exact owner merge and applies the same saved plan', async (): Promise<void> => {
    const report = new Report()
    const delivery = await Delivery.create('tests/fixtures/config.json', report)
    await delivery.preview()
    expect(
      await readFile('.ci/reports/preview-receipt.json', 'utf8'),
    ).toContain('"version": 2')
    await delivery.gate()
    expect(core.setOutput).toHaveBeenCalledWith('preview_artifact', '99')
    await delivery.deploy()
    expect(core.setOutput).toHaveBeenCalledWith('admitted', 'true')
    expect(synthetic.archives).toEqual(['root', 'root'])
    expect(synthetic.receipts.at(-1)).toContain('"status":"finished"')
    await report.write()
    expect(await readFile('.ci/reports/test-summary.md', 'utf8')).toContain(
      'Terraform root',
    )
    expect(core.notice).toHaveBeenCalledWith(
      'Owner merge and latest exact preview verified',
    )
  })

  it('rejects changed fresh plans before state backup or apply', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await delivery.preview()
    await delivery.gate()
    synthetic.plan = JSON.stringify({
      format_version: '1.2',
      complete: true,
      resource_changes: [
        {
          address: 'synthetic.resource',
          change: { actions: ['create'], after: { value: 'different' } },
        },
      ],
    })
    await expect(delivery.deploy()).rejects.toThrow('differs')
    expect(synthetic.archives).toEqual([])
  })

  it('checks no-change and offers non-destructive archive CLI operations', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await delivery.checkNoChanges()
    await delivery.backup('root')
    await delivery.download(
      'root',
      'history/root/archive.tfstate',
      '.ci/private/download.tfstate',
    )
    expect(synthetic.downloads).toEqual(['history/root/archive.tfstate'])
    await expect(
      delivery.download(
        'root',
        'history/other/archive.tfstate',
        '.ci/private/file',
      ),
    ).rejects.toThrow('does not belong')
    synthetic.plan = JSON.stringify({
      format_version: '1.2',
      complete: true,
      output_changes: { result: { actions: ['create'], after: 'value' } },
    })
    await expect(delivery.checkNoChanges()).rejects.toThrow('requires no')
  })

  it('writes a summary and annotation when an operation fails', async (): Promise<void> => {
    await execute('unsupported', 'tests/fixtures/config.json', [])
    expect(core.setFailed).toHaveBeenCalledWith(
      'Unsupported Terraform delivery operation',
    )
    expect(await readFile('.ci/reports/test-summary.md', 'utf8')).toContain(
      'failed',
    )
  })

  it('skips stale main before reading PR or state', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    synthetic.mainSha = 'new-main'
    await delivery.gate()
    await delivery.deploy()
    expect(core.setOutput).toHaveBeenCalledWith('stale', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('admitted', 'false')
    expect(synthetic.archives).toEqual([])
  })

  it('rejects non-owner merges, absent receipts and failed latest previews', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    const prefix = '/repos/owner/repo'
    synthetic.api.set(`${prefix}/commits/merge/pulls`, [])
    await expect(delivery.gate()).rejects.toThrow('exactly one')
    synthetic.api.delete(`${prefix}/commits/merge/pulls`)
    synthetic.api.set(`${prefix}/pulls/7`, {
      ...pr,
      merged_by: { login: 'other' },
    })
    await expect(delivery.gate()).rejects.toThrow('configured owner')
    synthetic.api.delete(`${prefix}/pulls/7`)
    synthetic.api.set(`${prefix}/actions/workflows/preview.yml/runs`, {
      workflow_runs: [{ ...workflowRun, conclusion: 'failure' }],
    })
    await expect(delivery.gate()).rejects.toThrow('not successful')
    synthetic.api.delete(`${prefix}/actions/workflows/preview.yml/runs`)
    synthetic.api.set(`${prefix}/actions/runs/12/artifacts`, { artifacts: [] })
    await expect(delivery.gate()).rejects.toThrow('artifact is missing')
  })

  it('rejects GitHub API failure and an unavailable token', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    synthetic.failingPath = '/repos/owner/repo/git/ref/heads/main'
    await expect(delivery.gate()).rejects.toThrow('request failed (500)')
    synthetic.failingPath = ''
    vi.stubEnv('GITHUB_TOKEN', '')
    await expect(delivery.gate()).rejects.toThrow('token is required')
  })

  it('rejects changed signatures, unsupported format and failed exact jobs', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await delivery.preview()
    await delivery.gate()
    const receiptPath = '.ci/reports/preview-receipt.json'
    const original = await readFile(receiptPath, 'utf8')
    await writeFile(
      receiptPath,
      original.replace('"signature": "', '"signature": "0'),
    )
    await expect(delivery.deploy()).rejects.toThrow('signature')
    await writeFile(receiptPath, original)
    const parsed: unknown = JSON.parse(original)
    if (typeof parsed !== 'object' || parsed === null || !('payload' in parsed))
      throw new Error('Invalid test receipt')
    const payload = parsed.payload
    if (typeof payload !== 'object' || payload === null)
      throw new Error('Invalid test payload')
    const obsolete = { ...payload, version: 1 }
    await writeFile(
      receiptPath,
      JSON.stringify({
        payload: obsolete,
        signature: sign(obsolete, 'synthetic-signing-key'),
      }),
    )
    await expect(delivery.deploy()).rejects.toThrow(
      'Unsupported preview receipt format',
    )
    await writeFile(receiptPath, original)
    synthetic.api.set('/repos/owner/repo/actions/runs/12/attempts/2/jobs', {
      jobs: [{ name: 'Terraform preview', conclusion: 'failure' }],
    })
    await expect(delivery.deploy()).rejects.toThrow('Required preview job')
  })

  it('dispatches every CLI operation and rejects missing arguments', async (): Promise<void> => {
    await execute('validate-config', 'tests/fixtures/config.json', [])
    expect(core.setOutput).toHaveBeenCalledWith('roots', 'root')
    await execute('preview', 'tests/fixtures/config.json', [])
    await execute('gate', 'tests/fixtures/config.json', [])
    await execute('deploy', 'tests/fixtures/config.json', [])
    await execute('check-no-changes', 'tests/fixtures/config.json', [])
    await execute('backup', 'tests/fixtures/config.json', ['root'])
    await execute('download', 'tests/fixtures/config.json', [
      'root',
      'history/root/archive.tfstate',
      '.ci/private/download.tfstate',
    ])
    expect(core.setFailed).not.toHaveBeenCalled()
    await execute('backup', 'tests/fixtures/config.json', [])
    await execute('download', 'tests/fixtures/config.json', ['root'])
    expect(core.setFailed).toHaveBeenCalledWith('Usage: backup ROOT')
    expect(core.setFailed).toHaveBeenCalledWith(
      'Usage: download ROOT HISTORY_KEY NEW_OUTPUT_PATH',
    )
  })

  it('rejects unconfigured roots before touching the state API', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await expect(delivery.backup('other')).rejects.toThrow('configured')
    await expect(
      delivery.download('other', 'history/other/a.tfstate', '.ci/private/file'),
    ).rejects.toThrow('configured')
    synthetic.missingArchive = true
    await expect(delivery.backup('root')).rejects.toThrow(
      'Active state is missing',
    )
  })

  it('bounds job summaries and supports local execution without summary env', async (): Promise<void> => {
    const report = new Report()
    report.add('a'.repeat(61_000))
    report.add('omitted-marker')
    await report.write()
    expect(await readFile('.ci/reports/test-summary.md', 'utf8')).not.toContain(
      'omitted-marker',
    )
    vi.stubEnv('GITHUB_STEP_SUMMARY', '')
    await expect(report.write()).resolves.toBeUndefined()
  })

  it('orders multiple configured roots deterministically', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/multi-config.json',
      new Report(),
    )
    await delivery.checkNoChanges()
    expect(
      vi
        .mocked(runTerraform)
        .mock.calls.filter(([command]): boolean => command.includes('init'))
        .map(([command]): string => command[1] ?? ''),
    ).toEqual([
      `-chdir=${process.cwd()}/tests/fixtures/multi/a`,
      `-chdir=${process.cwd()}/tests/fixtures/multi/b`,
    ])
  })

  it('accepts an explicit action token instead of the environment fallback', async (): Promise<void> => {
    vi.mocked(core.getInput).mockImplementation((name: string): string =>
      name === 'token' ? 'input-token' : '',
    )
    vi.stubEnv('GITHUB_TOKEN', '')
    vi.stubEnv('GITHUB_API_URL', undefined)
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await delivery.gate()
    expect(core.setOutput).toHaveBeenCalledWith('stale', 'false')
  })

  it('rejects a preview checkout that differs from its PR event', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    vi.mocked(run).mockImplementationOnce((): string => 'wrong')
    await expect(delivery.preview()).rejects.toThrow('checkout does not match')
  })

  it('validates every GitHub API response field before admitting a merge', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    const prefix = '/repos/owner/repo'
    synthetic.api.set(`${prefix}/git/ref/heads/main`, {})
    await expect(delivery.gate()).rejects.toThrow('incomplete')
    synthetic.api.delete(`${prefix}/git/ref/heads/main`)
    synthetic.api.set(`${prefix}/commits/merge/pulls`, {})
    await expect(delivery.gate()).rejects.toThrow('invalid')
    synthetic.api.delete(`${prefix}/commits/merge/pulls`)
    synthetic.api.set(`${prefix}/actions/runs/12/artifacts`, {
      artifacts: [
        {
          id: 'bad',
          name: 'preview-receipt-12-2',
          expired: false,
          created_at: '2026-10-05T10:31:00Z',
        },
      ],
    })
    await expect(delivery.gate()).rejects.toThrow('invalid')
    synthetic.api.set(`${prefix}/actions/runs/12/artifacts`, {
      artifacts: [
        { id: 99, name: 'preview-receipt-12-2', expired: false, created_at: 3 },
      ],
    })
    await expect(delivery.gate()).rejects.toThrow('invalid')
    synthetic.api.delete(`${prefix}/actions/runs/12/artifacts`)
    vi.stubEnv('GITHUB_REPOSITORY', '')
    await expect(delivery.gate()).rejects.toThrow(
      'GITHUB_REPOSITORY is required',
    )
  })

  it('rejects incomplete GitHub pagination instead of using an older run', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    const runs: unknown[] = []
    for (let index = 0; index < 100; index++)
      runs.push({ ...workflowRun, id: index + 1 })
    synthetic.api.set('/repos/owner/repo/actions/workflows/preview.yml/runs', {
      workflow_runs: runs,
    })
    await expect(delivery.gate()).rejects.toThrow('pagination was incomplete')
  })

  it('rejects a signed receipt with an invalid root name', async (): Promise<void> => {
    const delivery = await Delivery.create(
      'tests/fixtures/config.json',
      new Report(),
    )
    await delivery.preview()
    await delivery.gate()
    const path = '.ci/reports/preview-receipt.json'
    const receipt: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof receipt !== 'object' ||
      receipt === null ||
      !('payload' in receipt)
    )
      throw new Error('Invalid test receipt')
    const payload = receipt.payload
    if (typeof payload !== 'object' || payload === null)
      throw new Error('Invalid test payload')
    const changed = { ...payload, roots: { 'bad/root': {} } }
    await writeFile(
      path,
      JSON.stringify({
        payload: changed,
        signature: sign(changed, 'synthetic-signing-key'),
      }),
    )
    await expect(delivery.deploy()).rejects.toThrow('invalid root')
  })

  it('keeps error summaries generic for malformed input and non-error throws', async (): Promise<void> => {
    await writeFile('.ci/private/malformed.json', '{')
    await execute('check-no-changes', '.ci/private/malformed.json', [])
    expect(core.setFailed).toHaveBeenCalledWith(
      'Terraform delivery failed; external response withheld',
    )
    vi.mocked(runTerraform).mockImplementationOnce((): Promise<void> => {
      // A tool adapter can reject with a non-Error value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject('synthetic-secret')
    })
    await execute('check-no-changes', 'tests/fixtures/config.json', [])
    expect(core.setFailed).toHaveBeenCalledWith(
      'Terraform delivery failed; external details withheld',
    )
    expect(await readFile('.ci/reports/test-summary.md', 'utf8')).not.toContain(
      'synthetic-secret',
    )
  })
})
