import { describe, expect, it } from 'vitest'
import {
  canonical,
  contractHash,
  inspectPlan,
  renderScope,
  requireNoChanges,
  requireSamePlans,
  reviewAddress,
  sha256,
  sign,
  verify,
} from '../src/plan-contract.ts'

function raw(patch: object = {}): string {
  return JSON.stringify({ format_version: '1.2', complete: true, ...patch })
}
function change(patch: object = {}): object {
  return {
    address: 'example.resource',
    change: {
      actions: ['update'],
      before: { value: 'old' },
      after: { value: 'new' },
      ...patch,
    },
  }
}

describe('Terraform plan contract', (): void => {
  it('signs canonical data and verifies exact receipts', (): void => {
    const payload = { b: 2, a: [1, null] }
    expect(canonical(payload)).toBe('{"a":[1,null],"b":2}')
    expect(canonical(true)).toBe('true')
    expect((): string => canonical(undefined)).toThrow()
    expect(sha256('a')).toHaveLength(64)
    const signature = sign(payload, 'key')
    expect(verify({ payload, signature }, 'key')).toEqual(payload)
    expect((): unknown => verify({ payload, signature: 'x' }, 'key')).toThrow(
      'signature',
    )
    expect((): unknown =>
      verify({ payload: { b: 3 }, signature }, 'key'),
    ).toThrow('signature')
    expect((): unknown => verify({}, 'key')).toThrow()
  })
  it('preserves lossless values and all semantic contract fields', (): void => {
    const baseline = inspectPlan(
      raw({
        resource_changes: [change()],
        variables: { input: { value: 'x' } },
        output_changes: { result: { actions: ['update'], after: 1 } },
        checks: [{ status: 'pass' }],
      }),
    )
    expect(baseline.summary).toEqual({ resourceChanges: 1, outputChanges: 1 })
    expect(baseline.scope.resources).toHaveLength(1)
    expect(baseline.scope.outputs).toHaveLength(1)
    expect(contractHash(baseline.contract, 'key')).not.toBe(
      contractHash(
        inspectPlan(
          raw({ resource_changes: [change({ after: { value: 'changed' } })] }),
        ).contract,
        'key',
      ),
    )
    const large = inspectPlan(
      '{"format_version":"1.2","complete":true,"output_changes":{"n":{"actions":["update"],"after":9007199254740993}}}',
    )
    expect(canonical(large.contract)).toContain('9007199254740993')
  })
  it('rejects unsupported and incomplete plan data', (): void => {
    for (const value of [
      '{bad',
      raw({ format_version: '2.0' }),
      raw({ complete: false }),
      raw({ errored: true }),
      raw({ deferred_changes: [{}] }),
    ]) {
      expect((): unknown => inspectPlan(value)).toThrow()
    }
    expect((): unknown => inspectPlan('{}')).toThrow()
    expect((): unknown =>
      inspectPlan(
        raw({ resource_changes: [{ address: 'x', change: { actions: [] } }] }),
      ),
    ).toThrow()
  })
  it('requires exact root sets and contract hashes', (): void => {
    expect((): void => {
      requireSamePlans({ a: { contract: 'x' } }, { a: { contract: 'x' } })
    }).not.toThrow()
    expect((): void => {
      requireSamePlans({ a: { contract: 'x' } }, { b: { contract: 'x' } })
    }).toThrow('root set')
    expect((): void => {
      requireSamePlans({ a: { contract: 'x' } }, { a: { contract: 'y' } })
    }).toThrow('differs')
  })
  it('rejects every mutation class in the no-change gate', (): void => {
    const unchanged = inspectPlan(
      raw({
        resource_changes: [
          { address: 'example.ok', change: { actions: ['no-op'] } },
        ],
      }),
    ).contract
    expect((): void => {
      requireNoChanges(unchanged)
    }).not.toThrow()
    for (const plan of [
      { resource_changes: [change()] },
      {
        resource_changes: [
          {
            address: 'example.ok',
            change: { actions: ['no-op'], importing: { id: 'private' } },
          },
        ],
      },
      {
        resource_changes: [
          {
            address: 'example.ok',
            previous_address: 'example.old',
            change: { actions: ['no-op'] },
          },
        ],
      },
      { output_changes: { result: { actions: ['update'] } } },
      { resource_drift: [change()] },
    ])
      expect((): void => {
        requireNoChanges(inspectPlan(raw(plan)).contract)
      }).toThrow()
  })
  it('redacts string instance keys and validates safe addresses', (): void => {
    expect(reviewAddress('module.a.example.resource["private.key"]')).toBe(
      'module.a.example.resource[redacted]',
    )
    expect(reviewAddress('example.resource[10]')).toBe('example.resource[10]')
    expect((): string => reviewAddress('bad\n::error::')).toThrow()
  })
  it('renders safe review scope with imports, moves, outputs and drift', (): void => {
    const plan = inspectPlan(
      raw({
        resource_changes: [
          {
            address: 'example.resource["secret"]',
            previous_address: 'example.old["secret"]',
            change: { actions: ['no-op'], importing: { id: 'secret' } },
          },
        ],
        output_changes: {
          output: { actions: ['update'], after: 'secret-value' },
        },
        resource_drift: [change()],
      }),
    )
    const text = renderScope('root', plan.scope)
    expect(text).toContain('Resource actions')
    expect(text).toContain('Observed drift')
    expect(text).toContain('Output actions')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('secret.key')
    expect(renderScope('root', inspectPlan(raw()).scope)).toContain(
      'No resource actions',
    )
  })
  it('rejects malformed field types and handles absent optional data', (): void => {
    for (const value of [
      raw({ format_version: 1 }),
      raw({ resource_changes: {} }),
      raw({ output_changes: [] }),
      raw({
        resource_changes: [{ address: 'a', change: { actions: 'update' } }],
      }),
      raw({ resource_changes: [null] }),
    ])
      expect((): unknown => inspectPlan(value)).toThrow()
    expect(
      renderScope('root', {
        resources: [
          {
            ordinal: 1,
            address: 'a',
            actions: ['update'],
            imported: false,
            moved: true,
          },
        ],
        outputs: [],
        drift: [],
      }),
    ).toContain('Move from')
  })
  it('rejects an invalid resource object', (): void => {
    expect((): void => {
      requireNoChanges({
        variables: {},
        resources: [null],
        outputs: {},
        drift: [],
        checks: [],
      })
    }).toThrow()
  })
  it('sorts resource, output, and drift rows deterministically', (): void => {
    const plan = inspectPlan(
      raw({
        resource_changes: [
          { address: 'z.x', change: { actions: ['update'] } },
          { address: 'a.x', change: { actions: ['update'] } },
        ],
        resource_drift: [
          { address: 'z.y', change: { actions: ['update'] } },
          { address: 'a.y', change: { actions: ['update'] } },
        ],
        output_changes: {
          z: { actions: ['update'] },
          a: { actions: ['update'] },
        },
      }),
    )
    expect(plan.scope.resources.map((row): string => row.address)).toEqual([
      'a.x',
      'z.x',
    ])
    expect(plan.scope.drift.map((row): string => row.address)).toEqual([
      'a.y',
      'z.y',
    ])
    expect(plan.scope.outputs.map((row): string => row.name)).toEqual([
      'a',
      'z',
    ])
  })
  it('caps public summary rows while retaining the full private contract', (): void => {
    const resources: {
      ordinal: number
      address: string
      actions: string[]
      imported: boolean
      moved: boolean
    }[] = []
    const outputs: { name: string; actions: string[] }[] = []
    for (let index = 0; index < 101; index++) {
      resources.push({
        ordinal: index + 1,
        address: `example.resource${index.toString()}`,
        actions: ['create'],
        imported: false,
        moved: false,
      })
      outputs.push({
        name: `output${index.toString()}`,
        actions: ['update'],
      })
    }
    const scope = {
      resources,
      outputs,
      drift: [],
    }
    const summary = renderScope('root', scope)
    expect(summary).toContain('Additional 1 rows omitted')
    expect(summary).toContain('Additional 1 output rows omitted')
    expect(summary).not.toContain('example.resource100')
  })
  it('rejects malformed actions and output names before publication', (): void => {
    expect((): unknown =>
      inspectPlan(
        raw({
          resource_changes: [
            { address: 'example.a', change: { actions: ['unknown'] } },
          ],
        }),
      ),
    ).toThrow('unsupported')
    expect((): unknown =>
      inspectPlan(
        raw({ output_changes: { 'bad|name': { actions: ['update'] } } }),
      ),
    ).toThrow('output name')
    expect((): unknown =>
      inspectPlan(raw({ output_changes: { ok: { actions: ['unknown'] } } })),
    ).toThrow('unsupported')
  })
})
