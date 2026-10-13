// 2D affine math and text-size estimation.
//
// tldraw positions a shape by its top-left origin (x, y) and rotates it around
// that origin. People think in boxes rotated around their center, so the board
// converts between the two using these helpers.

/** Matrix [a c e; b d f; 0 0 1]. */
export const Mat = {
  identity: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  // translate(x, y) * rotate(r)
  compose(x, y, r) {
    const cos = Math.cos(r), sin = Math.sin(r)
    return { a: cos, b: sin, c: -sin, d: cos, e: x, f: y }
  },
  multiply(m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f,
    }
  },
  invert(m) {
    const det = m.a * m.d - m.b * m.c
    return {
      a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det,
    }
  },
  apply(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }
  },
  // Apply only the rotation/scale part (for vectors / deltas).
  applyVec(m, v) {
    return { x: m.a * v.x + m.c * v.y, y: m.b * v.x + m.d * v.y }
  },
  rotation(m) {
    return Math.atan2(m.b, m.a)
  },
}

export const rotate = (p, r) => {
  const cos = Math.cos(r), sin = Math.sin(r)
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

export const toRad = (deg) => (deg * Math.PI) / 180
export const toDeg = (rad) => {
  let d = (rad * 180) / Math.PI
  d = ((d % 360) + 360) % 360
  return Math.round(d * 100) / 100
}

export const round = (n) => Math.round(n * 100) / 100

/** Axis-aligned bounds of a set of points. */
export function boundsOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

export const boxCorners = (b) => [
  { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
]

// ---------- text estimation ----------
// tldraw measures text with the browser. Without one, estimate from average
// glyph widths of tldraw's fonts (calibrated in Chromium against tldraw's own
// measurement). preview_board/export_board replace these estimates with tldraw's
// exact measurements.

export const THEME_FONT_SIZE = 16
export const LINE_HEIGHT = 1.35
export const LABEL_PADDING = 16
export const FONT_SIZES = { s: 1.125, m: 1.5, l: 2.25, xl: 2.75 } // text shapes
export const LABEL_FONT_SIZES = { s: 1.125, m: 1.375, l: 1.625, xl: 2 } // geo + note labels
export const ARROW_LABEL_FONT_SIZES = { s: 1.125, m: 1.25, l: 1.5, xl: 1.75 }

// Average advance width per character, as a fraction of font size
// (measured in Chromium with tldraw's fonts on mixed English text).
export const CHAR_WIDTH = { draw: 0.523, sans: 0.457, serif: 0.482, mono: 0.601 }
// Heading level -> [font size factor, line height factor] relative to body text.
export const HEADING = { 1: [2, 2.49], 2: [1.5, 1.99], 3: [1.25, 1.65] }
export const LIST_INDENT = 25.5

export function textWidth(text, fontSize, font) {
  return text.length * fontSize * (CHAR_WIDTH[font] ?? 0.58)
}

/** Count wrapped lines for one paragraph at maxWidth. */
export function wrapCount(text, maxWidth, fontSize, font) {
  if (!text) return 1
  if (!maxWidth || maxWidth <= 0) return 1
  const words = text.split(/(\s+)/)
  let lines = 1, line = 0
  for (const w of words) {
    const ww = textWidth(w, fontSize, font)
    if (line + ww <= maxWidth || line === 0) {
      if (ww > maxWidth && line === 0) {
        // Long word breaks across lines.
        lines += Math.floor(ww / maxWidth)
        line = ww % maxWidth
      } else line += ww
    } else if (/^\s+$/.test(w)) {
      // trailing space at a wrap point
    } else {
      lines++
      line = ww
    }
  }
  return lines
}

/**
 * Estimate {w, h} of rich text given as lines from richTextLines():
 * [{ text, heading (0-3), indent (list depth) }].
 * maxWidth: wrap width, or null for no wrapping.
 */
export function estimateRich(lines, fontSize, font, maxWidth) {
  let h = 0, widest = 0
  for (const l of lines) {
    const [fsK, lhK] = l.heading ? HEADING[l.heading] : [1, 1]
    const fs = fontSize * fsK
    const indent = l.indent * LIST_INDENT
    const lineH = Math.round(fontSize * LINE_HEIGHT) * lhK
    const w = textWidth(l.text, fs, font)
    if (maxWidth) {
      const avail = Math.max(fs, maxWidth - indent)
      h += wrapCount(l.text, avail, fs, font) * lineH
      widest = Math.max(widest, Math.min(w, avail) + indent)
    } else {
      h += lineH
      widest = Math.max(widest, w + indent)
    }
  }
  return { w: widest, h: Math.max(h, Math.round(fontSize * LINE_HEIGHT)) }
}
