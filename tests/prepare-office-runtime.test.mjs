import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { prepareLinuxOffice, prepareLinuxOfficeDependencies } from '../linux/prepare-office-runtime.mjs'

const linux = JSON.parse(await readFile(new URL('../linux/office-runtime-lock.json', import.meta.url), 'utf8'))

// The executable-selection and execFile boundary from upstream v0.12.1.
// Keep the original Windows fallback so the regression fails without adaptation.
const harnessHook = `
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
async function verifyPackagedHarness(context) {
  const product = context.packager.appInfo.productFilename
  const contents = path.join(context.appOutDir, \`\${product}.app\`, 'Contents')
  const resources = context.electronPlatformName === 'darwin' ? path.join(contents, 'Resources') : path.join(context.appOutDir, 'resources')
  const executable = context.electronPlatformName === 'darwin'
    ? path.join(contents, 'Frameworks', \`\${product} Helper.app\`, 'Contents', 'MacOS', \`\${product} Helper\`)
    : path.join(context.appOutDir, \`\${product}.exe\`)
  try {
    const { stdout, stderr } = await promisify(execFile)(executable, [__filename, '--verify-runtime', path.join(resources, 'app.asar'), resources, executable], {
      cwd: context.appOutDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true
    })
    process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout)
    if (error.stderr) process.stderr.write(error.stderr)
    throw error
  }
}
module.exports = { verifyPackagedHarness }
`

function loadHarnessHook(source, filename, failure) {
  const calls = []
  const require = createRequire(import.meta.url)
  const execFile = (executable, args, options, callback) => {
    calls.push({ executable, args: Array.from(args), options })
    callback(failure, { stdout: '', stderr: '' })
  }
  const module = { exports: {} }
  runInNewContext(source, {
    __filename: filename,
    module,
    require: name => name === 'node:child_process' ? { execFile } : require(name),
    process: { platform: 'linux', env: { DSH_GATE_TEST: 'preserved' }, stdout: { write() {} }, stderr: { write() {} } }
  })
  return { calls, verify: module.exports.verifyPackagedHarness }
}

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

test('Harness gate uses the target executable and still invokes runtime verification on every platform', async t => {
  const { root } = await fixture(t)
  const file = join(root, 'scripts/verify-packaged-harness.cjs')
  await writeFile(file, harnessHook)
  await prepareLinuxOffice(root)
  const source = await readFile(file, 'utf8')
  await prepareLinuxOffice(root)
  assert.equal(await readFile(file, 'utf8'), source)

  const appOutDir = join(root, 'dist', 'unpacked with spaces')
  for (const platform of ['linux', 'win32', 'darwin']) {
    const { calls, verify } = loadHarnessHook(source, file)
    const context = { appOutDir, electronPlatformName: platform, packager: { executableName: 'custom-desktop', appInfo: { productFilename: 'DSH Desktop' } } }
    await verify(context)
    assert.equal(calls.length, 1)
    const contents = join(appOutDir, 'DSH Desktop.app', 'Contents')
    const executable = platform === 'darwin'
      ? join(contents, 'Frameworks', 'DSH Desktop Helper.app', 'Contents', 'MacOS', 'DSH Desktop Helper')
      : join(appOutDir, platform === 'linux' ? 'custom-desktop' : 'DSH Desktop.exe')
    const resources = platform === 'darwin' ? join(contents, 'Resources') : join(appOutDir, 'resources')
    assert.equal(calls[0].executable, executable)
    assert.deepEqual(calls[0].args, [file, '--verify-runtime', join(resources, 'app.asar'), resources, executable])
    assert.equal(calls[0].options.cwd, appOutDir)
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(calls[0].options.env.DSH_GATE_TEST, 'preserved')
    assert.equal(calls[0].options.timeout, 120_000)
  }

  const failure = new Error('Packaged dependency is missing')
  const { verify } = loadHarnessHook(source, file, failure)
  await assert.rejects(verify({ appOutDir, electronPlatformName: 'linux', packager: { executableName: 'custom-desktop', appInfo: { productFilename: 'DSH Desktop' } } }), error => error === failure)
})

test('an unknown Harness hook stops adaptation before any source or lock is written', async t => {
  const { root } = await fixture(t)
  const file = join(root, 'scripts/verify-packaged-harness.cjs')
  const files = ['scripts/office-runtime/lock.json', 'scripts/office-runtime/prepare.mjs', 'scripts/verify-office-runtime.cjs', 'scripts/verify-packaged-ppt-runtime.cjs', 'build/office-engine-resolution.mjs']
  const before = await Promise.all(files.map(name => readFile(join(root, name), 'utf8')))
  for (const changed of ['module.exports = {}\n', harnessHook + harnessHook]) {
    await writeFile(file, changed)
    await assert.rejects(prepareLinuxOffice(root), /upstream scripts\/verify-packaged-harness\.cjs changed/)
    assert.deepEqual(await Promise.all(files.map(name => readFile(join(root, name), 'utf8'))), before)
    assert.equal(await readFile(file, 'utf8'), changed)
  }
  await rm(file)
  await mkdir(file)
  await assert.rejects(prepareLinuxOffice(root), { code: 'EISDIR' })
  assert.deepEqual(await Promise.all(files.map(name => readFile(join(root, name), 'utf8'))), before)
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
