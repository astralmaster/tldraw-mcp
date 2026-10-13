// Builds the headless tldraw viewer used by preview_board and export_board.
// Runs automatically after `npm install`; `npm run build-viewer` rebuilds it.
import { build } from 'esbuild'
import { cpSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'viewer', 'dist')
const stamp = join(out, 'build.json')
const require = createRequire(import.meta.url)
// Package folders (their package.json files are not exported, so walk up from the entry point).
function pkgDir(name) {
  let dir = dirname(require.resolve(name))
  while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name) {
    const up = dirname(dir)
    if (up === dir) throw new Error(`Cannot find package ${name}`)
    dir = up
  }
  return dir
}
const version = JSON.parse(readFileSync(join(pkgDir('tldraw'), 'package.json'), 'utf8')).version

const force = process.argv.includes('--force')
if (!force && existsSync(stamp)) {
  try {
    if (JSON.parse(readFileSync(stamp, 'utf8')).tldraw === version) process.exit(0)
  } catch {}
}

try {
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: [join(root, 'viewer', 'viewer.jsx')],
    bundle: true,
    outfile: join(out, 'viewer.js'),
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file', '.png': 'file' },
    logLevel: 'warning',
  })
  const assets = join(root, 'node_modules', '@tldraw', 'assets')
  for (const dir of ['fonts', 'icons', 'translations', 'embed-icons']) {
    cpSync(join(assets, dir), join(out, 'assets', dir), { recursive: true })
  }
  writeFileSync(join(out, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="viewer.css"></head>' +
    '<body style="margin:0"><div id="root"></div><script src="viewer.js"></script></body></html>')
  writeFileSync(stamp, JSON.stringify({ tldraw: version, built: new Date().toISOString() }))
  console.log(`tldraw-mcp: built preview renderer (tldraw ${version})`)
} catch (e) {
  // Never fail the install: drawing works without previews.
  console.warn(`tldraw-mcp: could not build the preview renderer (${e.message}). Drawing still works; run "npm run build-viewer" to retry.`)
}
