// Renders boards with tldraw itself, in a headless Chrome/Edge already on the
// computer (no browser download). Used by preview_board and export_board.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'dist')
const IDLE_CLOSE_MS = 5 * 60 * 1000
const RENDER_TIMEOUT_MS = 90 * 1000

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png',
}

export class PreviewUnavailable extends Error {}

let server, serverUrl, browser, page, idleTimer
let queue = Promise.resolve()

function startServer() {
  if (serverUrl) return Promise.resolve(serverUrl)
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '') || 'index.html'
      const file = join(DIST, rel)
      if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${server.address().port}/index.html`
      server.unref()
      resolve(serverUrl)
    })
  })
}

function candidateBrowsers() {
  const list = []
  if (process.env.CHROME_PATH) list.push({ executablePath: process.env.CHROME_PATH })
  list.push({ channel: 'chrome' }, { channel: 'msedge' })
  const paths = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    : process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [
        join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')])
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge', '/snap/bin/chromium']
  for (const p of paths) if (existsSync(p)) list.push({ executablePath: p })
  if (process.platform === 'linux') {
    for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
      try { const p = execFileSync('which', [name], { encoding: 'utf8' }).trim(); if (p) list.push({ executablePath: p }) } catch {}
    }
  }
  return list
}

async function getPage() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(closePreview, IDLE_CLOSE_MS)
  idleTimer.unref?.()
  if (page && !page.isClosed()) return page
  if (!existsSync(join(DIST, 'viewer.js'))) {
    // Installed with --ignore-scripts? Build it now.
    try {
      execFileSync(process.execPath, [join(DIST, '..', '..', 'scripts', 'build-viewer.mjs')], { stdio: 'ignore', timeout: 120000 })
    } catch {}
    if (!existsSync(join(DIST, 'viewer.js'))) {
      throw new PreviewUnavailable('The preview renderer is not built. In the tldraw-mcp folder run: npm run build-viewer')
    }
  }
  let chromium
  try {
    ({ chromium } = await import('playwright-core'))
  } catch {
    throw new PreviewUnavailable('playwright-core is not installed. In the tldraw-mcp folder run: npm install')
  }
  const errors = []
  for (const opts of candidateBrowsers()) {
    try {
      browser = await chromium.launch({ headless: true, ...opts })
      break
    } catch (e) {
      errors.push(`${opts.channel ?? opts.executablePath}: ${e.message.split('\n')[0]}`)
    }
  }
  if (!browser) {
    throw new PreviewUnavailable('Previews and image export need Google Chrome or Microsoft Edge on this computer ' +
      '(or set CHROME_PATH to a Chromium-based browser). Drawing works without it. Tried: ' + errors.slice(0, 4).join('; '))
  }
  const url = await startServer()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(url)
  await page.waitForFunction(() => window.tlReady === true, null, { timeout: 60000 })
  return page
}

export async function closePreview() {
  clearTimeout(idleTimer)
  const b = browser
  browser = undefined
  page = undefined
  if (b) await b.close().catch(() => {})
}

/**
 * Render a board file (JSON object) with tldraw.
 * opts: { pageId, shapeIds, format: png|svg|jpeg|webp, scale, maxSide, background, darkMode, padding }
 */
export function renderBoard(fileJson, opts) {
  const run = async () => {
    const p = await getPage()
    const json = JSON.stringify(fileJson)
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Rendering timed out')), RENDER_TIMEOUT_MS) })
    try {
      return await Promise.race([p.evaluate(([j, o]) => window.tlRender(j, o), [json, opts]), timeout])
    } catch (e) {
      // A crashed or hung page is replaced on the next call.
      await closePreview()
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}
