import { describe, expect, it } from 'vitest'
import {
  applyAll,
  type OperationStore,
  type SavedPlan,
} from '../src/operation.ts'
import { sha256 } from '../src/plan-contract.ts'

const plans: Record<string, SavedPlan> = {
  a: {
    contract: 'a-contract',
    savedPlan: sha256('a'),
    stateKey: 'a/state.tfstate',
    allowInitialState: false,
    noChanges: false,
  },
  b: {
    contract: 'b-contract',
    savedPlan: sha256('b'),
    stateKey: 'b/state.tfstate',
    allowInitialState: false,
    noChanges: false,
  },
}
const identity = { sha: 'sha', runId: '1', runAttempt: '1' }
function fakeStore(): OperationStore & {
  records: string[]
  backups: string[]
} {
  const records: string[] = []
  const backups: string[] = []
  return {
    records,
    backups,
    assertReconciled: (): Promise<void> => Promise.resolve(),
    backup: (
      root: string,
    ): Promise<{
      key: string
      sha256: string
      serial: number
      lineage: string
    }> => {
      backups.push(root)
      return Promise.resolve({
        key: `${root}/${backups.length.toString()}`,
        sha256: 'hash',
        serial: 1,
        lineage: 'lineage',
      })
    },
    put: (key: string, body: string): Promise<void> => {
      expect(key).toContain('operations/deploy/')
      records.push(body)
      return Promise.resolve()
    },
  }
}
function dependencies(applied: string[]): {
  current(): Promise<boolean>
  planBytes(root: string): Promise<Buffer>
  apply(root: string): Promise<void>
  report(message: string): Promise<void>
} {
  return {
    current: (): Promise<boolean> => Promise.resolve(true),
    planBytes: (root: string): Promise<Buffer> =>
      Promise.resolve(Buffer.from(root)),
    apply: (root: string): Promise<void> => {
      applied.push(root)
      return Promise.resolve()
    },
    report: (): Promise<void> => Promise.resolve(),
  }
}

describe('durable sequential apply', (): void => {
  it('blocks pending operations before any state archive', async (): Promise<void> => {
    const store = fakeStore()
    store.assertReconciled = (): Promise<void> =>
      Promise.reject(new Error('recovery'))
    const applied: string[] = []
    await expect(
      applyAll(store, plans, identity, dependencies(applied)),
    ).rejects.toThrow('recovery')
    expect(store.backups).toEqual([])
    expect(applied).toEqual([])
  })

  it('archives all before states, applies in order and archives after states', async (): Promise<void> => {
    const store = fakeStore()
    const applied: string[] = []
    expect(await applyAll(store, plans, identity, dependencies(applied))).toBe(
      true,
    )
    expect(applied).toEqual(['a', 'b'])
    expect(store.backups).toEqual(['a', 'b', 'a', 'b'])
    expect(store.records[0]).toContain('"status":"started"')
    expect(store.records.at(-1)).toContain('"status":"finished"')
  })

  it('stops after a failed apply and leaves a recovery receipt', async (): Promise<void> => {
    const store = fakeStore()
    const applied: string[] = []
    const actions = dependencies(applied)
    actions.apply = (root: string): Promise<void> => {
      applied.push(root)
      return Promise.reject(new Error('apply failed'))
    }
    await expect(applyAll(store, plans, identity, actions)).rejects.toThrow(
      'apply failed',
    )
    expect(applied).toEqual(['a'])
    expect(store.backups).toEqual(['a', 'b', 'a'])
    expect(store.records.at(-1)).toContain('"status":"recovery-required"')
  })

  it('does not apply when main advanced after preflight', async (): Promise<void> => {
    const store = fakeStore()
    const applied: string[] = []
    const actions = dependencies(applied)
    actions.current = (): Promise<boolean> => Promise.resolve(false)
    expect(await applyAll(store, plans, identity, actions)).toBe(false)
    expect(applied).toEqual([])
    expect(store.records.at(-1)).toContain('"result":"stale-before-apply"')
  })

  it('detects a corrupted saved plan before the first apply', async (): Promise<void> => {
    const store = fakeStore()
    const applied: string[] = []
    const actions = dependencies(applied)
    actions.planBytes = (): Promise<Buffer> =>
      Promise.resolve(Buffer.from('corrupt'))
    await expect(applyAll(store, plans, identity, actions)).rejects.toThrow(
      'checksum',
    )
    expect(applied).toEqual([])
    expect(store.records.at(-1)).toContain('"status":"recovery-required"')
  })
})
