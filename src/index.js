#!/usr/bin/env node
// tldraw-mcp: an MCP server that lets Claude Code draw on tldraw boards
// (.tldr files you import into tldraw.com), and preview/export them with tldraw.
import { mkdirSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, resolve, dirname, isAbsolute, extname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Board, BoardError, keyOf } from './board.js'
import { loadMedia, fetchLinkPreview } from './assets.js'
import { renderBoard, closePreview, PreviewUnavailable } from './preview.js'
import { TOOLS, INSTRUCTIONS } from './tools.js'

const VERSION = '2.0.0'
const BOARDS_DIR = resolve(process.env.TLDRAW_BOARDS_DIR || join(homedir(), 'tldraw-boards'))
const PREVIEW_MAX_SIDE = Number(process.env.TLDRAW_PREVIEW_MAX_PX || 1600)

// ---------- board files ----------

function boardPath(name) {
  if (!name || typeof name !== 'string' || !name.trim()) throw new BoardError('"board" is required')
  const n = name.trim()
  if (/[\\/]/.test(n) || isAbsolute(n)) {
    // A path: relative paths are relative to the folder Claude Code was started in.
    const p = resolve(n.startsWith('~') ? join(homedir(), n.slice(1)) : n)
    return extname(p).toLowerCase() === '.tldr' ? p : `${p}.tldr`
  }
  const clean = n.replace(/\.tldr$/i, '').replace(/[^A-Za-z0-9 _.()-]/g, '_')
  if (!clean || clean.startsWith('.')) throw new BoardError(`Invalid board name "${name}"`)
  mkdirSync(BOARDS_DIR, { recursive: true })
  return join(BOARDS_DIR, `${clean}.tldr`)
}

// One edit at a time per file.
const locks = new Map()
function withLock(path, fn) {
  const prev = locks.get(path) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(path, next.catch(() => {}))
  return next
}

/** Load, change, validate and save a board. Nothing is written if fn throws. */
function edit(name, fn) {
  const path = boardPath(name)
  return withLock(path, async () => {
    const board = Board.load(path)
    const result = await fn(board)
    board.save(path)
    return { ...result, ...(board.warnings.length ? { warnings: board.warnings } : {}), file: path }
  })
}

const each = async (list, label, fn) => {
  if (!Array.isArray(list) || !list.length) throw new BoardError(`${label} must be a non-empty array`)
  const out = []
  for (let i = 0; i < list.length; i++) {
    try {
      out.push(await fn(list[i], i))
    } catch (e) {
      // Programming errors propagate as-is; everything else is the caller's input.
      if (e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError) throw e
      const where = `${label}[${i}]${list[i]?.key ? ` ("${list[i].key}")` : ''}`
      throw new BoardError(`${where}: ${e.message.replace(/ \(nothing was saved\)$/, '')} (nothing was saved)`)
    }
  }
  return out
}

/**
 * Resolve media files and link previews (file/network IO) before touching the board.
 * type: the shape type ('image', 'video', 'bookmark', ...).
 */
async function prepare(spec, type, notes) {
  if (!spec || typeof spec !== 'object') return spec
  const out = { ...spec }
  if (spec.src !== undefined) {
    if (type !== 'image' && type !== 'video') throw new BoardError('src only applies to images and videos')
    out._media = await loadMedia(spec.src, type, process.cwd())
    if (out._media.warning) notes.push(out._media.warning)
  }
  if (type === 'bookmark' && spec.url && spec.fetchPreview !== false && !(spec.title && spec.description)) {
    out._preview = await fetchLinkPreview(spec.url)
    if (out._preview.warning) notes.push(out._preview.warning)
  }
  return out
}

// ---------- rendering ----------

async function render(name, args, extra) {
  const path = boardPath(name)
  return withLock(path, async () => {
    const board = Board.load(path)
    const page = board.page(args.page)
    const shapeIds = args.keys?.length ? args.keys.map((k) => board.shape(k).id) : undefined
    const result = await renderBoard(board.toFileJson(), { pageId: page.id, shapeIds, darkMode: args.darkMode, ...extra })
    if (!result.ok) throw new BoardError(result.error)
    // Keep tldraw's exact label measurements in the file.
    const fixed = board.applyMeasurements(result.measurements ?? [])
    if (fixed) board.save(path)
    return { result, board, page, path, fixed }
  })
}

// ---------- handlers ----------

