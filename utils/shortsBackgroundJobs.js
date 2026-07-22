// ═══════════════════════════════════════════════════════════
// SHORTS BACKGROUND JOBS
//
// Pre-warms the trending-shorts cache on a timer so real user
// requests always hit shortsCache (near-instant, zero quota cost)
// instead of triggering a fresh, quota-expensive search.list call.
//
// Kept to a SMALL category list on purpose — every category refresh
// costs ~100 quota units (one search.list call). With the default
// 45-minute interval and 4 categories below, that's:
//   4 categories × (60/45) refreshes/hour × 24 hours × 100 units
//   ≈ 12,800 units/day
// which is already over the default 10,000/day quota on its own.
// ADJUST_CATEGORIES and REFRESH_INTERVAL_MS below are the two knobs
// to tune this — fewer categories and/or a longer interval trade
// freshness for quota headroom. Shipped conservatively (2 categories,
// 60 min) so it fits comfortably under quota alongside real user
// search/related/channel calls; widen it once you've watched actual
// quota usage in the Google Cloud Console.
// ═══════════════════════════════════════════════════════════

const { getTrendingShorts, isConfigured } = require('./youtubeShortsProvider')

const REFRESH_INTERVAL_MS = 60 * 60 * 1000   // 60 min — safe default, see cost note above
const ACTIVE_CATEGORIES   = ['all', 'comedy'] // start small; add more once quota headroom is confirmed

let jobHandle = null

async function refreshOnce() {
  if (!isConfigured()) {
    console.warn('[ShortsJobs] YOUTUBE_API_KEY not set — skipping background refresh')
    return
  }
  for (const category of ACTIVE_CATEGORIES) {
    try {
      const results = await getTrendingShorts(category)
      console.log(`[ShortsJobs] Refreshed trending:${category} — ${results.length} shorts cached`)
    } catch (e) {
      console.error(`[ShortsJobs] Failed to refresh trending:${category}:`, e.message)
    }
  }
}

function startShortsBackgroundJobs() {
  if (jobHandle) return   // already running — don't double-schedule
  // Run once immediately so the cache isn't empty for the very first
  // users after a deploy/cold-start, then repeat on the interval.
  refreshOnce()
  jobHandle = setInterval(refreshOnce, REFRESH_INTERVAL_MS)
  console.log(`[ShortsJobs] Background refresh started — every ${REFRESH_INTERVAL_MS / 60000} min, categories: ${ACTIVE_CATEGORIES.join(', ')}`)
}

function stopShortsBackgroundJobs() {
  if (jobHandle) {
    clearInterval(jobHandle)
    jobHandle = null
  }
}

module.exports = { startShortsBackgroundJobs, stopShortsBackgroundJobs }
