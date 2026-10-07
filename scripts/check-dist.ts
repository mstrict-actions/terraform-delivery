import { execFileSync } from 'node:child_process'

const status = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', 'dist/'],
  { encoding: 'utf8' },
)
if (status.length > 0) {
  console.error(
    'dist/ differs from the committed build. Run npm run build and commit dist/.',
  )
  console.error(status)
  process.exitCode = 1
}
