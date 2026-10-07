import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { LosslessNumber, parse } from 'lossless-json'

export interface Contract {
  variables: unknown
  resources: unknown[]
  outputs: Record<string, unknown>
  drift: unknown[]
  checks: unknown
}
export interface ScopeRow {
  ordinal: number
  address: string
  actions: string[]
  imported: boolean
  moved: boolean
  previousAddress?: string
}
export interface Scope {
  resources: ScopeRow[]
  outputs: { name: string; actions: string[] }[]
  drift: ScopeRow[]
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function property(value: unknown, key: string): unknown {
  if (!object(value) || !(key in value))
    throw new Error(`Missing Terraform ${key}`)
  return value[key]
}
function optional(value: unknown, key: string): unknown {
  return object(value) ? value[key] : undefined
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected Terraform array')
  return Array.from(value, (item: unknown): unknown => item)
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected Terraform string')
  return value
}
function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error('Expected Terraform object')
  return value
}

export function canonical(value: unknown): string {
  if (value === undefined) throw new Error('Cannot canonicalize undefined')
  if (value instanceof LosslessNumber) return value.toString()
  if (Array.isArray(value)) return `[${array(value).map(canonical).join(',')}]`
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key): string => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  const result = JSON.stringify(value)
  return result
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
export function sign(payload: unknown, key: string): string {
  return createHmac('sha256', key).update(canonical(payload)).digest('hex')
}
export function verify(receipt: unknown, key: string): unknown {
  const payload = property(receipt, 'payload')
  const signature = optional(receipt, 'signature')
  const actual = sign(payload, key)
  if (
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(signature, 'hex'))
  )
    throw new Error('Preview receipt signature is invalid')
  return payload
}
export function contractHash(contract: Contract, key: string): string {
  return sign(contract, key)
}

