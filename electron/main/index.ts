import { app, BrowserWindow, dialog, DownloadItem, ipcMain, Menu, shell } from 'electron'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, writeFile, unlink } from 'node:fs/promises'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import type { CheerioAPI, Element } from 'cheerio'
import extract from 'extract-zip'

const execFileAsync = promisify(execFile)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
const runningGames = new Map<string, { child: ChildProcess; startedAt: number }>()

type CurrentInstallCancel = {
  abortController: AbortController
  downloadItem: DownloadItem | null
  megadbWindow: BrowserWindow | null
  isPaused: boolean
}
let currentInstallCancel: CurrentInstallCancel | null = null
let installCancelRequested = false

type StoreProgressPayload =
  | { phase: 'fetch' }
  | { phase: 'parse'; count: number }
  | { phase: 'covers'; current: number; total: number }
  | { phase: 'save' }
  | { phase: 'done' }

type InstallProgressPayload = {
  phase: string
  received?: number
  total?: number
  message?: string
  speedBytesPerSec?: number
  etaSeconds?: number
}

function sendStoreProgress(payload: StoreProgressPayload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('store-progress', payload)
  }
}

function sendInstallProgress(payload: InstallProgressPayload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('install-progress', payload)
  }
}

process.env.APP_ROOT = path.join(__dirname, '../..')

export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

function libraryPath() {
  return path.join(app.getPath('userData'), 'library.json')
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

type SettingsFile = {
  gamesFolderPath?: string | null
}

function loadSettings(): SettingsFile {
  try {
    const raw = readFileSync(settingsPath(), 'utf-8')
    return JSON.parse(raw) as SettingsFile
  } catch {
    return {}
  }
}

function saveSettings(data: SettingsFile) {
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function gamesRoot() {
  const settings = loadSettings()
  const root = settings.gamesFolderPath
    ? path.join(settings.gamesFolderPath, 'games')
    : path.join(app.getPath('userData'), 'games')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

function storeDiscoveryPath() {
  return path.join(app.getPath('userData'), 'store-discovery.json')
}

type StoreDiscoveryFile = {
  pageUrl: string
  items: { id: string; name: string; detailPageUrl: string; coverImageUrl: string | null }[]
  updatedAt: string
}

function loadStoreDiscovery(): StoreDiscoveryFile | null {
  try {
    const raw = readFileSync(storeDiscoveryPath(), 'utf-8')
    return JSON.parse(raw) as StoreDiscoveryFile
  } catch {
    return null
  }
}

function saveStoreDiscovery(data: Omit<StoreDiscoveryFile, 'updatedAt'> & { updatedAt?: string }) {
  const full: StoreDiscoveryFile = {
    pageUrl: data.pageUrl,
    items: data.items,
    updatedAt: data.updatedAt ?? new Date().toISOString(),
  }
  writeFileSync(storeDiscoveryPath(), JSON.stringify(full, null, 2), 'utf-8')
}

export type LibraryGame = {
  id: string
  name: string
  storePageUrl: string
  detailPageUrl: string
  coverImageUrl?: string | null
  addedToLibraryAt: string | null
  downloadUrl: string | null
  installDir: string
  exePath: string | null
  installedAt: string | null
  playTimeSeconds: number
  lastPlayedAt: string | null
  currentSessionStartedAt: string | null
}

type LibraryFile = { games: LibraryGame[]; version?: number }

function migrateGame(raw: Record<string, unknown>): LibraryGame {
  const g = raw as Record<string, unknown> & {
    id?: string
    name?: string
    sourcePageUrl?: string
    detailPageUrl?: string
    storePageUrl?: string
    coverImageUrl?: string | null
    addedToLibraryAt?: string | null
    downloadUrl?: string | null
    installDir?: string
    exePath?: string | null
    installedAt?: string | null
    playTimeSeconds?: number
    lastPlayedAt?: string | null
    currentSessionStartedAt?: string | null
  }

  const sourcePageUrl = String(g.sourcePageUrl || g.storePageUrl || '')
  const detail = String(g.detailPageUrl || sourcePageUrl || g.downloadUrl || '')
  const id = String(g.id || hashId(detail))
  const installDir = String(g.installDir || path.join(gamesRoot(), id))
  return {
    id,
    name: String(g.name || 'Sans nom'),
    storePageUrl: String(g.storePageUrl || sourcePageUrl),
    detailPageUrl: detail,
    coverImageUrl: g.coverImageUrl ?? null,
    addedToLibraryAt: g.addedToLibraryAt ?? g.installedAt ?? new Date().toISOString(),
    downloadUrl: g.downloadUrl ?? null,
    installDir,
    exePath: g.exePath ?? null,
    installedAt: g.installedAt ?? null,
    playTimeSeconds: Number.isFinite(g.playTimeSeconds) ? Number(g.playTimeSeconds) : 0,
    lastPlayedAt: g.lastPlayedAt ?? null,
    currentSessionStartedAt: null,
  }
}

function loadLibrary(): LibraryFile {
  try {
    const raw = readFileSync(libraryPath(), 'utf-8')
    const data = JSON.parse(raw) as LibraryFile
    data.games = (data.games || []).map((g) => migrateGame(g as unknown as Record<string, unknown>))
    return data
  } catch {
    return { games: [] }
  }
}

function saveLibrary(data: LibraryFile) {
  writeFileSync(libraryPath(), JSON.stringify({ ...data, version: 2 }, null, 2), 'utf-8')
}

function sendLibraryUpdated(lib: LibraryFile) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('library-updated', { games: lib.games })
  }
}

function hashId(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function normalizeName(text: string, href: string) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length > 0) return t.slice(0, 120)
  try {
    const u = new URL(href)
    return decodeURIComponent(path.basename(u.pathname) || u.hostname || 'Sans nom')
  } catch {
    return 'Sans nom'
  }
}

const JUNK_HOST =
  /^(www\.)?(facebook|twitter|t\.co|instagram|tiktok|linkedin|pinterest|whatsapp)\./i
const JUNK_PATH = /\/(wp-login|wp-admin|wp-json|feed|rss|login|register|cart|checkout)(\/|$)/i

function isJunkUrl(abs: string, base: URL, linkText: string, hasImgInside: boolean): boolean {
  let u: URL
  try {
    u = new URL(abs)
  } catch {
    return true
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
  if (JUNK_HOST.test(u.hostname)) return true
  if (JUNK_PATH.test(u.pathname)) return true
  if (/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)(\?|$)/i.test(u.pathname)) return true
  const pathLower = u.pathname.toLowerCase()
  if (pathLower.endsWith('.css') || pathLower.endsWith('.js') || pathLower.endsWith('.pdf')) return true
  if (u.href.split('#')[0] === base.href.split('#')[0] && u.hash && u.pathname === base.pathname) {
    return true
  }
  if (
    linkText.trim().length < 2 &&
    !hasImgInside &&
    !/[a-zàâäéèêëïîôùûç0-9]{2,}/i.test(linkText)
  ) {
    return true
  }
  return false
}

function resolveImgSrc(src: string | undefined, base: URL): string | null {
  if (!src || src.startsWith('data:')) return null
  try {
    return new URL(src, base).href
  } catch {
    return null
  }
}

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
}

