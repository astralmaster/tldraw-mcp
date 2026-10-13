// Converts between a small Markdown dialect and tldraw's rich text (TipTap JSON).
//
// Supported, matching what tldraw's text editor can produce:
//   **bold**  *italic* or _italic_  ++underline++  ~~strike~~  ==highlight==  `code`
//   [link text](https://example.com)
//   # / ## / ### heading      - or * bullet list      1. numbered list
//   Indent list items by 2 spaces per level to nest them. Backslash escapes a marker: \*

const INLINE = [
  { open: '**', close: '**', mark: { type: 'bold' } },
  { open: '++', close: '++', mark: { type: 'underline' } },
  { open: '~~', close: '~~', mark: { type: 'strike' } },
  { open: '==', close: '==', mark: { type: 'highlight' } },
  { open: '*', close: '*', mark: { type: 'italic' } },
  { open: '_', close: '_', mark: { type: 'italic' } },
]

const linkMark = (href) => ({
  type: 'link',
  attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow', class: null },
})

function sameMarks(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

function pushText(out, text, marks) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && sameMarks(last.marks, marks)) {
    last.text += text
    return
  }
  const node = { type: 'text', text }
  if (marks.length) node.marks = marks.map((m) => ({ ...m }))
  out.push(node)
}

function findClose(s, from, close) {
  for (let i = from; i <= s.length - close.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s.startsWith(close, i)) return i
  }
  return -1
}

/** Parse inline markdown into TipTap text nodes. */
export function parseInline(s, marks = [], out = []) {
  let buf = ''
  const flush = () => { pushText(out, buf, marks); buf = '' }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue }

    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        pushText(out, s.slice(i + 1, end), [...marks, { type: 'code' }])
        i = end + 1
        continue
      }
    }

    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i))
      if (m) {
        flush()
        parseInline(m[1], [...marks, linkMark(m[2])], out)
        i += m[0].length
        continue
      }
    }

    let matched = false
    for (const d of INLINE) {
      if (!s.startsWith(d.open, i)) continue
      const start = i + d.open.length
      if (start >= s.length || /\s/.test(s[start])) continue
      // _ only counts at word boundaries so snake_case stays literal
      if (d.open === '_' && i > 0 && /\w/.test(s[i - 1])) continue
      const end = findClose(s, start, d.close)
      if (end <= start || /\s/.test(s[end - 1])) continue
      if (d.open === '_' && end + 1 < s.length && /\w/.test(s[end + 1])) continue
      flush()
      parseInline(s.slice(start, end), [...marks, d.mark], out)
      i = end + d.close.length
      matched = true
      break
    }
    if (matched) continue
    buf += ch
    i++
  }
  flush()
  return out
}

