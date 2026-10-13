// Updates all tldraw packages together to the newest release, rebuilds the
// preview renderer and runs the tests. Use when tldraw.com moves to a newer
// file format ("saved by a newer version of tldraw").
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

const latest = execSync('npm view tldraw version', { cwd: root, encoding: 'utf8' }).trim()
console.log(`Updating tldraw packages to ${latest}...`)
run(`npm install --save-exact tldraw@${latest} @tldraw/tlschema@${latest} @tldraw/utils@${latest} @tldraw/assets@${latest}`)
run('node scripts/build-viewer.mjs --force')
run('npm test')
console.log(`\nDone: tldraw-mcp now uses tldraw ${latest}. Restart Claude Code to load it.`)