const handlers = {
  async create_board({ board, title, overwrite }) {
    const path = boardPath(board)
    return withLock(path, async () => {
      if (existsSync(path) && !overwrite) throw new BoardError(`Board "${board}" already exists (${path}). Pass overwrite: true to replace it, or pick another name.`)
      mkdirSync(dirname(path), { recursive: true })
      Board.createEmpty(title ?? basename(path, '.tldr')).save(path)
      return { created: path }
    })
  },

  async list_boards() {
    mkdirSync(BOARDS_DIR, { recursive: true })
    const boards = readdirSync(BOARDS_DIR).filter((f) => f.toLowerCase().endsWith('.tldr')).map((f) => {
      const st = statSync(join(BOARDS_DIR, f))
      return { board: f.replace(/\.tldr$/i, ''), file: join(BOARDS_DIR, f), modified: st.mtime.toISOString(), sizeKB: Math.round(st.size / 1024) }
    }).sort((a, b) => b.modified.localeCompare(a.modified))
    return { folder: BOARDS_DIR, boards }
  },

  async read_board({ board, page, keys }) {
    const path = boardPath(board)
    return { file: path, ...Board.load(path).summary({ page, keys }) }
  },

  async add_shapes({ board, shapes }) {
    const notes = []
    const prepared = await each(shapes, 'shapes', (s) => prepare(s, s?.kind, notes))
    const r = await edit(board, async (b) => ({ added: await each(prepared, 'shapes', (s) => b.addShape(s)) }))
    return notes.length ? { ...r, notes } : r
  },

  async connect({ board, arrows }) {
    return edit(board, async (b) => ({ added: await each(arrows, 'arrows', (a) => b.connect(a)) }))
  },

  async update_shapes({ board, updates }) {
    const notes = []
    // Loading media or a link preview depends on what kind of shape is being changed.
    const types = new Map(Board.load(boardPath(board)).shapes().map((s) => [keyOf(s.id), s.type]))
    const prepared = await each(updates, 'updates', (u) => prepare(u, types.get(String(u?.key ?? '').replace(/^shape:/, '')), notes))
    const r = await edit(board, async (b) => ({ updated: await each(prepared, 'updates', (u) => b.update(u)) }))
    return notes.length ? { ...r, notes } : r
  },

  async delete_shapes({ board, keys }) {
    return edit(board, (b) => ({ deleted: b.remove(keys) }))
  },

  async duplicate_shapes({ board, keys, offset, page, includeConnections }) {
    return edit(board, (b) => ({ copies: b.duplicate({ keys, offset, page, includeConnections }) }))
  },

  async group_shapes({ board, keys, key }) {
    return edit(board, (b) => ({ group: b.group({ keys, key }) }))
  },

  async ungroup_shapes({ board, keys }) {
    return edit(board, (b) => ({ ungrouped: b.ungroup(keys) }))
  },

  async reorder_shapes({ board, keys, action }) {
    return edit(board, (b) => ({ reordered: b.reorder({ keys, action }) }))
  },

  async arrange_shapes({ board, keys, action, gap, columns }) {
    return edit(board, (b) => ({ arranged: b.arrange({ keys, action, gap, columns }) }))
  },

  async add_page({ board, key, name, position }) {
    return edit(board, (b) => ({ page: b.addPage({ key, name, position }) }))
  },

  async update_page({ board, page, name, position }) {
    return edit(board, (b) => ({ page: b.updatePage({ page, name, position }) }))
  },

  async delete_page({ board, page }) {
    return edit(board, (b) => b.deletePage({ page }))
  },

  async preview_board(args) {
    const { result, board, page } = await render(args.board, args, { format: 'png', maxSide: PREVIEW_MAX_SIDE })
    const info = {
      page: keyOf(page.id),
      pages: board.pages().map((p) => keyOf(p.id)),
      ...(result.empty ? { empty: 'This page has no shapes yet.' } : { imageSize: `${Math.round(result.width)}x${Math.round(result.height)}` }),
      ...(result.bounds ? { contentBounds: { x: Math.round(result.bounds.x), y: Math.round(result.bounds.y), w: Math.round(result.bounds.w), h: Math.round(result.bounds.h) } } : {}),
      warnings: result.warnings?.length ? result.warnings : 'none',
    }
    const content = [{ type: 'text', text: JSON.stringify(info, null, 1) }]
    if (!result.empty) content.unshift({ type: 'image', data: result.data, mimeType: 'image/png' })
    return { content }
  },

  async export_board(args) {
    const format = args.format ?? 'png'
    const { result, page, path } = await render(args.board, args, {
      format, scale: args.scale, background: args.background, padding: args.padding,
    })
    if (result.empty) throw new BoardError('Nothing to export: this page has no shapes.')
    const pages = Board.load(path).pages()
    const suffix = pages.length > 1 ? `-${keyOf(page.id)}` : ''
    const out = args.file ? resolve(args.file) : join(dirname(path), `${basename(path, '.tldr')}${suffix}.${format === 'jpeg' ? 'jpg' : format}`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, format === 'svg' ? result.data : Buffer.from(result.data, 'base64'))
    return { exported: out, width: Math.round(result.width), height: Math.round(result.height), ...(result.warnings?.length ? { warnings: result.warnings } : {}) }
  },
}

// ---------- server ----------

const server = new Server({ name: 'tldraw', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const handler = handlers[name]
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}"` }] }
  try {
    const result = await handler(req.params.arguments ?? {})
    if (result && Array.isArray(result.content)) return result
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] }
  } catch (e) {
    const expected = e instanceof BoardError || e instanceof PreviewUnavailable || /^(File not found|.* is not an? |Malformed|.* MB; the limit)/.test(e.message)
    const text = expected ? e.message : `Unexpected error: ${e.message}`
    if (!expected) process.stderr.write(`${e.stack}\n`)
    return { isError: true, content: [{ type: 'text', text }] }
  }
})

const shutdown = async () => { await closePreview(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('close', shutdown)

await server.connect(new StdioServerTransport())
