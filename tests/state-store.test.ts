import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { sdkStreamMixin } from '@smithy/util-stream'
import { mockClient } from 'aws-sdk-client-mock'
import { sha256 } from '../src/plan-contract.ts'
import { StateStore } from '../src/state-store.ts'

const s3 = mockClient(S3Client)
const stateKey = 'root/state.tfstate'
const state = Buffer.from(
  JSON.stringify({ version: 4, serial: 2, lineage: 'lineage', resources: [] }),
)
interface Stored {
  body: Buffer
  metadata: Record<string, string>
}
const objects = new Map<string, Stored>()
function body(input: unknown): Buffer {
  if (typeof input === 'string') return Buffer.from(input)
  if (Buffer.isBuffer(input)) return input
  throw new Error('Unsupported test body')
}
function key(input: string | undefined): string {
  if (input === undefined) throw new Error('Missing test object key')
  return input
}
function property(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null && name in input
    ? Reflect.get(input, name)
    : undefined
}
function optionalString(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string') throw new Error('Invalid test input')
  return input
}
function metadata(input: unknown): Record<string, string> {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Invalid test metadata')
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') throw new Error('Invalid test metadata')
    result[name] = value
  }
  return result
}
function installStore(): StateStore {
  s3.on(GetObjectCommand).callsFake(
    (
      input: unknown,
    ): {
      Body: ReturnType<typeof sdkStreamMixin>
      Metadata: Record<string, string>
    } => {
      const row = objects.get(key(optionalString(property(input, 'Key'))))
      if (row === undefined)
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      return {
        Body: sdkStreamMixin(Readable.from([row.body])),
        Metadata: row.metadata,
      }
    },
  )
  s3.on(PutObjectCommand).callsFake((input: unknown): Record<string, never> => {
    const name = key(optionalString(property(input, 'Key')))
    if (property(input, 'IfNoneMatch') === '*' && objects.has(name))
      throw new Error('conditional write failed')
    objects.set(name, {
      body: body(property(input, 'Body')),
      metadata: metadata(property(input, 'Metadata')),
    })
    return {}
  })
  s3.on(DeleteObjectCommand).callsFake(
    (input: unknown): Record<string, never> => {
      objects.delete(key(optionalString(property(input, 'Key'))))
      return {}
    },
  )
  s3.on(ListObjectsV2Command).callsFake(
    (input: unknown): { Contents: { Key: string }[] } => ({
      Contents: [...objects.keys()]
        .filter((name): boolean =>
          name.startsWith(optionalString(property(input, 'Prefix')) ?? ''),
        )
        .map((name): { Key: string } => ({ Key: name })),
    }),
  )
  return new StateStore(new S3Client({ region: 'auto' }), 'bucket', '1.16.5')
}
beforeEach((): void => {
  s3.reset()
  objects.clear()
})
afterEach((): void => {
  s3.reset()
  vi.unstubAllEnvs()
})

