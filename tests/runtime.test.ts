import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import {
  diagnosticLocation,
  describeTerraformEvent,
  run,
  runTerraform,
} from '../src/runtime.ts'

vi.mock(
  '@actions/core',
  (): {
    info: ReturnType<typeof vi.fn>
    warning: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  } => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
)

describe('Terraform machine-readable progress', (): void => {
  it('only exposes allowlisted structural fields', (): void => {
    const counts = new Map<string, number>()
    expect(
      describeTerraformEvent(
        JSON.stringify({ type: 'version', ui: '1.0', '@message': 'secret' }),
        counts,
      ),
    ).toBe('Terraform UI schema 1.0')
    expect(
      describeTerraformEvent(
        JSON.stringify({
          type: 'change_summary',
          changes: { add: 1, change: 2, remove: 3 },
          '@message': 'secret',
        }),
        counts,
      ),
    ).toBe('Terraform changes: add 1, change 2, remove 3')
    expect(
      describeTerraformEvent(
        JSON.stringify({
          type: 'apply_start',
          hook: { resource: { addr: 'secret.example["private"]' } },
          '@message': 'secret',
        }),
        counts,
      ),
    ).toBe('Terraform apply start; resource identity withheld')
    expect(
      describeTerraformEvent(
        JSON.stringify({
          type: 'diagnostic',
          diagnostic: { summary: 'secret' },
        }),
        counts,
      ),
    ).toBe('Terraform diagnostic received; provider text withheld')
  })

  it('rejects invalid events and caps repeated progress', (): void => {
    const counts = new Map<string, number>()
    expect(describeTerraformEvent('raw secret', counts)).toBeUndefined()
    expect(describeTerraformEvent('null', counts)).toBeUndefined()
    expect(describeTerraformEvent('{"type":1}', counts)).toBeUndefined()
    expect(
      describeTerraformEvent('{"type":"version","ui":"secret"}', counts),
    ).toBeUndefined()
    expect(
      describeTerraformEvent(
        '{"type":"change_summary","changes":{"add":"secret"}}',
        counts,
      ),
    ).toBeUndefined()
    expect(describeTerraformEvent('{"type":"unknown"}', counts)).toBeUndefined()
    expect(
      describeTerraformEvent(
        '{"type":"init_output","message_code":"initializing_backend_message"}',
        counts,
      ),
    ).toBe('Terraform backend initialization started')
    expect(
      describeTerraformEvent(
        '{"type":"init_output","message_code":"initializing_provider_plugin_message"}',
        counts,
      ),
    ).toBe('Terraform provider initialization started')
    expect(
      describeTerraformEvent(
        '{"type":"init_output","message_code":"output_init_success_message"}',
        counts,
      ),
    ).toBe('Terraform initialization completed')
    expect(
      describeTerraformEvent(
        '{"type":"init_output","message_code":"other"}',
        counts,
      ),
    ).toBeUndefined()
    expect(
      describeTerraformEvent('{"type":"init_output"}', counts),
    ).toBeUndefined()
    expect(
      describeTerraformEvent(
        '{"type":"planned_change","change":{"resource":{"addr":"secret"}}}',
        counts,
      ),
    ).toBe('Terraform planned change; resource identity withheld')
    expect(describeTerraformEvent('{"type":"resource_drift"}', counts)).toBe(
      'Terraform resource drift; resource identity withheld',
    )
    expect(describeTerraformEvent('{"type":"apply_errored"}', counts)).toBe(
      'Terraform apply errored; resource identity withheld',
    )
    for (let index = 0; index < 30; index++) {
      const result = describeTerraformEvent('{"type":"apply_progress"}', counts)
      expect(result === undefined).toBe(index >= 3 && index !== 25)
    }
  })

  it('streams safe events and suppresses raw stderr and provider messages', async (): Promise<void> => {
    const info = vi.mocked(core.info)
    const warning = vi.mocked(core.warning)
    try {
      await runTerraform([
        process.execPath,
        '-e',
        'console.log("raw secret");console.log(JSON.stringify({type:"change_summary",changes:{add:1,change:0,remove:0},"@message":"secret"}));console.log(JSON.stringify({type:"diagnostic",diagnostic:{summary:"secret"}}));console.log(JSON.stringify({type:"apply_errored",hook:{resource:{addr:"secret"}}}));console.error("secret")',
      ])
      expect(info).toHaveBeenCalledWith(
        'Terraform changes: add 1, change 0, remove 0',
      )
      expect(warning).toHaveBeenCalledWith(
        'Terraform diagnostic received; provider text withheld',
      )
      expect(core.error).toHaveBeenCalledWith(
        'Terraform apply errored; resource identity withheld',
      )
      expect(
        JSON.stringify([...info.mock.calls, ...warning.mock.calls]),
      ).not.toContain('secret')
    } finally {
      vi.clearAllMocks()
    }
  })

  it('annotates only a verified Terraform source location', async (): Promise<void> => {
    const root = 'tests/fixtures/terraform/root'
    const event = (filename: unknown, line: unknown): string =>
      JSON.stringify({
        type: 'diagnostic',
        diagnostic: { summary: 'secret', range: { filename, start: { line } } },
      })
    expect(diagnosticLocation(event('main.tf', 1), root)).toEqual({
      file: 'tests/fixtures/terraform/root/main.tf',
      startLine: 1,
    })
    expect(diagnosticLocation(event('../outside.tf', 1), root)).toBeUndefined()
    expect(
      diagnosticLocation(event('main.tf\n::error::', 1), root),
    ).toBeUndefined()
    expect(diagnosticLocation(event('main.tf', 0), root)).toBeUndefined()
    expect(diagnosticLocation(event('missing.tf', 1), root)).toBeUndefined()
    expect(diagnosticLocation('raw secret', root)).toBeUndefined()
    expect(diagnosticLocation('{}', root)).toBeUndefined()
    expect(diagnosticLocation('{"type":"diagnostic"}', root)).toBeUndefined()
    expect(
      diagnosticLocation(
        '{"type":"diagnostic","diagnostic":{"range":{}}}',
        root,
      ),
    ).toBeUndefined()
    expect(
      diagnosticLocation(
        '{"type":"diagnostic","diagnostic":{"range":{"filename":"main.tf"}}}',
        root,
      ),
    ).toBeUndefined()
    expect(diagnosticLocation(event(7, 1), root)).toBeUndefined()
    const outside = await mkdtemp(join(tmpdir(), 'terraform-location-'))
    const link = join(root, 'outside.tf')
    try {
      await writeFile(join(outside, 'outside.tf'), 'synthetic')
      await symlink(join(outside, 'outside.tf'), link)
      expect(diagnosticLocation(event('outside.tf', 1), root)).toBeUndefined()
      expect(
        diagnosticLocation(event('outside.tf', 1), outside),
      ).toBeUndefined()
    } finally {
      await rm(link, { force: true })
      await rm(outside, { recursive: true, force: true })
    }
    const payload = event('main.tf', 1)
    await runTerraform(
      [process.execPath, '-e', `console.log(${JSON.stringify(payload)})`],
      [0],
      1000,
      root,
    )
    expect(core.warning).toHaveBeenCalledWith(
      'Terraform diagnostic received; provider text withheld',
      { file: 'tests/fixtures/terraform/root/main.tf', startLine: 1 },
    )
  })

  it('reports nonzero exit and timeout without subprocess output', async (): Promise<void> => {
    await expect(
      runTerraform([
        process.execPath,
        '-e',
        'console.error("secret");process.exit(3)',
      ]),
    ).rejects.toThrow('exit code 3')
    await expect(
      runTerraform(
        [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        [0],
        50,
      ),
    ).rejects.toThrow('timed out')
    await expect(
      runTerraform(
        [
          process.execPath,
          '-e',
          'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
        ],
        [0],
        200,
      ),
    ).rejects.toThrow('timed out')
    await expect(runTerraform(['/missing/terraform-binary'])).rejects.toThrow(
      'could not start',
    )
    await expect(runTerraform([])).rejects.toThrow('Missing command')
  })

  it('captures only successful tool output and hides failures', (): void => {
    expect(run([process.execPath, '-e', 'process.stdout.write("safe")'])).toBe(
      'safe',
    )
    expect(run([process.execPath, '-e', 'process.exit(2)'], [2])).toBe('')
    expect((): unknown =>
      run([process.execPath, '-e', 'console.error("secret");process.exit(3)']),
    ).toThrow('output withheld')
    expect((): unknown => run(['/missing/terraform-binary'])).toThrow(
      'output withheld',
    )
    expect((): unknown =>
      run([process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")']),
    ).toThrow('output withheld')
    expect((): unknown => run([])).toThrow('Missing command')
  })
})
