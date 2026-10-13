import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { startServer, assertValidFile } from './helpers.js'

let S
before(async () => { S = await startServer() })
after(async () => { await S.close() })

const file = (name) => join(S.boardsDir, `${name}.tldr`)
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (+/-${tol})`)
const shapeOf = (summary, key) => summary.shapes.find((s) => s.key === key)

// A real w x h PNG, built by hand.
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = []
  for (let y = 0; y < h; y++) { const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (x * 255) / w; row[2 + x * 3] = (y * 255) / h; row[3 + x * 3] = 160 } rows.push(row) }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

test('lists all tools with schemas and instructions', async () => {
  const { tools } = await S.client.listTools()
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['add_page', 'add_shapes', 'arrange_shapes', 'connect', 'create_board', 'delete_page', 'delete_shapes',
    'duplicate_shapes', 'export_board', 'group_shapes', 'list_boards', 'preview_board', 'read_board', 'reorder_shapes',
    'ungroup_shapes', 'update_page', 'update_shapes'])
  for (const t of tools) assert.equal(t.inputSchema.type, 'object')
  assert.match(S.client.getInstructions(), /tldraw\.com/)
})

test('create, overwrite and list boards', async () => {
  const r = await S.call('create_board', { board: 'b1', title: 'First' })
  assert.equal(r.created, file('b1'))
  assertValidFile(file('b1'))
  await S.fails('create_board', { board: 'b1' }, /already exists/)
  await S.call('create_board', { board: 'b1', overwrite: true })
  const list = await S.call('list_boards', {})
  assert.ok(list.boards.some((b) => b.board === 'b1'))
  // a path instead of a name
  const r2 = await S.call('create_board', { board: 'sub/dir/pathboard' })
  assert.match(r2.created, /sub[\\/]dir[\\/]pathboard\.tldr$/)
  assertValidFile(r2.created)
})

test('every shape kind, with labels and styles', async () => {
  await S.call('create_board', { board: 'kinds' })
  const png = join(S.dir, 'pic.png')
  writeFileSync(png, makePng(64, 48))
  const r = await S.call('add_shapes', {
    board: 'kinds',
    shapes: [
      { key: 'frame', kind: 'frame', x: 0, y: 0, w: 900, h: 600, label: 'All kinds', color: 'violet' },
      { key: 'rect', kind: 'box', x: 20, y: 40, label: '**Bold** and *italic*', color: 'blue', fill: 'semi', dash: 'solid', font: 'sans', parent: 'frame', labelColor: 'red', align: 'start', verticalAlign: 'start', url: 'https://tldraw.dev' },
      ...['ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'cloud', 'heart']
        .map((g, i) => ({ key: `g_${g}`, kind: g, x: 1000 + (i % 5) * 140, y: Math.floor(i / 5) * 140, w: 120, h: 120, label: g, fill: 'solid', color: 'light-blue' })),
      { key: 'txt', kind: 'text', x: 20, y: 200, label: '# Title\n- one\n- two', size: 'l', align: 'middle' },
      { key: 'fixedtxt', kind: 'text', x: 20, y: 400, w: 150, label: 'Fixed width text that wraps' },
      { key: 'note', kind: 'note', x: 400, y: 200, label: 'Sticky', color: 'light-green', size: 's' },
      { key: 'line', kind: 'line', points: [{ x: 0, y: 700 }, { x: 100, y: 760 }, { x: 200, y: 700 }], spline: 'cubic', dash: 'dotted' },
      { key: 'pen', kind: 'draw', points: [{ x: 300, y: 700 }, { x: 330, y: 750, pressure: 0.9 }, { x: 360, y: 700 }], closed: true, fill: 'pattern', color: 'green' },
      { key: 'multi', kind: 'draw', segments: [{ type: 'straight', points: [{ x: 400, y: 700 }, { x: 500, y: 700 }] }, { points: [{ x: 500, y: 700 }, { x: 520, y: 740 }] }] },
      { key: 'hl', kind: 'highlight', points: [{ x: 600, y: 700 }, { x: 800, y: 700 }], color: 'light-green' },
      { key: 'pic', kind: 'image', src: png, x: 0, y: 900, altText: 'gradient', crop: { x: 0.25, y: 0, w: 0.5, h: 1 } },
      { key: 'round', kind: 'image', src: png, x: 200, y: 900, w: 100, crop: { circle: true } },
      { key: 'yt', kind: 'embed', x: 1000, y: 700, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { key: 'figma', kind: 'embed', x: 1000, y: 1200, url: 'https://www.figma.com/file/abc123/Design', w: 400, h: 300 },
      { key: 'bm', kind: 'bookmark', x: 1500, y: 700, url: 'https://tldraw.dev', title: 'tldraw', description: 'The infinite canvas SDK' },
      { key: 'faint', kind: 'ellipse', x: 600, y: 40, opacity: 0.4, locked: true, rotation: 45, parent: 'frame' },
    ],
  })
  assert.equal(r.added.length, 34)
  const f = assertValidFile(file('kinds'))
  const byId = Object.fromEntries(f.records.map((x) => [x.id, x]))

  // image: natural size from the file, cropped to the middle half
  const pic = byId['shape:pic']
  assert.equal(byId[pic.props.assetId].props.w, 64)
  assert.equal(byId[pic.props.assetId].props.h, 48)
  assert.match(byId[pic.props.assetId].props.src, /^data:image\/png;base64,/)
  near(pic.props.w, 32); near(pic.props.h, 48)
  assert.deepEqual(pic.props.crop, { topLeft: { x: 0.25, y: 0 }, bottomRight: { x: 0.75, y: 1 } })
  near(byId['shape:round'].props.h, 75) // aspect kept from w
  assert.equal(byId['shape:round'].props.crop.isCircle, true)
  // styles landed
  assert.equal(byId['shape:rect'].props.labelColor, 'red')
  assert.equal(byId['shape:rect'].props.url, 'https://tldraw.dev')
  assert.equal(byId['shape:rect'].parentId, 'shape:frame')
  assert.equal(byId['shape:fixedtxt'].props.autoSize, false)
  assert.equal(byId['shape:txt'].props.textAlign, 'middle')
  assert.equal(byId['shape:fixedtxt'].props.w, 150)
  assert.equal(byId['shape:yt'].props.w, 800)
  assert.equal(byId['shape:pen'].props.isClosed, true)
  assert.equal(byId['shape:multi'].props.segments.length, 2)
  assert.equal(byId['shape:faint'].isLocked, true)
  // read back: labels as markdown, rotation, opacity
  const sum = await S.call('read_board', { board: 'kinds' })
  assert.equal(shapeOf(sum, 'rect').label, '**Bold** and *italic*')
  assert.equal(shapeOf(sum, 'txt').label, '# Title\n- one\n- two')
  assert.equal(shapeOf(sum, 'faint').rotation, 45)
  assert.equal(shapeOf(sum, 'faint').opacity, 0.4)
  assert.equal(shapeOf(sum, 'faint').locked, true)
  assert.equal(shapeOf(sum, 'fixedtxt').fixedWidth, true)
  assert.deepEqual(shapeOf(sum, 'line').points, [{ x: 0, y: 700 }, { x: 100, y: 760 }, { x: 200, y: 700 }])
  assert.equal(shapeOf(sum, 'bm').title, 'tldraw')
  assert.match(shapeOf(sum, 'pic').src, /embedded image\/png "pic.png", 64x48/)
  // boxes report what was asked
  const fr = shapeOf(sum, 'faint')
  near(fr.x, 600); near(fr.y, 40)
})

test('rejects bad input with clear messages and saves nothing', async () => {
  await S.call('create_board', { board: 'bad' })
  const before = readFileSync(file('bad'), 'utf8')
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'box', x: 0, y: 0 }, { kind: 'box', x: 0, y: 0, color: 'purple' }] }, /shapes\[1\].*color "purple" is not valid.*nothing was saved/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'blob', x: 0, y: 0 }] }, /kind "blob" is not valid/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'box' }] }, /needs x and y/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'line', points: [{ x: 0, y: 0 }] }] }, /at least 2 points/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'embed', x: 0, y: 0, url: 'https://example.com' }] }, /cannot embed.*bookmark/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'image', x: 0, y: 0, src: join(S.dir, 'missing.png') }] }, /File not found/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'box', x: 0, y: 0, src: 'x.png' }] }, /src only applies/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'box', x: 0, y: 0, parent: 'nope' }] }, /No shape with key "nope"/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'box', x: 0, y: 0, w: -5 }] }, /w must be greater than 0/)
  await S.fails('add_shapes', { board: 'bad', shapes: [{ kind: 'image', x: 0, y: 0, src: 'pic.png', crop: { x: 0.8, w: 0.5 } }] }, /File not found|crop/)
  await S.call('add_shapes', { board: 'bad', shapes: [{ key: 'a', kind: 'box', x: 0, y: 0 }] })
  const mid = readFileSync(file('bad'), 'utf8')
  await S.fails('add_shapes', { board: 'bad', shapes: [{ key: 'a', kind: 'box', x: 0, y: 0 }] }, /already exists/)
  await S.fails('update_shapes', { board: 'bad', updates: [{ key: 'a', w: 300 }, { key: 'zzz', w: 1 }] }, /updates\[1\].*No shape/)
  assert.equal(readFileSync(file('bad'), 'utf8'), mid, 'failed calls must not change the file')
  assert.notEqual(before, mid)
  await S.fails('read_board', { board: 'nope' }, /Board not found/)
  writeFileSync(file('junk'), 'not json')
  await S.fails('read_board', { board: 'junk' }, /not valid JSON/)
})

test('arrows: attach, anchors, exact, free points, labels, rules', async () => {
  await S.call('create_board', { board: 'arrows' })
  await S.call('add_shapes', { board: 'arrows', shapes: [
    { key: 'a', kind: 'box', x: 0, y: 0 }, { key: 'b', kind: 'box', x: 400, y: 0 }, { key: 'c', kind: 'ellipse', x: 400, y: 300 },
  ] })
  const r = await S.call('connect', { board: 'arrows', arrows: [
    { key: 'ab', from: 'a', to: 'b', label: 'yes', color: 'green' },
    { key: 'ac', from: { shape: 'a', anchor: 'bottom' }, to: { shape: 'c', anchor: { x: 0, y: 0.5 }, exact: true }, kind: 'elbow', elbowMidPoint: 0.3, arrowheadStart: 'dot', arrowheadEnd: 'triangle' },
    { key: 'free', from: { x: 0, y: 500 }, to: { x: 200, y: 500 }, bend: 30, labelPosition: 0.2, label: 'free' },
    { key: 'loop', from: { shape: 'b', anchor: 'right' }, to: { shape: 'b', anchor: 'top' }, bend: 60 },
  ] })
  assert.deepEqual(r.added, ['ab', 'ac', 'free', 'loop'])
  const f = assertValidFile(file('arrows'))
  const bindings = f.records.filter((x) => x.typeName === 'binding')
  assert.equal(bindings.length, 6)
  const acEnd = bindings.find((b) => b.fromId === 'shape:ac' && b.props.terminal === 'end')
  assert.deepEqual(acEnd.props.normalizedAnchor, { x: 0, y: 0.5 })
  assert.equal(acEnd.props.isExact, true)
  assert.equal(acEnd.props.isPrecise, true)
  const sum = await S.call('read_board', { board: 'arrows' })
  const ab = sum.arrows.find((x) => x.key === 'ab')
  assert.equal(ab.from, 'a'); assert.equal(ab.to, 'b'); assert.equal(ab.label, 'yes')
  const ac = sum.arrows.find((x) => x.key === 'ac')
  assert.deepEqual(ac.from, { shape: 'a', anchor: 'bottom' })
  assert.deepEqual(ac.to, { shape: 'c', anchor: 'left', exact: true })
  assert.equal(ac.arrowKind, 'elbow')
  assert.deepEqual(sum.arrows.find((x) => x.key === 'free').from, { x: 0, y: 500 })
  await S.fails('connect', { board: 'arrows', arrows: [{ from: 'ab', to: 'a' }] }, /cannot attach to other arrows/)
  await S.fails('connect', { board: 'arrows', arrows: [{ from: 'a', to: 'a' }] }, /needs anchors/)
  await S.fails('connect', { board: 'arrows', arrows: [{ from: 'a', to: { shape: 'b', anchor: 'middle' } }] }, /anchor "middle" is not valid/)
  // re-attach an arrow and restyle it
  await S.call('update_shapes', { board: 'arrows', updates: [{ key: 'ab', to: 'c', label: 'moved', arrowKind: 'elbow', bend: 0, arrowheadEnd: 'diamond' }] })
  const sum2 = await S.call('read_board', { board: 'arrows' })
  const ab2 = sum2.arrows.find((x) => x.key === 'ab')
  assert.equal(ab2.to, 'c'); assert.equal(ab2.label, 'moved'); assert.equal(ab2.arrowKind, 'elbow'); assert.equal(ab2.arrowheadEnd, 'diamond')
  // deleting a shape leaves its arrows with loose ends
  await S.call('delete_shapes', { board: 'arrows', keys: ['c'] })
  const sum3 = await S.call('read_board', { board: 'arrows' })
  assert.equal(typeof sum3.arrows.find((x) => x.key === 'ab').to, 'object')
  assertValidFile(file('arrows'))
})

test('update: move, resize, rotate, relabel, restyle, change outline, media', async () => {
  await S.call('create_board', { board: 'upd' })
  const png = join(S.dir, 'upd.png'); writeFileSync(png, makePng(100, 50))
  const png2 = join(S.dir, 'upd2.png'); writeFileSync(png2, makePng(30, 60))
  await S.call('add_shapes', { board: 'upd', shapes: [
    { key: 'a', kind: 'box', x: 10, y: 20, label: 'A' },
    { key: 't', kind: 'text', x: 0, y: 300, label: 'hello' },
    { key: 'n', kind: 'note', x: 500, y: 0 },
    { key: 'img', kind: 'image', x: 0, y: 500, src: png },
    { key: 'l', kind: 'line', points: [{ x: 0, y: 800 }, { x: 100, y: 800 }] },
    { key: 'bm', kind: 'bookmark', x: 800, y: 0, url: 'https://tldraw.dev', title: 'T', description: 'D' },
  ] })
  await S.call('update_shapes', { board: 'upd', updates: [
    { key: 'a', x: 100, y: 200, w: 300, h: 150, rotation: 90, label: '## New', color: 'red', fill: 'solid', dash: 'dashed', size: 'xl', font: 'mono', kind: 'hexagon', opacity: 0.5, locked: true, flipX: true },
    { key: 't', w: 120, align: 'end' },
    { key: 'n', w: 300 },
    { key: 'img', src: png2, crop: { x: 0, y: 0.5, w: 1, h: 0.5 } },
    { key: 'l', points: [{ x: 0, y: 900 }, { x: 50, y: 950 }, { x: 100, y: 900 }], spline: 'cubic' },
    { key: 'bm', title: 'New title' },
  ] })
  const sum = await S.call('read_board', { board: 'upd' })
  const a = shapeOf(sum, 'a')
  assert.equal(a.kind, 'hexagon'); assert.equal(a.rotation, 90); assert.equal(a.label, '## New')
  near(a.x, 100); near(a.y, 200); near(a.w, 300)
  assert.equal(a.color, 'red'); assert.equal(a.fill, 'solid'); assert.equal(a.dash, 'dashed'); assert.equal(a.size, 'xl')
  assert.equal(a.font, 'mono'); assert.equal(a.opacity, 0.5); assert.equal(a.locked, true); assert.equal(a.flipX, true)
  assert.equal(shapeOf(sum, 't').fixedWidth, true); assert.equal(shapeOf(sum, 't').align, 'end')
  near(shapeOf(sum, 'n').w, 300); assert.equal(shapeOf(sum, 'n').scale, 1.5)
  assert.match(shapeOf(sum, 'img').src, /30x60/)
  assert.deepEqual(shapeOf(sum, 'img').crop, { x: 0, y: 0.5, w: 1, h: 0.5 })
  assert.equal(shapeOf(sum, 'l').points.length, 3)
  assert.equal(shapeOf(sum, 'bm').title, 'New title')
  // moving without other changes keeps size
  await S.call('update_shapes', { board: 'upd', updates: [{ key: 'a', x: 0, y: 0 }] })
  const a2 = shapeOf(await S.call('read_board', { board: 'upd' }), 'a')
  near(a2.x, 0); near(a2.y, 0); near(a2.w, a.w); assert.equal(a2.rotation, 90)
  await S.fails('update_shapes', { board: 'upd', updates: [{ key: 't', kind: 'ellipse' }] }, /Only outline shapes/)
  await S.fails('update_shapes', { board: 'upd', updates: [{ key: 'n', w: 100, h: 200 }] }, /Notes are square/)
  await S.fails('update_shapes', { board: 'upd', updates: [{ key: 'a', src: png }] }, /src only applies/)
  assertValidFile(file('upd'))
})

test('frames and rotation: positions are page coordinates, also in rotated frames', async () => {
  await S.call('create_board', { board: 'rot' })
  await S.call('add_shapes', { board: 'rot', shapes: [
    { key: 'f', kind: 'frame', x: 100, y: 100, w: 600, h: 400, rotation: 30 },
    { key: 'inner', kind: 'box', x: 250, y: 200, w: 120, h: 80, rotation: 10, parent: 'f' },
  ] })
  const sum = await S.call('read_board', { board: 'rot' })
  const inner = shapeOf(sum, 'inner')
  near(inner.x, 250, 0.1); near(inner.y, 200, 0.1); near(inner.rotation, 10, 0.01); near(inner.w, 120)
  assert.equal(inner.parent, 'f')
  // take it out of the frame: stays put on the page
  await S.call('update_shapes', { board: 'rot', updates: [{ key: 'inner', parent: '' }] })
  const out = shapeOf(await S.call('read_board', { board: 'rot' }), 'inner')
  near(out.x, 250, 0.1); near(out.y, 200, 0.1); near(out.rotation, 10, 0.01); assert.equal(out.parent, undefined)
  // and back in
  await S.call('update_shapes', { board: 'rot', updates: [{ key: 'inner', parent: 'f', x: 300 }] })
  const back = shapeOf(await S.call('read_board', { board: 'rot' }), 'inner')
  near(back.x, 300, 0.1); near(back.y, 200, 0.1); assert.equal(back.parent, 'f')
  await S.fails('update_shapes', { board: 'rot', updates: [{ key: 'f', parent: 'inner' }] }, /must be a frame or group/)
  assertValidFile(file('rot'))
})

test('delete, duplicate, group, ungroup', async () => {
  await S.call('create_board', { board: 'grp' })
  await S.call('add_shapes', { board: 'grp', shapes: [
    { key: 'f', kind: 'frame', x: 0, y: 0, w: 500, h: 300 },
    { key: 'in1', kind: 'box', x: 20, y: 40, parent: 'f' },
    { key: 'a', kind: 'box', x: 600, y: 0 }, { key: 'b', kind: 'box', x: 900, y: 0 }, { key: 'c', kind: 'box', x: 1200, y: 0 },
  ] })
  await S.call('connect', { board: 'grp', arrows: [{ key: 'ab', from: 'a', to: 'b' }] })
  const d = await S.call('duplicate_shapes', { board: 'grp', keys: ['a', 'b'], offset: { x: 0, y: 200 } })
  assert.deepEqual(d.copies, { a: 'a_copy', b: 'b_copy', ab: 'ab_copy' })
  const d2 = await S.call('duplicate_shapes', { board: 'grp', keys: ['a'] })
  assert.equal(d2.copies.a, 'a_copy2')
  const df = await S.call('duplicate_shapes', { board: 'grp', keys: ['f'], offset: { x: 0, y: 400 } })
  assert.equal(df.copies.in1, 'in1_copy')
  let sum = await S.call('read_board', { board: 'grp' })
  assert.equal(shapeOf(sum, 'in1_copy').parent, 'f_copy')
  near(shapeOf(sum, 'a_copy').y, 200)
  const abCopy = sum.arrows.find((x) => x.key === 'ab_copy')
  assert.equal(abCopy.from, 'a_copy'); assert.equal(abCopy.to, 'b_copy')

  const g = await S.call('group_shapes', { board: 'grp', keys: ['a', 'b', 'c'], key: 'g' })
  assert.equal(g.group, 'g')
  sum = await S.call('read_board', { board: 'grp' })
  assert.deepEqual(shapeOf(sum, 'g').children, ['a', 'b', 'c'])
  near(shapeOf(sum, 'a').x, 600)
  await S.fails('group_shapes', { board: 'grp', keys: ['in1', 'a_copy'] }, /same parent/)
  await S.fails('connect', { board: 'grp', arrows: [{ from: 'g', to: 'f' }] }, /cannot attach to a group/)
  // deleting down to one member dissolves the group, like tldraw
  await S.call('delete_shapes', { board: 'grp', keys: ['b', 'c'] })
  sum = await S.call('read_board', { board: 'grp' })
  assert.equal(shapeOf(sum, 'g'), undefined)
  near(shapeOf(sum, 'a').x, 600)
  await S.call('group_shapes', { board: 'grp', keys: ['a', 'a_copy'], key: 'g2' })
  const u = await S.call('ungroup_shapes', { board: 'grp', keys: ['g2'] })
  assert.deepEqual(u.ungrouped.g2.sort(), ['a', 'a_copy'])
  // deleting a frame deletes what is inside it
  const del = await S.call('delete_shapes', { board: 'grp', keys: ['f'] })
  assert.deepEqual(del.deleted.sort(), ['f', 'in1'])
  assertValidFile(file('grp'))
})

test('stacking order', async () => {
  await S.call('create_board', { board: 'order' })
  await S.call('add_shapes', { board: 'order', shapes: ['a', 'b', 'c', 'd'].map((k, i) => ({ key: k, kind: 'box', x: i * 30, y: 0 })) })
  const order = async () => (await S.call('read_board', { board: 'order' })).shapes.map((s) => s.key).join('')
  assert.equal(await order(), 'abcd')
  await S.call('reorder_shapes', { board: 'order', keys: ['a'], action: 'front' }); assert.equal(await order(), 'bcda')
  await S.call('reorder_shapes', { board: 'order', keys: ['d'], action: 'back' }); assert.equal(await order(), 'dbca')
  await S.call('reorder_shapes', { board: 'order', keys: ['d'], action: 'forward' }); assert.equal(await order(), 'bdca')
  await S.call('reorder_shapes', { board: 'order', keys: ['a', 'c'], action: 'backward' }); assert.equal(await order(), 'bcad')
  assertValidFile(file('order'))
})

test('arrange: align, distribute, stack, stretch, flip, grid, pack', async () => {
  await S.call('create_board', { board: 'arr' })
  await S.call('add_shapes', { board: 'arr', shapes: [
    { key: 'a', kind: 'box', x: 0, y: 0, w: 100, h: 50 }, { key: 'b', kind: 'box', x: 300, y: 80, w: 150, h: 60 }, { key: 'c', kind: 'box', x: 900, y: 30, w: 80, h: 40 },
  ] })
  const get = async () => Object.fromEntries((await S.call('read_board', { board: 'arr' })).shapes.map((s) => [s.key, s]))
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'align-top' })
  let s = await get(); assert.ok(['a', 'b', 'c'].every((k) => Math.abs(s[k].y) < 0.5))
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'distribute-horizontal' })
  s = await get()
  near(s.b.x - (s.a.x + s.a.w), s.c.x - (s.b.x + s.b.w), 0.5)
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'stack-vertical', gap: 20 })
  s = await get(); near(s.b.y, s.a.y + s.a.h + 20, 0.5); near(s.c.y, s.b.y + s.b.h + 20, 0.5)
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'align-center-horizontal' })
  s = await get(); near(s.a.x + s.a.w / 2, s.b.x + s.b.w / 2, 0.5)
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'stretch-horizontal' })
  s = await get(); near(s.a.w, s.b.w, 0.5); near(s.a.x, s.c.x, 0.5)
  await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action: 'grid', columns: 2, gap: 10 })
  s = await get(); near(s.a.y, s.b.y, 30); assert.ok(s.c.y > s.a.y + 40)
  for (const action of ['align-left', 'align-right', 'align-bottom', 'align-center-vertical', 'distribute-vertical', 'stack-horizontal', 'stretch-vertical', 'flip-horizontal', 'flip-vertical', 'pack']) {
    await S.call('arrange_shapes', { board: 'arr', keys: ['a', 'b', 'c'], action })
  }
  await S.fails('arrange_shapes', { board: 'arr', keys: ['a', 'b'], action: 'distribute-horizontal' }, /at least 3/)
  await S.fails('arrange_shapes', { board: 'arr', keys: ['a', 'b'], action: 'spin' }, /action "spin" is not valid/)
  assertValidFile(file('arr'))
})

test('pages', async () => {
  await S.call('create_board', { board: 'pages' })
  assert.equal((await S.call('add_page', { board: 'pages', key: 'arch', name: 'Architecture' })).page, 'arch')
  await S.call('add_page', { board: 'pages', key: 'first', name: 'Intro', position: 1 })
  let sum = await S.call('read_board', { board: 'pages' })
  assert.deepEqual(sum.pages.map((p) => p.key), ['first', 'page', 'arch'])
  await S.call('add_shapes', { board: 'pages', shapes: [{ key: 'x', kind: 'box', x: 0, y: 0, page: 'Architecture' }, { key: 'y', kind: 'box', x: 300, y: 0, page: 'arch' }] })
  await S.call('connect', { board: 'pages', arrows: [{ key: 'xy', from: 'x', to: 'y' }] })
  sum = await S.call('read_board', { board: 'pages', page: 'arch' })
  assert.equal(sum.shapes.length, 2); assert.equal(sum.arrows.length, 1)
  await S.call('add_shapes', { board: 'pages', shapes: [{ key: 'z', kind: 'box', x: 0, y: 0 }] })
  await S.fails('connect', { board: 'pages', arrows: [{ from: 'z', to: 'x' }] }, /different page/)
  // moving a shape to another page detaches arrows that would cross pages
  await S.call('update_shapes', { board: 'pages', updates: [{ key: 'y', page: 'first' }] })
  sum = await S.call('read_board', { board: 'pages', page: 'all' })
  assert.equal(sum.shapes.find((s) => s.key === 'y').page, 'first')
  assert.equal(typeof sum.arrows.find((a) => a.key === 'xy').to, 'object')
  await S.call('update_page', { board: 'pages', page: 'arch', name: 'System', position: 1 })
  sum = await S.call('read_board', { board: 'pages' })
  assert.equal(sum.pages[0].name, 'System')
  await S.fails('add_page', { board: 'pages', name: 'system' }, /already exists/)
  const del = await S.call('delete_page', { board: 'pages', page: 'System' })
  assert.equal(del.deletedShapes, 2)
  await S.call('delete_page', { board: 'pages', page: 'first' })
  await S.fails('delete_page', { board: 'pages', page: 'page' }, /at least one page/)
  assertValidFile(file('pages'))
})

test('reads boards saved by tldraw.com (session records, other ids)', async () => {
  // Shape of a real tldraw.com download: extra session records, random ids, an older schema.
  const tlFile = {
    tldrawFileFormatVersion: 1,
    schema: { schemaVersion: 2, sequences: { 'com.tldraw.store': 4, 'com.tldraw.asset': 1, 'com.tldraw.camera': 1, 'com.tldraw.document': 2, 'com.tldraw.instance': 25, 'com.tldraw.instance_page_state': 5, 'com.tldraw.page': 1, 'com.tldraw.instance_presence': 5, 'com.tldraw.pointer': 1, 'com.tldraw.shape': 4, 'com.tldraw.asset.image': 4, 'com.tldraw.asset.video': 4, 'com.tldraw.asset.bookmark': 2, 'com.tldraw.shape.geo': 9, 'com.tldraw.shape.text': 2, 'com.tldraw.shape.arrow': 5, 'com.tldraw.binding.arrow': 0, 'com.tldraw.shape.note': 7, 'com.tldraw.shape.frame': 0, 'com.tldraw.shape.group': 0, 'com.tldraw.shape.line': 5, 'com.tldraw.shape.draw': 2, 'com.tldraw.shape.highlight': 1, 'com.tldraw.shape.image': 4, 'com.tldraw.shape.video': 2, 'com.tldraw.shape.embed': 4, 'com.tldraw.shape.bookmark': 2 } },
    records: [
      { gridSize: 10, name: '', meta: {}, id: 'document:document', typeName: 'document' },
      { meta: {}, id: 'page:page', name: 'Page 1', index: 'a1', typeName: 'page' },
      { x: 0, y: 0, z: 1, meta: {}, id: 'camera:page:page', typeName: 'camera' },
      { id: 'pointer:pointer', typeName: 'pointer', x: 0, y: 0, lastActivityTimestamp: 0, meta: {} },
      { x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {}, id: 'shape:Xy7_kQ2abcDEF', type: 'geo', parentId: 'page:page', index: 'a1', typeName: 'shape',
        props: { w: 200, h: 100, geo: 'rectangle', color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', text: 'Old label', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1 } },
      { x: 10, y: 200, rotation: 0, isLocked: false, opacity: 1, meta: {}, id: 'shape:t1', type: 'text', parentId: 'page:page', index: 'a2', typeName: 'shape',
        props: { color: 'black', size: 'm', w: 8, text: 'Hi', font: 'draw', textAlign: 'start', autoSize: true, scale: 1 } },
    ],
  }
  writeFileSync(file('fromdotcom'), JSON.stringify(tlFile))
  const sum = await S.call('read_board', { board: 'fromdotcom' })
  assert.equal(shapeOf(sum, 'Xy7_kQ2abcDEF').label, 'Old label')
  assert.equal(shapeOf(sum, 't1').label, 'Hi')
  await S.call('update_shapes', { board: 'fromdotcom', updates: [{ key: 'Xy7_kQ2abcDEF', label: 'Edited by Claude' }] })
  await S.call('connect', { board: 'fromdotcom', arrows: [{ from: 'Xy7_kQ2abcDEF', to: 't1' }] })
  assertValidFile(file('fromdotcom'))
  // a file from a newer tldraw
  const newer = { ...tlFile, schema: { ...tlFile.schema, sequences: { ...tlFile.schema.sequences, 'com.tldraw.shape.geo': 999 } } }
  writeFileSync(file('newer'), JSON.stringify(newer))
  await S.fails('read_board', { board: 'newer' }, /newer version of tldraw.*update-tldraw/)
})

test('remote media and previews degrade gracefully offline', async () => {
  await S.call('create_board', { board: 'net' })
  const r = await S.call('add_shapes', { board: 'net', shapes: [
    { key: 'v', kind: 'video', x: 0, y: 0, src: 'https://invalid.invalid/clip.mp4' },
    { key: 'im', kind: 'image', x: 0, y: 500, src: 'https://invalid.invalid/pic.png', w: 300, h: 200 },
    { key: 'bm', kind: 'bookmark', x: 800, y: 0, url: 'https://invalid.invalid/page' },
  ] })
  assert.equal(r.added.length, 3)
  assert.ok(r.notes.length >= 2)
  const f = assertValidFile(file('net'))
  const v = f.records.find((x) => x.id === 'shape:v')
  near(v.props.w, 640); near(v.props.h, 360)
  assert.equal(f.records.find((x) => x.id === v.props.assetId).props.src, 'https://invalid.invalid/clip.mp4')
})
