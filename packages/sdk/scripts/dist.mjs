// Turns the workspace build into a package that installs on its own.
//
// The SDK imports `@agenttrace/manifest` and `@agenttrace/shared` by name, and
// neither is published: they are compiled into `dist/` next to the SDK. Their
// bare specifiers are rewritten to relative paths here, and the step fails if
// one survives — a tarball that still names them installs cleanly and breaks
// on the first import, in someone else's project.
//
//   node scripts/dist.mjs clean   remove dist/ before tsc
//   node scripts/dist.mjs link    rewrite the specifiers after tsc

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const BUNDLED = ['manifest', 'shared']
const SPECIFIER = /(['"])@agenttrace\/(manifest|shared)\1/g

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return files(path)
    return /\.(js|d\.ts)$/.test(entry.name) ? [path] : []
  })
}

function target(from, pkg) {
  const path = relative(dirname(from), join(DIST, pkg, 'src', 'index.js'))
    .split(sep)
    .join('/')
  return path.startsWith('.') ? path : `./${path}`
}

function link() {
  const leftovers = []
  for (const file of files(DIST)) {
    const source = readFileSync(file, 'utf8')
    const linked = source.replace(
      SPECIFIER,
      (_, quote, pkg) => `${quote}${target(file, pkg)}${quote}`,
    )
    if (linked !== source) writeFileSync(file, linked)
    if (linked.includes('@agenttrace/')) leftovers.push(relative(DIST, file))
  }
  if (leftovers.length > 0) {
    throw new Error(`dist: @agenttrace/ is still named in ${leftovers.join(', ')}`)
  }
  for (const pkg of ['sdk', ...BUNDLED]) {
    if (!files(DIST).some((file) => file.includes(`${sep}${pkg}${sep}`))) {
      throw new Error(`dist: nothing was built for ${pkg}`)
    }
  }
}

const mode = process.argv[2]
if (mode === 'clean') rmSync(DIST, { recursive: true, force: true })
else if (mode === 'link') link()
else throw new Error(`dist: unknown mode ${String(mode)}`)
