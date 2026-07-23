// ═══════════════════════════════════════════════════════════
// YOUTUBE SHORTS PROVIDER
//
// Every function here is wrapped with shortsCache.cached() so the
// same quota-expensive call is never repeated within its TTL window.
//
// IMPORTANT — API facts this file works around:
//
// 1. search.list's `relatedToVideoId` was deprecated June 2023 and
//    no longer works — getRelatedShorts() reconstructs "related"
//    from the source video's own tags/channel instead.
//
// 2. videos.list's `chart=mostPopular` was narrowed July 2025 to only
//    return Trending Music/Movies/Gaming — getTrendingShorts() uses
//    search.list with a recency + view-count bias instead.
//
// 3. YouTube's Data API has NO hard "exclude this country's content"
//    or "video is in English" filter. `relevanceLanguage` only hints
//    the ranking, it doesn't strictly filter. This file combines
//    relevanceLanguage + regionCode + a title-script heuristic +
//    defaultAudioLanguage check as a best-effort multi-layer filter —
//    this reduces non-English/Indian-region content significantly
//    but cannot guarantee zero false positives, since YouTube simply
//    doesn't expose a field for "this creator/video is Indian."
//
// 4. "Same shorts every login" fix: the trending pool is now built
//    from topic hashtag CLUSTERS (see HASHTAG_CLUSTERS below) merged
//    together, cached as a larger pool, and — critically — SHUFFLED
//    on every serve (not just every cache refresh). Two logins five
//    minutes apart now see a different order/slice of the pool even
//    though the underlying cached data hasn't changed yet, which is
//    what was actually missing before (the old version cached and
//    returned one fixed, deterministically-ordered list).
// ═══════════════════════════════════════════════════════════

const cache = require('./shortsCache')

let fetch = globalThis.fetch
if (!fetch) fetch = require('node-fetch')

// ── API KEY POOL (multi-key rotation for higher effective quota) ──
// Set YOUTUBE_API_KEYS="key1,key2,key3,key4,key5,key6" (comma-separated)
// to use several keys. Falls back to the old single YOUTUBE_API_KEY if
// that's all that's set, so this is backward compatible.
const YT_BASE = 'https://www.googleapis.com/youtube/v3'
const API_KEYS = (process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean)

let keyCursor = 0
const exhaustedUntil = {} // key -> timestamp when it's safe to retry

function markExhausted(key) {
  // YouTube quota resets once daily (midnight Pacific). We don't track
  // timezone precisely here — a flat 24h backoff is simple and safe,
  // it just means a key may sit idle a little past its actual reset.
  exhaustedUntil[key] = Date.now() + 24 * 60 * 60 * 1000
  console.error(`[Shorts] key ...${key.slice(-6)} hit quotaExceeded, backing off 24h`)
}

function getAvailableKey() {
  const now = Date.now()
  for (let i = 0; i < API_KEYS.length; i++) {
    const idx = (keyCursor + i) % API_KEYS.length
    const key = API_KEYS[idx]
    if (!exhaustedUntil[key] || exhaustedUntil[key] <= now) {
      keyCursor = (idx + 1) % API_KEYS.length // round-robin starting point for next call
      return key
    }
  }
  return null // every key is currently exhausted
}

// Quota-aware fetch: tries an available key, and if THAT specific call
// comes back quotaExceeded, marks the key exhausted and retries with the
// next available key — up to once per configured key.
async function ytFetch(path, params) {
  if (!API_KEYS.length) return { items: [], error: { message: 'No YouTube API keys configured' } }

  const triedKeys = new Set()
  let lastError = null

  while (triedKeys.size < API_KEYS.length) {
    const key = getAvailableKey()
    if (!key || triedKeys.has(key)) break
    triedKeys.add(key)

    try {
      const qs = new URLSearchParams({ ...params, key })
      const res  = await fetch(`${YT_BASE}/${path}?${qs.toString()}`)
      const data = await res.json()

      const reason = data?.error?.errors?.[0]?.reason
      if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
        markExhausted(key)
        lastError = data.error
        continue // rotate to next key
      }
      return data
    } catch (e) {
      lastError = { message: e.message }
      continue
    }
  }

  console.error('[Shorts] all API keys exhausted or failing:', lastError?.message)
  return { items: [], error: lastError }
}

// A Short is currently defined by YouTube as up to 3 minutes long
// (raised from the original 60s limit, October 2024 policy update).
const MAX_SHORT_DURATION_SECONDS = 180

