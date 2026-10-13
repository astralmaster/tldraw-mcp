// The board engine: reads, edits and writes tldraw .tldr files.
//
// Every record is created with tldraw's own schema package (@tldraw/tlschema)
// and every save is validated with the same validators tldraw.com uses when it
// imports a file, so a saved board always opens.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import {
  createTLSchema, b64Vecs,
  GeoShapeGeoStyle, DefaultColorStyle, DefaultFillStyle, DefaultDashStyle, DefaultSizeStyle,
  DefaultFontStyle, DefaultHorizontalAlignStyle, DefaultVerticalAlignStyle, DefaultTextAlignStyle,
  ArrowShapeArrowheadStartStyle, ArrowShapeKindStyle, LineShapeSplineStyle,
} from '@tldraw/tlschema'
import { getIndexAbove, getIndexBetween, getIndicesBetween } from '@tldraw/utils'
import {
  Mat, rotate, toRad, toDeg, round, boundsOf, boxCorners, estimateRich, textWidth,
  THEME_FONT_SIZE, LABEL_PADDING, FONT_SIZES, LABEL_FONT_SIZES,
} from './geometry.js'
import { markdownToRichText, richTextToMarkdown, richTextLines, isEmptyRichText } from './richtext.js'

export const schema = createTLSchema()

// ---------- vocabulary ----------

const vals = (style) => [...style.values]
export const ENUMS = {
  geo: vals(GeoShapeGeoStyle),
  color: vals(DefaultColorStyle),
  fill: vals(DefaultFillStyle),
  dash: vals(DefaultDashStyle),
  size: vals(DefaultSizeStyle),
  font: vals(DefaultFontStyle),
  align: vals(DefaultHorizontalAlignStyle).filter((v) => !v.endsWith('-legacy')),
  verticalAlign: vals(DefaultVerticalAlignStyle),
  textAlign: vals(DefaultTextAlignStyle),
  arrowhead: vals(ArrowShapeArrowheadStartStyle),
  arrowKind: vals(ArrowShapeKindStyle),
  spline: vals(LineShapeSplineStyle),
  anchor: ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
}

export const SHAPE_KINDS = [...ENUMS.geo, 'box', 'text', 'note', 'frame', 'line', 'draw', 'highlight', 'image', 'video', 'embed', 'bookmark']

// Embed providers tldraw renders, with tldraw's default sizes.
export const EMBED_PROVIDERS = [
  { type: 'tldraw', hosts: ['tldraw.com', 'beta.tldraw.com'], w: 720, h: 500 },
  { type: 'figma', hosts: ['figma.com'], w: 720, h: 500 },
  { type: 'canva', hosts: ['canva.com'], w: 720, h: 500 },
  { type: 'google_maps', hosts: ['google.*'], path: /^\/maps/, w: 720, h: 500 },
  { type: 'val_town', hosts: ['val.town'], w: 720, h: 500 },
  { type: 'codesandbox', hosts: ['codesandbox.io'], w: 720, h: 500 },
  { type: 'codepen', hosts: ['codepen.io'], w: 520, h: 400 },
  { type: 'scratch', hosts: ['scratch.mit.edu'], w: 520, h: 400 },
  { type: 'youtube', hosts: ['youtube.com', '*.youtube.com', 'youtu.be'], w: 800, h: 450 },
  { type: 'google_calendar', hosts: ['calendar.google.*'], w: 720, h: 500 },
  { type: 'google_slides', hosts: ['docs.google.*'], w: 720, h: 500 },
  { type: 'github_gist', hosts: ['gist.github.com'], w: 720, h: 500 },
  { type: 'replit', hosts: ['replit.com'], w: 720, h: 500 },
  { type: 'felt', hosts: ['felt.com'], w: 720, h: 500 },
  { type: 'spotify', hosts: ['open.spotify.com'], w: 720, h: 500 },
  { type: 'vimeo', hosts: ['vimeo.com', 'player.vimeo.com'], w: 640, h: 360 },
  { type: 'observable', hosts: ['observablehq.com'], w: 720, h: 500 },
  { type: 'desmos', hosts: ['desmos.com'], w: 700, h: 450 },
]

export function embedProvider(url) {
  let u
  try { u = new URL(url) } catch { return null }
  const host = u.hostname.replace(/^www\./, '')
  const match = (pattern) => {
    const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]+') + '$')
    return re.test(host)
  }
  // Most specific first so calendar.google.com is not taken for google maps.
  const ordered = [...EMBED_PROVIDERS].sort((a, b) => Math.max(...b.hosts.map((h) => h.length)) - Math.max(...a.hosts.map((h) => h.length)))
  return ordered.find((p) => p.hosts.some(match) && (!p.path || p.path.test(u.pathname))) ?? null
}

const ANCHORS = {
  center: { x: 0.5, y: 0.5 }, top: { x: 0.5, y: 0 }, bottom: { x: 0.5, y: 1 }, left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 }, 'top-left': { x: 0, y: 0 }, 'top-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 1 }, 'bottom-right': { x: 1, y: 1 },
}

const NOTE_SIZE = 200
const BOOKMARK_W = 300
const BOOKMARK_H = 320
const DEFAULT_MEDIA_MAX = 800

// ---------- small helpers ----------

export class BoardError extends Error {}
const fail = (msg) => { throw new BoardError(msg) }

const cleanKey = (key, what = 'key') => {
  const k = String(key ?? '').trim().replace(/^(shape|page|asset|binding):/, '').replace(/[^A-Za-z0-9_.-]/g, '_')
  if (!k) fail(`Invalid ${what} "${key}"`)
  return k
}
const rand = () => Math.random().toString(36).slice(2, 8)
const textSig = (s) => JSON.stringify([s.props.richText, s.props.size, s.props.font, s.props.w, s.props.autoSize])
export const keyOf = (id) => String(id).replace(/^[a-z_]+:/, '')