function actions(row: unknown): string[] {
  const values = array(property(property(row, 'change'), 'actions'))
  if (
    values.length === 0 ||
    values.some((value): boolean => typeof value !== 'string')
  ) {
    throw new Error('Terraform change actions are invalid')
  }
  return values.map(string)
}
const allowedActions = new Set([
  'no-op',
  'create',
  'read',
  'update',
  'delete',
  'forget',
])
function reviewActions(values: string[]): string[] {
  if (values.some((value): boolean => !allowedActions.has(value))) {
    throw new Error('Terraform plan contains unsupported review actions')
  }
  return [...values]
}
export function reviewAddress(address: string): string {
  const redacted = address.replace(/\["(?:\\.|[^"\\])*"\]/g, '[redacted]')
  if (!/^[A-Za-z0-9_.[\]-]+$/.test(redacted)) {
    throw new Error('Terraform plan resource address has an unsupported form')
  }
  return redacted
}
function reviewResource(row: unknown, ordinal: number): ScopeRow {
  const previous = optional(row, 'previous_address')
  const importing = optional(property(row, 'change'), 'importing')
  return {
    ordinal,
    address: reviewAddress(string(property(row, 'address'))),
    actions: reviewActions(actions(row)),
    imported: importing !== undefined && importing !== null,
    moved: previous !== undefined && previous !== null,
    ...(previous === undefined || previous === null
      ? {}
      : { previousAddress: reviewAddress(string(previous)) }),
  }
}
function changed(row: unknown): boolean {
  const previous = optional(row, 'previous_address')
  const importing = optional(property(row, 'change'), 'importing')
  return (
    (previous !== undefined && previous !== null) ||
    (importing !== undefined && importing !== null) ||
    actions(row).some((action): boolean => action !== 'no-op')
  )
}
export function reviewScope(contract: Contract): Scope {
  const resources = contract.resources
    .filter(changed)
    .map((row, index): ScopeRow => reviewResource(row, index + 1))
  const outputs = Object.entries(contract.outputs)
    .filter(([, change]): boolean =>
      array(property(change, 'actions')).some(
        (action): boolean => action !== 'no-op',
      ),
    )
    .sort(([a], [b]): number => a.localeCompare(b))
    .map(([name, change]): { name: string; actions: string[] } => {
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new Error('Terraform output name has an unsupported form')
      return {
        name,
        actions: reviewActions(array(property(change, 'actions')).map(string)),
      }
    })
  const drift = [...contract.drift]
    .sort((a, b): number =>
      string(property(a, 'address')).localeCompare(
        string(property(b, 'address')),
      ),
    )
    .map((row, index): ScopeRow => reviewResource(row, index + 1))
  return { resources, outputs, drift }
}
export function inspectPlan(raw: string): {
  contract: Contract
  scope: Scope
  summary: { resourceChanges: number; outputChanges: number }
} {
  let plan: unknown
  try {
    plan = parse(raw)
  } catch {
    throw new Error('Terraform returned invalid plan JSON; output withheld')
  }
  if (!string(property(plan, 'format_version')).startsWith('1.'))
    throw new Error('Unsupported Terraform plan JSON format')
  if (
    optional(plan, 'errored') === true ||
    property(plan, 'complete') !== true ||
    (optional(plan, 'deferred_changes') !== undefined &&
      array(optional(plan, 'deferred_changes')).length > 0)
  ) {
    throw new Error('Terraform plan is incomplete or errored')
  }
  const resources = array(optional(plan, 'resource_changes') ?? []).sort(
    (a, b): number =>
      string(property(a, 'address')).localeCompare(
        string(property(b, 'address')),
      ),
  )
  const outputs = record(optional(plan, 'output_changes') ?? {})
  const contract: Contract = {
    variables: optional(plan, 'variables') ?? {},
    resources,
    outputs,
    drift: array(optional(plan, 'resource_drift') ?? []),
    checks: optional(plan, 'checks') ?? [],
  }
  const summary = {
    resourceChanges: resources.filter((row): boolean =>
      actions(row).some((action): boolean => action !== 'no-op'),
    ).length,
    outputChanges: Object.values(outputs).filter((row): boolean =>
      array(property(row, 'actions')).some(
        (action): boolean => action !== 'no-op',
      ),
    ).length,
  }
  return { contract, scope: reviewScope(contract), summary }
}
export function requireSamePlans(
  expected: Record<string, { contract: string }>,
  actual: Record<string, { contract: string }>,
): void {
  if (
    Object.keys(expected).sort().join('\n') !==
    Object.keys(actual).sort().join('\n')
  )
    throw new Error('Terraform root set changed since preview')
  for (const root of Object.keys(expected)) {
    if (expected[root]?.contract !== actual[root]?.contract)
      throw new Error(`Fresh ${root} plan differs from the reviewed preview`)
  }
}
export function requireNoChanges(contract: Contract): void {
  if (
    contract.resources.some(changed) ||
    Object.values(contract.outputs).some((row): boolean =>
      array(property(row, 'actions')).some(
        (action): boolean => action !== 'no-op',
      ),
    ) ||
    contract.drift.length > 0
  ) {
    throw new Error(
      'Migration gate requires no resource, output, import, move or drift changes',
    )
  }
}
export function renderScope(root: string, scope: Scope): string {
  const lines = [
    `### Terraform ${root}`,
    '',
    'Review this scope with the configuration diff. Attribute values and import IDs are withheld; full values are compared cryptographically before apply. Quoted instance keys are redacted; row numbers distinguish instances.',
    '',
  ]
  if (
    scope.resources.length === 0 &&
    scope.outputs.length === 0 &&
    scope.drift.length === 0
  )
    lines.push('No resource actions, output changes, imports, moves, or drift.')
  for (const [name, rows] of [
    ['Resource actions', scope.resources],
    ['Observed drift', scope.drift],
  ] as const) {
    if (rows.length === 0) continue
    lines.push(
      `**${name}**`,
      '',
      '| # | Configuration address | Actions | Import | Move from |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const row of rows.slice(0, 100))
      lines.push(
        `| ${row.ordinal.toString()} | \`${row.address}\` | ${row.actions.join(' → ')} | ${row.imported ? 'yes; ID withheld' : 'no'} | ${row.moved ? `\`${row.previousAddress ?? ''}\`` : 'no'} |`,
      )
    if (rows.length > 100)
      lines.push(
        `Additional ${String(rows.length - 100)} rows omitted from summary.`,
      )
    lines.push('')
  }
  if (scope.outputs.length > 0) {
    lines.push(
      '**Output actions**',
      '',
      '| Output name | Actions |',
      '| --- | --- |',
    )
    for (const row of scope.outputs.slice(0, 100))
      lines.push(`| \`${row.name}\` | ${row.actions.join(' → ')} |`)
    if (scope.outputs.length > 100)
      lines.push(
        `Additional ${String(scope.outputs.length - 100)} output rows omitted from summary.`,
      )
  }
  return lines.join('\n')
}
