// ═══════════════════════════════════════════════════════════
// SHORTS CACHE — generic in-memory TTL cache, snapshotted to
// disk so a Render cold-start doesn't come back completely empty.
//
// NOTE ON REDIS: the project spec mentioned Redis as an option for
// this cache layer. This backend does not currently have Redis
// provisioned (no REDIS_URL, no redis/ioredis dependency), so this
// module uses an in-memory Map + periodic JSON snapshot instead —
// it achieves the same goal (stop re-hitting the YouTube API on
// every request) without adding a new paid service. If Redis gets
// provisioned later, only this file needs to change; every caller
// (youtubeShortsProvider.js, routes/shorts.js) just calls
// cache.get/set/has and doesn't know or care how it's stored.
// ═══════════════════════════════════════════════════════════

const fs   = require('fs')
const path = require('path')

const SNAPSHOT_FILE = path.join(__dirname, '../data/shortsCache.json')
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000   // write to disk every 5 min

const store = new Map()   // key -> { value, expiresAt }

// ── Load any previous snapshot on startup (survives cold starts) ──
function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return
    const raw  = fs.readFileSync(SNAPSHOT_FILE, 'utf8')
    const data = JSON.parse(raw)
    const now  = Date.now()
    let restored = 0
    for (const [key, entry] of Object.entries(data)) {
      // Only restore entries that haven't expired yet
      if (entry.expiresAt > now) {
        store.set(key, entry)
        restored++
      }
    }
    console.log(`[ShortsCache] Restored ${restored} cache entries from disk`)
  } catch (e) {
    console.error('[ShortsCache] Failed to load snapshot:', e.message)
  }
}

function saveSnapshot() {
  try {
    const obj = {}
    for (const [key, entry] of store.entries()) {
      // Don't bother persisting already-expired entries
      if (entry.expiresAt > Date.now()) obj[key] = entry
    }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(obj))
  } catch (e) {
    console.error('[ShortsCache] Failed to save snapshot:', e.message)
  }
}

loadSnapshot()
setInterval(saveSnapshot, SNAPSHOT_INTERVAL_MS)

// ── Public cache API ──────────────────────────────────────
function get(key) {
  const entry = store.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }
  return entry.value
}

function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

function has(key) {
  return get(key) !== null
}

function del(key) {
  store.delete(key)
}

const inFlight = new Map()   // key -> Promise, so concurrent callers share one fetch

// Wraps an async fetcher function with cache-aside logic: return the
// cached value if present, otherwise call fetcher(), cache the result,
// and return it. This is the pattern every YouTube-calling function
// in youtubeShortsProvider.js uses so quota-expensive calls never
// happen twice for the same cache key within the TTL window.
//
// Also de-dupes CONCURRENT calls for the same key (a "cache stampede"
// guard): if two requests for the same trending category arrive at
// nearly the same moment — e.g. both users opening the feed together,
// or a user request landing mid-way through the background job's own
// refresh — only ONE actual fetcher() call happens; the second caller
// awaits the same in-flight promise instead of firing its own
// quota-expensive search.list call.
async function cached(key, ttlMs, fetcher) {
  const existing = get(key)
  if (existing !== null) return existing

  if (inFlight.has(key)) return inFlight.get(key)

  const promise = (async () => {
    try {
      const fresh = await fetcher()
      set(key, fresh, ttlMs)
      return fresh
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, promise)
  return promise
}

module.exports = { get, set, has, del, cached, saveSnapshot }
