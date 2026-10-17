import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareLinuxOffice, prepareLinuxOfficeDependencies } from '../linux/prepare-office-runtime.mjs'

const linux = JSON.parse(await readFile(new URL('../linux/office-runtime-lock.json', import.meta.url), 'utf8'))

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-office-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts/office-runtime'), { recursive: true })
  await mkdir(join(root, 'build'))
  const lock = {
    pythonVersion: linux.pythonVersion,
    pythonRelease: linux.pythonRelease,
    pythonPackages: linux.pythonPackages,
    targets: { 'win-x64': { pythonTarget: 'x86_64-pc-windows-msvc', pythonSha256: 'unchanged' } },
    wheels: [{ url: 'https://example.com/shared.whl', sha256: 'unchanged' }]
  }
  await writeFile(join(root, 'scripts/office-runtime/lock.json'), JSON.stringify(lock))
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
  await writeFile(join(root, 'scripts/office-runtime/prepare.mjs'), `
export function manifest(target) {
  const windows = target === 'win-x64'
  return {
    platform: windows ? 'win32' : 'darwin',
  }
}
`)
  await writeFile(join(root, 'scripts/verify-office-runtime.cjs'), `
const path = require('node:path')
module.exports = context => {
  const product = 'DSH Desktop'
  return process.platform === 'darwin' ? 'mac-helper'
    : path.join(context.appOutDir, \`\${product}.exe\`)
}
`)
  await writeFile(join(root, 'build/office-engine-resolution.mjs'), String.raw`
export const ENGINE_PACKAGE = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u
`)
  await writeFile(join(root, 'scripts/verify-packaged-ppt-runtime.cjs'), `
const path = require('node:path')
module.exports = context => {
  const executable = process.platform === 'win32' ? 'windows.exe' : 'mac-helper'
  return executable
}
`)
  return { root, lock }
}

test('older releases without Office remain buildable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pre-office-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await prepareLinuxOffice(root), false)
  assert.equal(await prepareLinuxOfficeDependencies(root), false)
})

test('a missing Office asset lock is not mistaken for an older release', async t => {
  const { root } = await fixture(t)
  await rm(join(root, 'scripts/office-runtime/lock.json'))
  await assert.rejects(prepareLinuxOffice(root), /Office asset lock is missing/)
})

test('Linux runtime uses pinned assets, correct platform, executable, and WASM resolution', async t => {
  const { root, lock } = await fixture(t)
  await prepareLinuxOffice(root)
  const prepared = JSON.parse(await readFile(join(root, 'scripts/office-runtime/lock.json'), 'utf8'))
  assert.deepEqual(prepared.targets['linux-x64'], linux.target)
  assert.deepEqual(prepared.targets['win-x64'], lock.targets['win-x64'])
  assert.deepEqual(prepared.wheels, lock.wheels)
  assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}\n')

  const { manifest } = await import(pathToFileURL(join(root, 'scripts/office-runtime/prepare.mjs')))
  assert.equal(manifest('linux-x64').platform, 'linux')
  assert.equal(manifest('win-x64').platform, 'win32')
  assert.equal(manifest('mac-arm64').platform, 'darwin')
  const { default: executable } = await import(pathToFileURL(join(root, 'scripts/verify-office-runtime.cjs')))
  if (process.platform === 'linux') {
    assert.equal(executable({ appOutDir: '/app', packager: { executableName: 'dsh-desktop' } }), '/app/dsh-desktop')
    const { default: pptExecutable } = await import(pathToFileURL(join(root, 'scripts/verify-packaged-ppt-runtime.cjs')))
    assert.equal(pptExecutable({ appOutDir: '/app', packager: { executableName: 'dsh-desktop' } }), '/app/dsh-desktop')
  }
  const { ENGINE_PACKAGE } = await import(pathToFileURL(join(root, 'build/office-engine-resolution.mjs')))
  for (const name of ['@deepseek-ai/libreoffice-kit-wasm', '@deepseek-ai/libreoffice-kit-wasm/prebuilds.json', '@deepseek-ai/libreoffice-kit-win32-x64']) {
    assert(ENGINE_PACKAGE.test(name), name)
  }
  assert(!ENGINE_PACKAGE.test('@deepseek-ai/libreoffice-kit-wasm-unrelated'))
})

test('reapplying the adaptation preserves the generated files', async t => {
  const { root } = await fixture(t)
  await prepareLinuxOffice(root)
  const files = ['scripts/office-runtime/lock.json', 'scripts/office-runtime/prepare.mjs', 'scripts/verify-office-runtime.cjs', 'scripts/verify-packaged-ppt-runtime.cjs', 'build/office-engine-resolution.mjs']
  const before = await Promise.all(files.map(file => readFile(join(root, file), 'utf8')))
  await prepareLinuxOffice(root)
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(root, file), 'utf8'))), before)
})

test('a new Python version requires new verified Linux assets', async t => {
  const { root, lock } = await fixture(t)
  lock.pythonVersion = '3.13.0'
  const path = join(root, 'scripts/office-runtime/lock.json')
  await writeFile(path, JSON.stringify(lock))
  const before = await readFile(join(root, 'scripts/office-runtime/prepare.mjs'), 'utf8')
  await assert.rejects(prepareLinuxOffice(root), /Python version changed/)
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(lock))
  assert.equal(await readFile(join(root, 'scripts/office-runtime/prepare.mjs'), 'utf8'), before)
})

test('unknown upstream layout stops before writing a partial adaptation', async t => {
  const { root } = await fixture(t)
  const lockPath = join(root, 'scripts/office-runtime/lock.json')
  const before = await readFile(lockPath, 'utf8')
  await writeFile(join(root, 'build/office-engine-resolution.mjs'), 'export const changedUpstream = true\n')
  await assert.rejects(prepareLinuxOffice(root), /upstream build\/office-engine-resolution.mjs changed/)
  assert.equal(await readFile(lockPath, 'utf8'), before)
})

test('Electron ASAR null and Node undefined both mean missing; existing native engines remain detectable', async t => {
  const { root } = await fixture(t)
  const lib = join(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib')
  await mkdir(lib, { recursive: true })
  await writeFile(join(lib, '../package.json'), '{"type":"module"}\n')
  const original = `
import { join } from 'node:path'
export function installedPackageExists(entry) {
  const lstatSync = () => entry
  const name = 'native-engine'
  return ['node_modules'].some(directory => lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0)
}
`
  await writeFile(join(lib, 'index.js'), original)
  await writeFile(join(lib, 'cli.js'), original)
  await prepareLinuxOfficeDependencies(root)
  const once = await readFile(join(lib, 'index.js'), 'utf8')
  await prepareLinuxOfficeDependencies(root)
  assert.equal(await readFile(join(lib, 'index.js'), 'utf8'), once)
  for (const file of ['index.js', 'cli.js']) {
    const { installedPackageExists } = await import(pathToFileURL(join(lib, file)))
    assert.equal(installedPackageExists(null), false)
    assert.equal(installedPackageExists(undefined), false)
    assert.equal(installedPackageExists({ isDirectory: () => true }), true)
  }
})