function findCoverForAnchor($: CheerioAPI, el: Element, base: URL): string | null {
  let cur: Element | null = el
  for (let depth = 0; depth < 10 && cur; depth++) {
    const $scope = $(cur)
    const imgs = $scope.find('img').toArray()
    if ($scope.is('img')) imgs.unshift(cur)
    for (const img of imgs) {
      const $img = $(img)
      const src =
        $img.attr('src') ||
        $img.attr('data-src') ||
        $img.attr('data-lazy-src') ||
        $img.attr('data-original')
      const abs = resolveImgSrc(src, base)
      if (!abs) continue
      const w = parseInt($img.attr('width') || '0', 10)
      const h = parseInt($img.attr('height') || '0', 10)
      if (w > 0 && w < 24 && h > 0 && h < 24) continue
      if (/icon|avatar|emoji|smiley|spacer|pixel|1x1/i.test($img.attr('class') || '')) continue
      if (/logo.*small|favicon/i.test(abs)) continue
      return abs
    }
    cur = $(cur).parent()[0] || null
  }
  return null
}

/** Image depuis la page « fiche jeu » (og:image ou première image d’article) */
async function fetchCoverFromGamePage(detailUrl: string): Promise<string | null> {
  try {
    const pageUrl = new URL(detailUrl)
    const res = await fetch(detailUrl, {
      headers: FETCH_HEADERS,
    })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)
    const og =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content')
    let img = resolveImgSrc(og, pageUrl)
    if (img) return img
    const first =
      $('article img[src], .entry-content img[src], .post-content img[src], main img[src]')
        .not('[src*="emoji"], [src*="icon"], [class*="avatar"]')
        .first()
        .attr('src') ||
      $('.wp-post-image').first().attr('src')
    return resolveImgSrc(first, pageUrl)
  } catch {
    return null
  }
}

async function enrichItemsWithGamePageCovers(
  items: { id: string; name: string; detailPageUrl: string; coverImageUrl: string | null }[],
): Promise<void> {
  const total = items.length
  let current = 0
  const chunk = 4
  for (let i = 0; i < items.length; i += chunk) {
    const slice = items.slice(i, i + chunk)
    await Promise.all(
      slice.map(async (it) => {
        if (it.coverImageUrl) {
          current++
          sendStoreProgress({ phase: 'covers', current, total })
          return
        }
        it.coverImageUrl = await fetchCoverFromGamePage(it.detailPageUrl)
        current++
        sendStoreProgress({ phase: 'covers', current, total })
      }),
    )
  }
}

const DOWNLOAD_HOST_RE =
  /(mediafire\.com|mega\.nz|mega\.co\.nz|mega\.io|megadb\.|drive\.google|dropbox\.com|anonfiles|zippyshare|pixeldrain|gofile|1fichier|uploaded|rapidgator|turbobit|nitroflare|megaup|krakenfiles|buzzheavier|send\.cm|workupload|yourfile|ddownload|github\.com\/.*\/releases)/i

function scoreDownloadCandidate(url: string): number {
  const u = url.toLowerCase()
  let s = 0
  if (/\.(zip|rar|7z|exe)(\?|$)/.test(u)) s += 100
  if (DOWNLOAD_HOST_RE.test(u)) s += 50
  return s
}

/** Liens utiles au téléchargement : fichier direct ou hébergeur externe — pas les autres fiches du site */
function isPlausibleDownloadLink(abs: string, pageUrl: URL): boolean {
  try {
    const u = new URL(abs)
    const path = u.pathname.toLowerCase()
    const full = abs.toLowerCase()

    if (/\.(zip|rar|7z|exe)(\?|$)/i.test(path)) return true

    if (!DOWNLOAD_HOST_RE.test(full)) return false

    if (u.hostname !== pageUrl.hostname) return true

    return /upload|download|file|content|attach|wp-content|media|files|static|storage|cdn/.test(
      path + u.search,
    )
  } catch {
    return false
  }
}

function collectDownloadCandidates($: CheerioAPI, pageUrl: URL): { url: string; label: string }[] {
  const seen = new Set<string>()
  const out: { url: string; label: string }[] = []

  const addFromEl = (el: Element) => {
    const raw = $(el).attr('href')?.trim()
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return
    let abs: string
    try {
      abs = new URL(raw, pageUrl).href
    } catch {
      return
    }
    if (seen.has(abs)) return
    if (!isPlausibleDownloadLink(abs, pageUrl)) return
    seen.add(abs)
    const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 80)
    const label = text || new URL(abs).hostname
    out.push({ url: abs, label })
  }

  let $scope = $('article').first()
  if (!$scope.length) $scope = $('main').first()
  if (!$scope.length) $scope = $('.entry-content, .post-content, .single-content').first()

  const $first = $scope.length
    ? $scope
        .find('a[href]')
        .not('aside a, .widget a, .related-posts a, .wp-block-latest-posts a')
    : $('a[href]')

  $first.each((_, el) => addFromEl(el))

  if (out.length === 0 && $('main').length) {
    $('main a[href]')
      .not('aside a, footer a, nav a, .widget a, .related-posts a, .wp-block-latest-posts a')
      .each((_, el) => addFromEl(el))
  }

  out.sort((a, b) => scoreDownloadCandidate(b.url) - scoreDownloadCandidate(a.url))
  return out
}

/**
 * Suit les pages intermédiaires (hébergeurs, etc.) jusqu’à un lien .zip / .rar / .7z / .exe direct.
 */
