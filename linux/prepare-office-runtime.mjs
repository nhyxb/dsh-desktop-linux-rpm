import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const linuxLock = JSON.parse(await readFile(new URL('./office-runtime-lock.json', import.meta.url), 'utf8'))

function replaceKnown(source, before, after, file) {
  if (source.includes(after)) return source
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) {
    throw new Error(`Linux Office adaptation: upstream ${file} changed; review the adapter before building`)
  }
  return source.replace(before, after)
}

/** Adapt the extracted upstream tree, leaving its npm lockfile and checks intact. */
export async function prepareLinuxOffice(sourceRoot) {
  const lockPath = join(sourceRoot, 'scripts/office-runtime/lock.json')
  let lock
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    try {
      await access(join(sourceRoot, 'scripts/office-runtime/prepare.mjs'))
    } catch (missing) {
      if (missing.code === 'ENOENT') return false // Releases before the Office runtime.
      throw missing
    }
    throw new Error('Linux Office adaptation: upstream Office asset lock is missing')
  }

  // These assets come from the same immutable Harness lock as upstream's assets.
  // Never reuse them against a different Python or native-wheel version.
  assert.equal(lock.pythonVersion, linuxLock.pythonVersion, 'Linux Office Python version changed')
  assert.equal(lock.pythonRelease, linuxLock.pythonRelease, 'Linux Office Python release changed')
  for (const name of ['numpy', 'pandas', 'Pillow', 'lxml']) {
    assert.equal(lock.pythonPackages[name], linuxLock.pythonPackages[name], `Linux Office ${name} version changed`)
  }
  if (lock.targets['linux-x64']) assert.deepEqual(lock.targets['linux-x64'], linuxLock.target)

  const adaptations = [
    ['scripts/office-runtime/prepare.mjs',
      "platform: windows ? 'win32' : 'darwin',",
      "platform: target.startsWith('linux-') ? 'linux' : windows ? 'win32' : 'darwin',"],
    ['scripts/verify-office-runtime.cjs',
      ': path.join(context.appOutDir, `${product}.exe`)',
      ": path.join(context.appOutDir, process.platform === 'linux' ? context.packager.executableName : `${product}.exe`)"],
    ['scripts/verify-packaged-ppt-runtime.cjs',
      "const executable = process.platform === 'win32'",
      "const executable = process.platform === 'linux'\n    ? path.join(context.appOutDir, context.packager.executableName)\n    : process.platform === 'win32'"],
    // Added in upstream 0.12.1; older Office releases have no Harness gate.
    ['scripts/verify-packaged-harness.cjs',
      ': path.join(context.appOutDir, `${product}.exe`)',
      ": path.join(context.appOutDir, context.electronPlatformName === 'linux' ? context.packager.executableName : `${product}.exe`)",
      true],
    ['build/office-engine-resolution.mjs',
      String.raw`/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u`,
      String.raw`/^@deepseek-ai\/libreoffice-kit-(?:darwin-|win32-|linux-|wasm(?:\/|$))/u`]
  ]
  // Validate all supported upstream seams before writing any changes.
  const files = await Promise.all(adaptations.map(async ([file, before, after, optional = false]) => {
    const path = join(sourceRoot, file)
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null
      throw error
    }
    return [path, replaceKnown(source, before, after, file)]
  }))
  lock.targets['linux-x64'] = linuxLock.target
  for (const [path, contents] of files.filter(Boolean)) await writeFile(path, contents)
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n')
  return true
}

export async function prepareLinuxOfficeDependencies(sourceRoot) {
  try {
    await access(join(sourceRoot, 'scripts/office-runtime/lock.json'))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  // Node returns undefined for missing entries; Electron's ASAR shim returns
  // null. Both mean absent, so Linux can select its installed WASM engine.
  // An existing but incomplete native package must still fail verification.
  // The published API and CLI each bundle this probe.
  const files = await Promise.all(['index.js', 'cli.js'].map(async name => {
    const file = `node_modules/@deepseek-ai/libreoffice-kit/lib/${name}`
    const path = join(sourceRoot, file)
    const prepared = replaceKnown(await readFile(path, 'utf8'),
      'lstatSync(join(directory, name), { throwIfNoEntry: false }) !== void 0',
      'lstatSync(join(directory, name), { throwIfNoEntry: false }) != null', file)
    return [path, prepared]
  }))
  for (const [path, prepared] of files) await writeFile(path, prepared)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--dependencies')) {
    throw new Error('Usage: node linux/prepare-office-runtime.mjs <extracted upstream root> [--dependencies]')
  }
  const dependencies = process.argv[3] === '--dependencies'
  const changed = await (dependencies ? prepareLinuxOfficeDependencies : prepareLinuxOffice)(resolve(process.argv[2]))
  console.log(changed ? (dependencies ? 'Linux Office runtime: Electron ASAR package detection prepared' : 'Linux Office runtime: verified asset lock and Linux/WASM paths prepared') : 'Upstream has no bundled Office runtime; no adaptation needed')
}
