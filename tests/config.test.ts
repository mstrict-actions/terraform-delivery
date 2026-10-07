import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadConfig, discoverRoots, terraformCommand } from '../src/config.ts'

describe('portable Terraform configuration', (): void => {
  it('loads synthetic roots and creates an explicit chdir command', async (): Promise<void> => {
    const config = await loadConfig('tests/fixtures/config.json')
    expect(await discoverRoots(config)).toEqual({
      root: { stateKey: 'root/state.tfstate', allowInitialState: true },
    })
    expect(terraformCommand(config, 'root', 'plan')).toEqual([
      'terraform',
      `-chdir=${process.cwd()}/tests/fixtures/terraform/root`,
      'plan',
    ])
    expect((): void => {
      terraformCommand(config, '../root', 'plan')
    }).toThrow('invalid')
  })

  it('rejects unsafe paths and incomplete configuration', async (): Promise<void> => {
    const directory = await mkdtemp(join(process.cwd(), '.ci-config-'))
    try {
      const original: unknown = JSON.parse(
        await readFile('tests/fixtures/config.json', 'utf8'),
      )
      if (typeof original !== 'object' || original === null)
        throw new Error('Fixture invalid')
      const path = join(directory, 'bad.json')
      await writeFile(
        path,
        JSON.stringify({ ...original, rootsDirectory: '../outside' }),
      )
      await expect(loadConfig(path)).rejects.toThrow('Unsafe')
      await writeFile(path, JSON.stringify({ ...original, previewJobs: [] }))
      await expect(loadConfig(path)).rejects.toThrow('previewJobs')
      await writeFile(path, JSON.stringify({ ...original, owner: '' }))
      await expect(loadConfig(path)).rejects.toThrow('owner')
      await writeFile(path, 'null')
      await expect(loadConfig(path)).rejects.toThrow('must be an object')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects duplicate state keys, missing metadata and invalid names', async (): Promise<void> => {
    const directory = await mkdtemp(join(process.cwd(), '.ci-roots-'))
    const rootsDirectory = relative(process.cwd(), directory)
    const base = await loadConfig('tests/fixtures/config.json')
    const config = { ...base, rootsDirectory }
    try {
      await expect(discoverRoots(config)).rejects.toThrow('distinct')
      await mkdir(join(directory, 'a'))
      await expect(discoverRoots(config)).rejects.toThrow()
      await writeFile(
        join(directory, 'a', 'root.json'),
        '{"stateKey":"a/state.tfstate"}',
      )
      await mkdir(join(directory, 'b'))
      await writeFile(
        join(directory, 'b', 'root.json'),
        '{"stateKey":"a/state.tfstate"}',
      )
      await expect(discoverRoots(config)).rejects.toThrow('distinct')
      await writeFile(
        join(directory, 'b', 'root.json'),
        '{"stateKey":"b/state.tfstate"}',
      )
      expect(Object.keys(await discoverRoots(config))).toEqual(['a', 'b'])
      await writeFile(join(directory, 'b', 'root.json'), 'null')
      await expect(discoverRoots(config)).rejects.toThrow('metadata is invalid')
      await writeFile(
        join(directory, 'b', 'root.json'),
        '{"stateKey":"history/private.tfstate"}',
      )
      await expect(discoverRoots(config)).rejects.toThrow('state key')
      await writeFile(
        join(directory, 'b', 'root.json'),
        '{"stateKey":"b/state.tfstate"}',
      )
      await mkdir(join(directory, 'Bad'))
      await expect(discoverRoots(config)).rejects.toThrow('name')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
