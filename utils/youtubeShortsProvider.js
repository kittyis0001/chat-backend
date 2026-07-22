// ═══════════════════════════════════════════════════════════
// YOUTUBE SHORTS PROVIDER
//
// Every function here is wrapped with shortsCache.cached() so the
// same quota-expensive call is never repeated within its TTL window.
//
// IMPORTANT — two YouTube API facts this file works around:
//
// 1. search.list's `relatedToVideoId` parameter was deprecated by
//    YouTube in June 2023 and no longer works. There is no direct
//    "give me related videos" endpoint anymore. getRelatedShorts()
//    below reconstructs "related" by pulling the source video's own
//    tags/category/channel (1 cheap videos.list call) and using
//    those as search terms — the closest working equivalent.
//
// 2. videos.list's `chart=mostPopular` was narrowed by YouTube in
//    July 2025 to only return Trending Music / Movies / Gaming — it
//    no longer reflects general trending content. getTrendingShorts()
//    below does NOT rely on that chart; it uses search.list with a
//    recency + view-count bias instead, which is more quota-expensive
//    (100 units vs 1) but is the only way to get genuinely general
//    trending Shorts today. This is exactly why the background-job
//    caching layer (shortsBackgroundJobs.js) matters so much — this
//    expensive call should only run a few times per hour, server-side,
//    never once per user request.
// ═══════════════════════════════════════════════════════════

const cache = require('./shortsCache')

let fetch = globalThis.fetch
if (!fetch) fetch = require('node-fetch')

const YT_API_KEY = process.env.YOUTUBE_API_KEY
const YT_BASE     = 'https://www.googleapis.com/youtube/v3'

// A Short is currently defined by YouTube as up to 3 minutes long
// (raised from the original 60s limit in an October 2024 policy
// update). Kept as a single constant so it's a one-line change if
// YouTube's definition shifts again.
const MAX_SHORT_DURATION_SECONDS = 180

// ── TTLs — tuned so the background job (every 45-60 min) is the
// main quota consumer, not individual user requests. ──
const TTL = {
  TRENDING: 60 * 60 * 1000,       // 1 hour — refreshed by background job anyway
  SEARCH:   20 * 60 * 1000,       // 20 min — repeated identical searches are free within this window
  CHANNEL:  60 * 60 * 1000,       // 1 hour — channel uploads don't change minute to minute
  RELATED:  6  * 60 * 60 * 1000,  // 6 hours — relatedness doesn't need to be fresh
  VIDEO_META: 6 * 60 * 60 * 1000  // 6 hours — per-video duration/snippet lookups
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
    durationSeconds: duration,
    viewCount:    parseInt(item.statistics?.viewCount || '0', 10),
    likeCount:    parseInt(item.statistics?.likeCount || '0', 10)
  }
}

// ── Batch videos.list lookup (cheap — 1 unit per call regardless of
// how many of the up-to-50 IDs are requested) — used both to filter
// search results down to actual Shorts-length videos, and to fetch
// a single video's metadata for the "related" feature. ──
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

// ── Runs a search.list query, then hard-filters the results down to
// actual Shorts-length videos via one batched videos.list call. ──
async function searchAndFilterToShorts(params, limit = 20) {
  if (!isConfigured()) return []
  try {
    const qs = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      maxResults: String(Math.min(limit * 2, 50)),  // over-fetch since some will be filtered out by duration
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
      .slice(0, limit)
  } catch (e) {
    console.error('[Shorts] searchAndFilterToShorts error:', e.message)
    return []
  }
}

// ── TRENDING ───────────────────────────────────────────────
// No working "official trending" endpoint for general Shorts (see
// file header) — approximated via recent + high-view-count search.
const TRENDING_QUERY_BY_CATEGORY = {
  all:     '#shorts',
  comedy:  '#shorts comedy funny',
  music:   '#shorts music',
  gaming:  '#shorts gaming',
  sports:  '#shorts sports',
  cooking: '#shorts recipe cooking',
  dance:   '#shorts dance'
}

async function getTrendingShorts(category = 'all', regionCode = 'US') {
  const cacheKey = `trending:${category}:${regionCode}`
  return cache.cached(cacheKey, TTL.TRENDING, async () => {
    const q = TRENDING_QUERY_BY_CATEGORY[category] || TRENDING_QUERY_BY_CATEGORY.all
    const publishedAfter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()  // last 7 days
    return searchAndFilterToShorts({
      q,
      order: 'viewCount',
      regionCode,
      publishedAfter,
      videoDuration: 'short'   // YouTube's own <4min filter, cheap first pass before our own stricter check
    }, 20)
  })
}

// ── SEARCH ─────────────────────────────────────────────────
async function searchShorts(query, pageToken = '') {
  if (!query || !query.trim()) return []
  const cacheKey = `search:${query.toLowerCase()}:${pageToken}`
  return cache.cached(cacheKey, TTL.SEARCH, async () => {
    return searchAndFilterToShorts({
      q: `${query} #shorts`,
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

// ── RELATED SHORTS (relatedToVideoId replacement — see header) ──
async function getRelatedShorts(videoId) {
  if (!videoId) return []
  const cacheKey = `related:${videoId}`
  return cache.cached(cacheKey, TTL.RELATED, async () => {
    const [source] = await fetchVideoDetails([videoId])
    if (!source) return []

    // Pull from the same channel first (cheapest, most reliably
    // "related" in spirit), then top up with a tag-based search if
    // that channel doesn't have enough other Shorts.
    let results = await getChannelShorts(source.channelId)
    results = results.filter(v => v.videoId !== videoId)

    if (results.length < 10 && source.tags.length) {
      const tagQuery = source.tags.slice(0, 3).join(' ')
      const tagResults = await searchAndFilterToShorts({
        q: `${tagQuery} #shorts`,
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
// No official YouTube "recommendations" endpoint is exposed by the
// Data API — this is a lightweight, rule-based blend built from the
// user's own signals (not machine-learned), combining:
//   - tags/categories from their recent watch history + likes/saves
//   - the shared trending pool as a fallback/filler
async function getRecommendedShorts(interestTags = [], fallbackCategory = 'all') {
  const cacheKey = `recommended:${interestTags.slice().sort().join(',')}:${fallbackCategory}`
  return cache.cached(cacheKey, TTL.SEARCH, async () => {
    let results = []

    if (interestTags.length) {
      const tagQuery = interestTags.slice(0, 4).join(' ')
      results = await searchAndFilterToShorts({
        q: `${tagQuery} #shorts`,
        order: 'relevance',
        videoDuration: 'short'
      }, 15)
    }

    if (results.length < 10) {
      const trending = await getTrendingShorts(fallbackCategory)
      const existingIds = new Set(results.map(v => v.videoId))
      for (const v of trending) {
        if (!existingIds.has(v.videoId)) {
          results.push(v)
          existingIds.add(v.videoId)
        }
      }
    }

    return results.slice(0, 20)
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
  TRENDING_QUERY_BY_CATEGORY
}