const TTL = {
  TRENDING: 3 * 60 * 60 * 1000,   // 3 hours — per-tag querying (below) costs more quota per refresh than the old combined-query approach, so refresh less often. Variety still comes from shuffle-on-serve.
  SEARCH:   20 * 60 * 1000,
  CHANNEL:  60 * 60 * 1000,
  RELATED:  6  * 60 * 60 * 1000,
  VIDEO_META: 6 * 60 * 60 * 1000
}

function isConfigured() {
  return API_KEYS.length > 0
}

// ── ISO 8601 duration ("PT1M30S") → seconds ───────────────
function parseIsoDuration(iso) {
  if (!iso) return 0
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  const h = parseInt(m[1] || '0', 10)
  const min = parseInt(m[2] || '0', 10)
  const s = parseInt(m[3] || '0', 10)
  return h * 3600 + min * 60 + s
}

// ── Best-effort "is this likely English / non-Indian" check ──
// See file header note #3 — this is a heuristic layer, not a
// guarantee, because YouTube's API doesn't expose a hard filter.
const INDIC_SCRIPT_RANGES = [
  [0x0900, 0x097F], // Devanagari (Hindi, Marathi, etc.)
  [0x0980, 0x09FF], // Bengali
  [0x0A00, 0x0A7F], // Gurmukhi (Punjabi)
  [0x0A80, 0x0AFF], // Gujarati
  [0x0B00, 0x0B7F], // Oriya
  [0x0B80, 0x0BFF], // Tamil
  [0x0C00, 0x0C7F], // Telugu
  [0x0C80, 0x0CFF], // Kannada
  [0x0D00, 0x0D7F]  // Malayalam
]
function containsIndicScript(text) {
  if (!text) return false
  for (const ch of text) {
    const code = ch.codePointAt(0)
    for (const [start, end] of INDIC_SCRIPT_RANGES) {
      if (code >= start && code <= end) return true
    }
  }
  return false
}

// Romanized Hindi/Hinglish check — catches AI-generated videos with
// Hindi content typed in LATIN letters (e.g. "samose ke andar aalu
// kaise"), which the script-range check above can't see since there's
// no Devanagari, and which often ship with defaultAudioLanguage unset
// so the language-code check also misses them. This is a curated list
// of Hindi/Hinglish words that are very unlikely to appear in genuine
// English titles by coincidence — one hit is enough to flag it.
const HINGLISH_WORDS = [
  'kaise','bhaiya','bhai','didi','wala','wali','andar','bahar','gaye','gaya','gayi',
  'accha','theek','nahi','nahin','hai','hain','tha','thi','the','kya','kyun','kaha',
  'kahani','zindagi','pyaar','pyar','dost','ghar','sasta','sabse','chahiye','milega',
  'hoga','karo','karna','dekho','dekhiye','suniye','mera','meri','tera','teri',
  'humara','tumhara','uska','uski','apna','apni','yaar','shaadi','biwi','pati',
  'sasural','maayka','beta','beti','maa','papa','amma','abba'
]
const HINGLISH_REGEX = new RegExp('\\b(' + HINGLISH_WORDS.join('|') + ')\\b', 'i')
function looksHinglish(text) {
  if (!text) return false
  return HINGLISH_REGEX.test(text)
}

function looksEnglish(video) {
  const title = video.title || ''
  const description = video.description || ''
  if (containsIndicScript(title) || containsIndicScript(description)) return false
  if (looksHinglish(title)) return false
  const lang = (video.defaultAudioLanguage || video.defaultLanguage || '').toLowerCase()
  if (lang && !lang.startsWith('en')) return false
  return true
}

function mapVideoResource(item) {
  const duration = parseIsoDuration(item.contentDetails?.duration)
  return {
    videoId:      item.id,
    title:        item.snippet?.title || '',
    description:  item.snippet?.description || '',
    channelId:    item.snippet?.channelId || '',
    channelTitle: item.snippet?.channelTitle || '',
    thumbnail:    item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
    publishedAt:  item.snippet?.publishedAt || '',
    tags:         item.snippet?.tags || [],
    categoryId:   item.snippet?.categoryId || '',
    defaultAudioLanguage: item.snippet?.defaultAudioLanguage || '',
    defaultLanguage:      item.snippet?.defaultLanguage || '',
    durationSeconds: duration,
    viewCount:    parseInt(item.statistics?.viewCount || '0', 10),
    likeCount:    parseInt(item.statistics?.likeCount || '0', 10)
  }
}

async function fetchVideoDetails(videoIds) {
  if (!videoIds.length || !isConfigured()) return []
  const key = 'videometa:' + videoIds.slice().sort().join(',')
  return cache.cached(key, TTL.VIDEO_META, async () => {
    try {
      const data = await ytFetch('videos', {
        part: 'snippet,contentDetails,statistics',
        id: videoIds.join(',')
      })
      if (!data.items) return []
      return data.items.map(mapVideoResource)
    } catch (e) {
      console.error('[Shorts] fetchVideoDetails error:', e.message)
      return []
    }
  })
}