async function resolveDirectDownloadUrl(url: string, depth = 0): Promise<string> {
  if (depth > 6) {
    throw new Error(
      "Trop d’étapes. Ouvre le lien dans un navigateur, télécharge le fichier, puis place l’archive dans le dossier du jeu.",
    )
  }

  const pathOnly = url.split(/[?#]/)[0].toLowerCase()
  if (/\.(zip|rar|7z|exe)$/.test(pathOnly)) return url

  const res = await fetch(url, { headers: { ...FETCH_HEADERS, Referer: url }, redirect: 'follow' })
  const finalUrl = res.url
  const pathFinal = finalUrl.split(/[?#]/)[0].toLowerCase()
  if (/\.(zip|rar|7z|exe)$/.test(pathFinal)) return finalUrl

  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const cd = res.headers.get('content-disposition') || ''

  if (ct.includes('application/zip') || ct.includes('application/x-zip')) return finalUrl
  if (ct.includes('application/x-rar-compressed')) return finalUrl
  if (ct.includes('application/x-7z')) return finalUrl
  if (ct.includes('application/octet-stream') && /\.(zip|rar|7z|exe)/i.test(cd)) return finalUrl

  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    if (ct.includes('application/octet-stream') || ct.includes('binary')) {
      return finalUrl
    }
    throw new Error(
      'Réponse inattendue du serveur. Télécharge le fichier depuis le navigateur si le site bloque les requêtes automatiques.',
    )
  }

  const html = await res.text()
  const base = new URL(finalUrl)
  const $ = cheerio.load(html)

  // Spécifique MediaFire
  if (base.hostname.includes('mediafire.com')) {
    const mfDl = $('#downloadButton').attr('href') || $('.input_btn').attr('href')
    if (mfDl) return mfDl
  }

  if (base.hostname.includes('buzzheavier')) {
    const direct =
      $('a[href*="download"]').first().attr('href') ||
      $('a[id*="download" i]').first().attr('href') ||
      $('a[class*="download" i]').first().attr('href') ||
      $('form[action*="download"]').first().attr('action')
    if (direct) {
      try {
        return new URL(direct, base).href
      } catch {
        /* ignore */
      }
    }
    const m1 = html.match(/https?:\/\/[^\s"'<>]+/gi)
    if (m1) {
      const candidates = m1
        .map((s) => s.trim())
        .filter((s) => /buzzheavier|download|dl|files|cdn/i.test(s))
      if (candidates.length > 0) {
        try {
          return new URL(candidates[0], base).href
        } catch {
          /* ignore */
        }
      }
    }
  }

  const found: string[] = []

  let $linkScope = $('main a[href], article a[href]')
  if (!$linkScope.length) $linkScope = $('a[href]')
  $linkScope.each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    try {
      const abs = new URL(href, base).href
      if (/\.(zip|rar|7z|exe)(\?|$)/i.test(abs)) found.push(abs)
    } catch {
      /* ignore */
    }
  })

  $('[data-url], [data-download], [data-href], [data-file]').each((_, el) => {
    const du =
      $(el).attr('data-url') ||
      $(el).attr('data-download') ||
      $(el).attr('data-href') ||
      $(el).attr('data-file')
    if (du && /\.(zip|rar|7z|exe)/i.test(du)) {
      try {
        found.push(new URL(du, base).href)
      } catch {
        /* ignore */
      }
    }
  })

  const re = /(https?:\/\/[^\s"'<>]+\.(?:zip|rar|7z|exe)(?:\?[^\s"'<>]*)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) found.push(m[1])

  const unique = [...new Set(found)].filter((u) => u !== url)
  if (unique.length === 0) {
    throw new Error(
      "Aucun fichier .zip/.exe détecté sur cette page. Ouvre le lien dans Chrome, télécharge, puis dépose l’archive dans le dossier du jeu.",
    )
  }

  unique.sort((a, b) => scoreDownloadCandidate(b) - scoreDownloadCandidate(a))
  return resolveDirectDownloadUrl(unique[0], depth + 1)
}

ipcMain.handle('library:get', () => loadLibrary())

ipcMain.handle('store:cached', () => loadStoreDiscovery())

ipcMain.handle('store:clear', () => {
  saveStoreDiscovery({
    pageUrl: '',
    items: [],
    updatedAt: new Date().toISOString(),
  })
  return true
})

ipcMain.handle('library:addGame', async (_e, payload: {
  name: string
  storePageUrl: string
  detailPageUrl: string
  coverImageUrl?: string | null
}) => {
  const id = hashId(payload.detailPageUrl)
  const lib = loadLibrary()
  const existing = lib.games.find((g) => g.id === id)
  if (existing) return existing

  const installDir = path.join(gamesRoot(), id)
  mkdirSync(installDir, { recursive: true })

  const game: LibraryGame = {
    id,
    name: payload.name,
    storePageUrl: payload.storePageUrl,
    detailPageUrl: payload.detailPageUrl,
    coverImageUrl: payload.coverImageUrl ?? null,
    addedToLibraryAt: new Date().toISOString(),
    downloadUrl: null,
    installDir,
    exePath: null,
    installedAt: null,
    playTimeSeconds: 0,
    lastPlayedAt: null,
    currentSessionStartedAt: null,
  }
  lib.games.push(game)
  saveLibrary(lib)
  sendLibraryUpdated(lib)
  return game
})

async function searchSteamGame(name: string): Promise<string | null> {
  try {
    // Nettoyer le nom pour la recherche
    const cleanName = name
      .replace(/[®™]/g, '')
      .replace(/\(.*\)/g, '')
      .replace(/\[.*\]/g, '')
      .replace(/(Download|Free|Gratuit|PC Game|Full Version|Direct Link).*/gi, '')
      .split(':')[0] // Prendre avant le sous-titre souvent
      .trim()

    if (cleanName.length < 2) return null

    const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(cleanName)}&category1=998`
    const res = await fetch(searchUrl, { headers: FETCH_HEADERS })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)
    
    // On prend le premier résultat de la recherche
    const firstResult = $('#search_resultsRows a').first().attr('href')
    if (firstResult) {
      // Nettoyer l'URL (enlever les paramètres de tracking/session)
      try {
        const u = new URL(firstResult, 'https://store.steampowered.com')
        const finalUrl = `${u.protocol}//${u.hostname}${u.pathname}`
        
        // Vérification de pertinence : le nom trouvé doit ressembler un peu au nom cherché
        const foundName = $('#search_resultsRows a').first().find('.title').text().toLowerCase()
        const searchLower = cleanName.toLowerCase()
        if (!foundName.includes(searchLower) && !searchLower.includes(foundName)) {
          // Si le nom ne correspond vraiment pas, on ignore pour éviter les faux positifs
          console.log(`Steam search mismatch: searched "${cleanName}", found "${foundName}"`)
          return null
        }

        return finalUrl
      } catch {
        return null
      }
    }
    return finalUrl
  } catch (err) {
    console.error('Erreur recherche Steam:', err)
    return null
  }
}

async function searchSteamGames(query: string): Promise<{ id: number; name: string; header_image: string }[]> {
  try {
    const searchUrl = `https://store.steampowered.com/search/?term=${encodeURIComponent(query)}&category1=998&l=french`
    const res = await fetch(searchUrl, { headers: FETCH_HEADERS })
    if (!res.ok) return []
    const html = await res.text()
    const $ = cheerio.load(html)
    
    const results: { id: number; name: string; header_image: string }[] = []
    $('#search_resultsRows a').slice(0, 20).each((_, el) => {
      const $el = $(el)
      const href = $el.attr('href') || ''
      const idMatch = href.match(/\/app\/(\d+)/)
      const id = idMatch ? parseInt(idMatch[1], 10) : 0
      const name = $el.find('.title').text().trim()
      const img = $el.find('img').attr('src') || ''
      
      if (id && name) {
        // Transformer l'image de recherche en header image plus grande si possible
        const header_image = img.replace('capsule_sm_120.jpg', 'header.jpg').replace('capsule_61x28.jpg', 'header.jpg')
        results.push({ id, name, header_image })
      }
    })
    return results
  } catch (err) {
    console.error('Erreur searchSteamGames:', err)
    return []
  }
}

ipcMain.handle('store:searchSteam', (_e, query: string) => searchSteamGames(query))

ipcMain.handle('store:fetchDashboard', async () => {
  try {
    const topUrl = 'https://store.steampowered.com/api/featuredcategories/?l=french'
    const res = await fetch(topUrl, { headers: FETCH_HEADERS })
    if (!res.ok) throw new Error('Steam API failed')
    
    const data = await res.json()
    
    const topSellers = (data.top_sellers?.items || []).slice(0, 12).map((i: any) => ({
      id: i.id,
      name: i.name,
      header_image: i.header_image
    }))

    const newReleases = (data.new_releases?.items || []).slice(0, 12).map((i: any) => ({
      id: i.id,
      name: i.name,
      header_image: i.header_image
    }))

    const specials = (data.specials?.items || []).slice(0, 12).map((i: any) => ({
      id: i.id,
      name: i.name,
      header_image: i.header_image
    }))

    const comingSoon = (data.coming_soon?.items || []).slice(0, 12).map((i: any) => ({
      id: i.id,
      name: i.name,
      header_image: i.header_image
    }))

    const featured = (data.featured_win?.items || []).slice(0, 16).map((i: any) => ({
      id: i.id,
      name: i.name,
      header_image: i.header_image
    }))

    return { topSellers, newReleases, specials, comingSoon, featured }
  } catch (err) {
    console.error('Erreur store:fetchDashboard:', err)
    return { topSellers: [], newReleases: [], specials: [], comingSoon: [], featured: [] }
  }
})

ipcMain.handle('steam:appDetails', async (_e, appId: number | string) => {
  try {
    const id = Number(appId)
    if (!Number.isFinite(id) || id <= 0) return null
    const url = `https://store.steampowered.com/api/appdetails?appids=${id}&l=french&cc=fr`
    const res = await fetch(url, { headers: FETCH_HEADERS })
    if (!res.ok) return null
    const json = await res.json()
    const entry = json?.[String(id)]
    if (!entry?.success || !entry?.data) return null
    const d = entry.data
    return {
      id,
      name: String(d.name || ''),
      short_description: String(d.short_description || ''),
      about_the_game: String(d.about_the_game || ''),
      header_image: String(d.header_image || ''),
      release_date: String(d.release_date?.date || ''),
      developers: Array.isArray(d.developers) ? d.developers.map(String) : [],
      publishers: Array.isArray(d.publishers) ? d.publishers.map(String) : [],
      genres: Array.isArray(d.genres) ? d.genres.map((g: any) => String(g?.description || '')).filter(Boolean) : [],
      screenshots: Array.isArray(d.screenshots)
        ? d.screenshots
            .map((s: any) => String(s?.path_full || s?.path_thumbnail || ''))
            .filter(Boolean)
            .slice(0, 10)
        : [],
    }
  } catch (err) {
    console.error('Erreur steam:appDetails:', err)
    return null
  }
})

ipcMain.handle('store:scrape', async (_e, pageUrl: string) => {
  try {
    sendStoreProgress({ phase: 'fetch' })
    const previous = loadStoreDiscovery()
    const prevById = new Map<string, { coverImageUrl: string | null }>()
    if (previous?.items?.length && previous.pageUrl === pageUrl) {
      for (const it of previous.items) prevById.set(it.id, { coverImageUrl: it.coverImageUrl ?? null })
    }
    const base = new URL(pageUrl)
    const res = await fetch(pageUrl, {
      headers: FETCH_HEADERS,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const $ = cheerio.load(html)
    const seen = new Set<string>()
    const items: { id: string; name: string; detailPageUrl: string; coverImageUrl: string | null }[] = []

    const excludedAncestors =
      'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],.menu,.navbar,.nav,.site-header,.site-footer,.header,.footer,.logo,.brand,.breadcrumb,.breadcrumbs,.pagination,.pager,.page-numbers,.widget,.social,.share,.language,.lang,.search,.searchform,.comments,.comment,.cookie,.consent'

    const isExcluded = (el: Element) => {
      const $el = $(el)
      if ($el.parents(excludedAncestors).length > 0) return true
      const role = ($el.attr('role') || '').toLowerCase()
      if (role.includes('menuitem') || role.includes('navigation')) return true
      const aria = ($el.attr('aria-label') || '').toLowerCase()
      if (aria.includes('menu') || aria.includes('navigation')) return true
      const cls = ($el.attr('class') || '').toLowerCase()
      if (/(menu|nav|navbar|breadcrumb|logo|brand|footer|header|cookie|consent)/.test(cls)) return true
      return false
    }

    let $scope = $('article').first()
    if (!$scope.length) $scope = $('main').first()
    if (!$scope.length) $scope = $('.entry-content, .post-content, .single-content, #content, .content').first()
    const $links = $scope.length ? $scope.find('a[href]') : $('a[href]')

    $links.each((_, el) => {
      if (isExcluded(el)) return
      const raw = $(el).attr('href')?.trim()
      if (!raw) return
      if (raw.startsWith('mailto:') || raw.startsWith('javascript:')) return
      let abs: string
      try {
        abs = new URL(raw, base).href
      } catch {
        return
      }
      if (seen.has(abs)) return
      const hasImgInside = $(el).find('img').length > 0
      const name = normalizeName($(el).text(), abs)
      if (isJunkUrl(abs, base, $(el).text(), hasImgInside)) return

      const listingCover = findCoverForAnchor($, el, base)
      const id = hashId(abs)
      const prevCover = prevById.get(id)?.coverImageUrl ?? null

      seen.add(abs)
      items.push({
        id,
        name,
        detailPageUrl: abs,
        coverImageUrl: prevCover || listingCover,
      })
    })

    sendStoreProgress({ phase: 'parse', count: items.length })
    const toEnrich = items.filter((it) => !it.coverImageUrl)
    if (toEnrich.length > 0) {
      await enrichItemsWithGamePageCovers(toEnrich)
    }

    sendStoreProgress({ phase: 'save' })
    const result = { pageUrl, items }
    saveStoreDiscovery({ ...result, updatedAt: new Date().toISOString() })
    return result
  } finally {
    sendStoreProgress({ phase: 'done' })
  }
})

ipcMain.handle('store:scrapeDetail', async (_e, detailPageUrl: string) => {
  try {
    const pageUrl = new URL(detailPageUrl)
    const isSteamOriginal = pageUrl.hostname.includes('steampowered')

    // 1. Scraper la page originale pour avoir le titre et les liens
    const res = await fetch(detailPageUrl, {
      headers: FETCH_HEADERS,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const $ = cheerio.load(html)

    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim()
    let title = ogTitle || $('title').first().text().trim() || 'Sans titre'
    
    // Nettoyer le titre (enlever "Télécharger", "Gratuit", etc.)
    title = title.replace(/(Download|Free|Gratuit|PC Game|Full Version|Direct Link).*/gi, '').trim()

    const downloadCandidates = collectDownloadCandidates($, pageUrl)

    // 2. Si on n'est pas déjà sur Steam, on cherche les infos sur Steam par le nom
    let steamData: any = null
    if (!isSteamOriginal) {
      const steamUrl = await searchSteamGame(title)
      if (steamUrl) {
        try {
          const resSteam = await fetch(steamUrl, { headers: FETCH_HEADERS })
          if (resSteam.ok) {
            const htmlSteam = await resSteam.text()
            const $steam = cheerio.load(htmlSteam)
            
            const ogImageSteam = $steam('meta[property="og:image"]').attr('content')
            const steamCover = $steam('.game_header_image_full').attr('src') || $steam('.package_header').attr('src')
            
            const screenshots: string[] = []
            $steam('.highlight_screenshot_link').each((_, el) => {
              const href = $steam(el).attr('href')
              if (href) screenshots.push(href)
            })

            const min = $steam('.game_area_sys_req_left').text().trim()
          const rec = $steam('.game_area_sys_req_right').text().trim()
          
          const genres: string[] = []
          $steam('.game_details_right_panel a[href*="genre"]').each((_, el) => {
            const t = $steam(el).text().trim()
            if (t && !genres.includes(t)) genres.push(t)
          })

          // Nettoyage de la description Steam pour enlever les avis/awards
          const $desc = $steam('#game_area_description')
          $desc.find('.review_quotes, .awards_container, .game_area_description_header').remove()
          const cleanDescription = $desc.html()?.trim() || $steam('.game_area_description').first().html()?.trim()

          // Nettoyage du titre Steam (enlever prix, promos, etc.)
           let steamTitle = $steam('.apphub_AppName').first().text().trim() || $steam('meta[property="og:title"]').attr('content')?.trim() || title
           steamTitle = steamTitle.replace(/(-?\d+%\s+)?sur Steam/gi, '')
             .replace(/Economisez.*$/gi, '')
             .replace(/Save.*$/gi, '')
             .replace(/(-?\d+%\s+)?off/gi, '')
             .trim()

           steamData = {
             title: steamTitle,
             coverImageUrl: steamCover || resolveImgSrc(ogImageSteam, new URL(steamUrl)),
            description: cleanDescription || $steam('meta[name="description"]').attr('content'),
            releaseDate: $steam('.release_date .date').first().text().trim(),
            developer: $steam('.dev_row a').first().text().trim(),
            publisher: $steam('.dev_row').last().find('a').first().text().trim(),
            genres,
            screenshots,
            systemRequirements: (min || rec) ? { minimum: min, recommended: rec } : null
          }
          }
        } catch (e) {
          console.error('Erreur enrichissement Steam:', e)
        }
      }
    }

    // 3. Fusionner les données (Priorité à Steam pour le visuel, mais garder les liens originaux)
    if (steamData) {
      return {
        detailPageUrl, // On garde l'URL originale !
        title: steamData.title,
        coverImageUrl: steamData.coverImageUrl,
        description: steamData.description,
        releaseDate: steamData.releaseDate || null,
        developer: steamData.developer || null,
        publisher: steamData.publisher || null,
        genres: steamData.genres.length ? steamData.genres : null,
        screenshots: steamData.screenshots.length ? steamData.screenshots : null,
        systemRequirements: steamData.systemRequirements,
        downloadCandidates,
      }
    }

    // Fallback sur le scraping classique si pas de Steam
    const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content')
    let steamCover = isSteamOriginal ? ($('.game_header_image_full').attr('src') || $('.package_header').attr('src')) : null

    const ogDesc = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content')
    const longDescHtml = $('.game_area_description, .game_description, .product-description').first().html()?.trim()
    
    const screenshots: string[] = []
    if (isSteamOriginal) {
      $('.highlight_screenshot_link').each((_, el) => {
        const href = $(el).attr('href')
        if (href) screenshots.push(href)
      })
    }

    return {
      detailPageUrl,
      title,
      coverImageUrl: steamCover || resolveImgSrc(ogImage, pageUrl),
      description: (ogDesc || longDescHtml || null)?.slice(0, 10000)?.trim() || null,
      releaseDate: isSteamOriginal ? $('.release_date .date').first().text().trim() : null,
      developer: isSteamOriginal ? $('.dev_row a').first().text().trim() : null,
      publisher: isSteamOriginal ? $('.dev_row').last().find('a').first().text().trim() : null,
      genres: [],
      screenshots: screenshots.length ? screenshots : null,
      systemRequirements: null,
      downloadCandidates,
    }
  } catch (err) {
    console.error('Erreur store:scrapeDetail:', err)
    throw err
  }
})

function findFirstExe(dir: string, gameName?: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true })
  const candidates: { path: string; score: number }[] = []

  const IGNORED_EXES = [
    'unins000.exe',
    'unins001.exe',
    'unitycrashhandler.exe',
    'unitycrashhandler64.exe',
    'dxwebsetup.exe',
    'vc_redist.x64.exe',
    'vc_redist.x86.exe',
    'redist',
  ]

  function walk(currentDir: string) {
    const files = readdirSync(currentDir, { withFileTypes: true })
    for (const f of files) {
      const full = path.join(currentDir, f.name)
      if (f.isDirectory()) {
        walk(full)
      } else if (f.isFile() && f.name.toLowerCase().endsWith('.exe')) {
        const nameLower = f.name.toLowerCase()
        if (IGNORED_EXES.some((ignored) => nameLower.includes(ignored))) continue

        let score = 0
        // Score basé sur la profondeur (préférer la racine)
        const depth = full.split(path.sep).length - dir.split(path.sep).length
        score -= depth * 10

        // Score basé sur le nom du jeu
        if (gameName) {
          const words = gameName.toLowerCase().split(/\s+/)
          for (const word of words) {
            if (word.length > 2 && nameLower.includes(word)) score += 50
          }
        }

        // Score basé sur la taille (les jeux sont souvent gros)
        try {
          const stats = statSync(full)
          score += Math.floor(stats.size / (1024 * 1024)) // 1 point par Mo
        } catch {
          /* ignore */
        }

        candidates.push({ path: full, score })
      }
    }
  }

  walk(dir)

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].path
}

function isMegadbHostname(hostname: string): boolean {
  return /megadb\./i.test(hostname)
}

function isBuzzheavierHostname(hostname: string): boolean {
  return /buzzheavier\./i.test(hostname)
}

function is1fichierHostname(hostname: string): boolean {
  return /(^|\.)1fichier\.com$/i.test(hostname)
}

function isMegaHostname(hostname: string): boolean {
  return /(mega\.nz|mega\.co\.nz|mega\.io)$/i.test(hostname)
}

function isGofileHostname(hostname: string): boolean {
  return /(^|\.)gofile\.io$/i.test(hostname)
}

async function downloadToFileWithProgress(
  url: string,
  dest: string,
  onProgress: (
    received: number,
    total: number,
    speedBytesPerSec?: number,
    etaSeconds?: number,
  ) => void,
  signal?: AbortSignal,
) {
  const refUrl = (() => {
    try {
      return new URL(url).href
    } catch {
      return url
    }
  })()
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Referer: refUrl },
    redirect: 'follow',
    signal,
  })
  if (!res.ok) throw new Error(`Téléchargement: HTTP ${res.status}`)
  mkdirSync(path.dirname(dest), { recursive: true })
  const total = Number(res.headers.get('content-length') || 0)
  const body = res.body
  if (!body) throw new Error('Réponse vide')
  const reader = body.getReader()
  const file = createWriteStream(dest)
  let received = 0
  let lastTime = Date.now()
  let lastReceived = 0
  const throttleMs = 150
  try {
    for (;;) {
      if (currentInstallCancel?.isPaused) {
        await new Promise(resolve => setTimeout(resolve, 500))
        continue
      }
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.length
        file.write(Buffer.from(value))
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000
        let speedBytesPerSec: number | undefined
        let etaSeconds: number | undefined
        if (elapsed >= throttleMs / 1000 && total > 0) {
          const delta = received - lastReceived
          speedBytesPerSec = delta / elapsed
          if (speedBytesPerSec > 0) etaSeconds = (total - received) / speedBytesPerSec
          lastTime = now
          lastReceived = received
        }
        onProgress(received, total || received, speedBytesPerSec, etaSeconds)
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
    })
  }
}

