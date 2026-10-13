// Tool definitions (names, descriptions, JSON schemas) for the MCP server.
import { ENUMS, SHAPE_KINDS, EMBED_PROVIDERS } from './board.js'

const s = (type, description, extra = {}) => ({ type, ...(description ? { description } : {}), ...extra })
const e = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) })

const BOARD = s('string', 'Board name (saved as <name>.tldr in the boards folder) or a path to a .tldr file.')
const PAGE = s('string', 'Page key or name. Defaults to the first page.')
const KEYS = s('array', 'Shape keys.', { items: { type: 'string' }, minItems: 1 })

const STYLE = {
  color: e(ENUMS.color, 'Stroke/text color (sticky notes: background color).'),
  labelColor: e(ENUMS.color, 'Label text color, if different from color (outline shapes, notes, arrows).'),
  fill: e(ENUMS.fill, '"none", "semi" (light tint), "solid", "pattern" (hatched), "fill" (full color), "lined-fill".'),
  dash: e(ENUMS.dash, '"draw" = hand-drawn; "solid" for clean lines; "dashed", "dotted", "none".'),
  size: e(ENUMS.size, 'Stroke thickness and text size: s, m, l, xl.'),
  font: e(ENUMS.font, '"draw" = handwritten, "sans", "serif", "mono".'),
  opacity: s('number', '0 to 1.', { minimum: 0, maximum: 1 }),
  rotation: s('number', 'Degrees clockwise, around the shape\'s center.'),
  locked: s('boolean', 'Locked shapes cannot be selected or moved in tldraw.'),
  scale: s('number', 'Overall scale of strokes and text (tldraw\'s "dynamic size"). Default 1.'),
}

const LABEL = s('string',
  'Text. Markdown: **bold**, *italic*, ++underline++, ~~strike~~, ==highlight==, `code`, [link](https://...), ' +
  '"# " / "## " / "### " headings, "- " bullets, "1. " numbered lists (indent 2 spaces to nest), \\n for new lines. ' +
  'For frames this is the frame title.')

const POINT = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
const STROKE_POINT = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, pressure: { type: 'number', minimum: 0, maximum: 1 } }, required: ['x', 'y'] }
const SEGMENTS = s('array', 'Several strokes in one drawing: [{type: "free"|"straight", points: [...]}].', {
  items: { type: 'object', properties: { type: e(['free', 'straight']), points: { type: 'array', items: STROKE_POINT } }, required: ['points'] },
})
const CROP = s('object', 'Crop an image: x, y, w, h as fractions (0-1) of the image; circle: true for a round crop.', {
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, circle: { type: 'boolean' } },
})

const SHAPE_PROPS = {
  key: s('string', 'Your own id for the shape (letters, digits, _ - .), used to connect, update or delete it. Auto-generated if omitted.'),
  kind: e(SHAPE_KINDS,
    'Outline shapes (hold a label): rectangle (or "box"), ellipse, diamond, triangle, pentagon, hexagon, octagon, star, rhombus, rhombus-2, oval, trapezoid, ' +
    'cloud, heart, x-box, check-box, arrow-right/left/up/down. Others: text (free text), note (sticky note, 200x200), frame (titled container), ' +
    'line (points), draw (freehand, points), highlight (highlighter, points), image (src), video (src), embed (url), bookmark (url).'),
  x: s('number', 'Left edge, in page coordinates (y grows downward). Page coordinates even inside frames.'),
  y: s('number', 'Top edge, in page coordinates.'),
  w: s('number', 'Width. Defaults: outline 200, frame 600, embed/media from source. Text: sets a fixed wrap width (omit to auto-size).'),
  h: s('number', 'Height. Outline default 100. Ignored for text (follows content); notes are square (use w or scale).'),
  label: LABEL,
  page: PAGE,
  parent: s('string', 'Key of a frame or group to place the shape in. Make sure it fits inside a frame; frames clip their content.'),
  align: s('string', `Horizontal text alignment: ${ENUMS.align.join(', ')}.`),
  verticalAlign: e(ENUMS.verticalAlign, 'Vertical label alignment (outline shapes and notes).'),
  url: s('string', 'Outline shapes, notes, images, videos: a link opened from the shape. embed/bookmark: the page to show.'),
  points: s('array', 'line / draw / highlight: points in page coordinates (2+ for lines). Optional pressure 0-1 for draw.', { items: STROKE_POINT }),
  segments: SEGMENTS,
  spline: e(ENUMS.spline, 'line: "line" (straight segments) or "cubic" (smooth curve).'),
  closed: s('boolean', 'draw: close the stroke into a shape (fill applies).'),
  src: s('string', `image / video: a local file path (embedded in the board; tldraw.com uploads it on import) or an https URL. Max 10 MB per file.`),
  crop: CROP,
  flipX: s('boolean', 'Mirror horizontally (outline shapes, images).'),
  flipY: s('boolean', 'Mirror vertically (outline shapes, images).'),
  altText: s('string', 'image / video: accessibility description.'),
  autoplay: s('boolean', 'video: start playing automatically.'),
  playing: s('boolean', 'video: playing state.'),
  time: s('number', 'video: start time in seconds.'),
  title: s('string', 'bookmark: override the fetched title.'),
  description: s('string', 'bookmark: override the fetched description.'),
  image: s('string', 'bookmark: override the preview image URL.'),
  fetchPreview: s('boolean', 'bookmark: fetch title/description/image from the page (default true).'),
  ...STYLE,
}

