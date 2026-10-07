import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const project = process.cwd()
let directory = ''
beforeAll(async (): Promise<void> => {
  directory = await mkdtemp(join(tmpdir(), 'terraform-bundle-'))
  await mkdir(join(directory, 'bin'))
  await mkdir(join(directory, '.github/config'), { recursive: true })
  await mkdir(join(directory, 'terraform/root'), { recursive: true })
  await mkdir(join(directory, 'terraform/backends'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(directory, 'output.txt'), '')
  await writeFile(join(directory, 'tools.json'), '{"terraform":"1.16.5"}\n')
  await writeFile(
    join(directory, 'terraform/backends/backend.hcl'),
    'bucket = "synthetic-state"\n',
  )
  await writeFile(
    join(directory, 'terraform/root/root.json'),
    '{"stateKey":"root/state.tfstate"}\n',
  )
  await writeFile(
    join(directory, '.github/config/terraform-delivery.json'),
    JSON.stringify({
      rootsDirectory: 'terraform',
      backendConfig: 'terraform/backends/backend.hcl',
      backendConfigRelative: '../backends/backend.hcl',
      toolsFile: 'tools.json',
      owner: 'owner',
      defaultBranch: 'main',
      previewWorkflow: 'preview.yml',
      previewJobs: ['Terraform preview'],
      identityFiles: ['tools.json'],
    }),
  )
  const fakeTerraform = join(directory, 'bin/terraform')
  await writeFile(
    fakeTerraform,
    '#!/bin/sh\ncase "$2" in\n  init) exit 0;;\n  plan) for argument in "$@"; do case "$argument" in -out=*) printf "saved-plan" > "${argument#-out=}";; esac; done; printf \'{"type":"change_summary","changes":{"add":0,"change":0,"remove":0}}\\n\'; exit 0;;\n  show) printf \'{"format_version":"1.2","complete":true}\\n\'; exit 0;;\n  version) printf \'{"terraform_version":"1.16.5","platform":"linux_amd64"}\\n\'; exit 0;;\nesac\nexit 1\n',
  )
  await chmod(fakeTerraform, 0o755)
  execFileSync(
    process.execPath,
    ['build.config.mjs', join(directory, 'fresh.js')],
    {
      cwd: project,
    },
  )
  await copyFile(resolve('dist/index.js'), join(directory, 'tracked.js'))
})
afterAll(async (): Promise<void> => {
  if (directory.length > 0)
    await rm(directory, { recursive: true, force: true })
})
function runBundle(
  file: string,
  operation: string,
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [join(directory, file)], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      PATH: `${join(directory, 'bin')}:${process.env['PATH'] ?? ''}`,
      INPUT_OPERATION: operation,
      INPUT_CONFIG: '.github/config/terraform-delivery.json',
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
      GITHUB_OUTPUT: join(directory, 'output.txt'),
      NODE_PATH: '',
    },
    timeout: 30_000,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}
describe('bundles without node_modules or repository source', (): void => {
  for (const file of ['fresh.js', 'tracked.js']) {
    it(`${file} validates its standalone configuration`, async (): Promise<void> => {
      const result = runBundle(file, 'validate-config')
      expect(result.status).toBe(0)
      expect(result.output).toContain('Validated Terraform roots: root')
      expect(await readFile(join(directory, 'output.txt'), 'utf8')).toMatch(
        /roots<<[^\n]+\nroot\n/,
      )
    })
    it(`${file} runs the no-change contract`, async (): Promise<void> => {
      const result = runBundle(file, 'check-no-changes')
      expect(result.status).toBe(0)
      expect(result.output).toContain('All Terraform roots have no changes')
      expect(await readFile(join(directory, 'summary.md'), 'utf8')).toContain(
        'No resource actions',
      )
      expect(result.output).not.toContain('saved-plan')
    })
    it(`${file} exits nonzero and writes a summary on bad input`, async (): Promise<void> => {
      const result = runBundle(file, 'unknown')
      expect(result.status).not.toBe(0)
      expect(await readFile(join(directory, 'summary.md'), 'utf8')).toContain(
        'failed',
      )
    })
  }
})