async function tryExtractWith7Zip(archivePath: string, outDir: string): Promise<boolean> {
  const outArg = outDir.endsWith(path.sep) ? outDir : outDir + path.sep
  const candidates = [
    '7z',
    String.raw`C:\Program Files\7-Zip\7z.exe`,
    String.raw`C:\Program Files (x86)\7-Zip\7z.exe`,
  ]
  for (const z of candidates) {
    try {
      await execFileAsync(z, ['x', archivePath, `-o${outArg}`, '-y'], {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      })
      return true
    } catch {
      continue
    }
  }
  return false
}

async function processDownloadedFileToExe(
  localPath: string,
  installDir: string,
  gameName?: string,
): Promise<string> {
  const lower = localPath.toLowerCase()
  if (lower.endsWith('.exe')) {
    const dest = path.join(installDir, path.basename(localPath))
    if (path.resolve(localPath) !== path.resolve(dest)) {
      await copyFile(localPath, dest)
      return dest
    }
    return localPath
  }
  if (lower.endsWith('.zip')) {
    await extract(localPath, { dir: installDir })
    try {
      if (statSync(localPath).isFile()) await unlink(localPath)
    } catch {
      /* ignore */
    }
    const exe = findFirstExe(installDir, gameName)
    if (!exe) throw new Error('Aucun .exe trouvé dans l’archive .zip')
    return exe
  }
  if (lower.endsWith('.rar') || lower.endsWith('.7z')) {
    const ok = await tryExtractWith7Zip(localPath, installDir)
    if (!ok) {
      void shell.openPath(installDir)
      throw new Error(
        `7-Zip est introuvable. Installe-le depuis https://www.7-zip.org puis extrais « ${path.basename(localPath)} » dans le dossier ouvert.`,
      )
    }
    try {
      if (statSync(localPath).isFile()) await unlink(localPath)
    } catch {
      /* ignore */
    }
    const exe = findFirstExe(installDir, gameName)
    if (!exe) throw new Error('Extraction terminée mais aucun .exe trouvé dans le dossier')
    return exe
  }
  throw new Error('Format non supporté (.exe, .zip, .rar, .7z)')
}

