// Rendering tests: open boards in real tldraw (headless Chrome/Edge).
// Skipped unless a browser is configured: CHROME_PATH=/path/to/chrome npm test
// (or TLDRAW_TEST_BROWSER=1 to use an installed Chrome/Edge).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { startServer, assertValidFile, hasBrowser } from './helpers.js'

const skip = !hasBrowser() && 'set CHROME_PATH (or TLDRAW_TEST_BROWSER=1) to run rendering tests'
let S
before(async () => { if (!skip) S = await startServer() })
after(async () => { if (S) await S.close() })

const ARTIFACTS = process.env.TEST_ARTIFACTS_DIR
const keep = (name, b64) => { if (ARTIFACTS) { mkdirSync(ARTIFACTS, { recursive: true }); writeFileSync(join(ARTIFACTS, name), Buffer.from(b64, 'base64')) } }
const image = (r) => r._content.find((c) => c.type === 'image')

function pngOf(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = []
  for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (x * 255) / w; row[2 + x * 3] = 120; row[3 + x * 3] = (y * 255) / h } rows.push(row) }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

test('tldraw opens and renders every shape kind', { skip }, async () => {
  await S.call('create_board', { board: 'everything', title: 'Everything' })
  const png = join(S.dir, 'grad.png'); writeFileSync(png, pngOf(240, 160))
  await S.call('add_shapes', { board: 'everything', shapes: [
    { key: 'title', kind: 'text', x: 0, y: -120, label: '# Every tldraw shape\nRendered by **tldraw** itself', font: 'sans' },
    { key: 'frame', kind: 'frame', x: 0, y: 0, w: 1180, h: 520, label: 'Outline shapes', color: 'blue' },
    ...['rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'cloud', 'heart']
      .map((g, i) => ({ key: g.replace('-', '_'), kind: g, x: 30 + (i % 7) * 165, y: 40 + Math.floor(i / 7) * 160, w: 140, h: 120, label: g, parent: 'frame', fill: ['semi', 'solid', 'pattern', 'none', 'fill', 'lined-fill'][i % 6], color: ['blue', 'green', 'orange', 'violet', 'red', 'light-blue', 'yellow'][i % 7], font: 'sans', size: 's' })),
    { key: 'note', kind: 'note', x: 1240, y: 0, label: '**Sticky** note\n- with a list', color: 'light-green' },
    { key: 'rich', kind: 'box', x: 1240, y: 260, w: 260, h: 160, label: '**bold** *italic* ++under++ ~~strike~~ ==mark== `code` [link](https://tldraw.dev)', font: 'sans', dash: 'solid' },
    { key: 'line', kind: 'line', points: [{ x: 0, y: 620 }, { x: 150, y: 700 }, { x: 300, y: 600 }, { x: 450, y: 700 }], spline: 'cubic', color: 'red', size: 'l' },
    { key: 'pen', kind: 'draw', points: Array.from({ length: 50 }, (_, i) => ({ x: 560 + Math.cos(i / 7.8) * 70, y: 660 + Math.sin(i / 7.8) * 50 })), closed: true, fill: 'semi', color: 'violet' },
    { key: 'hl', kind: 'highlight', points: [{ x: 0, y: -40 }, { x: 330, y: -40 }] },
    { key: 'pic', kind: 'image', src: png, x: 760, y: 590, crop: { circle: true }, w: 160 },
    { key: 'yt', kind: 'embed', x: 1000, y: 590, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', w: 320, h: 180 },
    { key: 'bm', kind: 'bookmark', x: 1360, y: 590, url: 'https://tldraw.dev', title: 'tldraw', description: 'The infinite canvas SDK' },
  ] })
  await S.call('connect', { board: 'everything', arrows: [
    { from: 'rectangle', to: 'ellipse', label: 'arc', color: 'green' },
    { from: { shape: 'hexagon', anchor: 'bottom' }, to: { shape: 'cloud', anchor: 'top' }, kind: 'elbow', label: 'elbow' },
    { from: 'note', to: 'rich', bend: 40, arrowheadStart: 'dot', arrowheadEnd: 'triangle', dash: 'dashed' },
  ] })
  await S.call('group_shapes', { board: 'everything', keys: ['line', 'pen'], key: 'strokes' })
  const r = await S.call('preview_board', { board: 'everything' })
  const img = image(r)
  assert.ok(img && img.mimeType === 'image/png')
  assert.ok(Buffer.from(img.data, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
  keep('everything.png', img.data)
  assertValidFile(join(S.boardsDir, 'everything.tldr'))
})

test('preview applies tldraw\'s exact label sizes and reports problems', { skip }, async () => {
  await S.call('create_board', { board: 'fit' })
  await S.call('add_shapes', { board: 'fit', shapes: [
    { key: 'tight', kind: 'box', x: 0, y: 0, w: 120, h: 40, label: 'A label far too long for such a small box, so it must grow' },
    { key: 'f', kind: 'frame', x: 400, y: 0, w: 200, h: 150 },
    { key: 'spill', kind: 'box', x: 450, y: 50, w: 300, h: 80, parent: 'f' },
    { key: 'o1', kind: 'box', x: 0, y: 300 }, { key: 'o2', kind: 'box', x: 100, y: 330 },
  ] })
  const before = JSON.parse(readFileSync(join(S.boardsDir, 'fit.tldr'), 'utf8')).records.find((x) => x.id === 'shape:tight').props.growY
  const r = await S.call('preview_board', { board: 'fit' })
  keep('fit.png', image(r).data)
  const after = JSON.parse(readFileSync(join(S.boardsDir, 'fit.tldr'), 'utf8')).records.find((x) => x.id === 'shape:tight').props.growY
  assert.ok(after > 0, 'label growth measured')
  assert.ok(Math.abs(after - before) / after < 0.35, `estimate ${before} should be near tldraw's ${after}`)
  assert.ok(r.warnings.some((w) => /"spill" sticks out of frame "f"/.test(w)), JSON.stringify(r.warnings))
  assert.ok(r.warnings.some((w) => /"o1" and "o2" overlap/.test(w)), JSON.stringify(r.warnings))
  assertValidFile(join(S.boardsDir, 'fit.tldr'))
})

test('export to PNG, SVG, JPEG and WebP; pages, subsets, dark mode', { skip }, async () => {
  await S.call('create_board', { board: 'exp' })
  await S.call('add_shapes', { board: 'exp', shapes: [{ key: 'a', kind: 'box', x: 0, y: 0, label: 'Export me', color: 'blue', fill: 'semi' }, { key: 'b', kind: 'ellipse', x: 300, y: 0, label: 'and me' }] })
  await S.call('connect', { board: 'exp', arrows: [{ from: 'a', to: 'b' }] })
  const png = await S.call('export_board', { board: 'exp' })
  assert.ok(readFileSync(png.exported).subarray(1, 4).toString() === 'PNG')
  const svg = await S.call('export_board', { board: 'exp', format: 'svg' })
  assert.match(readFileSync(svg.exported, 'utf8'), /^<svg/)
  const jpg = await S.call('export_board', { board: 'exp', format: 'jpeg', file: join(S.dir, 'out', 'custom.jpg') })
  assert.ok(readFileSync(jpg.exported).subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))
  const webp = await S.call('export_board', { board: 'exp', format: 'webp', darkMode: true, scale: 0.5, keys: ['a'] })
  assert.equal(readFileSync(webp.exported).subarray(8, 12).toString(), 'WEBP')
  const tp = await S.call('export_board', { board: 'exp', background: false, padding: 0, file: join(S.dir, 'transparent.png') })
  assert.ok(existsSync(tp.exported))
  await S.call('add_page', { board: 'exp', key: 'two' })
  await S.call('add_shapes', { board: 'exp', shapes: [{ kind: 'star', x: 0, y: 0, page: 'two' }] })
  const p2 = await S.call('export_board', { board: 'exp', page: 'two' })
  assert.match(p2.exported, /exp-two\.png$/)
  await S.call('add_page', { board: 'exp', key: 'empty' })
  const empty = await S.call('preview_board', { board: 'exp', page: 'empty' })
  assert.match(empty.empty, /no shapes/)
  await S.fails('export_board', { board: 'exp', page: 'empty' }, /Nothing to export/)
  if (ARTIFACTS) writeFileSync(join(ARTIFACTS, 'exp.svg'), readFileSync(svg.exported))
})