const ENDPOINT = {
  description: 'A shape key (attaches to it), a free point {x, y}, or {shape, anchor, exact}: anchor is ' +
    `${ENUMS.anchor.join(', ')} or {x, y} fractions of the shape; exact: true makes the arrow reach the anchor instead of stopping at the edge.`,
  oneOf: [
    { type: 'string' },
    POINT,
    {
      type: 'object',
      properties: {
        shape: { type: 'string' },
        anchor: { oneOf: [e(ENUMS.anchor), POINT] },
        exact: { type: 'boolean' },
      },
      required: ['shape'],
    },
  ],
}

const ARROW_PROPS = {
  key: s('string', 'Optional id for the arrow.'),
  from: ENDPOINT,
  to: ENDPOINT,
  label: LABEL,
  page: s('string', 'Page, only needed when both ends are free points. Otherwise the arrow goes on the page of the shapes it attaches to.'),
  kind: e(ENUMS.arrowKind, '"arc" (straight or curved, default) or "elbow" (right-angle connector).'),
  bend: s('number', 'Arc arrows: curve amount in px (positive bends one way, negative the other). 0 = straight.'),
  arrowheadStart: e(ENUMS.arrowhead, 'Default "none".'),
  arrowheadEnd: e(ENUMS.arrowhead, 'Default "arrow".'),
  labelPosition: s('number', 'Where the label sits along the arrow, 0 (start) to 1 (end). Default 0.5.'),
  elbowMidPoint: s('number', 'Elbow arrows: where the bend sits, 0 to 1. Default 0.5.'),
  fill: e(ENUMS.fill, 'Arrowhead fill.'),
  ...Object.fromEntries(['color', 'labelColor', 'dash', 'size', 'font', 'opacity', 'locked', 'scale'].map((k) => [k, STYLE[k]])),
}

const UPDATE_PROPS = {
  ...Object.fromEntries(Object.entries(SHAPE_PROPS).filter(([k]) => !['fetchPreview'].includes(k))),
  key: s('string', 'Key of the shape or arrow to change.'),
  kind: e([...ENUMS.geo, 'box'], 'Outline shapes only: change the outline (e.g. rectangle -> diamond).'),
  parent: s('string', 'Key of a frame or group to move the shape into; "" to move it out onto the page.'),
  page: s('string', 'Move a top-level shape (with its contents) to another page.'),
  src: s('string', 'image / video: replace the media.'),
  crop: { ...CROP, description: CROP.description + ' null removes the crop.' },
  // arrows
  from: ENDPOINT,
  to: ENDPOINT,
  arrowKind: e(ENUMS.arrowKind, 'Arrows: "arc" or "elbow".'),
  bend: ARROW_PROPS.bend,
  arrowheadStart: ARROW_PROPS.arrowheadStart,
  arrowheadEnd: ARROW_PROPS.arrowheadEnd,
  labelPosition: ARROW_PROPS.labelPosition,
  elbowMidPoint: ARROW_PROPS.elbowMidPoint,
}

