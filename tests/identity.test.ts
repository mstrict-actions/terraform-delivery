import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import {
  assertOwnerPR,
  isPreviewRun,
  latestPreview,
  parsePullRequest,
  parseReceiptPayload,
  parseWorkflowRun,
  requirePreviewIdentity,
  requireRetainedRoots,
} from '../src/identity.ts'

const rawPr = {
  number: 7,
  user: { login: 'owner' },
  head: { sha: 'head', repo: { full_name: 'owner/repo' } },
  base: {
    sha: 'base',
    ref: 'main',
    repo: { full_name: 'owner/repo' },
  },
  merged_at: '2026-10-05T11:00:00Z',
  merge_commit_sha: 'merge',
  merged_by: { login: 'owner' },
}
const rawRun = {
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
  pull_requests: [{ number: 7 }],
}
const rawReceipt = {
  version: 2,
  createdAt: '2026-10-05T10:00:00Z',
  repository: 'owner/repo',
  workflow: 'preview.yml',
  runId: '12',
  runAttempt: '2',
  pr: 7,
  head: 'head',
  base: 'base',
  testedTree: 'tree',
  binding: {
    files: { 'tools.json': 'digest' },
    terraform: { version: '1.16.5', platform: 'linux_amd64' },
    node: 'v26.0.0',
  },
  roots: { root: { contract: 'hash' } },
}

describe('exact preview identity', (): void => {
  it('parses the API response and enforces the owner and repository', async (): Promise<void> => {
    const config = await loadConfig('tests/fixtures/config.json')
    const pr = parsePullRequest(rawPr)
    assertOwnerPR(pr, 'owner/repo', config)
    expect((): void => {
      assertOwnerPR({ ...pr, user: { login: 'other' } }, 'owner/repo', config)
    }).toThrow('owner-authored')
    expect((): void => {
      assertOwnerPR(pr, 'other/repo', config)
    }).toThrow('same-repository')
    expect((): unknown =>
      parsePullRequest({ ...rawPr, merged_by: { login: 1 } }),
    ).toThrow('invalid')
    expect((): unknown =>
      parsePullRequest({ ...rawPr, merged_at: null }),
    ).not.toThrow()
  })

  it('never falls back from the latest failed or post-merge rerun', async (): Promise<void> => {
    const config = await loadConfig('tests/fixtures/config.json')
    const pr = parsePullRequest(rawPr)
    const green = parseWorkflowRun(rawRun)
    expect(isPreviewRun(green, pr, config)).toBe(true)
    expect(latestPreview([green], pr, config).id).toBe(12)
    expect((): unknown =>
      latestPreview(
        [
          green,
          parseWorkflowRun({
            ...rawRun,
            id: 13,
            conclusion: 'failure',
            created_at: '2026-10-05T10:00:00Z',
          }),
        ],
        pr,
        config,
      ),
    ).toThrow('not successful')
    expect((): unknown =>
      latestPreview(
        [parseWorkflowRun({ ...rawRun, updated_at: '2026-10-05T11:01:00Z' })],
        pr,
        config,
      ),
    ).toThrow('not successful')
    expect((): unknown => latestPreview([], pr, config)).toThrow('No exact')
    expect((): unknown =>
      latestPreview(
        [parseWorkflowRun({ ...rawRun, pull_requests: [{ number: 8 }] })],
        pr,
        config,
      ),
    ).toThrow('not successful')
    expect((): unknown =>
      parseWorkflowRun({ ...rawRun, pull_requests: null }),
    ).toThrow('association')
  })

  it('binds receipt version, time, tree, parent, run, attempt and tools', async (): Promise<void> => {
    const config = await loadConfig('tests/fixtures/config.json')
    const pr = parsePullRequest(rawPr)
    const run = parseWorkflowRun(rawRun)
    const receipt = parseReceiptPayload(rawReceipt)
    const context = {
      pr,
      run,
      repository: 'owner/repo',
      parent: 'base',
      tree: 'tree',
      binding: receipt.binding,
      config,
      now: Date.parse('2026-10-05T12:00:00Z'),
    }
    requirePreviewIdentity(receipt, context)
    for (const patch of [
      { head: 'other' },
      { base: 'other' },
      { testedTree: 'other' },
      { runId: '13' },
      { runAttempt: '1' },
      { binding: { ...receipt.binding, node: 'other' } },
      { createdAt: '2026-09-20T10:00:00Z' },
      { createdAt: '2026-10-06T10:00:00Z' },
    ]) {
      expect((): void => {
        requirePreviewIdentity({ ...receipt, ...patch }, context)
      }).toThrow()
    }
    expect((): unknown =>
      parseReceiptPayload({ ...rawReceipt, version: 1 }),
    ).toThrow('Unsupported')
    expect((): void => {
      requirePreviewIdentity(receipt, {
        ...context,
        run: { ...run, updated_at: '2026-10-05T11:01:00Z' },
      })
    }).toThrow()
  })

  it('requires explicit retirement for removed Terraform roots', (): void => {
    requireRetainedRoots(['a'], ['a', 'b'])
    expect((): void => {
      requireRetainedRoots(['a', 'b'], ['a'])
    }).toThrow('retirement')
  })

  it('rejects malformed API and receipt fields without trusting their shape', async (): Promise<void> => {
    const config = await loadConfig('tests/fixtures/config.json')
    const pr = parsePullRequest(rawPr)
    const run = parseWorkflowRun(rawRun)
    expect((): unknown =>
      parseReceiptPayload({
        ...rawReceipt,
        binding: { ...rawReceipt.binding, files: null },
      }),
    ).toThrow('binding')
    expect((): unknown => parsePullRequest({ ...rawPr, number: '7' })).toThrow(
      'invalid',
    )
    expect((): unknown => parsePullRequest({ ...rawPr, base: {} })).toThrow(
      'incomplete',
    )
    expect((): unknown =>
      parseWorkflowRun({ ...rawRun, conclusion: null }),
    ).not.toThrow()
    const unmerged = parsePullRequest({ ...rawPr, merged_at: null })
    expect((): unknown => latestPreview([run], unmerged, config)).toThrow(
      'not been merged',
    )
    const receipt = parseReceiptPayload(rawReceipt)
    expect((): void => {
      requirePreviewIdentity(receipt, {
        pr: unmerged,
        run,
        repository: 'owner/repo',
        parent: 'base',
        tree: 'tree',
        binding: receipt.binding,
        config,
      })
    }).toThrow('not been merged')
    expect(
      latestPreview(
        [
          parseWorkflowRun({ ...rawRun, id: 11 }),
          parseWorkflowRun({ ...rawRun, id: 12 }),
        ],
        pr,
        config,
      ).id,
    ).toBe(12)
  })
})
