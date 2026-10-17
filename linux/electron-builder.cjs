const fs = require('node:fs')
const path = require('node:path')

// Preserve upstream packaging inputs while retaining the physical session
// constant consumed by this repository's automatic-release compatibility gate.
const { build } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
if (!build) throw new Error('Upstream electron-builder configuration is missing')
const unpack = build.asarUnpack === undefined ? [] : Array.isArray(build.asarUnpack) ? build.asarUnpack : [build.asarUnpack]
module.exports = {
  ...build,
  asarUnpack: [...new Set([...unpack, 'node_modules/@deepseek-ai/dsh-session/lib/index.js'])]
}