function checkEnum(name, value, allowed) {
  if (value === undefined || value === null) return
  if (!allowed.includes(value)) fail(`${name} "${value}" is not valid. Use one of: ${allowed.join(', ')}`)
}
function checkNum(name, v, { min, max, positive } = {}) {
  if (v === undefined || v === null) return
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`)
  if (positive && v <= 0) fail(`${name} must be greater than 0`)
  if (min !== undefined && v < min) fail(`${name} must be at least ${min}`)
  if (max !== undefined && v > max) fail(`${name} must be at most ${max}`)
}
function checkBool(name, v) {
  if (v !== undefined && typeof v !== 'boolean') fail(`${name} must be true or false`)
}
function checkUrl(name, v) {
  if (v === undefined || v === '') return
  try { const u = new URL(v); if (!/^https?:$|^mailto:$/.test(u.protocol)) throw 0 } catch { fail(`${name} must be a full http(s) URL`) }
}
const STYLE_CHECKS = {
  color: ENUMS.color, labelColor: ENUMS.color, fill: ENUMS.fill, dash: ENUMS.dash, size: ENUMS.size,
  font: ENUMS.font, verticalAlign: ENUMS.verticalAlign, spline: ENUMS.spline,
  arrowheadStart: ENUMS.arrowhead, arrowheadEnd: ENUMS.arrowhead,
}
function checkStyles(spec) {
  for (const [k, allowed] of Object.entries(STYLE_CHECKS)) checkEnum(k, spec[k], allowed)
  checkNum('opacity', spec.opacity, { min: 0, max: 1 })
  checkNum('rotation', spec.rotation)
  checkNum('scale', spec.scale, { positive: true })
  for (const b of ['locked', 'flipX', 'flipY']) checkBool(b, spec[b])
}

const POINT_ERR = 'points must be an array of {x, y} with at least 2 points'
function checkPoints(points, min = 2) {
  if (!Array.isArray(points) || points.length < min) fail(POINT_ERR)
  for (const p of points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(POINT_ERR)
  }
}

// ---------- the board ----------

export class Board {
  constructor(records, warnings = []) {
    this.records = new Map(records.map((r) => [r.id, r]))
    this.warnings = warnings
  }

  static createEmpty(title = '') {
    return new Board([
      { id: 'document:document', typeName: 'document', gridSize: 10, name: title, meta: {} },
      { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    ])
  }

  static fromFileJson(file, label = 'file') {
    if (!file || !Array.isArray(file.records) || !file.schema) fail(`${label} is not a tldraw .tldr file`)
    const warnings = []
    const known = file.records.filter((r) => {
      if (schema.types[r.typeName]) return true
      warnings.push(`Dropped a "${r.typeName}" record this server does not understand.`)
      return false
    })
    const snap = { store: Object.fromEntries(known.map((r) => [r.id, r])), schema: file.schema }
    const res = schema.migrateStoreSnapshot(snap)
    if (res.type !== 'success') {
      fail(`Could not read ${label}: it was saved by a newer version of tldraw (${res.reason}). ` +
        'Run "npm run update-tldraw" in the tldraw-mcp folder.')
    }
    // Session-only records (camera, selection, cursors) are not part of the drawing.
    const keep = Object.values(res.value).filter((r) => ['document', 'page', 'shape', 'binding', 'asset'].includes(r.typeName))
    return new Board(keep, warnings)
  }

  static load(path) {
    if (!existsSync(path)) fail(`Board not found: ${path}. Create it with create_board, or check list_boards.`)
    let json
    try { json = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { fail(`${path} is not valid JSON: ${e.message}`) }
    return Board.fromFileJson(json, path)
  }

  toFileJson() {
    this.refreshArrows()
    this.collectGarbage()
    this.validate()
    return { tldrawFileFormatVersion: 1, schema: schema.serialize(), records: [...this.records.values()] }
  }

  save(path) {
    const json = JSON.stringify(this.toFileJson(), null, 1)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, json)
    renameSync(tmp, path)
  }

  validate() {
    for (const r of this.records.values()) {
      try {
        schema.types[r.typeName].validate(r)
      } catch (e) {
        fail(`Internal error: invalid ${r.typeName} ${r.id}: ${e.message}`)
      }
      if (r.typeName === 'shape') {
        const p = this.records.get(r.parentId)
        if (!p) fail(`Internal error: ${r.id} has missing parent ${r.parentId}`)
        if ((r.type === 'image' || r.type === 'video' || r.type === 'bookmark') && r.props.assetId && !this.records.has(r.props.assetId)) {
          fail(`Internal error: ${r.id} uses missing asset ${r.props.assetId}`)
        }
      }
      if (r.typeName === 'binding') {
        const from = this.records.get(r.fromId), to = this.records.get(r.toId)
        if (!from || !to) fail(`Internal error: binding ${r.id} points at a missing shape`)
        if (this.pageIdOf(from) !== this.pageIdOf(to)) fail(`Internal error: binding ${r.id} crosses pages`)
      }
    }
  }

  // ---------- lookups ----------

  get doc() { return this.records.get('document:document') }

  pages() {
    return [...this.records.values()].filter((r) => r.typeName === 'page').sort((a, b) => (a.index < b.index ? -1 : 1))
  }

  page(ref) {
    const pages = this.pages()
    if (ref === undefined || ref === null || ref === '') return pages[0]
    const s = String(ref)
    const found = this.records.get(`page:${cleanKey(s, 'page')}`) ??
      pages.find((p) => p.name.toLowerCase() === s.toLowerCase())
    if (!found || found.typeName !== 'page') fail(`No page "${ref}". Pages: ${pages.map((p) => `${keyOf(p.id)} ("${p.name}")`).join(', ')}`)
    return found
  }

  shapes() { return [...this.records.values()].filter((r) => r.typeName === 'shape') }
  bindings() { return [...this.records.values()].filter((r) => r.typeName === 'binding') }

  shape(key) {
    const id = `shape:${cleanKey(key)}`
    const s = this.records.get(id)
    if (!s) fail(`No shape with key "${key}". Use read_board to see the keys.`)
    return s
  }

  children(parentId) {
    return this.shapes().filter((s) => s.parentId === parentId).sort((a, b) => (a.index < b.index ? -1 : 1))
  }

  descendants(id) {
    const out = []
    const walk = (pid) => { for (const c of this.children(pid)) { out.push(c); walk(c.id) } }
    walk(id)
    return out
  }

  pageIdOf(shape) {
    let r = shape
    while (r && r.typeName === 'shape') r = this.records.get(r.parentId)
    return r?.id
  }

  bindingsOf(arrow) { return this.bindings().filter((b) => b.fromId === arrow.id) }
  bindingsTo(shape) { return this.bindings().filter((b) => b.toId === shape.id) }

  newShapeId(key, prefix) {
    if (key !== undefined && key !== null && key !== '') {
      const id = `shape:${cleanKey(key)}`
      if (this.records.has(id)) fail(`A shape with key "${keyOf(id)}" already exists. Pick another key.`)
      return id
    }
    let id
    do id = `shape:${prefix}_${rand()}`; while (this.records.has(id))
    return id
  }

  topIndex(parentId) {
    const kids = this.children(parentId)
    return getIndexAbove(kids.length ? kids[kids.length - 1].index : null)
  }

  // ---------- geometry ----------

  /** Bounds of a shape in its own coordinate space. */
  localBounds(s) {
    const p = s.props
    switch (s.type) {
      case 'geo': return { minX: 0, minY: 0, maxX: p.w, maxY: p.h + p.growY }
      case 'note': return { minX: 0, minY: 0, maxX: NOTE_SIZE * p.scale, maxY: (NOTE_SIZE + p.growY) * p.scale }
      case 'text': {
        const size = this.textSize(s)
        return { minX: 0, minY: 0, maxX: size.w, maxY: size.h }
      }
      case 'line': return boundsOf(Object.values(p.points).map((pt) => ({ x: pt.x * p.scale, y: pt.y * p.scale })))
      case 'draw':
      case 'highlight': {
        const pts = p.segments.flatMap((seg) => b64Vecs.decodePoints(seg.path))
        const b = boundsOf(pts.map((pt) => ({ x: pt.x * p.scaleX * p.scale, y: pt.y * p.scaleY * p.scale })))
        const pad = { s: 2, m: 3.5, l: 5, xl: 10 }[p.size] * (s.type === 'highlight' ? 4 : 1)
        return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
      }
      case 'arrow': return boundsOf([p.start, p.end])
      case 'group': {
        const pts = []
        for (const c of this.children(s.id)) {
          const m = Mat.compose(c.x, c.y, c.rotation)
          for (const corner of boxCorners(this.localBounds(c))) pts.push(Mat.apply(m, corner))
        }
        return boundsOf(pts)
      }
      default: return { minX: 0, minY: 0, maxX: p.w, maxY: p.h }
    }
  }

  textSize(s) {
    const p = s.props
    const fs = THEME_FONT_SIZE * FONT_SIZES[p.size]
    const lines = richTextLines(p.richText)
    const measured = this.measured?.get(s.id)
    if (measured && measured.sig === textSig(s)) return { w: measured.w * p.scale, h: measured.h * p.scale }
    const est = estimateRich(lines, fs, p.font, p.autoSize ? null : Math.max(16, p.w))
    return { w: (p.autoSize ? Math.max(16, est.w + 1) : Math.max(16, p.w)) * p.scale, h: est.h * p.scale }
  }

  localMatrix(s) { return Mat.compose(s.x, s.y, s.rotation) }

  parentMatrix(parentId) {
    const parent = this.records.get(parentId)
    return parent && parent.typeName === 'shape' ? this.pageMatrix(parent) : Mat.identity()
  }

  pageMatrix(s) { return Mat.multiply(this.parentMatrix(s.parentId), this.localMatrix(s)) }

  pageRotation(s) { return Mat.rotation(this.pageMatrix(s)) }

  /** Axis-aligned page-space bounds. */
  pageBounds(s) {
    const m = this.pageMatrix(s)
    return boundsOf(boxCorners(this.localBounds(s)).map((c) => Mat.apply(m, c)))
  }

  /**
   * The shape as a box people reason about: (x, y) is the top-left of the
   * unrotated box in page space, rotation (degrees) turns it around its center.
   */
  box(s) {
    const b = this.localBounds(s)
    const w = b.maxX - b.minX, h = b.maxY - b.minY
    const c = Mat.apply(this.pageMatrix(s), { x: b.minX + w / 2, y: b.minY + h / 2 })
    return { x: round(c.x - w / 2), y: round(c.y - h / 2), w: round(w), h: round(h), rotation: toDeg(this.pageRotation(s)) }
  }

  /**
   * Place a shape so its box (page space) is at (x, y) with page rotation rot
   * (radians). Uses the shape's current local bounds for its size.
   */
  place(s, x, y, rot) {
    const b = this.localBounds(s)
    const w = b.maxX - b.minX, h = b.maxY - b.minY
    const centerPage = { x: x + w / 2, y: y + h / 2 }
    const localCenter = { x: b.minX + w / 2, y: b.minY + h / 2 }
    const originPage = { x: centerPage.x - rotate(localCenter, rot).x, y: centerPage.y - rotate(localCenter, rot).y }
    const pm = this.parentMatrix(s.parentId)
    const local = Mat.apply(Mat.invert(pm), originPage)
    s.x = round(local.x)
    s.y = round(local.y)
    s.rotation = rot - Mat.rotation(pm)
    if (Math.abs(s.rotation) < 1e-9) s.rotation = 0
  }

  /** Move a shape by a page-space delta. */
  translate(s, dx, dy) {
    const pm = this.parentMatrix(s.parentId)
    const d = Mat.applyVec(Mat.invert(pm), { x: dx, y: dy })
    s.x = round(s.x + d.x)
    s.y = round(s.y + d.y)
  }

  /** Page point for a normalized anchor on a shape. */
  anchorPoint(s, anchor) {
    const b = this.localBounds(s)
    return Mat.apply(this.pageMatrix(s), { x: b.minX + (b.maxX - b.minX) * anchor.x, y: b.minY + (b.maxY - b.minY) * anchor.y })
  }

  // ---------- label fitting (estimates; preview/export apply tldraw's exact measurements) ----------

  fitLabel(s) {
    const p = s.props
    if (s.type === 'geo') {
      if (isEmptyRichText(p.richText)) { p.growY = 0; return }
      const fs = THEME_FONT_SIZE * LABEL_FONT_SIZES[p.size]
      const width = Math.max(1, p.w / p.scale - LABEL_PADDING * 2)
      const needed = estimateRich(richTextLines(p.richText), fs, p.font, width).h + LABEL_PADDING * 2
      const shapeH = p.h / p.scale
      p.growY = needed > shapeH ? round((needed - shapeH) * p.scale) : 0
    } else if (s.type === 'note') {
      if (isEmptyRichText(p.richText)) { p.growY = 0; p.fontSizeAdjustment = 1; return }
      const base = THEME_FONT_SIZE * LABEL_FONT_SIZES[p.size]
      const width = NOTE_SIZE - LABEL_PADDING * 2 - 1
      const lines = richTextLines(p.richText)
      const longestWord = Math.max(...lines.flatMap((l) => l.text.split(/\s+/).map((w) => w.length)), 0)
      let fs = base
      while (fs > 14 && textWidth('m'.repeat(longestWord), fs, p.font) > width) fs -= 1
      const h = estimateRich(lines, fs, p.font, width).h
      p.fontSizeAdjustment = fs === base ? 1 : fs / base
      p.growY = round(Math.max(0, h + LABEL_PADDING * 2 - NOTE_SIZE))
    }
  }

  /** Apply exact measurements from tldraw's renderer (see preview.js). */
  applyMeasurements(list) {
    let changed = 0
    for (const m of list) {
      const s = this.records.get(m.id)
      if (!s) continue
      if (s.type === 'geo' && m.growY !== undefined && Math.abs(s.props.growY - m.growY) > 0.5) { s.props.growY = m.growY; changed++ }
      if (s.type === 'note' && m.growY !== undefined &&
        (Math.abs(s.props.growY - m.growY) > 0.5 || Math.abs(s.props.fontSizeAdjustment - m.fontSizeAdjustment) > 0.001)) {
        s.props.growY = m.growY
        s.props.fontSizeAdjustment = m.fontSizeAdjustment
        changed++
      }
      if (s.type === 'text' && m.w !== undefined) {
        this.measured ??= new Map()
        this.measured.set(s.id, { sig: textSig(s), w: m.w / s.props.scale, h: m.h / s.props.scale })
      }
    }
    return changed
  }

  // ---------- pages ----------

  addPage({ key, name, position }) {
    const pages = this.pages()
    const k = key ? cleanKey(key, 'page key') : `page_${rand()}`
    const id = `page:${k}`
    if (this.records.has(id)) fail(`A page with key "${k}" already exists`)
    const nm = name ?? `Page ${pages.length + 1}`
    if (pages.some((p) => p.name.toLowerCase() === nm.toLowerCase())) fail(`A page named "${nm}" already exists`)
    this.records.set(id, { id, typeName: 'page', name: nm, index: this.pageIndexAt(position, null), meta: {} })
    return k
  }

  pageIndexAt(position, moving) {
    const pages = this.pages().filter((p) => p.id !== moving)
    if (position === undefined || position === null || position >= pages.length + 1) {
      return getIndexAbove(pages.length ? pages[pages.length - 1].index : null)
    }
    checkNum('position', position, { min: 1 })
    const i = Math.floor(position) - 1
    const before = i > 0 ? pages[i - 1].index : null
    const after = pages[i] ? pages[i].index : null
    return getIndexBetween(before, after)
  }

  updatePage({ page, name, position }) {
    const p = this.page(page)
    if (name !== undefined) {
      if (!String(name).trim()) fail('name cannot be empty')
      if (this.pages().some((o) => o.id !== p.id && o.name.toLowerCase() === String(name).toLowerCase())) fail(`A page named "${name}" already exists`)
      p.name = String(name)
    }
    if (position !== undefined) p.index = this.pageIndexAt(position, p.id)
    return keyOf(p.id)
  }

  deletePage({ page }) {
    const p = this.page(page)
    if (this.pages().length === 1) fail('A board needs at least one page; this is the last one.')
    const doomed = this.descendants(p.id)
    this.removeRecords(new Set(doomed.map((s) => s.id)))
    this.records.delete(p.id)
    return { page: keyOf(p.id), deletedShapes: doomed.length }
  }

  // ---------- creating shapes ----------

  resolveParent(spec) {
    if (spec.parent) {
      const parent = this.shape(spec.parent)
      if (parent.type !== 'frame' && parent.type !== 'group') fail(`parent "${spec.parent}" must be a frame or group`)
      if (spec.page !== undefined && this.pageIdOf(parent) !== this.page(spec.page).id) fail(`parent "${spec.parent}" is on a different page`)
      return parent.id
    }
    return this.page(spec.page).id
  }

  baseRecord(id, type, parentId, spec) {
    return {
      id, typeName: 'shape', type, x: 0, y: 0, rotation: 0,
      isLocked: spec.locked ?? false, opacity: spec.opacity ?? 1,
      parentId, index: this.topIndex(parentId), meta: {}, props: {},
    }
  }

  /**
   * Add a shape. Media must already be resolved into spec._media (see index.js).
   * Returns the new key.
   */
  addShape(spec) {
    if (!spec || typeof spec !== 'object') fail('Each shape must be an object')
    if (!SHAPE_KINDS.includes(spec.kind)) fail(`kind "${spec.kind}" is not valid. Use one of: ${SHAPE_KINDS.join(', ')}`)
    checkStyles(spec)
    checkNum('w', spec.w, { positive: true }); checkNum('h', spec.h, { positive: true })
    checkNum('x', spec.x); checkNum('y', spec.y)
    const kind = spec.kind === 'box' ? 'rectangle' : spec.kind
    const pointBased = kind === 'line' || kind === 'draw' || kind === 'highlight'
    if (!pointBased && (spec.x === undefined || spec.y === undefined)) fail(`${spec.kind} needs x and y`)

    const parentId = this.resolveParent(spec)
    const type = ENUMS.geo.includes(kind) ? 'geo' : kind
    const id = this.newShapeId(spec.key, type === 'geo' ? kind.replace(/-/g, '_') : type)
    const s = this.baseRecord(id, type, parentId, spec)
    const label = () => markdownToRichText(spec.label ?? '')

    switch (type) {
      case 'geo':
        checkEnum('align', spec.align, ENUMS.align)
        checkUrl('url', spec.url)
        s.props = {
          geo: kind, dash: spec.dash ?? 'draw', url: spec.url ?? '', w: spec.w ?? 200, h: spec.h ?? 100, growY: 0,
          scale: spec.scale ?? 1, flipX: spec.flipX ?? false, flipY: spec.flipY ?? false,
          labelColor: spec.labelColor ?? 'black', color: spec.color ?? 'black', fill: spec.fill ?? 'none',
          size: spec.size ?? 'm', font: spec.font ?? 'draw', align: spec.align ?? 'middle',
          verticalAlign: spec.verticalAlign ?? 'middle', richText: label(),
        }
        break
      case 'text':
        checkEnum('align', spec.align, ENUMS.textAlign)
        s.props = {
          color: spec.color ?? 'black', size: spec.size ?? 'm', font: spec.font ?? 'draw',
          textAlign: spec.align ?? 'start', w: spec.w ?? 8, autoSize: spec.w === undefined,
          richText: label(), scale: spec.scale ?? 1,
        }
        break
      case 'note':
        checkEnum('align', spec.align, ENUMS.align)
        checkUrl('url', spec.url)
        s.props = {
          color: spec.color ?? 'yellow', labelColor: spec.labelColor ?? 'black', size: spec.size ?? 'm',
          font: spec.font ?? 'draw', fontSizeAdjustment: 1, align: spec.align ?? 'middle',
          verticalAlign: spec.verticalAlign ?? 'middle', growY: 0, url: spec.url ?? '',
          richText: label(), scale: spec.scale ?? 1, textLastEditedBy: null,
        }
        break
      case 'frame':
        s.props = { w: spec.w ?? 600, h: spec.h ?? 400, name: spec.label ?? '', color: spec.color ?? 'black' }
        break
      case 'line': {
        checkPoints(spec.points)
        s.props = { color: spec.color ?? 'black', dash: spec.dash ?? 'draw', size: spec.size ?? 'm', spline: spec.spline ?? 'line', points: {}, scale: spec.scale ?? 1 }
        this.setLinePoints(s, spec.points)
        break
      }
      case 'draw':
      case 'highlight': {
        const segs = this.parseSegments(spec)
        s.props = type === 'draw'
          ? { color: spec.color ?? 'black', fill: spec.fill ?? 'none', dash: spec.dash ?? 'draw', size: spec.size ?? 'm', segments: [], isComplete: true, isClosed: spec.closed ?? false, isPen: false, scale: spec.scale ?? 1, scaleX: 1, scaleY: 1 }
          : { color: spec.color ?? 'yellow', size: spec.size ?? 'm', segments: [], isComplete: true, isPen: false, scale: spec.scale ?? 1, scaleX: 1, scaleY: 1 }
        checkBool('closed', spec.closed)
        this.setStrokes(s, segs)
        break
      }
      case 'image':
      case 'video':
        this.buildMedia(s, type, spec)
        break
      case 'embed': {
        const url = spec.url
        checkUrl('url', url)
        if (!url) fail('embed needs "url"')
        const provider = embedProvider(url)
        if (!provider) {
          fail(`tldraw cannot embed ${url}. Embeds work for: ${EMBED_PROVIDERS.map((p) => p.hosts[0]).join(', ')}. Use kind "bookmark" for other links.`)
        }
        s.props = { w: spec.w ?? provider.w, h: spec.h ?? provider.h, url }
        break
      }
      case 'bookmark': {
        const url = spec.url
        checkUrl('url', url)
        if (!url) fail('bookmark needs "url"')
        const meta = spec._preview ?? {}
        const assetId = `asset:${keyOf(id)}`
        this.records.set(assetId, {
          id: assetId, typeName: 'asset', type: 'bookmark', meta: {},
          props: {
            title: spec.title ?? meta.title ?? '', description: spec.description ?? meta.description ?? '',
            image: spec.image ?? meta.image ?? '', favicon: meta.favicon ?? '', src: url,
          },
        })
        s.props = { w: spec.w ?? BOOKMARK_W, h: spec.h ?? BOOKMARK_H, assetId, url }
        break
      }
    }

    this.records.set(id, s)
    this.fitLabel(s)

    if (pointBased) {
      // Points are already in page space; the origin was set from them.
      if (spec.rotation) this.place(s, this.box(s).x, this.box(s).y, toRad(spec.rotation))
    } else {
      this.place(s, spec.x, spec.y, toRad(spec.rotation ?? 0))
    }
    return keyOf(id)
  }

  buildMedia(s, type, spec) {
    const m = spec._media
    if (!m) fail(`${type} needs "src": a file path or https URL`)
    checkUrl('url', spec.url)
    const natW = m.w ?? (type === 'video' ? 640 : 400)
    const natH = m.h ?? (type === 'video' ? 360 : 300)
    let crop = null
    if (spec.crop !== undefined && spec.crop !== null) {
      if (type !== 'image') fail('crop only applies to images')
      crop = this.parseCrop(spec.crop)
    }
    const visW = natW * (crop ? crop.bottomRight.x - crop.topLeft.x : 1)
    const visH = natH * (crop ? crop.bottomRight.y - crop.topLeft.y : 1)
    let w = spec.w, h = spec.h
    if (w === undefined && h === undefined) {
      const k = Math.min(1, DEFAULT_MEDIA_MAX / Math.max(visW, visH))
      w = visW * k; h = visH * k
    } else if (w === undefined) w = (h * visW) / visH
    else if (h === undefined) h = (w * visH) / visW
    const assetId = `asset:${keyOf(s.id)}`
    this.records.set(assetId, {
      id: assetId, typeName: 'asset', type, meta: {},
      props: {
        w: natW, h: natH, name: m.name ?? type, isAnimated: type === 'video' ? true : !!m.isAnimated,
        mimeType: m.mimeType ?? null, src: m.src, ...(m.fileSize ? { fileSize: m.fileSize } : {}),
      },
    })
    s.props = type === 'image'
      ? { w: round(w), h: round(h), playing: true, url: spec.url ?? '', assetId, crop, flipX: spec.flipX ?? false, flipY: spec.flipY ?? false, altText: spec.altText ?? '' }
      : { w: round(w), h: round(h), time: spec.time ?? 0, playing: spec.playing ?? false, autoplay: spec.autoplay ?? false, url: spec.url ?? '', assetId, altText: spec.altText ?? '' }
  }

  parseCrop(crop) {
    if (crop.circle === true && crop.x === undefined) {
      return { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 }, isCircle: true }
    }
    for (const k of ['x', 'y', 'w', 'h']) checkNum(`crop.${k}`, crop[k], { min: 0, max: 1 })
    const x = crop.x ?? 0, y = crop.y ?? 0, w = crop.w ?? 1 - x, h = crop.h ?? 1 - y
    if (w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) fail('crop must stay inside the image: x + w <= 1 and y + h <= 1 (fractions of the image)')
    const out = { topLeft: { x, y }, bottomRight: { x: Math.min(1, x + w), y: Math.min(1, y + h) } }
    if (crop.circle) out.isCircle = true
    return out
  }

  /** Line points are given in page space; the line's origin becomes the first point. */
  setLinePoints(s, pagePoints) {
    checkPoints(pagePoints)
    const pm = this.parentMatrix(s.parentId)
    const inv = Mat.invert(pm)
    const first = Mat.apply(inv, pagePoints[0])
    s.x = round(first.x); s.y = round(first.y); s.rotation = 0
    const local = pagePoints.map((p) => {
      const q = Mat.apply(inv, p)
      return { x: (q.x - first.x) / s.props.scale, y: (q.y - first.y) / s.props.scale }
    })
    const indices = getIndicesBetween(null, null, local.length)
    s.props.points = {}
    local.forEach((p, i) => {
      const pid = `p${i}`
      s.props.points[pid] = { id: pid, index: indices[i], x: round(p.x), y: round(p.y) }
    })
  }

  /** Normalized stroke list: [{ type: 'free'|'straight', points: [{x,y,pressure?}] }] in page space. */
  parseSegments(spec) {
    let segs
    if (spec.segments !== undefined) {
      if (!Array.isArray(spec.segments) || !spec.segments.length) fail('segments must be a non-empty array')
      segs = spec.segments.map((seg, i) => {
        if (!seg || typeof seg !== 'object') fail(`segments[${i}] must be an object`)
        checkEnum(`segments[${i}].type`, seg.type ?? 'free', ['free', 'straight'])
        checkPoints(seg.points, 1)
        return { type: seg.type ?? 'free', points: seg.points }
      })
    } else {
      checkPoints(spec.points, 1)
      segs = [{ type: 'free', points: spec.points }]
    }
    return segs
  }

  setStrokes(s, segs) {
    const inv = Mat.invert(this.parentMatrix(s.parentId))
    const first = Mat.apply(inv, segs[0].points[0])
    s.x = round(first.x); s.y = round(first.y); s.rotation = 0
    const k = s.props.scale
    s.props.segments = segs.map((seg) => ({
      type: seg.type,
      path: b64Vecs.encodePoints(seg.points.map((p) => {
        const q = Mat.apply(inv, p)
        return { x: (q.x - first.x) / k, y: (q.y - first.y) / k, z: typeof p.pressure === 'number' ? Math.min(1, Math.max(0, p.pressure)) : 0.5 }
      })),
    }))
  }

  // ---------- arrows ----------

  /** endpoint: shape key | {x,y} | {shape, anchor?, exact?} */
  resolveEndpoint(ep, name, pageId) {
    if (typeof ep === 'string') ep = { shape: ep }
    if (!ep || typeof ep !== 'object') fail(`${name} must be a shape key, a point {x, y}, or {shape, anchor}`)
    if (ep.shape !== undefined) {
      const target = this.shape(ep.shape)
      if (target.type === 'arrow') fail(`${name}: arrows cannot attach to other arrows`)
      if (target.type === 'group') fail(`${name}: arrows cannot attach to a group; attach to a shape inside it`)
      if (this.pageIdOf(target) !== pageId) fail(`${name}: "${ep.shape}" is on a different page`)
      let anchor = ANCHORS.center, precise = false
      if (ep.anchor !== undefined) {
        if (typeof ep.anchor === 'string') {
          checkEnum(`${name}.anchor`, ep.anchor, ENUMS.anchor)
          anchor = ANCHORS[ep.anchor]
        } else if (ep.anchor && typeof ep.anchor === 'object') {
          checkNum(`${name}.anchor.x`, ep.anchor.x, { min: 0, max: 1 }); checkNum(`${name}.anchor.y`, ep.anchor.y, { min: 0, max: 1 })
          anchor = { x: ep.anchor.x ?? 0.5, y: ep.anchor.y ?? 0.5 }
        } else fail(`${name}.anchor must be a name like "top" or {x, y} fractions`)
        precise = !(anchor.x === 0.5 && anchor.y === 0.5)
      }
      checkBool(`${name}.exact`, ep.exact)
      return { shape: target, anchor, precise, exact: ep.exact ?? false, point: this.anchorPoint(target, anchor) }
    }
    checkNum(`${name}.x`, ep.x); checkNum(`${name}.y`, ep.y)
    if (ep.x === undefined || ep.y === undefined) fail(`${name} point needs x and y`)
    return { shape: null, point: { x: ep.x, y: ep.y } }
  }

  setArrowEnd(arrow, terminal, end) {
    for (const b of this.bindingsOf(arrow)) if (b.props.terminal === terminal) this.records.delete(b.id)
    const inv = Mat.invert(this.pageMatrix(arrow))
    arrow.props[terminal] = (({ x, y }) => ({ x: round(x), y: round(y) }))(Mat.apply(inv, end.point))
    if (end.shape) {
      const bid = `binding:${keyOf(arrow.id)}_${terminal}`
      this.records.set(bid, {
        id: bid, typeName: 'binding', type: 'arrow', fromId: arrow.id, toId: end.shape.id, meta: {},
        props: { terminal, normalizedAnchor: end.anchor, isExact: end.exact, isPrecise: end.precise, snap: 'none' },
      })
    }
  }

  connect(spec) {
    if (!spec || typeof spec !== 'object') fail('Each arrow must be an object')
    checkStyles(spec)
    checkEnum('kind', spec.kind, ENUMS.arrowKind)
    checkNum('bend', spec.bend)
    checkNum('labelPosition', spec.labelPosition, { min: 0, max: 1 })
    checkNum('elbowMidPoint', spec.elbowMidPoint, { min: 0, max: 1 })
    if (spec.from === undefined || spec.to === undefined) fail('arrows need "from" and "to"')
    // The arrow lives on the page of whatever it attaches to.
    const shapeKeyOf = (ep) => (typeof ep === 'string' ? ep : ep && typeof ep === 'object' ? ep.shape : undefined)
    const attached = shapeKeyOf(spec.from) ?? shapeKeyOf(spec.to)
    const pageId = spec.page !== undefined ? this.page(spec.page).id
      : attached !== undefined ? this.pageIdOf(this.shape(attached)) : this.page().id
    const from = this.resolveEndpoint(spec.from, 'from', pageId)
    const to = this.resolveEndpoint(spec.to, 'to', pageId)
    if (from.shape && to.shape && from.shape.id === to.shape.id && !from.precise && !to.precise) {
      fail('An arrow from a shape to itself needs anchors, e.g. from {shape, anchor: "right"} to {shape, anchor: "top"}')
    }
    const id = this.newShapeId(spec.key, 'arrow')
    const a = this.baseRecord(id, 'arrow', pageId, spec)
    a.x = round(from.point.x); a.y = round(from.point.y)
    a.props = {
      kind: spec.kind ?? 'arc', labelColor: spec.labelColor ?? 'black', color: spec.color ?? 'black',
      fill: spec.fill ?? 'none', dash: spec.dash ?? 'draw', size: spec.size ?? 'm',
      arrowheadStart: spec.arrowheadStart ?? 'none', arrowheadEnd: spec.arrowheadEnd ?? 'arrow',
      font: spec.font ?? 'draw', start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, bend: spec.bend ?? 0,
      richText: markdownToRichText(spec.label ?? ''), labelPosition: spec.labelPosition ?? 0.5,
      scale: spec.scale ?? 1, elbowMidPoint: spec.elbowMidPoint ?? 0.5,
    }
    this.records.set(id, a)
    this.setArrowEnd(a, 'start', from)
    this.setArrowEnd(a, 'end', to)
    return keyOf(id)
  }

  /** Keep stored arrow terminals in step with the shapes they attach to. */
  refreshArrows() {
    for (const a of this.shapes()) {
      if (a.type !== 'arrow') continue
      const inv = Mat.invert(this.pageMatrix(a))
      for (const b of this.bindingsOf(a)) {
        const target = this.records.get(b.toId)
        if (!target) continue
        const pt = Mat.apply(inv, this.anchorPoint(target, b.props.normalizedAnchor))
        a.props[b.props.terminal] = { x: round(pt.x), y: round(pt.y) }
      }
    }
  }

  // ---------- updating ----------

  update(spec) {
    if (!spec || typeof spec !== 'object' || !spec.key) fail('Each update needs a "key"')
    const s = this.shape(spec.key)
    checkStyles(spec)
    for (const k of ['x', 'y']) checkNum(k, spec[k])
    for (const k of ['w', 'h']) checkNum(k, spec[k], { positive: true })
    const p = s.props
    const has = (k) => spec[k] !== undefined
    const before = this.box(s)

    // Page / parent changes first, keeping the shape where it is on screen.
    if (has('page')) {
      const target = this.page(spec.page)
      if (this.pageIdOf(s) !== target.id) {
        if (s.parentId.startsWith('shape:') && !has('parent')) fail(`"${spec.key}" is inside "${keyOf(s.parentId)}"; move that, or also pass parent: "" to take it out`)
        this.moveToPage(s, target)
      }
    }
    if (has('parent')) {
      const newParent = spec.parent ? this.shape(spec.parent) : this.page(has('page') ? spec.page : undefined)
      if (spec.parent && newParent.type !== 'frame' && newParent.type !== 'group') fail(`parent "${spec.parent}" must be a frame or group`)
      if (spec.parent) {
        for (let r = newParent; r && r.typeName === 'shape'; r = this.records.get(r.parentId)) {
          if (r.id === s.id) fail(`"${spec.key}" cannot go inside itself`)
        }
        if (this.pageIdOf(newParent) !== this.pageIdOf(s)) fail(`parent "${spec.parent}" is on another page; move the shape there first with "page"`)
      } else if (newParent.id !== this.pageIdOf(s)) {
        // parent "" with no page: stay on the current page
      }
      const targetId = spec.parent ? newParent.id : this.pageIdOf(s)
      if (s.parentId !== targetId) {
        const m = this.pageMatrix(s)
        s.parentId = targetId
        s.index = this.topIndex(targetId)
        const local = Mat.multiply(Mat.invert(this.parentMatrix(targetId)), m)
        s.x = round(local.e); s.y = round(local.f); s.rotation = Mat.rotation(local)
        this.cleanupGroups()
      }
    }

    // Kind-specific properties.
    if (has('kind')) {
      if (s.type !== 'geo') fail(`Only outline shapes can change kind; "${spec.key}" is ${/^[aeiou]/.test(s.type) ? 'an' : 'a'} ${s.type}${s.type === 'arrow' ? ' (use arrowKind for arrows)' : ''}`)
      const g = spec.kind === 'box' ? 'rectangle' : spec.kind
      checkEnum('kind', g, ENUMS.geo)
      p.geo = g
    }
    if (has('label')) {
      if (s.type === 'frame') p.name = String(spec.label)
      else if ('richText' in p) p.richText = markdownToRichText(spec.label)
      else fail(`${s.type} shapes have no label`)
    }
    const setIf = (k, propName = k) => {
      if (!has(k)) return
      if (!(propName in p)) fail(`${s.type} shapes have no ${k}`)
      p[propName] = spec[k]
    }
    for (const k of ['color', 'labelColor', 'fill', 'dash', 'size', 'font', 'verticalAlign', 'spline', 'scale', 'flipX', 'flipY',
      'arrowheadStart', 'arrowheadEnd', 'altText', 'playing', 'autoplay', 'time']) setIf(k)
    if (has('align')) {
      if ('textAlign' in p) { checkEnum('align', spec.align, ENUMS.textAlign); p.textAlign = spec.align }
      else if ('align' in p) { checkEnum('align', spec.align, ENUMS.align); p.align = spec.align }
      else fail(`${s.type} shapes have no align`)
    }
    if (has('url')) {
      checkUrl('url', spec.url)
      if (s.type === 'embed') {
        if (!embedProvider(spec.url)) fail(`tldraw cannot embed ${spec.url}`)
        p.url = spec.url
      } else if (s.type === 'bookmark') {
        p.url = spec.url
        const asset = this.records.get(p.assetId)
        const pv = spec._preview ?? {}
        if (asset) {
          asset.props.src = spec.url
          for (const k of ['title', 'description', 'image', 'favicon']) asset.props[k] = pv[k] ?? ''
        }
      } else setIf('url')
    }
    if (s.type === 'bookmark') {
      const asset = this.records.get(p.assetId)
      for (const k of ['title', 'description', 'image']) if (has(k) && asset) asset.props[k] = String(spec[k])
    }
    if (has('closed')) { checkBool('closed', spec.closed); if (s.type !== 'draw') fail('closed only applies to draw shapes'); p.isClosed = spec.closed }
    if (has('crop')) {
      if (s.type !== 'image') fail('crop only applies to images')
      p.crop = spec.crop === null ? null : this.parseCrop(spec.crop)
    }
    if (has('_media')) {
      const asset = this.records.get(p.assetId)
      const m = spec._media
      if (asset) Object.assign(asset.props, { src: m.src, name: m.name ?? asset.props.name, mimeType: m.mimeType ?? null, w: m.w ?? asset.props.w, h: m.h ?? asset.props.h, isAnimated: s.type === 'video' || !!m.isAnimated })
    }
    if (s.type === 'arrow') {
      checkEnum('kind', spec.arrowKind, ENUMS.arrowKind)
      if (has('arrowKind')) p.kind = spec.arrowKind
      for (const k of ['bend', 'labelPosition', 'elbowMidPoint']) {
        if (!has(k)) continue
        checkNum(k, spec[k], k === 'bend' ? {} : { min: 0, max: 1 })
        p[k] = spec[k]
      }
      const pageId = this.pageIdOf(s)
      if (has('from')) this.setArrowEnd(s, 'start', this.resolveEndpoint(spec.from, 'from', pageId))
      if (has('to')) this.setArrowEnd(s, 'end', this.resolveEndpoint(spec.to, 'to', pageId))
    }
    if (has('points')) {
      if (s.type === 'line') this.setLinePoints(s, spec.points)
      else if (s.type === 'draw' || s.type === 'highlight') this.setStrokes(s, this.parseSegments({ points: spec.points }))
      else fail(`${s.type} shapes have no points`)
    } else if (has('segments')) {
      if (s.type !== 'draw' && s.type !== 'highlight') fail(`${s.type} shapes have no segments`)
      this.setStrokes(s, this.parseSegments({ segments: spec.segments }))
    }
    if (has('opacity')) s.opacity = spec.opacity
    if (has('locked')) s.isLocked = spec.locked

    // Size.
    if (has('w') || has('h')) this.resize(s, spec.w, spec.h)

    this.fitLabel(s)

    // Position / rotation (box semantics, page space).
    const repositioned = has('points') || has('segments')
    if (!repositioned && s.type !== 'arrow') {
      const now = this.box(s)
      const x = has('x') ? spec.x : (has('w') || has('h') || has('parent') || has('page')) ? now.x : before.x
      const y = has('y') ? spec.y : (has('w') || has('h') || has('parent') || has('page')) ? now.y : before.y
      const rot = has('rotation') ? toRad(spec.rotation) : this.pageRotation(s)
      if (has('x') || has('y') || has('rotation') || has('w') || has('h') || has('label') || has('size') || has('kind') || has('scale')) {
        this.place(s, x, y, rot)
      }
    } else if (s.type === 'arrow' && (has('x') || has('y'))) {
      fail('Move an arrow by changing what it connects (from / to), not x / y')
    }
    return keyOf(s.id)
  }

  resize(s, w, h) {
    const p = s.props
    switch (s.type) {
      case 'geo': case 'frame': case 'image': case 'video': case 'embed': case 'bookmark':
        if (w !== undefined) p.w = w
        if (h !== undefined) p.h = h
        break
      case 'text':
        if (h !== undefined && w === undefined) fail('Text height follows its content; set w (wrap width) or size instead')
        if (w !== undefined) { p.w = w / p.scale; p.autoSize = false }
        break
      case 'note':
        if (w !== undefined && h !== undefined && Math.abs(w - h) > 1) fail('Notes are square; set w or h (or scale)')
        p.scale = (w ?? h) / NOTE_SIZE
        break
      case 'line': case 'draw': case 'highlight': {
        const b = this.localBounds(s)
        const cw = Math.max(1e-6, b.maxX - b.minX), ch = Math.max(1e-6, b.maxY - b.minY)
        const fx = w !== undefined ? w / cw : 1, fy = h !== undefined ? h / ch : 1
        if (s.type === 'line') {
          for (const pt of Object.values(p.points)) { pt.x = round(pt.x * fx); pt.y = round(pt.y * fy) }
        } else {
          p.scaleX *= fx; p.scaleY *= fy
        }
        break
      }
      case 'group': {
        // Scale children positions and sizes around the group origin.
        const b = this.localBounds(s)
        const fx = w !== undefined ? w / Math.max(1e-6, b.maxX - b.minX) : 1
        const fy = h !== undefined ? h / Math.max(1e-6, b.maxY - b.minY) : 1
        for (const c of this.children(s.id)) {
          const cb = this.box(c)
          const pm = this.pageMatrix(s)
          const local = Mat.apply(Mat.invert(pm), { x: cb.x, y: cb.y })
          if (c.type !== 'arrow') this.resize(c, cb.w * fx, c.type === 'text' ? undefined : cb.h * fy)
          const target = Mat.apply(pm, { x: b.minX + (local.x - b.minX) * fx, y: b.minY + (local.y - b.minY) * fy })
          if (c.type !== 'arrow') this.place(c, target.x, target.y, this.pageRotation(c))
        }
        break
      }
      case 'arrow':
        fail('Arrows size themselves from what they connect')
    }
  }

  moveToPage(s, page) {
    const moving = new Set([s.id, ...this.descendants(s.id).map((d) => d.id)])
    // Arrows lose attachments to shapes that stay behind, and vice versa.
    for (const b of this.bindings()) {
      if (moving.has(b.fromId) !== moving.has(b.toId)) this.records.delete(b.id)
    }
    const m = this.pageMatrix(s)
    s.parentId = page.id
    s.index = this.topIndex(page.id)
    s.x = round(m.e); s.y = round(m.f); s.rotation = Mat.rotation(m)
  }

  // ---------- deleting ----------

  removeRecords(ids) {
    // Arrows attached to deleted shapes keep their current end point.
    this.refreshArrows()
    for (const b of this.bindings()) {
      if (ids.has(b.fromId) || ids.has(b.toId)) this.records.delete(b.id)
    }
    for (const id of ids) this.records.delete(id)
  }

  remove(keys) {
    const ids = new Set()
    for (const k of keys) {
      const s = this.shape(k)
      ids.add(s.id)
      for (const d of this.descendants(s.id)) ids.add(d.id)
    }
    this.removeRecords(ids)
    this.cleanupGroups()
    return [...ids].map(keyOf)
  }

  /** tldraw dissolves groups left with fewer than two children. */
  cleanupGroups() {
    let again = true
    while (again) {
      again = false
      for (const g of this.shapes().filter((x) => x.type === 'group')) {
        const kids = this.children(g.id)
        if (kids.length >= 2) continue
        if (kids.length === 1) this.ungroupOne(g)
        else this.records.delete(g.id)
        again = true
      }
    }
  }

  collectGarbage() {
    const used = new Set(this.shapes().map((s) => s.props.assetId).filter(Boolean))
    for (const r of [...this.records.values()]) if (r.typeName === 'asset' && !used.has(r.id)) this.records.delete(r.id)
  }

  // ---------- duplicate ----------

  duplicate({ keys, offset, page, includeConnections = true }) {
    const dx = offset?.x ?? 40, dy = offset?.y ?? 40
    checkNum('offset.x', dx); checkNum('offset.y', dy)
    const targetPage = page !== undefined ? this.page(page) : null
    const roots = keys.map((k) => this.shape(k))
    const rootIds = new Set(roots.map((r) => r.id))
    // Skip roots that are inside another root (they come along anyway).
    const top = roots.filter((r) => {
      for (let p = this.records.get(r.parentId); p && p.typeName === 'shape'; p = this.records.get(p.parentId)) if (rootIds.has(p.id)) return false
      return true
    })
    const map = new Map()
    const uniqueCopyId = (s) => {
      const base = keyOf(s.id).replace(/_copy\d*$/, '') + '_copy'
      let k = base, n = 2
      while (this.records.has(`shape:${k}`) || [...map.values()].includes(`shape:${k}`)) k = `${base}${n++}`
      return `shape:${k}`
    }
    const all = []
    const visit = (s) => { all.push(s); map.set(s.id, uniqueCopyId(s)); for (const c of this.children(s.id)) visit(c) }
    top.forEach(visit)
    if (includeConnections) {
      for (const a of this.shapes()) {
        if (a.type !== 'arrow' || map.has(a.id)) continue
        const bs = this.bindingsOf(a)
        if (bs.length === 2 && bs.every((b) => map.has(b.toId))) { all.push(a); map.set(a.id, uniqueCopyId(a)) }
      }
    }
    const assetMap = new Map()
    for (const s of all) {
      const copy = structuredClone(s)
      copy.id = map.get(s.id)
      const isRoot = !map.has(s.parentId)
      if (isRoot) {
        copy.parentId = targetPage ? targetPage.id : (s.type === 'arrow' ? this.pageIdOf(s) : s.parentId)
        if (targetPage && s.parentId !== this.pageIdOf(s)) {
          const m = this.pageMatrix(s)
          copy.x = m.e; copy.y = m.f; copy.rotation = Mat.rotation(m)
        }
        copy.index = this.topIndex(copy.parentId)
      } else copy.parentId = map.get(s.parentId)
      if (copy.props.assetId) {
        if (!assetMap.has(copy.props.assetId)) {
          const asset = structuredClone(this.records.get(copy.props.assetId))
          asset.id = `asset:${keyOf(copy.id)}`
          this.records.set(asset.id, asset)
          assetMap.set(copy.props.assetId, asset.id)
        }
        copy.props.assetId = assetMap.get(copy.props.assetId)
      }
      this.records.set(copy.id, copy)
      if (isRoot) this.translate(copy, dx, dy)
    }
    for (const b of this.bindings()) {
      if (!map.has(b.fromId)) continue
      const newArrow = map.get(b.fromId)
      const toId = map.get(b.toId) ?? (this.pageIdOf(this.records.get(b.toId)) === this.pageIdOf(this.records.get(newArrow)) ? b.toId : null)
      if (!toId) continue
      const id = `binding:${keyOf(newArrow)}_${b.props.terminal}`
      this.records.set(id, { ...structuredClone(b), id, fromId: newArrow, toId })
    }
    return Object.fromEntries([...map].map(([a, b]) => [keyOf(a), keyOf(b)]))
  }

  // ---------- groups ----------

  group({ keys, key }) {
    if (!Array.isArray(keys) || keys.length < 2) fail('Group at least 2 shapes')
    const members = keys.map((k) => this.shape(k))
    const parentId = members[0].parentId
    if (members.some((m) => m.parentId !== parentId)) fail('Shapes in a group must share the same parent (same frame/group or all on the page)')
    const pts = []
    for (const m of members) {
      const lm = this.localMatrix(m)
      for (const c of boxCorners(this.localBounds(m))) pts.push(Mat.apply(lm, c))
    }
    const b = boundsOf(pts)
    const id = this.newShapeId(key, 'group')
    const ordered = [...members].sort((a, c) => (a.index < c.index ? -1 : 1))
    const g = {
      id, typeName: 'shape', type: 'group', x: round(b.minX), y: round(b.minY), rotation: 0, isLocked: false, opacity: 1,
      parentId, index: ordered[ordered.length - 1].index, meta: {}, props: {},
    }
    this.records.set(id, g)
    const idx = getIndicesBetween(null, null, ordered.length)
    ordered.forEach((m, i) => {
      m.parentId = id
      m.x = round(m.x - b.minX); m.y = round(m.y - b.minY)
      m.index = idx[i]
    })
    return keyOf(id)
  }

  ungroupOne(g) {
    const kids = this.children(g.id)
    const gm = this.localMatrix(g)
    const siblings = this.children(g.parentId)
    const pos = siblings.findIndex((x) => x.id === g.id)
    const above = siblings[pos + 1]?.index ?? null
    const idx = getIndicesBetween(g.index, above, kids.length)
    kids.forEach((k, i) => {
      const m = Mat.multiply(gm, this.localMatrix(k))
      k.parentId = g.parentId
      k.x = round(m.e); k.y = round(m.f); k.rotation = Mat.rotation(m)
      k.index = idx[i]
    })
    this.records.delete(g.id)
    return kids.map((k) => keyOf(k.id))
  }

  ungroup(keys) {
    const out = {}
    for (const k of keys) {
      const g = this.shape(k)
      if (g.type !== 'group') fail(`"${k}" is not a group`)
      out[keyOf(g.id)] = this.ungroupOne(g)
    }
    return out
  }

  // ---------- layering ----------

  reorder({ keys, action }) {
    checkEnum('action', action, ['front', 'back', 'forward', 'backward'])
    const shapes = keys.map((k) => this.shape(k))
    const byParent = new Map()
    for (const s of shapes) byParent.set(s.parentId, [...(byParent.get(s.parentId) ?? []), s.id])
    for (const [parentId, ids] of byParent) {
      const order = this.children(parentId).map((c) => c.id)
      const sel = new Set(ids)
      let next
      if (action === 'front') next = [...order.filter((i) => !sel.has(i)), ...order.filter((i) => sel.has(i))]
      else if (action === 'back') next = [...order.filter((i) => sel.has(i)), ...order.filter((i) => !sel.has(i))]
      else {
        next = [...order]
        const step = action === 'forward' ? 1 : -1
        const seq = action === 'forward' ? [...next.keys()].reverse() : [...next.keys()]
        for (const i of seq) {
          const id = next[i]
          if (!sel.has(id)) continue
          const j = i + step
          if (j < 0 || j >= next.length || sel.has(next[j])) continue
          ;[next[i], next[j]] = [next[j], next[i]]
        }
      }
      const idx = getIndicesBetween(null, null, next.length)
      next.forEach((id, i) => { this.records.get(id).index = idx[i] })
    }
    return shapes.map((s) => keyOf(s.id))
  }

  // ---------- arranging ----------

  arrange({ keys, action, gap, columns }) {
    const ACTIONS = ['align-left', 'align-center-horizontal', 'align-right', 'align-top', 'align-center-vertical', 'align-bottom',
      'distribute-horizontal', 'distribute-vertical', 'stack-horizontal', 'stack-vertical', 'stretch-horizontal', 'stretch-vertical',
      'flip-horizontal', 'flip-vertical', 'pack', 'grid']
    checkEnum('action', action, ACTIONS)
    checkNum('gap', gap, { min: 0 })
    const shapes = keys.map((k) => this.shape(k))
    if (shapes.length < (action.startsWith('distribute') ? 3 : action === 'pack' || action === 'grid' || action.startsWith('flip') ? 1 : 2)) {
      fail(`${action} needs at least ${action.startsWith('distribute') ? 3 : 2} shapes`)
    }
    for (const s of shapes) if (s.type === 'arrow') fail(`Arrows follow the shapes they connect; leave "${keyOf(s.id)}" out of arrange_shapes`)
    const B = () => shapes.map((s) => ({ s, b: this.pageBounds(s) }))
    const all = () => boundsOf(B().flatMap(({ b }) => boxCorners(b)))
    const g = gap ?? 16
    const moveTo = (s, b, x, y) => this.translate(s, x - b.minX, y - b.minY)

    switch (action) {
      case 'align-left': { const u = all(); for (const { s, b } of B()) moveTo(s, b, u.minX, b.minY); break }
      case 'align-right': { const u = all(); for (const { s, b } of B()) moveTo(s, b, u.maxX - (b.maxX - b.minX), b.minY); break }
      case 'align-center-horizontal': { const u = all(); const cx = (u.minX + u.maxX) / 2; for (const { s, b } of B()) moveTo(s, b, cx - (b.maxX - b.minX) / 2, b.minY); break }
      case 'align-top': { const u = all(); for (const { s, b } of B()) moveTo(s, b, b.minX, u.minY); break }
      case 'align-bottom': { const u = all(); for (const { s, b } of B()) moveTo(s, b, b.minX, u.maxY - (b.maxY - b.minY)); break }
      case 'align-center-vertical': { const u = all(); const cy = (u.minY + u.maxY) / 2; for (const { s, b } of B()) moveTo(s, b, b.minX, cy - (b.maxY - b.minY) / 2); break }
      case 'distribute-horizontal':
      case 'distribute-vertical': {
        const hz = action.endsWith('horizontal')
        const items = B().sort((p, q) => (hz ? p.b.minX - q.b.minX : p.b.minY - q.b.minY))
        const size = (b) => (hz ? b.maxX - b.minX : b.maxY - b.minY)
        const start = hz ? items[0].b.minX : items[0].b.minY
        const last = items[items.length - 1].b
        const end = hz ? last.maxX : last.maxY
        const space = (end - start - items.reduce((t, i) => t + size(i.b), 0)) / (items.length - 1)
        let cur = start
        for (const { s, b } of items) {
          if (hz) moveTo(s, b, cur, b.minY); else moveTo(s, b, b.minX, cur)
          cur += size(b) + space
        }
        break
      }
      case 'stack-horizontal':
      case 'stack-vertical': {
        const hz = action.endsWith('horizontal')
        const items = B().sort((p, q) => (hz ? p.b.minX - q.b.minX : p.b.minY - q.b.minY))
        let cur = hz ? items[0].b.minX : items[0].b.minY
        for (const { s, b } of items) {
          if (hz) { moveTo(s, b, cur, b.minY); cur += b.maxX - b.minX + g } else { moveTo(s, b, b.minX, cur); cur += b.maxY - b.minY + g }
        }
        break
      }
      case 'stretch-horizontal':
      case 'stretch-vertical': {
        const hz = action.endsWith('horizontal')
        const u = all()
        for (const { s } of B()) {
          if (s.rotation !== 0 || this.pageRotation(s) !== 0) fail(`Cannot stretch rotated shape "${keyOf(s.id)}"`)
          if (hz) this.resize(s, u.maxX - u.minX, undefined); else this.resize(s, undefined, u.maxY - u.minY)
          this.fitLabel(s)
          const b = this.pageBounds(s)
          moveTo(s, b, hz ? u.minX : b.minX, hz ? b.minY : u.minY)
        }
        break
      }
      case 'flip-horizontal':
      case 'flip-vertical': {
        const hz = action.endsWith('horizontal')
        const u = all()
        for (const { s, b } of B()) {
          if (hz) moveTo(s, b, u.minX + u.maxX - b.maxX, b.minY); else moveTo(s, b, b.minX, u.minY + u.maxY - b.maxY)
          const prop = hz ? 'flipX' : 'flipY'
          if (prop in s.props) s.props[prop] = !s.props[prop]
        }
        break
      }
      case 'pack':
      case 'grid': {
        checkNum('columns', columns, { min: 1 })
        const items = action === 'pack' ? B().sort((p, q) => (q.b.maxY - q.b.minY) - (p.b.maxY - p.b.minY)) : B()
        const u = all()
        const area = items.reduce((t, { b }) => t + (b.maxX - b.minX + g) * (b.maxY - b.minY + g), 0)
        const cols = columns ?? (action === 'grid' ? Math.ceil(Math.sqrt(items.length)) : null)
        const maxW = Math.max(Math.sqrt(area) * 1.3, ...items.map(({ b }) => b.maxX - b.minX))
        let x = u.minX, y = u.minY, rowH = 0, col = 0
        const cellW = cols ? Math.max(...items.map(({ b }) => b.maxX - b.minX)) : 0
        const cellH = cols ? Math.max(...items.map(({ b }) => b.maxY - b.minY)) : 0
        for (const { s, b } of items) {
          const w = b.maxX - b.minX, h = b.maxY - b.minY
          if (cols) {
            if (col === cols) { col = 0; x = u.minX; y += cellH + g }
            moveTo(s, b, x + (cellW - w) / 2, y + (cellH - h) / 2)
            x += cellW + g; col++
          } else {
            if (x > u.minX && x + w > u.minX + maxW) { x = u.minX; y += rowH + g; rowH = 0 }
            moveTo(s, b, x, y)
            x += w + g; rowH = Math.max(rowH, h)
          }
        }
        break
      }
    }
    return shapes.map((s) => keyOf(s.id))
  }

  // ---------- reading ----------

  describe(s) {
    const p = s.props
    const out = { key: keyOf(s.id), kind: s.type === 'geo' ? p.geo : s.type }
    const parent = this.records.get(s.parentId)
    if (s.type !== 'arrow') Object.assign(out, this.box(s))
    if (out.rotation === 0) delete out.rotation
    if (parent?.typeName === 'shape') out.parent = keyOf(parent.id)
    if (s.type === 'frame') { if (p.name) out.label = p.name }
    else if (p.richText && !isEmptyRichText(p.richText)) out.label = richTextToMarkdown(p.richText)
    const DEFAULTS = {
      labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      textAlign: 'start', scale: 1, flipX: false, flipY: false, url: '', spline: 'line', altText: '',
    }
    if (p.color !== undefined) out.color = p.color
    for (const [k, d] of Object.entries(DEFAULTS)) if (k in p && p[k] !== d) out[k === 'textAlign' ? 'align' : k] = p[k]
    if (s.type === 'text' && !p.autoSize) out.fixedWidth = true
    if (s.type === 'draw' && p.isClosed) out.closed = true
    if (s.opacity !== 1) out.opacity = s.opacity
    if (s.isLocked) out.locked = true
    if (s.type === 'line') out.points = this.linePagePoints(s)
    if (s.type === 'image' || s.type === 'video') {
      const a = this.records.get(p.assetId)
      if (a) out.src = a.props.src?.startsWith('data:') ? `(embedded ${a.props.mimeType ?? ''} "${a.props.name}", ${a.props.w}x${a.props.h})` : a.props.src
      if (p.crop) out.crop = { x: p.crop.topLeft.x, y: p.crop.topLeft.y, w: round(p.crop.bottomRight.x - p.crop.topLeft.x), h: round(p.crop.bottomRight.y - p.crop.topLeft.y), ...(p.crop.isCircle ? { circle: true } : {}) }
      if (s.type === 'video') Object.assign(out, { autoplay: p.autoplay, playing: p.playing })
    }
    if (s.type === 'embed') out.url = p.url
    if (s.type === 'bookmark') {
      const a = this.records.get(p.assetId)
      out.url = p.url
      if (a?.props.title) out.title = a.props.title
    }
    if (s.type === 'group') out.children = this.children(s.id).map((c) => keyOf(c.id))
    if (s.type === 'arrow') {
      const end = (t) => {
        const b = this.bindingsOf(s).find((x) => x.props.terminal === t)
        if (!b) {
          const pt = Mat.apply(this.pageMatrix(s), p[t])
          return { x: round(pt.x), y: round(pt.y) }
        }
        const target = keyOf(b.toId)
        const named = Object.entries(ANCHORS).find(([, v]) => v.x === b.props.normalizedAnchor.x && v.y === b.props.normalizedAnchor.y)?.[0]
        if (!b.props.isPrecise && !b.props.isExact) return target
        return { shape: target, anchor: named ?? b.props.normalizedAnchor, ...(b.props.isExact ? { exact: true } : {}) }
      }
      out.from = end('start')
      out.to = end('end')
      if (p.kind !== 'arc') out.arrowKind = p.kind
      if (p.bend) out.bend = p.bend
      if (p.arrowheadStart !== 'none') out.arrowheadStart = p.arrowheadStart
      if (p.arrowheadEnd !== 'arrow') out.arrowheadEnd = p.arrowheadEnd
      if (p.labelPosition !== 0.5) out.labelPosition = p.labelPosition
    }
    return out
  }

  linePagePoints(s) {
    const m = this.pageMatrix(s)
    return Object.values(s.props.points).sort((a, b) => (a.index < b.index ? -1 : 1))
      .map((pt) => { const q = Mat.apply(m, { x: pt.x * s.props.scale, y: pt.y * s.props.scale }); return { x: round(q.x), y: round(q.y) } })
  }

  summary({ page, keys } = {}) {
    const pages = this.pages()
    const pg = page === 'all' ? null : this.page(page)
    const want = keys ? new Set(keys.map((k) => this.shape(k).id)) : null
    const list = []
    const walk = (parentId) => {
      for (const c of this.children(parentId)) {
        if (!want || want.has(c.id)) list.push(this.describe(c))
        walk(c.id)
      }
    }
    for (const p of pg ? [pg] : pages) {
      const before = list.length
      walk(p.id)
      if (!pg) for (let i = before; i < list.length; i++) list[i].page = keyOf(p.id)
    }
    const shapes = list.filter((d) => d.kind !== 'arrow')
    const arrows = list.filter((d) => d.kind === 'arrow').map(({ kind, ...rest }) => rest)
    const contentBounds = pg ? this.contentBounds(pg.id) : null
    return {
      title: this.doc?.name ?? '',
      pages: pages.map((p) => ({ key: keyOf(p.id), name: p.name, shapes: this.descendants(p.id).length })),
      ...(pg ? { page: keyOf(pg.id) } : {}),
      ...(contentBounds ? { contentBounds } : {}),
      shapes,
      arrows,
      ...(this.warnings.length ? { warnings: this.warnings } : {}),
    }
  }

  contentBounds(pageId) {
    const top = this.children(pageId)
    if (!top.length) return null
    const b = boundsOf(top.flatMap((s) => boxCorners(this.pageBounds(s))))
    return { x: round(b.minX), y: round(b.minY), w: round(b.maxX - b.minX), h: round(b.maxY - b.minY) }
  }
}