async function searchAndFilterToShorts(params, limit = 20) {
  if (!isConfigured()) return []
  try {
    const data = await ytFetch('search', {
      part: 'snippet',
      type: 'video',
      maxResults: String(Math.min(limit * 3, 50)),  // over-fetch — duration + language filtering both remove items
      relevanceLanguage: 'en',
      ...params
    })
    if (!data.items || !data.items.length) return []

    const ids = data.items.map(it => it.id?.videoId).filter(Boolean)
    if (!ids.length) return []

    const details = await fetchVideoDetails(ids)
    return details
      .filter(v => v.durationSeconds > 0 && v.durationSeconds <= MAX_SHORT_DURATION_SECONDS)
      .filter(looksEnglish)
      .slice(0, limit)
  } catch (e) {
    console.error('[Shorts] searchAndFilterToShorts error:', e.message)
    return []
  }
}

// ── Fisher-Yates shuffle — used to give repeat visits variety even
// when serving from the same cached pool (see file header note #4). ──
function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── HASHTAG CLUSTERS ───────────────────────────────────────
// Built from the exact hashtag list provided, deduped and grouped
// into thematically-related sets. Each cluster becomes ONE search
// query (a few representative tags combined), not one query per tag
// — 70+ individual tag searches would cost 70×100=7000+ quota units
// per refresh cycle, which isn't sustainable. Grouping into ~6
// clusters keeps this to a handful of search.list calls per cycle
// while still covering the full requested topic range over time
// (see shortsBackgroundJobs.js's rotation).
const HASHTAG_CLUSTERS = {
  romance_books: {
    label: 'Romance & Books',
    query: 'booktok spicy darkromance love shorts',
    tags: ['spicy','darkromance','books','booktok','love','delulu','deluluisthesolulu']
  },
  anime_manga: {
    label: 'Anime & Manga',
    query: 'anime manga manhwa webtoon shorts',
    tags: ['anime','manga','animelove','loveanddeepspace','manhwa','webtoon','comic','cartoon','berserk',
           'animeedit','sylus','ksmalicsi','i_am_your_guardian_angel','웹툰','whenthesilentbirdsings']
  },
  cats: {
    label: 'Cats',
    query: 'cat kitten cute funny shorts',
    tags: ['cat','cats','kitten','kittens','meow','kitty','catlover','catlovers','catlife','catstory','cutestory',
           'catsofyoutube','cutecat','cutekitten','funnycats','funnycatvideos','catvideos','catvideo','fluffycat',
           'adorablecats','catcontent','catfunnyvideos']
  },
  ai_content: {
    label: 'AI Shorts',
    query: 'ai generated aivideo aishorts shorts',
    tags: ['aivideo','ai','aishorts','aistory']
  },
  kpop: {
    label: 'K-pop',
    query: 'kpop bts rumi shorts',
    tags: ['rumi','rumistory','rumishorts','kpop','kpopedit','kpopfunny','bts','sehar']
  },
  general_viral: {
    label: 'Trending',
    query: 'viral trending fyp relatable funny shorts',
    tags: ['aesthetic','funny','trending','viral','fyp','relatable','memes','meme','art','digitalart','pov',
           'shortsfeed','funnyvideo','story','oc']
  }
}
const CLUSTER_KEYS = Object.keys(HASHTAG_CLUSTERS)

