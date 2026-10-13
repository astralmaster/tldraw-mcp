// Images, videos and link previews.
//
// Local files are embedded in the .tldr file as data URLs. When you import the
// file, tldraw.com uploads them to your account's storage. Web URLs are kept as
// links and loaded by tldraw from the web.
import { readFileSync, statSync, existsSync } from 'node:fs'
import { extname, basename, resolve, isAbsolute } from 'node:path'
import { imageSize } from 'image-size'

export const MAX_MEDIA_BYTES = Number(process.env.TLDRAW_MAX_MEDIA_MB || 10) * 1024 * 1024
const FETCH_TIMEOUT_MS = 10000

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.apng': 'image/apng',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
}

const isUrl = (s) => /^https?:\/\//i.test(s)
const isDataUrl = (s) => /^data:/i.test(s)

function sniffMime(buf, fallback) {
  const hex = buf.subarray(0, 12).toString('hex')
  if (hex.startsWith('89504e47')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (hex.startsWith('47494638')) return 'image/gif'
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString()
    if (/avi[fs]/.test(brand)) return 'image/avif'
    if (brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm'
  const head = buf.subarray(0, 512).toString('utf8').trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return fallback
}

function isAnimated(buf, mime) {
  if (mime === 'image/gif') {
    // More than one graphic-control / image block means more than one frame.
    let frames = 0
    for (let i = 0; i < buf.length - 1 && frames < 2; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9) frames++
    return frames > 1
  }
  if (mime === 'image/webp') return buf.includes(Buffer.from('ANIM'))
  if (mime === 'image/png' || mime === 'image/apng') return buf.subarray(0, 4096).includes(Buffer.from('acTL'))
  return false
}

// Width/height of an MP4/MOV from the first video track header ('tkhd').
function mp4Size(buf) {
  let i = buf.indexOf('tkhd')
  while (i !== -1) {
    const version = buf[i + 4]
    const off = i + 4 + (version === 1 ? 88 : 76)
    if (off + 8 <= buf.length) {
      const w = buf.readUInt32BE(off) / 65536
      const h = buf.readUInt32BE(off + 4) / 65536
      if (w > 0 && h > 0) return { w, h }
    }
    i = buf.indexOf('tkhd', i + 4)
  }
  return null
}

function measure(buf, mime) {
  if (mime.startsWith('video/')) return mime === 'video/webm' ? null : mp4Size(buf)
  try {
    const s = imageSize(new Uint8Array(buf))
    if (!s.width || !s.height) return null
    const rotated = s.orientation && s.orientation >= 5
    return rotated ? { w: s.height, h: s.width } : { w: s.width, h: s.height }
  } catch {
    return null
  }
}

async function fetchWithLimit(url, maxBytes) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 tldraw-mcp' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      chunks.push(chunk)
      if (size >= maxBytes) break
    }
    return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') || '').split(';')[0].trim(), finalUrl: res.url }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve an image/video source into an asset description.
 * src: local file path, http(s) URL, or data URL.
 * Returns { src, name, mimeType, w, h, isAnimated, fileSize?, embedded }
 */
export async function loadMedia(src, kind, baseDir) {
  if (!src || typeof src !== 'string') throw new Error(`${kind} needs "src": a file path or https URL`)

  if (isDataUrl(src)) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src)
    if (!m) throw new Error('Malformed data URL')
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    const mime = sniffMime(buf, m[1])
    checkKind(mime, kind, 'data URL')
    return { src, name: kind, mimeType: mime, ...(measure(buf, mime) ?? {}), isAnimated: isAnimated(buf, mime), fileSize: buf.length, embedded: true }
  }

  if (isUrl(src)) {
    // Keep the link; read just enough of the file to learn its size.
    let info = { mimeType: MIME_BY_EXT[extname(new URL(src).pathname).toLowerCase()] ?? null }
    try {
      const probeBytes = kind === 'video' ? 1024 * 1024 : 2 * 1024 * 1024
      const { buf, type } = await fetchWithLimit(src, probeBytes)
      const mime = sniffMime(buf, type || info.mimeType)
      checkKind(mime, kind, src)
      info = { mimeType: mime, ...(measure(buf, mime) ?? {}), isAnimated: isAnimated(buf, mime) }
    } catch (e) {
      if (/is not an? (image|video)/.test(e.message)) throw e
      info.warning = `Could not download ${src} to read its size (${e.message}); give w and h to be exact.`
    }
    const name = decodeURIComponent(basename(new URL(src).pathname)) || kind
    return { src, name, isAnimated: false, ...info, embedded: false }
  }

  const path = isAbsolute(src) ? src : resolve(baseDir ?? process.cwd(), src)
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
  const size = statSync(path).size
  if (size > MAX_MEDIA_BYTES) {
    throw new Error(`${basename(path)} is ${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_MEDIA_BYTES / 1048576} MB. ` +
      'Compress it, or host it online and pass its https URL instead.')
  }
  const buf = readFileSync(path)
  const mime = sniffMime(buf, MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream')
  checkKind(mime, kind, path)
  return {
    src: `data:${mime};base64,${buf.toString('base64')}`,
    name: basename(path),
    mimeType: mime,
    ...(measure(buf, mime) ?? {}),
    isAnimated: isAnimated(buf, mime),
    fileSize: size,
    embedded: true,
  }
}

function checkKind(mime, kind, what) {
  if (!mime) return
  const ok = kind === 'image' ? mime.startsWith('image/') : mime.startsWith('video/')
  if (!ok) throw new Error(`${what} is not a${kind === 'image' ? 'n image' : ' video'} (detected ${mime})`)
}

// ---------- link previews (bookmarks) ----------

function metaContent(html, ...names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i')
    const tag = re.exec(html)?.[0]
    const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1]
    if (content) return decodeEntities(content.trim())
  }
  return ''
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Fetch title/description/image/favicon for a URL. Never throws. */
export async function fetchLinkPreview(url) {
  const out = { title: '', description: '', image: '', favicon: '' }
  try {
    const { buf, finalUrl } = await fetchWithLimit(url, 1024 * 1024)
    const html = buf.toString('utf8')
    const abs = (u) => { try { return u ? new URL(u, finalUrl || url).href : '' } catch { return '' } }
    out.title = metaContent(html, 'og:title', 'twitter:title') || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '')
    out.description = metaContent(html, 'og:description', 'twitter:description', 'description')
    out.image = abs(metaContent(html, 'og:image', 'og:image:url', 'twitter:image'))
    const icon = /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*>/i.exec(html)?.[0]
    out.favicon = abs(icon && /href=["']([^"']+)["']/i.exec(icon)?.[1]) || abs('/favicon.ico')
  } catch (e) {
    out.warning = `Could not fetch a preview for ${url} (${e.message}); the bookmark shows the link only.`
  }
  return out
}
