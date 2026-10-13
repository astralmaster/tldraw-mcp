// Test helpers: run the real server over stdio, exactly as Claude Code does.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTLSchema } from '@tldraw/tlschema'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = createTLSchema()

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'tldraw-mcp-test-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'src', 'index.js')],
    cwd: dir,
    env: { ...process.env, TLDRAW_BOARDS_DIR: join(dir, 'boards') },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)

  async function raw(name, args) {
    return client.callTool({ name, arguments: args })
  }
  /** Call a tool that must succeed; returns parsed JSON (or the raw result for image tools). */
  async function call(name, args) {
    const r = await raw(name, args)
    if (r.isError) assert.fail(`${name} failed: ${r.content[0].text}`)
    const text = r.content.find((c) => c.type === 'text')?.text
    const json = text ? JSON.parse(text) : {}
    return Object.assign(json, { _content: r.content })
  }
  /** Call a tool that must fail; returns the error text. */
  async function fails(name, args, pattern) {
    const r = await raw(name, args)
    assert.ok(r.isError, `${name} should have failed but returned ${r.content[0]?.text?.slice(0, 200)}`)
    const text = r.content[0].text
    if (pattern) assert.match(text, pattern)
    return text
  }
  const close = () => client.close()
  return { client, call, fails, raw, close, dir, boardsDir: join(dir, 'boards') }
}

/** Validate a saved .tldr the way tldraw.com does on import (migrate + validate every record). */
export function assertValidFile(path) {
  const file = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(file.tldrawFileFormatVersion, 1)
  const res = schema.migrateStoreSnapshot({ store: Object.fromEntries(file.records.map((r) => [r.id, r])), schema: file.schema })
  assert.equal(res.type, 'success', `migration failed: ${res.reason}`)
  for (const r of Object.values(res.value)) schema.types[r.typeName].validate(r)
  return file
}

export const hasBrowser = () => !!process.env.CHROME_PATH || process.env.TLDRAW_TEST_BROWSER === '1'
