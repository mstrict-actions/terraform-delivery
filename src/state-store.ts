import { open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3'
import { sha256 } from './plan-contract.ts'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function field(input: unknown, key: string): unknown {
  if (!object(input) || !(key in input)) throw new Error(`Missing ${key}`)
  return input[key]
}
function string(value: unknown, key: string): string {
  const result = field(value, key)
  if (typeof result !== 'string' || result.length === 0)
    throw new Error(`Invalid ${key}`)
  return result
}
export interface Archive {
  key: string
  sha256: string
  serial: number
  lineage: string
}
export class StateStore {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly version: string
  constructor(client: S3Client, bucket: string, version: string) {
    this.client = client
    this.bucket = bucket
    this.version = version
  }
  static async create(configFile: string): Promise<StateStore> {
    const settings: unknown = JSON.parse(await readFile(configFile, 'utf8'))
    const backend = await readFile(string(settings, 'backendConfig'), 'utf8')
    const bucket = /^bucket\s*=\s*"([^"]+)"/m.exec(backend)?.[1]
    const endpoint = /s3\s*=\s*"([^"]+)"/.exec(backend)?.[1]
    if (
      bucket === undefined ||
      endpoint === undefined ||
      process.env['AWS_ACCESS_KEY_ID'] === undefined ||
      process.env['AWS_SECRET_ACCESS_KEY'] === undefined
    ) {
      throw new Error('S3 backend configuration or credentials are missing')
    }
    const tools: unknown = JSON.parse(
      await readFile(string(settings, 'toolsFile'), 'utf8'),
    )
    return new StateStore(
      new S3Client({
        endpoint,
        region: 'auto',
        forcePathStyle: true,
        maxAttempts: 3,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
      bucket,
      string(tools, 'terraform'),
    )
  }
  async read(
    key: string,
  ): Promise<{ body: Buffer; metadata: Record<string, string> }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )
    if (result.Body === undefined) throw new Error('State object has no body')
    return {
      body: Buffer.from(await result.Body.transformToByteArray()),
      metadata: result.Metadata ?? {},
    }
  }
  async put(
    key: string,
    body: string | Buffer,
    options: Partial<PutObjectCommandInput> = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ...options,
      }),
    )
    const stored = await this.read(key)
    if (sha256(stored.body) !== sha256(body))
      throw new Error('Durable state receipt checksum verification failed')
  }
  async assertReconciled(): Promise<void> {
    let token: string | undefined
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'operations/',
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      )
      for (const row of page.Contents ?? []) {
        if (row.Key === undefined)
          throw new Error('Operation receipt has no key')
        const operation: unknown = JSON.parse(
          (await this.read(row.Key)).body.toString('utf8'),
        )
        if (string(operation, 'status') !== 'finished')
          throw new Error('A previous deployment requires state reconciliation')
      }
      if (page.IsTruncated === true && page.NextContinuationToken === undefined)
        throw new Error('S3 returned incomplete operation pagination')
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (token !== undefined)
  }
  async download(
    key: string,
    destination: string,
    expectedStateKey: string,
  ): Promise<void> {
    if (!key.startsWith('history/') || !key.endsWith('.tfstate'))
      throw new Error('Download requires an archived state key')
    const { body, metadata } = await this.read(key)
    let state: unknown
    try {
      state = JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error('Archive is not valid state JSON; output withheld')
    }
    const serial = field(state, 'serial')
    const lineage = field(state, 'lineage')
    if (
      field(state, 'version') !== 4 ||
      !Number.isSafeInteger(serial) ||
      typeof lineage !== 'string' ||
      metadata['sha256'] === undefined ||
      sha256(body) !== metadata['sha256'] ||
      metadata['source-key'] !== expectedStateKey ||
      metadata['lineage'] !== lineage ||
      metadata['serial'] !== String(serial)
    ) {
      throw new Error('Archive checksum or state metadata verification failed')
    }
    const file = await open(destination, 'wx', 0o600)
    try {
      await file.writeFile(body)
    } finally {
      await file.close()
    }
  }
  async backup(
    root: string,
    key: string,
    allowMissing = false,
  ): Promise<Archive | { missing: true; stateKey: string }> {
    if (
      !/^[a-z][a-z0-9_-]*$/.test(root) ||
      !key.endsWith('.tfstate') ||
      key.startsWith('history/') ||
      key.startsWith('operations/')
    )
      throw new Error('Unsupported state root')
    const lockKey = `${key}.tflock`,
      id = randomUUID()
    const lock = JSON.stringify({
      ID: id,
      Operation: 'state archive',
      Info: '',
      Who: 'terraform-delivery@github-actions',
      Version: this.version,
      Created: new Date().toISOString(),
      Path: `${this.bucket}/${key}`,
    })
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: lockKey,
        Body: lock,
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    )
    try {
      let body: Buffer
      try {
        body = (await this.read(key)).body
      } catch (error) {
        if (allowMissing && object(error) && error['name'] === 'NoSuchKey')
          return { missing: true, stateKey: key }
        throw error
      }
      const state: unknown = JSON.parse(body.toString('utf8'))
      const serial = field(state, 'serial')
      const lineage = field(state, 'lineage')
      if (
        field(state, 'version') !== 4 ||
        !Number.isSafeInteger(serial) ||
        typeof serial !== 'number' ||
        typeof lineage !== 'string' ||
        lineage.length === 0
      )
        throw new Error('Unsupported Terraform state snapshot')
      const archive = `history/${root}/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.tfstate`
      const digest = sha256(body)
      await this.put(archive, body, {
        IfNoneMatch: '*',
        Metadata: {
          sha256: digest,
          'source-key': key,
          serial: String(serial),
          lineage,
        },
      })
      const stored = await this.read(archive)
      if (
        stored.metadata['sha256'] !== digest ||
        sha256(stored.body) !== digest ||
        stored.metadata['source-key'] !== key ||
        stored.metadata['serial'] !== String(serial) ||
        stored.metadata['lineage'] !== lineage
      )
        throw new Error('State archive verification failed')
      return { key: archive, sha256: digest, serial, lineage }
    } finally {
      await this.releaseLock(lockKey, id)
    }
  }

  private async releaseLock(lockKey: string, id: string): Promise<void> {
    const current: unknown = JSON.parse(
      (await this.read(lockKey)).body.toString('utf8'),
    )
    if (string(current, 'ID') !== id)
      throw new Error('State archive lock ownership changed')
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: lockKey }),
    )
  }
}
