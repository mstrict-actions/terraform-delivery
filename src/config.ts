import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface DeliveryConfig {
  rootsDirectory: string
  backendConfig: string
  backendConfigRelative: string
  toolsFile: string
  owner: string
  defaultBranch: string
  previewWorkflow: string
  previewJobs: string[]
  identityFiles: string[]
}
export interface RootConfig {
  stateKey: string
  allowInitialState: boolean
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Invalid ${name}`)
  return value
}
function safePath(value: unknown, name: string): string {
  const path = text(value, name)
  if (
    path.startsWith('/') ||
    path.startsWith('..') ||
    path.includes('\\') ||
    path.split('/').includes('..') ||
    path.includes('\n')
  )
    throw new Error(`Unsafe ${name}`)
  return path
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`Invalid ${name}`)
  return value.map((item: unknown): string => text(item, name))
}
export async function loadConfig(path: string): Promise<DeliveryConfig> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!object(raw)) throw new Error('Delivery configuration must be an object')
  return {
    rootsDirectory: safePath(raw['rootsDirectory'], 'rootsDirectory'),
    backendConfig: safePath(raw['backendConfig'], 'backendConfig'),
    backendConfigRelative: text(
      raw['backendConfigRelative'],
      'backendConfigRelative',
    ),
    toolsFile: safePath(raw['toolsFile'], 'toolsFile'),
    owner: text(raw['owner'], 'owner'),
    defaultBranch: text(raw['defaultBranch'], 'defaultBranch'),
    previewWorkflow: text(raw['previewWorkflow'], 'previewWorkflow'),
    previewJobs: strings(raw['previewJobs'], 'previewJobs'),
    identityFiles: strings(raw['identityFiles'], 'identityFiles').map(
      (item): string => safePath(item, 'identityFiles'),
    ),
  }
}
export async function discoverRoots(
  config: DeliveryConfig,
): Promise<Record<string, RootConfig>> {
  const roots: Record<string, RootConfig> = {}
  for (const entry of await readdir(config.rootsDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name === 'backends') continue
    if (!/^[a-z][a-z0-9_-]*$/.test(entry.name))
      throw new Error('Terraform root name is invalid')
    const metadataPath = `${config.rootsDirectory}/${entry.name}/root.json`
    const raw: unknown = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (!object(raw)) throw new Error('Terraform root metadata is invalid')
    const stateKey = raw['stateKey']
    const allowInitialState = raw['allowInitialState'] ?? false
    if (
      typeof stateKey !== 'string' ||
      !/^[A-Za-z0-9/_-]+\.tfstate$/.test(stateKey) ||
      /^(history|operations)\//.test(stateKey) ||
      typeof allowInitialState !== 'boolean'
    )
      throw new Error(
        'Terraform root state key or initial-state policy is invalid',
      )
    roots[entry.name] = { stateKey, allowInitialState }
  }
  const keys = Object.values(roots).map((root): string => root.stateKey)
  if (keys.length === 0 || new Set(keys).size !== keys.length)
    throw new Error('Terraform roots must have distinct state keys')
  return roots
}
export function terraformCommand(
  config: DeliveryConfig,
  root: string,
  ...args: string[]
): string[] {
  if (!/^[a-z][a-z0-9_-]*$/.test(root))
    throw new Error('Terraform root name is invalid')
  const directory = resolve(config.rootsDirectory, root)
  return ['terraform', `-chdir=${directory}`, ...args]
}