describe('state archives and reconciliation', (): void => {
  it('constructs the configured S3 backend only with credentials', async (): Promise<void> => {
    await expect(
      StateStore.create('tests/fixtures/config.json'),
    ).rejects.toThrow('credentials')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-key')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret')
    await expect(
      StateStore.create('tests/fixtures/config.json'),
    ).resolves.toBeInstanceOf(StateStore)
    const directory = await mkdtemp(join(tmpdir(), 'invalid-backend-'))
    try {
      const config = join(directory, 'config.json')
      await writeFile(config, '{"backendConfig":""}')
      await expect(StateStore.create(config)).rejects.toThrow(
        'Invalid backendConfig',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects missing objects and corrupt durable reads', async (): Promise<void> => {
    const store = installStore()
    await expect(store.read('missing')).rejects.toThrow('missing')
    s3.on(GetObjectCommand).resolves({})
    await expect(store.read('missing')).rejects.toThrow('no body')
    s3.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from(['wrong'])),
    })
    await expect(store.put('operation.json', 'expected')).rejects.toThrow(
      'checksum',
    )
  })
  it('backs up a locked state with verified metadata and releases its own lock', async (): Promise<void> => {
    const store = installStore()
    objects.set(stateKey, { body: state, metadata: {} })
    const archive = await store.backup('root', stateKey)
    expect('missing' in archive).toBe(false)
    if ('missing' in archive) throw new Error('Expected archive')
    expect(archive.sha256).toBe(sha256(state))
    expect(objects.get(archive.key)?.metadata['source-key']).toBe(stateKey)
    expect(objects.has(`${stateKey}.tflock`)).toBe(false)
    expect(
      s3
        .commandCalls(PutObjectCommand)
        .some((call): boolean => call.args[0].input.IfNoneMatch === '*'),
    ).toBe(true)
  })

  it('allows declared initial state and rejects undeclared missing state', async (): Promise<void> => {
    const store = installStore()
    await expect(store.backup('root', stateKey)).rejects.toThrow('missing')
    expect(await store.backup('root', stateKey, true)).toEqual({
      missing: true,
      stateKey,
    })
    expect(objects.has(`${stateKey}.tflock`)).toBe(false)
  })

  it('rejects invalid roots, snapshots and archive checksum mismatches', async (): Promise<void> => {
    const store = installStore()
    await expect(store.backup('../root', stateKey)).rejects.toThrow(
      'Unsupported',
    )
    await expect(store.backup('root', 'history/state.tfstate')).rejects.toThrow(
      'Unsupported',
    )
    objects.set(stateKey, { body: Buffer.from('{}'), metadata: {} })
    await expect(store.backup('root', stateKey)).rejects.toThrow(
      'Missing serial',
    )
    objects.set(stateKey, { body: state, metadata: {} })
    s3.on(GetObjectCommand).callsFake(
      (
        input: unknown,
      ): {
        Body: ReturnType<typeof sdkStreamMixin>
        Metadata: Record<string, string>
      } => {
        const name = key(optionalString(property(input, 'Key')))
        const row = objects.get(name)
        if (row === undefined) throw new Error('missing')
        return {
          Body: sdkStreamMixin(Readable.from([row.body])),
          Metadata: name.startsWith('history/') ? {} : row.metadata,
        }
      },
    )
    await expect(store.backup('root', stateKey)).rejects.toThrow('verification')
  })

  it('refuses malformed state and a changed archive lock owner', async (): Promise<void> => {
    const store = installStore()
    objects.set(stateKey, {
      body: Buffer.from('{"version":3,"serial":2,"lineage":"lineage"}'),
      metadata: {},
    })
    await expect(store.backup('root', stateKey)).rejects.toThrow('Unsupported')
    objects.set(stateKey, { body: state, metadata: {} })
    s3.on(GetObjectCommand).callsFake(
      (
        input: unknown,
      ): {
        Body: ReturnType<typeof sdkStreamMixin>
        Metadata: Record<string, string>
      } => {
        const name = key(optionalString(property(input, 'Key')))
        const row = objects.get(name)
        if (row === undefined) throw new Error('missing')
        return {
          Body: sdkStreamMixin(
            Readable.from([
              name.endsWith('.tflock')
                ? Buffer.from('{"ID":"other"}')
                : row.body,
            ]),
          ),
          Metadata: row.metadata,
        }
      },
    )
    await expect(store.backup('root', stateKey)).rejects.toThrow(
      'lock ownership',
    )
  })

  it('blocks pending operations and detects incomplete pagination', async (): Promise<void> => {
    const store = installStore()
    objects.set('operations/a.json', {
      body: Buffer.from('{"status":"started"}'),
      metadata: {},
    })
    await expect(store.assertReconciled()).rejects.toThrow('reconciliation')
    objects.set('operations/a.json', {
      body: Buffer.from('{"status":"finished"}'),
      metadata: {},
    })
    await expect(store.assertReconciled()).resolves.toBeUndefined()
    s3.on(ListObjectsV2Command).resolves({ IsTruncated: true })
    await expect(store.assertReconciled()).rejects.toThrow('pagination')
    s3.on(ListObjectsV2Command).resolves({ Contents: [{}] })
    await expect(store.assertReconciled()).rejects.toThrow('no key')
    s3.reset()
    installStore()
    s3.on(ListObjectsV2Command).callsFake(
      (
        input: unknown,
      ): {
        IsTruncated: boolean
        NextContinuationToken?: string
        Contents: { Key: string }[]
      } =>
        property(input, 'ContinuationToken') === undefined
          ? { IsTruncated: true, NextContinuationToken: 'next', Contents: [] }
          : { IsTruncated: false, Contents: [{ Key: 'operations/a.json' }] },
    )
    await expect(store.assertReconciled()).resolves.toBeUndefined()
  })

  it('downloads only a verified archive into a new file', async (): Promise<void> => {
    const store = installStore()
    const directory = await mkdtemp(join(tmpdir(), 'terraform-archive-'))
    const destination = join(directory, 'download.tfstate')
    const archiveKey = 'history/root/archive.tfstate'
    const metadata = {
      sha256: sha256(state),
      'source-key': stateKey,
      serial: '2',
      lineage: 'lineage',
    }
    try {
      objects.set(archiveKey, { body: state, metadata })
      await expect(
        store.download('other/key.tfstate', destination, stateKey),
      ).rejects.toThrow('archived')
      await expect(
        store.download(archiveKey, destination, 'wrong/state.tfstate'),
      ).rejects.toThrow('verification')
      await store.download(archiveKey, destination, stateKey)
      expect(await readFile(destination)).toEqual(state)
      await expect(
        store.download(archiveKey, destination, stateKey),
      ).rejects.toThrow()
      objects.set(archiveKey, { body: Buffer.from('{'), metadata })
      await expect(
        store.download(archiveKey, join(directory, 'invalid'), stateKey),
      ).rejects.toThrow('not valid')
      await writeFile(join(directory, 'other'), 'safe')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
