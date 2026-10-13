// A headless tldraw editor the MCP server drives to preview and export boards.
// It opens files with the same function tldraw.com uses (parseTldrawJsonFile),
// measures labels with tldraw's own text layout, and renders with editor.toImage.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Tldraw, parseTldrawJsonFile, createTLSchema } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import 'tldraw/tldraw.css'

const assetUrls = getAssetUrls({ baseUrl: './assets' })
let editor = null
let ready
const readyPromise = new Promise((r) => (ready = r))

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

const LEAF_SKIP = new Set(['frame', 'group', 'arrow', 'line', 'draw', 'highlight'])

function measure(ed) {
  const out = []
  for (const id of ed.getCurrentPageShapeIdsSorted()) {
    const shape = ed.getShape(id)
    const util = ed.getShapeUtil(shape)
    if (shape.type === 'geo') {
      const next = util.onBeforeCreate?.(shape)
      out.push({ id, growY: next ? next.props.growY : shape.props.growY })
    } else if (shape.type === 'note') {
      const next = util.getNoteSizeAdjustments?.(shape)
      out.push({ id, growY: next ? next.props.growY : shape.props.growY, fontSizeAdjustment: next ? next.props.fontSizeAdjustment : shape.props.fontSizeAdjustment })
    } else if (shape.type === 'text') {
      const b = ed.getShapeGeometry(shape).bounds
      out.push({ id, w: b.w, h: b.h })
    }
  }
  return out
}

function diagnostics(ed) {
  const warnings = []
  const shapes = [...ed.getCurrentPageShapeIds()].map((id) => ed.getShape(id))
  const name = (s) => s.id.replace(/^shape:/, '')
  // Shapes poking out of the frame they belong to get clipped.
  for (const s of shapes) {
    const parent = ed.getShape(s.parentId)
    if (!parent || parent.type !== 'frame' || s.type === 'arrow') continue
    const sb = ed.getShapePageBounds(s), fb = ed.getShapePageBounds(parent)
    if (sb && fb && !fb.contains(sb)) warnings.push(`"${name(s)}" sticks out of frame "${name(parent)}" and is clipped there.`)
  }
  // Overlapping content shapes (siblings only, ignoring containers and strokes).
  const leaves = shapes.filter((s) => !LEAF_SKIP.has(s.type))
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j]
      if (a.parentId !== b.parentId) continue
      const ab = ed.getShapePageBounds(a), bb = ed.getShapePageBounds(b)
      if (!ab || !bb) continue
      const ix = Math.min(ab.maxX, bb.maxX) - Math.max(ab.minX, bb.minX)
      const iy = Math.min(ab.maxY, bb.maxY) - Math.max(ab.minY, bb.minY)
      if (ix > 4 && iy > 4) {
        const smaller = Math.min(ab.w * ab.h, bb.w * bb.h)
        if ((ix * iy) / smaller > 0.05) warnings.push(`"${name(a)}" and "${name(b)}" overlap.`)
      }
    }
  }
  return warnings.slice(0, 40)
}

window.tlRender = async function tlRender(json, opts = {}) {
  await readyPromise
  const ed = editor
  const parsed = parseTldrawJsonFile({ json, schema: createTLSchema() })
  if (!parsed.ok) return { ok: false, error: `tldraw could not open the file: ${JSON.stringify(parsed.error).slice(0, 400)}` }
  ed.loadSnapshot(parsed.value.getStoreSnapshot())

  const pages = ed.getPages()
  const page = opts.pageId ? pages.find((p) => p.id === opts.pageId) : pages[0]
  if (!page) return { ok: false, error: `No page ${opts.pageId}` }
  ed.setCurrentPage(page.id)
  await ed.fonts?.loadRequiredFontsForCurrentPage?.()
  await document.fonts.ready

  const measurements = measure(ed)
  // Show the board the way tldraw would after measuring its labels.
  const fixes = measurements
    .map((m) => {
      const s = ed.getShape(m.id)
      if (s.type === 'geo' && m.growY !== s.props.growY) return { id: s.id, type: s.type, props: { growY: m.growY } }
      if (s.type === 'note' && (m.growY !== s.props.growY || m.fontSizeAdjustment !== s.props.fontSizeAdjustment)) {
        return { id: s.id, type: s.type, props: { growY: m.growY, fontSizeAdjustment: m.fontSizeAdjustment } }
      }
      return null
    })
    .filter(Boolean)
  if (fixes.length) ed.updateShapes(fixes)

  const warnings = diagnostics(ed)
  let ids = opts.shapeIds?.length ? opts.shapeIds.filter((id) => ed.getShape(id)) : [...ed.getCurrentPageShapeIds()]
  if (opts.shapeIds?.length && ids.length !== opts.shapeIds.length) return { ok: false, error: 'Some of those shapes are not on this page' }
  if (!ids.length) return { ok: true, empty: true, measurements, warnings }

  const bounds = ed.getShapesPageBounds(ids)
  const format = opts.format ?? 'png'
  let scale = opts.scale ?? 1
  if (opts.maxSide && bounds) scale = Math.min(scale, opts.maxSide / Math.max(bounds.w + 64, bounds.h + 64))
  const exportOpts = {
    format,
    background: opts.background ?? true,
    padding: opts.padding ?? 32,
    darkMode: opts.darkMode ?? false,
    scale,
    ...(format === 'svg' ? {} : { pixelRatio: opts.pixelRatio ?? (opts.maxSide ? 1 : 2) }),
  }
  const { blob, width, height } = await ed.toImage(ids, exportOpts)
  const data = format === 'svg' ? await blob.text() : await blobToBase64(blob)
  return { ok: true, format, width, height, data, measurements, warnings, bounds: bounds && { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } }
}

function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        assetUrls={assetUrls}
        hideUi
        onMount={(e) => {
          editor = e
          window.tlReady = true
          ready()
        }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
