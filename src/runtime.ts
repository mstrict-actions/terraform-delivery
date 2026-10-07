import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import * as core from '@actions/core'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function run(command: string[], allowed: number[] = [0]): string {
  const executable = command[0]
  if (executable === undefined) throw new Error('Missing command')
  const result = spawnSync(executable, command.slice(1), {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  })
  if (result.error !== undefined || !allowed.includes(result.status ?? -1))
    throw new Error(`${executable} operation failed; tool output withheld`)
  return result.stdout
}

export function describeTerraformEvent(
  line: string,
  counts: Map<string, number>,
): string | undefined {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!object(event) || typeof event['type'] !== 'string') return undefined
  const type = event['type']
  if (type === 'version') {
    return typeof event['ui'] === 'string' &&
      /^[0-9]+\.[0-9]+$/.test(event['ui'])
      ? `Terraform UI schema ${event['ui']}`
      : undefined
  }
  if (type === 'change_summary' && object(event['changes'])) {
    const changes = event['changes']
    const add = changes['add']
    const change = changes['change']
    const remove = changes['remove']
    if (
      [add, change, remove].every(
        (value): boolean =>
          typeof value === 'number' && Number.isSafeInteger(value),
      )
    ) {
      return `Terraform changes: add ${String(add)}, change ${String(change)}, remove ${String(remove)}`
    }
  }
  if (type === 'diagnostic') {
    return 'Terraform diagnostic received; provider text withheld'
  }
  if (type === 'init_output') {
    const code = event['message_code']
    const milestones: Record<string, string> = {
      initializing_backend_message: 'Terraform backend initialization started',
      initializing_provider_plugin_message:
        'Terraform provider initialization started',
      output_init_success_message: 'Terraform initialization completed',
    }
    return typeof code === 'string' ? milestones[code] : undefined
  }
  if (type === 'planned_change' || type === 'resource_drift')
    return `Terraform ${type.replaceAll('_', ' ')}; resource identity withheld`
  if (type === 'apply_errored')
    return 'Terraform apply errored; resource identity withheld'
  if (['apply_start', 'apply_progress', 'apply_complete'].includes(type)) {
    const seen = counts.get(type) ?? 0
    counts.set(type, seen + 1)
    if (type === 'apply_progress' && seen >= 3 && seen % 25 !== 0)
      return undefined
    return `Terraform ${type.replaceAll('_', ' ')}; resource identity withheld`
  }
  return undefined
}

export function diagnosticLocation(
  line: string,
  rootDirectory: string,
): { file: string; startLine: number } | undefined {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!object(event) || event['type'] !== 'diagnostic') return undefined
  const diagnostic = event['diagnostic']
  if (!object(diagnostic) || !object(diagnostic['range'])) return undefined
  const range = diagnostic['range']
  const filename = range['filename']
  if (
    typeof filename !== 'string' ||
    !/^[A-Za-z0-9_./-]+\.tf(?:\.json)?$/.test(filename) ||
    filename.split('/').includes('..')
  )
    return undefined
  const start = range['start']
  if (!object(start)) return undefined
  const lineNumber = start['line']
  if (
    typeof lineNumber !== 'number' ||
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > 1_000_000
  )
    return undefined
  const candidate = resolve(rootDirectory, filename)
  if (!existsSync(candidate)) return undefined
  const canonicalRoot = realpathSync(rootDirectory)
  const canonicalFile = realpathSync(candidate)
  const insideRoot = relative(canonicalRoot, canonicalFile)
  const insideRepository = relative(process.cwd(), canonicalFile)
  if (insideRoot.startsWith('..') || insideRepository.startsWith('..'))
    return undefined
  return { file: insideRepository, startLine: lineNumber }
}

export async function runTerraform(
  command: string[],
  allowed: number[] = [0],
  timeoutMs = 20 * 60 * 1000,
  sourceRoot?: string,
): Promise<void> {
  const executable = command[0]
  if (executable === undefined) throw new Error('Missing command')
  const child = spawn(executable, command.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const started = Date.now()
  const counts = new Map<string, number>()
  const timeout = { elapsed: false }
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout((): void => {
    timeout.elapsed = true
    child.kill('SIGTERM')
    killTimer = setTimeout(
      (): void => {
        child.kill('SIGKILL')
      },
      Math.min(5000, timeoutMs),
    )
  }, timeoutMs)
  try {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line: string): void => {
      const description = describeTerraformEvent(line, counts)
      if (description === undefined) return
      if (description.startsWith('Terraform diagnostic')) {
        const location =
          sourceRoot === undefined
            ? undefined
            : diagnosticLocation(line, sourceRoot)
        if (location === undefined) core.warning(description)
        else core.warning(description, location)
      } else if (description.startsWith('Terraform apply errored'))
        core.error(description)
      else core.info(description)
    })
    // Drain stderr without retaining or echoing provider-controlled content.
    child.stderr.resume()
    const code = await new Promise<number | null>((resolve, reject): void => {
      child.once('error', (): void => {
        reject(new Error('Terraform process could not start; output withheld'))
      })
      child.once('close', resolve)
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (timeout.elapsed)
      throw new Error(`Terraform timed out after ${seconds}s; output withheld`)
    if (code === null || !allowed.includes(code))
      throw new Error(
        `Terraform failed with exit code ${String(code)} after ${seconds}s; output withheld`,
      )
    core.info(`Terraform completed in ${seconds}s (exit ${code.toString()})`)
  } finally {
    clearTimeout(timer)
    if (killTimer !== undefined) clearTimeout(killTimer)
  }
}