const RENDER_OPTS = {
  board: BOARD,
  page: PAGE,
  keys: s('array', 'Only these shapes (and what is inside them). Default: the whole page.', { items: { type: 'string' } }),
  darkMode: s('boolean', 'Render in dark mode.'),
}

export const INSTRUCTIONS = `tldraw boards for tldraw.com. Boards are .tldr files the user imports into tldraw.com (signed in: drag the file onto the left sidebar, or name menu > Import file).

Workflow: create_board -> add_shapes (frames before their contents) -> connect (arrows) -> preview_board to look at the result and fix problems -> tell the user the file path.
Every tool call is all-or-nothing: if one item fails, nothing is saved; fix that item and resend.

Coordinates: x grows right, y grows down. A shape's x, y is its top-left; rotation turns it around its center. Coordinates are always page coordinates, also inside frames.
Layout: outline boxes about 200x100 (wider for long labels), gaps of 60-120 px, flow left-to-right or top-to-bottom, align rows and columns (arrange_shapes helps). Keep shapes inside their frame.
Labels use Markdown (bold, italic, lists, headings, links). Arrows attach to shapes and follow them when moved; label arrows ("yes"/"no").
Style: font "sans" + dash "solid" for clean technical diagrams; the defaults ("draw") give tldraw's hand-drawn look. Use fill "semi" with color to group related shapes.
preview_board renders the board with tldraw itself and returns an image, warnings (overlaps, shapes clipped by frames), and also saves tldraw's exact label sizes into the file. Preview after building or changing a diagram.
read_board lists everything on a board, including boards downloaded from tldraw.com (Menu > File > Download file).`

