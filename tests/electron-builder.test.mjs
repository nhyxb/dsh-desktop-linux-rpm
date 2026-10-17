import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const config = fileURLToPath(new URL('../linux/electron-builder.cjs', import.meta.url))

async function loadConfig(t, build) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-builder-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ build }))
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', config], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('session-format gate retains its physical source without dropping native unpack rules or hooks', async t => {
  const original = { asar: true, asarUnpack: ['**/*.node', '**/*.so'], afterPack: 'scripts/after-pack.cjs', extraResources: [{ from: '.build/office-runtime', to: 'office-runtime' }] }
  const actual = await loadConfig(t, original)
  assert.deepEqual(actual, { ...original, asarUnpack: [...original.asarUnpack, 'node_modules/@deepseek-ai/dsh-session/lib/index.js'] })
})

test('legacy unarchived application layout stays enabled', async t => {
  const actual = await loadConfig(t, { asar: false, npmRebuild: false })
  assert.equal(actual.asar, false)
  assert.equal(actual.npmRebuild, false)
})