function downloadThroughHostedPageWindow(
  pageUrl: string,
  installDir: string,
  cancelRef: CurrentInstallCancel,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    let settled = false
    let downloadStarted = false
    let firstArchiveHandled = false
    let title = 'Téléchargement — clique sur Download'
    let hostedKind:
      | 'megadb'
      | 'buzzheavier'
      | '1fichier'
      | 'mega'
      | 'gofile'
      | 'other' = 'other'
    try {
      const host = new URL(pageUrl).hostname
      if (isMegadbHostname(host)) {
        title = 'Téléchargement — action requise'
        hostedKind = 'megadb'
      } else if (isBuzzheavierHostname(host)) {
        title = 'Téléchargement'
        hostedKind = 'buzzheavier'
      } else if (is1fichierHostname(host)) {
        title = 'Téléchargement — action requise'
        hostedKind = '1fichier'
      } else if (isMegaHostname(host)) {
        title = 'Téléchargement — action requise'
        hostedKind = 'mega'
      } else if (isGofileHostname(host)) {
        title = 'Téléchargement'
        hostedKind = 'gofile'
      }
    } catch {
      /* ignore */
    }
    const bw = new BrowserWindow({
      width: 980,
      height: 820,
      title,
      parent,
      show: hostedKind !== 'buzzheavier' && hostedKind !== 'gofile',
      skipTaskbar: hostedKind === 'buzzheavier' || hostedKind === 'gofile',
      webPreferences: {
        partition: 'persist:hosted-dl',
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    cancelRef.megadbWindow = bw

    const sess = bw.webContents.session
    let autoClickInterval: NodeJS.Timeout | null = null
    let hostedTimeout: NodeJS.Timeout | null = null

    bw.webContents.setWindowOpenHandler(({ url }) => {
      void bw.loadURL(url)
      return { action: 'deny' }
    })

    const clearAutoClick = () => {
      if (autoClickInterval) {
        clearInterval(autoClickInterval)
        autoClickInterval = null
      }
    }

    const clearHostedTimeout = () => {
      if (hostedTimeout) {
        clearTimeout(hostedTimeout)
        hostedTimeout = null
      }
    }

    const scheduleAutoClick = () => {
      if (hostedKind !== 'buzzheavier' && hostedKind !== 'gofile' && hostedKind !== 'mega') return
      if (bw.isDestroyed()) return
      if (downloadStarted || settled) return
      clearAutoClick()
      let remaining = 20
      autoClickInterval = setInterval(() => {
        if (bw.isDestroyed() || downloadStarted || settled) {
          clearAutoClick()
          return
        }
        remaining--
        if (remaining < 0) {
          clearAutoClick()
          return
        }
        void bw.webContents
          .executeJavaScript(
            `(() => {
              const els = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'))
              const quick = document.querySelector(
                'a[href*="download" i],button[id*="download" i],a[id*="download" i],button[class*="download" i],a[class*="download" i]',
              )
              if (quick) {
                try { quick.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
                try { quick.focus() } catch {}
                try { quick.click() } catch {}
                try {
                  quick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                } catch {}
                return true
              }
              const score = (el) => {
                const text = (el.textContent || '').trim()
                const aria = (el.getAttribute && el.getAttribute('aria-label')) || ''
                const title = (el.getAttribute && el.getAttribute('title')) || ''
                const value = el.tagName === 'INPUT' ? (el.value || '') : ''
                const href = el.tagName === 'A' ? (el.href || '') : ''
                const s = (text + ' ' + value + ' ' + aria + ' ' + title + ' ' + href).toLowerCase()
                let n = 0
                if (s.includes('download')) n += 10
                if (href && /\\/download\\b/i.test(href)) n += 5
                if (el.tagName === 'A' && href) n += 1
                if (s.includes('standard download')) n += 8
                return n
              }
              let best = null
              let bestScore = 0
              for (const el of els) {
                const sc = score(el)
                if (sc > bestScore) {
                  bestScore = sc
                  best = el
                }
              }
              if (best && bestScore >= 10) {
                try { best.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
                try { best.focus() } catch {}
                try { best.click() } catch {}
                try {
                  best.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                } catch {}
                return true
              }
              return false
            })()`,
            true,
          )
          .catch(() => {})
      }, 900)
    }

    const onWillDownload = (_e: unknown, item: DownloadItem) => {
      const fn = item.getFilename()
      const mime = item.getMimeType() || ''
      const urlText = (() => {
        try {
          const chain =
            typeof item.getURLChain === 'function' ? item.getURLChain() : ([] as unknown as string[])
          const u = typeof item.getURL === 'function' ? item.getURL() : ''
          return [u, ...(Array.isArray(chain) ? chain : [])].join(' ').toLowerCase()
        } catch {
          return ''
        }
      })()
      const isLikelyNonFile =
        /text\/html|application\/json|javascript/i.test(mime) || /\.(html?|php|aspx?)$/i.test(fn)
      const looksLikeArchive =
        hostedKind === 'buzzheavier' || hostedKind === 'gofile' || hostedKind === 'mega'
          ? !isLikelyNonFile
          : /\.(zip|rar|7z|exe)$/i.test(fn) ||
            /zip|rar|7z|octet-stream|x-msdownload|x-zip|x-7z|x-rar|binary|x-binary|x-download/i.test(
              mime,
            ) ||
            /\.(zip|rar|7z|exe)(\?|$)/i.test(urlText)
      if (!looksLikeArchive) {
        item.cancel()
        return
      }
      if (firstArchiveHandled) {
        item.cancel()
        return
      }
      firstArchiveHandled = true
      downloadStarted = true
      clearAutoClick()
      clearHostedTimeout()
      cancelRef.downloadItem = item
      cancelRef.megadbWindow = null
      const safeName = fn && fn.trim() ? fn : 'download.bin'
      const dest = path.join(installDir, path.basename(safeName))
      item.setSavePath(dest)

      let lastTime = Date.now()
      let lastReceived = 0

      item.on('updated', () => {
        if (currentInstallCancel?.isPaused && !item.isPaused()) {
          item.pause()
        } else if (!currentInstallCancel?.isPaused && item.isPaused()) {
          item.resume()
        }
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const t = total || received
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000
        let speedBytesPerSec: number | undefined
        let etaSeconds: number | undefined
        if (elapsed >= 0.15 && t > 0) {
          const delta = received - lastReceived
          speedBytesPerSec = delta / elapsed
          if (speedBytesPerSec > 0 && total) etaSeconds = (total - received) / speedBytesPerSec
          lastTime = now
          lastReceived = received
        }
        sendInstallProgress({
          phase: 'download',
          received,
          total: t,
          message: fn,
          speedBytesPerSec,
          etaSeconds,
        })
      })

      item.once('done', (_e2, state) => {
        if (settled) return
        if (state === 'completed') {
          settled = true
          sess.removeListener('will-download', onWillDownload)
          bw.destroy()
          resolve(dest)
        } else if (state === 'cancelled' || state === 'interrupted') {
          settled = true
          sess.removeListener('will-download', onWillDownload)
          reject(
            new Error(
              state === 'cancelled' ? 'Téléchargement annulé' : 'Téléchargement interrompu',
            ),
          )
        }
      })
      sess.removeListener('will-download', onWillDownload)
      bw.close()
    }

    sess.on('will-download', onWillDownload)
    if (hostedKind === 'buzzheavier' || hostedKind === 'gofile') {
      if (hostedKind === 'buzzheavier') {
        bw.webContents.setUserAgent(FETCH_HEADERS['User-Agent'])
        setTimeout(() => scheduleAutoClick(), 2000)
        setTimeout(() => {
          if (settled || downloadStarted || bw.isDestroyed()) return
          try {
            bw.setSkipTaskbar(false)
            bw.show()
            sendInstallProgress({ phase: 'hosted', message: 'Clique sur Download sur le site…' })
          } catch {
            /* ignore */
          }
        }, 6_000)
      }
      if (hostedKind === 'gofile') {
        setTimeout(() => {
          if (settled || downloadStarted || bw.isDestroyed()) return
          try {
            bw.setSkipTaskbar(false)
            bw.show()
            sendInstallProgress({ phase: 'hosted', message: 'Clique sur Download sur le site…' })
          } catch {
            /* ignore */
          }
        }, 8_000)
      }
      hostedTimeout = setTimeout(() => {
        if (settled || downloadStarted || bw.isDestroyed()) return
        settled = true
        clearAutoClick()
        clearHostedTimeout()
        sess.removeListener('will-download', onWillDownload)
        try {
          bw.destroy()
        } catch {
          /* ignore */
        }
        reject(new Error('Téléchargement non démarré'))
      }, 45_000)
    }

    bw.on('closed', () => {
      clearAutoClick()
      clearHostedTimeout()
      sess.removeListener('will-download', onWillDownload)
      if (!settled && !downloadStarted) {
        settled = true
        reject(
          new Error(
            installCancelRequested
              ? 'Téléchargement annulé'
              : hostedKind === 'buzzheavier'
                ? 'Téléchargement non démarré'
                : 'Fenêtre fermée avant la validation du CAPTCHA',
          ),
        )
      }
    })

    sendInstallProgress({
      phase: 'hosted',
      message:
        hostedKind === 'buzzheavier' || hostedKind === 'gofile'
          ? 'En attente du site…'
          : hostedKind === 'megadb'
            ? 'Valide le CAPTCHA puis clique sur « Free Download ».'
            : hostedKind === 'mega'
              ? 'Clique sur “Download” puis “Standard Download”.'
            : 'Suis les étapes sur le site pour démarrer le téléchargement.',
    })

    bw.webContents.on('did-finish-load', () => {
      scheduleAutoClick()
    })
    bw.webContents.on('did-navigate', () => {
      scheduleAutoClick()
    })

    void bw.loadURL(pageUrl).catch((err) => {
      if (!settled) {
        settled = true
        clearAutoClick()
        reject(err)
      }
    })
  })
}

ipcMain.handle(
  'game:install',
  async (
    _e,
    payload: {
      id: string
      name: string
      storePageUrl: string
      detailPageUrl: string
      downloadUrl: string
      coverImageUrl?: string | null
    },
  ) => {
    const expectedId = hashId(payload.detailPageUrl)
    if (payload.id !== expectedId) {
      throw new Error('Identifiant jeu incohérent')
    }

    const libFirst = loadLibrary()
    const entry = libFirst.games.find((g) => g.id === payload.id)
    if (!entry) {
      throw new Error('Ajoute d’abord le jeu à la bibliothèque')
    }
    if (entry.exePath && existsSync(entry.exePath)) {
      return entry
    }

    const installDir = entry.installDir
    mkdirSync(installDir, { recursive: true })

    currentInstallCancel = {
      abortController: new AbortController(),
      downloadItem: null,
      megadbWindow: null,
      isPaused: false,
    }
    const signal = currentInstallCancel.abortController.signal

    let resolvedUrlForLibrary = payload.downloadUrl
    let localFilePath: string

    try {
      const dl = new URL(payload.downloadUrl)

      if (
        isMegadbHostname(dl.hostname) ||
        isBuzzheavierHostname(dl.hostname) ||
        is1fichierHostname(dl.hostname) ||
        isMegaHostname(dl.hostname) ||
        isGofileHostname(dl.hostname)
      ) {
        localFilePath = await downloadThroughHostedPageWindow(
          payload.downloadUrl,
          installDir,
          currentInstallCancel!,
        )
      } else {
        sendInstallProgress({ phase: 'resolve', message: 'Résolution du lien…' })
        const resolvedUrl = await resolveDirectDownloadUrl(payload.downloadUrl)
        resolvedUrlForLibrary = resolvedUrl

        const lower = resolvedUrl.split('?')[0].toLowerCase()

        if (lower.endsWith('.exe')) {
          const fileName = path.basename(new URL(resolvedUrl).pathname) || 'game.exe'
          const target = path.join(installDir, fileName)
          await downloadToFileWithProgress(
            resolvedUrl,
            target,
            (received, total, speedBytesPerSec, etaSeconds) => {
              sendInstallProgress({
                phase: 'download',
                received,
                total,
                message: fileName,
                speedBytesPerSec,
                etaSeconds,
              })
            },
            signal,
          )
          localFilePath = target
        } else if (lower.endsWith('.zip')) {
          const zipPath = path.join(installDir, 'download.zip')
          await downloadToFileWithProgress(
            resolvedUrl,
            zipPath,
            (received, total, speedBytesPerSec, etaSeconds) => {
              sendInstallProgress({
                phase: 'download',
                received,
                total,
                message: 'download.zip',
                speedBytesPerSec,
                etaSeconds,
              })
            },
            signal,
          )
          localFilePath = zipPath
        } else if (lower.endsWith('.rar') || lower.endsWith('.7z')) {
          const ext = lower.endsWith('.rar') ? '.rar' : '.7z'
          const archivePath = path.join(installDir, `download${ext}`)
          await downloadToFileWithProgress(
            resolvedUrl,
            archivePath,
            (received, total, speedBytesPerSec, etaSeconds) => {
              sendInstallProgress({
                phase: 'download',
                received,
                total,
                message: `download${ext}`,
                speedBytesPerSec,
                etaSeconds,
              })
            },
            signal,
          )
          localFilePath = archivePath
        } else {
          throw new Error(
            'Format non reconnu après résolution du lien. Utilise un .zip, .rar, .7z ou .exe.',
          )
        }
      }

      sendInstallProgress({ phase: 'extract', message: 'Extraction…' })
      const exePath = await processDownloadedFileToExe(localFilePath, installDir, payload.name)

      const game: LibraryGame = {
        ...entry,
        name: payload.name,
        storePageUrl: payload.storePageUrl,
        detailPageUrl: payload.detailPageUrl,
        coverImageUrl: payload.coverImageUrl ?? entry.coverImageUrl,
        downloadUrl: resolvedUrlForLibrary,
        exePath,
        installedAt: new Date().toISOString(),
      }
      const lib = loadLibrary()
      lib.games = lib.games.filter((g) => g.id !== payload.id)
      lib.games.push(game)
      saveLibrary(lib)
      sendLibraryUpdated(lib)
      return game
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Téléchargement annulé')) {
        throw new Error('Téléchargement annulé')
      }
      throw err
    } finally {
      currentInstallCancel = null
      installCancelRequested = false
      sendInstallProgress({ phase: 'done' })
    }
  },
)