export const TOOLS = [
  {
    name: 'create_board',
    description: 'Create a new empty board (.tldr file). Fails if it exists unless overwrite is true.',
    inputSchema: { type: 'object', properties: { board: BOARD, title: s('string', 'Board title.'), overwrite: s('boolean', 'Replace an existing board.') }, required: ['board'] },
  },
  {
    name: 'list_boards',
    description: 'List the boards in the boards folder, newest first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_board',
    description: 'Everything on a page: pages, shapes (key, kind, position, size, rotation, label as Markdown, styles that differ from defaults, parent frame/group) and arrows (from, to, label). Use before changing a board you did not just build.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, page: s('string', 'Page key or name, or "all". Default: first page.'), keys: s('array', 'Only these shapes.', { items: { type: 'string' } }) },
      required: ['board'],
    },
  },
  {
    name: 'add_shapes',
    description: 'Add shapes: outlines with labels, text, sticky notes, frames, lines, freehand drawing, highlighter, images, videos, embeds (' +
      EMBED_PROVIDERS.map((p) => p.type.replace('_', ' ')).join(', ') + ') and link bookmarks. Add a frame before the shapes that go inside it. Returns the keys.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, shapes: s('array', 'Shapes to add, in order.', { items: { type: 'object', properties: SHAPE_PROPS, required: ['kind'] }, minItems: 1 }) },
      required: ['board', 'shapes'],
    },
  },
  {
    name: 'connect',
    description: 'Add arrows between shapes or points. Attached arrows follow their shapes when moved in tldraw. Arrows cannot attach to other arrows or to groups.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, arrows: s('array', 'Arrows to add.', { items: { type: 'object', properties: ARROW_PROPS, required: ['from', 'to'] }, minItems: 1 }) },
      required: ['board', 'arrows'],
    },
  },
  {
    name: 'update_shapes',
    description: 'Change shapes or arrows by key: move, resize, rotate, relabel, restyle, change outline, crop or replace media, re-attach arrows, move into/out of frames or groups, or to another page. Only the fields given change.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, updates: s('array', 'Changes, applied in order.', { items: { type: 'object', properties: UPDATE_PROPS, required: ['key'] }, minItems: 1 }) },
      required: ['board', 'updates'],
    },
  },
  {
    name: 'delete_shapes',
    description: 'Delete shapes. Deleting a frame or group deletes its contents. Arrows attached to deleted shapes stay, with a loose end.',
    inputSchema: { type: 'object', properties: { board: BOARD, keys: KEYS }, required: ['board', 'keys'] },
  },
  {
    name: 'duplicate_shapes',
    description: 'Copy shapes (with their contents). Copies get keys like "<key>_copy". Returns old key -> new key.',
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        keys: KEYS,
        offset: s('object', 'Move copies by this much. Default {x: 40, y: 40}.', { properties: { x: { type: 'number' }, y: { type: 'number' } } }),
        page: s('string', 'Put the copies on this page instead.'),
        includeConnections: s('boolean', 'Also copy arrows that connect two copied shapes (default true).'),
      },
      required: ['board', 'keys'],
    },
  },
  {
    name: 'group_shapes',
    description: 'Group shapes so they move together. They must share the same parent (all on the page, or all in the same frame).',
    inputSchema: { type: 'object', properties: { board: BOARD, keys: { ...KEYS, minItems: 2 }, key: s('string', 'Key for the group.') }, required: ['board', 'keys'] },
  },
  {
    name: 'ungroup_shapes',
    description: 'Dissolve groups, keeping their contents where they are.',
    inputSchema: { type: 'object', properties: { board: BOARD, keys: KEYS }, required: ['board', 'keys'] },
  },
  {
    name: 'reorder_shapes',
    description: 'Change stacking order among shapes with the same parent.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, keys: KEYS, action: e(['front', 'back', 'forward', 'backward'], 'Bring to front, send to back, or move one step.') },
      required: ['board', 'keys', 'action'],
    },
  },
  {
    name: 'arrange_shapes',
    description: 'Align, distribute, stack, stretch, flip, pack or grid shapes (tldraw\'s arrange tools). Arrows follow automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        board: BOARD,
        keys: KEYS,
        action: e(['align-left', 'align-center-horizontal', 'align-right', 'align-top', 'align-center-vertical', 'align-bottom',
          'distribute-horizontal', 'distribute-vertical', 'stack-horizontal', 'stack-vertical', 'stretch-horizontal', 'stretch-vertical',
          'flip-horizontal', 'flip-vertical', 'pack', 'grid']),
        gap: s('number', 'stack / pack / grid: space between shapes. Default 16.'),
        columns: s('number', 'grid: number of columns (default: square-ish).'),
      },
      required: ['board', 'keys', 'action'],
    },
  },
  {
    name: 'add_page',
    description: 'Add a page to the board.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, key: s('string', 'Page key.'), name: s('string', 'Page name shown in tldraw.'), position: s('number', '1-based position among pages. Default: last.') },
      required: ['board'],
    },
  },
  {
    name: 'update_page',
    description: 'Rename or reorder a page.',
    inputSchema: {
      type: 'object',
      properties: { board: BOARD, page: s('string', 'Page key or name.'), name: s('string'), position: s('number', '1-based position.') },
      required: ['board', 'page'],
    },
  },
  {
    name: 'delete_page',
    description: 'Delete a page and everything on it. A board keeps at least one page.',
    inputSchema: { type: 'object', properties: { board: BOARD, page: s('string', 'Page key or name.') }, required: ['board', 'page'] },
  },
  {
    name: 'preview_board',
    description: 'Render a page with tldraw itself and look at it. Returns an image plus warnings (overlapping shapes, shapes clipped by frames). Also saves tldraw\'s exact label sizes into the board. Needs Chrome or Edge installed.',
    inputSchema: { type: 'object', properties: RENDER_OPTS, required: ['board'] },
  },
  {
    name: 'export_board',
    description: 'Export a page (or some shapes) as PNG, SVG, JPEG or WebP, rendered by tldraw. Saved next to the board unless file is given. Needs Chrome or Edge installed.',
    inputSchema: {
      type: 'object',
      properties: {
        ...RENDER_OPTS,
        format: e(['png', 'svg', 'jpeg', 'webp'], 'Default png.'),
        file: s('string', 'Output path. Default: <board>[-<page>].<format> next to the board.'),
        scale: s('number', 'Size multiplier. Default 1 (PNG/JPEG/WebP are rendered at 2x pixel density).'),
        background: s('boolean', 'Include the background (default true; PNG/WebP/SVG can be transparent).'),
        padding: s('number', 'Margin around the content in px. Default 32.'),
      },
      required: ['board'],
    },
  },
]
