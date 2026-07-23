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

const YT_API_KEY = process.env.YOUTUBE_API_KEY
const YT_BASE     = 'https://www.googleapis.com/youtube/v3'

// A Short is currently defined by YouTube as up to 3 minutes long
// (raised from the original 60s limit, October 2024 policy update).
const MAX_SHORT_DURATION_SECONDS = 180

const TTL = {
  TRENDING: 60 * 60 * 1000,       // 1 hour — pool refresh; variety comes from shuffle-on-serve, not this
  SEARCH:   20 * 60 * 1000,
  CHANNEL:  60 * 60 * 1000,
  RELATED:  6  * 60 * 60 * 1000,
  VIDEO_META: 6 * 60 * 60 * 1000
}

function isConfigured() {
  return !!YT_API_KEY
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
function looksEnglish(video) {
  const title = video.title || ''
  if (containsIndicScript(title)) return false
  const lang = (video.defaultAudioLanguage || video.defaultLanguage || '').toLowerCase()
  if (lang && !lang.startsWith('en')) return false
  return true
}

function mapVideoResource(item) {
  const duration = parseIsoDuration(item.contentDetails?.duration)
  return {
    videoId:      item.id,
    title:        item.snippet?.title || '',
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
      const url = `${YT_BASE}/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(',')}&key=${YT_API_KEY}`
      const res  = await fetch(url)
      const data = await res.json()
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
    const qs = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      maxResults: String(Math.min(limit * 3, 50)),  // over-fetch — duration + language filtering both remove items
      relevanceLanguage: 'en',
      key: YT_API_KEY,
      ...params
    })
    const res  = await fetch(`${YT_BASE}/search?${qs.toString()}`)
    const data = await res.json()
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
async function getTrendingShorts(clusterKey = 'all', regionCode = 'US', excludeVideoIds = []) {
  const clusters = clusterKey === 'all' ? CLUSTER_KEYS : [clusterKey].filter(k => HASHTAG_CLUSTERS[k])
  const cacheKey = `trendingpool:${clusters.join(',')}:${regionCode}`

  const pool = await cache.cached(cacheKey, TTL.TRENDING, async () => {
    const publishedAfter = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()  // last 10 days
    let combined = []
    for (const key of clusters) {
      const cluster = HASHTAG_CLUSTERS[key]
      const results = await searchAndFilterToShorts({
        q: cluster.query,
        order: 'viewCount',
        regionCode,
        publishedAfter,
        videoDuration: 'short'
      }, 15)
      results.forEach(v => { v.cluster = key })
      combined.push(...results)
    }
    // De-dupe across clusters (a video could match more than one)
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
  