ipcMain.handle('game:installCancel', () => {
  const ref = currentInstallCancel
  if (!ref) return
  installCancelRequested = true
  if (ref.megadbWindow && !ref.megadbWindow.isDestroyed()) {
    ref.megadbWindow.close()
  } else if (ref.downloadItem) {
    ref.downloadItem.cancel()
  } else {
    ref.abortController.abort()
  }
})

ipcMain.handle('game:installPause', () => {
  if (currentInstallCancel) {
    currentInstallCancel.isPaused = true
    if (currentInstallCancel.downloadItem) {
      currentInstallCancel.downloadItem.pause()
    }
    return true
  }
  return false
})

ipcMain.handle('game:installResume', () => {
  if (currentInstallCancel) {
    currentInstallCancel.isPaused = false
    if (currentInstallCancel.downloadItem) {
      currentInstallCancel.downloadItem.resume()
    }
    return true
  }
  return false
})

ipcMain.handle('game:launch', async (_e, gameId: string) => {
  const lib = loadLibrary()
  const g = lib.games.find((x) => x.id === gameId)
  if (!g?.exePath || !existsSync(g.exePath)) throw new Error('Jeu introuvable ou non installé')
  if (runningGames.has(gameId)) return true
  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  const updated: LibraryGame = {
    ...g,
    lastPlayedAt: startedIso,
    currentSessionStartedAt: startedIso,
  }
  lib.games = lib.games.filter((x) => x.id !== gameId)
  lib.games.push(updated)
  saveLibrary(lib)
  sendLibraryUpdated(lib)

  const child = spawn(updated.exePath, [], {
    cwd: path.dirname(updated.exePath),
    stdio: 'ignore',
    windowsHide: true,
  })
  runningGames.set(gameId, { child, startedAt })

  const finalize = () => {
    const run = runningGames.get(gameId)
    if (!run) return
    runningGames.delete(gameId)
    const elapsed = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000))
    const lib2 = loadLibrary()
    const g2 = lib2.games.find((x) => x.id === gameId)
    if (!g2) return
    const updated2: LibraryGame = {
      ...g2,
      playTimeSeconds: (g2.playTimeSeconds || 0) + elapsed,
      currentSessionStartedAt: null,
    }
    lib2.games = lib2.games.filter((x) => x.id !== gameId)
    lib2.games.push(updated2)
    saveLibrary(lib2)
    sendLibraryUpdated(lib2)
  }

  child.once('exit', finalize)
  child.once('error', finalize)
  return true
})

