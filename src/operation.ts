import { sha256 } from './plan-contract.ts'
import type { Archive } from './state-store.ts'

export interface SavedPlan {
  contract: string
  savedPlan: string
  stateKey: string
  allowInitialState: boolean
  noChanges: boolean
}
export interface OperationIdentity {
  sha: string
  runId: string
  runAttempt: string
}
type Backup = Archive | { missing: true; stateKey: string }
export interface OperationStore {
  assertReconciled(): Promise<void>
  backup(root: string, key: string, allowMissing?: boolean): Promise<Backup>
  put(
    key: string,
    body: string,
    options?: { IfNoneMatch?: string },
  ): Promise<void>
}
export interface OperationDependencies {
  current(): Promise<boolean>
  planBytes(root: string): Promise<Buffer>
  apply(root: string): Promise<void>
  report(message: string): Promise<void>
}
interface RootOperation {
  before: Backup
  savedPlan: string
  result?: 'applying' | 'success' | 'failed'
  after?: Backup
}
interface OperationRecord extends OperationIdentity {
  status: 'started' | 'finished' | 'recovery-required'
  result?: 'stale-before-apply'
  roots: Record<string, RootOperation>
}

export async function applyAll(
  store: OperationStore,
  plans: Record<string, SavedPlan>,
  identity: OperationIdentity,
  dependencies: OperationDependencies,
): Promise<boolean> {
  await store.assertReconciled()
  const operationKey = `operations/deploy/${identity.runId}-${identity.runAttempt}.json`
  const record: OperationRecord = {
    ...identity,
    status: 'started',
    roots: {},
  }
  const prepared: { root: string; plan: SavedPlan; receipt: RootOperation }[] =
    []
  for (const [root, plan] of Object.entries(plans).sort(([a], [b]): number =>
    a.localeCompare(b),
  )) {
    const receipt: RootOperation = {
      before: await store.backup(root, plan.stateKey, plan.allowInitialState),
      savedPlan: plan.savedPlan,
    }
    record.roots[root] = receipt
    prepared.push({ root, plan, receipt })
  }
  await store.put(operationKey, JSON.stringify(record), { IfNoneMatch: '*' })
  try {
    if (!(await dependencies.current())) {
      record.status = 'finished'
      record.result = 'stale-before-apply'
      await store.put(operationKey, JSON.stringify(record))
      await dependencies.report(
        'Main advanced before apply; deployment skipped.',
      )
      return false
    }
    for (const { root, plan, receipt } of prepared) {
      if (sha256(await dependencies.planBytes(root)) !== plan.savedPlan)
        throw new Error('Saved plan checksum changed')
      receipt.result = 'applying'
      await store.put(operationKey, JSON.stringify(record))
      try {
        await dependencies.apply(root)
        receipt.result = 'success'
      } catch (error) {
        receipt.result = 'failed'
        throw error
      } finally {
        receipt.after = await store.backup(root, plan.stateKey)
        await store.put(operationKey, JSON.stringify(record))
      }
    }
    record.status = 'finished'
    await store.put(operationKey, JSON.stringify(record))
    await dependencies.report(
      'All exact fresh Terraform plans applied and states archived.',
    )
    return true
  } catch (error) {
    record.status = 'recovery-required'
    await store.put(operationKey, JSON.stringify(record))
    throw error
  }
}