// ── TRENDING ───────────────────────────────────────────────
// Builds a pool from one or more hashtag clusters, caches the pool,
// and returns a SHUFFLED slice on every call — see file header #4
// for why this matters (fixes "same shorts every login").
//
// With a 10-key pool (~1,000,000 daily units) there's enough quota
// to search EVERY individual tag in a cluster separately, in parallel,
// instead of folding them into one representative query string — this
// gives noticeably better per-topic coverage. Cost per full refresh:
// (~70 tags total) × 100 units ≈ 7,000 units, run once per TTL.TRENDING
// window (3h) ≈ 8×/day ≈ 56,000 units/day, leaving headroom for
// search/channel/related/recommended calls elsewhere.
async function getTrendingShorts(clusterKey = 'all', regionCode = 'US', excludeVideoIds = []) {
  const clusters = clusterKey === 'all' ? CLUSTER_KEYS : [clusterKey].filter(k => HASHTAG_CLUSTERS[k])
  const cacheKey = `trendingpool:${clusters.join(',')}:${regionCode}`

  const pool = await cache.cached(cacheKey, TTL.TRENDING, async () => {
    const publishedAfter = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()  // last 10 days

    // Build one search task per (cluster, tag) pair, then run them
    // in parallel so a full refresh doesn't serialize 70+ round-trips.
    const tasks = []
    for (const key of clusters) {
      const cluster = HASHTAG_CLUSTERS[key]
      for (const tag of cluster.tags) {
        tasks.push(
          searchAndFilterToShorts({
            q: `${tag} shorts`,
            order: 'viewCount',
            regionCode,
            publishedAfter,
            videoDuration: 'short'
          }, 5).then(results => {
            results.forEach(v => { v.cluster = key; v.matchedTag = tag })
            return results
          })
        )
      }
    }

    const settled = await Promise.allSettled(tasks)
    let combined = []
    for (const r of settled) {
      if (r.status === 'fulfilled') combined.push(...r.value)
    }

    // De-dupe across tags/clusters (a video could match more than one)
    const seen = new Set()
    combined = combined.filter(v => {
      if (seen.has(v.videoId)) return false
      seen.add(v.videoId)
      return true
    })
    return combined
  })

  const excludeSet = new Set(excludeVideoIds)
  const filtered = pool.filter(v => !excludeSet.has(v.videoId))
  return shuffle(filtered.length >= 10 ? filtered : pool).slice(0, 25)
}

// ── SEARCH ─────────────────────────────────────────────────
async function searchShorts(query, pageToken = '') {
  if (!query || !query.trim()) return []
  const cacheKey = `search:${query.toLowerCase()}:${pageToken}`
  return cache.cached(cacheKey, TTL.SEARCH, async () => {
    return searchAndFilterToShorts({
      q: `${query} shorts`,
      order: 'relevance',
      videoDuration: 'short',
      ...(pageToken ? { pageToken } : {})
    }, 20)
  })
}

// ── CHANNEL SHORTS ─────────────────────────────────────────
async function getChannelShorts(channelId, pageToken = '') {
  if (!channelId) return []
  const cacheKey = `channel:${channelId}:${pageToken}`
  return cache.cached(cacheKey, TTL.CHANNEL, async () => {
    return searchAndFilterToShorts({
      channelId,
      order: 'date',
      videoDuration: 'short',
      ...(pageToken ? { pageToken } : {})
    }, 20)
  })
}

// ── RELATED SHORTS (relatedToVideoId replacement) ──────────
async function getRelatedShorts(videoId) {
  if (!videoId) return []
  const cacheKey = `related:${videoId}`
  return cache.cached(cacheKey, TTL.RELATED, async () => {
    const [source] = await fetchVideoDetails([videoId])
    if (!source) return []

    let results = await getChannelShorts(source.channelId)
    results = results.filter(v => v.videoId !== videoId)

    if (results.length < 10 && source.tags.length) {
      const tagQuery = source.tags.slice(0, 3).join(' ')
      const tagResults = await searchAndFilterToShorts({
        q: `${tagQuery} shorts`,
        order: 'relevance',
        videoDuration: 'short'
      }, 20)
      const existingIds = new Set(results.map(v => v.videoId))
      for (const v of tagResults) {
        if (v.videoId !== videoId && !existingIds.has(v.videoId)) {
          results.push(v)
          existingIds.add(v.videoId)
        }
      }
    }

    return results.slice(0, 20)
  })
}

// ── RECOMMENDED SHORTS ─────────────────────────────────────
async function getRecommendedShorts(interestTags = [], fallbackCluster = 'all') {
  const cacheKey = `recommended:${interestTags.slice().sort().join(',')}:${fallbackCluster}`
  return cache.cached(cacheKey, TTL.SEARCH, async () => {
    let results = []

    if (interestTags.length) {
      const tagQuery = interestTags.slice(0, 4).join(' ')
      results = await searchAndFilterToShorts({
        q: `${tagQuery} shorts`,
        order: 'relevance',
        videoDuration: 'short'
      }, 15)
    }

    if (results.length < 10) {
      const trending = await getTrendingShorts(fallbackCluster)
      const existingIds = new Set(results.map(v => v.videoId))
      for (const v of trending) {
        if (!existingIds.has(v.videoId)) {
          results.push(v)
          existingIds.add(v.videoId)
        }
      }
    }

    return shuffle(results).slice(0, 20)
  })
}

module.exports = {
  isConfigured,
  MAX_SHORT_DURATION_SECONDS,
  parseIsoDuration,
  fetchVideoDetails,
  getTrendingShorts,
  searchShorts,
  getChannelShorts,
  getRelatedShorts,
  getRecommendedShorts,
  HASHTAG_CLUSTERS,
  CLUSTER_KEYS
                                }
         