ipcMain.handle('game:uninstall', async (_e, gameId: string) => {
  const lib = loadLibrary()
  const game = lib.games.find((g) => g.id === gameId)
  if (game?.installDir && existsSync(game.installDir)) {
    try {
      rmSync(game.installDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  lib.games = lib.games.filter((g) => g.id !== gameId)
  saveLibrary(lib)
  sendLibraryUpdated(lib)
  return true
})

ipcMain.handle('game:uninstallFiles', async (_e, gameId: string) => {
  const lib = loadLibrary()
  const game = lib.games.find((g) => g.id === gameId)
  if (!game) throw new Error('Jeu introuvable')
  if (game.installDir && existsSync(game.installDir)) {
    try {
      rmSync(game.installDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  const updated: LibraryGame = {
    ...game,
    exePath: null,
    installedAt: null,
  }
  lib.games = lib.games.filter((g) => g.id !== gameId)
  lib.games.push(updated)
  saveLibrary(lib)
  sendLibraryUpdated(lib)
  return updated
})

// Settings handlers
ipcMain.handle('settings:get', () => loadSettings())

ipcMain.handle('settings:setGamesFolder', async (_e, folderPath: string | null) => {
  const settings = loadSettings()
  const oldGamesRoot = gamesRoot()
  
  if (folderPath) {
    // Validate the path exists
    if (!existsSync(folderPath)) {
      throw new Error('Le dossier sélectionné n\'existe pas')
    }
    settings.gamesFolderPath = folderPath
  } else {
    settings.gamesFolderPath = null
  }
  
  saveSettings(settings)
  
  // If there are existing games, offer to migrate them
  const newGamesRoot = gamesRoot()
  if (oldGamesRoot !== newGamesRoot && existsSync(oldGamesRoot)) {
    const entries = readdirSync(oldGamesRoot, { withFileTypes: true })
    const gameFolders = entries.filter(e => e.isDirectory())
    
    if (gameFolders.length > 0) {
      // Migrate existing games to new location
      for (const folder of gameFolders) {
        const oldPath = path.join(oldGamesRoot, folder.name)
        const newPath = path.join(newGamesRoot, folder.name)
        try {
          if (!existsSync(newPath)) {
            renameSync(oldPath, newPath)
          }
        } catch {
          // Ignore migration errors
        }
      }
      
      // Update library paths
      const lib = loadLibrary()
      for (const game of lib.games) {
        if (game.installDir.startsWith(oldGamesRoot)) {
          game.installDir = game.installDir.replace(oldGamesRoot, newGamesRoot)
          if (game.exePath && game.exePath.startsWith(oldGamesRoot)) {
            game.exePath = game.exePath.replace(oldGamesRoot, newGamesRoot)
          }
        }
      }
      saveLibrary(lib)
    }
  }
  
  return settings
})

ipcMain.handle('settings:selectGamesFolder', async () => {
  if (!mainWindow) throw new Error('Fenêtre principale non disponible')
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choisir le dossier de stockage des jeux',
    buttonLabel: 'Sélectionner',
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return result.filePaths[0]
})

// Full app uninstall handler
ipcMain.handle('app:uninstall', async () => {
  const lib = loadLibrary()
  
  // Stop all running games
  runningGames.forEach((run, gameId) => {
    try {
      run.child.kill()
    } catch {
      // ignore
    }
  })
  runningGames.clear()
  
  // Delete all game files
  for (const game of lib.games) {
    if (game.installDir && existsSync(game.installDir)) {
      try {
        rmSync(game.installDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
  
  // Get the games root folder
  const gamesFolder = gamesRoot()
  if (existsSync(gamesFolder)) {
    try {
      rmSync(gamesFolder, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  
  // Clear user data (library, settings, store cache)
  const userData = app.getPath('userData')
  const filesToDelete = ['library.json', 'settings.json', 'store-discovery.json']
  for (const file of filesToDelete) {
    const filePath = path.join(userData, file)
    if (existsSync(filePath)) {
      try {
        rmSync(filePath)
      } catch {
        // ignore
      }
    }
  }
  
  return { success: true }
})

async function createWindow() {
  Menu.setApplicationMenu(null)
  const iconPath = process.env.VITE_PUBLIC ? path.join(process.env.VITE_PUBLIC, 'app-icon.png') : ''
  const icon = iconPath && existsSync(iconPath) ? iconPath : undefined
  mainWindow = new BrowserWindow({
    title: 'GameScraper',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b2838',
    icon,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setAutoHideMenuBar(true)

  if (VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(indexHtml)
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  mainWindow = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})