const para = (text) => {
  const content = parseInline(text)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/** Markdown string -> tldraw rich text document. */
export function markdownToRichText(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const doc = { type: 'doc', content: [] }
  // Stack of open lists: { indent, node }
  let stack = []

  for (const raw of lines) {
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (item) {
      const indent = item[1].replace(/\t/g, '  ').length
      const ordered = /\d/.test(item[2])
      const type = ordered ? 'orderedList' : 'bulletList'
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop()
      let top = stack[stack.length - 1]
      if (top && top.indent === indent && top.node.type !== type) { stack.pop(); top = stack[stack.length - 1] }
      if (!top || top.indent < indent) {
        const list = { type, content: [] }
        if (ordered) list.attrs = { start: parseInt(item[2], 10) || 1, type: null }
        if (top) {
          const parentItem = top.node.content[top.node.content.length - 1]
          parentItem.content.push(list)
        } else {
          doc.content.push(list)
        }
        stack.push({ indent, node: list })
        top = stack[stack.length - 1]
      }
      top.node.content.push({ type: 'listItem', content: [para(item[3])] })
      continue
    }
    stack = []
    const heading = /^(#{1,3})\s+(.*)$/.exec(raw)
    if (heading) {
      const content = parseInline(heading[2])
      const node = { type: 'heading', attrs: { level: heading[1].length } }
      if (content.length) node.content = content
      doc.content.push(node)
      continue
    }
    doc.content.push(para(raw))
  }
  if (!doc.content.length) doc.content.push({ type: 'paragraph' })
  return doc
}

// ---------- back to markdown ----------

// Escape only when the raw text would otherwise be read as markup.
function escapeMd(t) {
  const parsed = parseInline(t)
  if (parsed.length === 1 && !parsed[0].marks && parsed[0].text === t && !t.includes('\\')) return t
  if (!t) return t
  return t.replace(/([\\*_~=+`[\]])/g, '\\$1')
}

function styledToMd(n) {
  let t = n.text ?? ''
  const marks = n.marks ?? []
  const has = (type) => marks.some((m) => m.type === type)
  t = has('code') ? '`' + t + '`' : escapeMd(t)
  if (has('highlight')) t = `==${t}==`
  if (has('strike')) t = `~~${t}~~`
  if (has('underline')) t = `++${t}++`
  if (has('italic')) t = `*${t}*`
  if (has('bold')) t = `**${t}**`
  return t
}

function inlineToMd(nodes = []) {
  let out = ''
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]
    if (n.type === 'hardBreak') { out += ' '; i++; continue }
    if (n.type !== 'text') { i++; continue }
    const link = (n.marks ?? []).find((m) => m.type === 'link')
    if (!link) { out += styledToMd(n); i++; continue }
    // Gather the whole run of nodes sharing this link.
    const href = link.attrs?.href ?? ''
    let inner = ''
    while (i < nodes.length && nodes[i].type === 'text' &&
      (nodes[i].marks ?? []).some((m) => m.type === 'link' && m.attrs?.href === href)) {
      const node = nodes[i]
      inner += styledToMd({ ...node, marks: node.marks.filter((m) => m.type !== 'link') })
      i++
    }
    out += `[${inner}](${href})`
  }
  return out
}

function blockToMd(node, depth, lines) {
  switch (node.type) {
    case 'paragraph':
      lines.push(inlineToMd(node.content))
      break
    case 'heading':
      lines.push('#'.repeat(node.attrs?.level ?? 1) + ' ' + inlineToMd(node.content))
      break
    case 'bulletList':
    case 'orderedList': {
      let n = node.attrs?.start ?? 1
      for (const li of node.content ?? []) {
        const marker = node.type === 'bulletList' ? '-' : `${n++}.`
        const [first, ...rest] = li.content ?? []
        const firstText = first && first.type === 'paragraph' ? inlineToMd(first.content) : ''
        lines.push('  '.repeat(depth) + marker + ' ' + firstText)
        for (const child of rest) blockToMd(child, depth + 1, lines)
      }
      break
    }
    default:
      if (node.content) for (const c of node.content) blockToMd(c, depth, lines)
  }
}

/** tldraw rich text -> markdown string. */
export function richTextToMarkdown(rt) {
  if (!rt || !rt.content) return ''
  const lines = []
  for (const b of rt.content) blockToMd(b, 0, lines)
  return lines.join('\n').replace(/\n+$/, '')
}

/**
 * Lines of plain text for size estimation: [{ text, heading, indent }]
 * heading: 0 for body text, else 1-3; indent: list nesting depth.
 */
export function richTextLines(rt) {
  const out = []
  const plain = (nodes = []) => nodes.map((n) => (n.type === 'text' ? n.text : ' ')).join('')
  const walk = (node, depth) => {
    if (node.type === 'paragraph') out.push({ text: plain(node.content), heading: 0, indent: depth })
    else if (node.type === 'heading') out.push({ text: plain(node.content), heading: Math.min(3, Math.max(1, node.attrs?.level ?? 1)), indent: depth })
    else if (node.type === 'bulletList' || node.type === 'orderedList') {
      for (const li of node.content ?? []) for (const c of li.content ?? []) walk(c, depth + 1)
    } else if (node.content) for (const c of node.content) walk(c, depth)
  }
  for (const b of rt?.content ?? []) walk(b, 0)
  return out.length ? out : [{ text: '', heading: 0, indent: 0 }]
}

export function richTextToPlain(rt) {
  return richTextLines(rt).map((l) => l.text).join('\n')
}

export function isEmptyRichText(rt) {
  return richTextToPlain(rt).trim() === ''
}
