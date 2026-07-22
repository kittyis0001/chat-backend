// ═══════════════════════════════════════════════════════════
// SHORTS ROUTES
//
// Content (all served from cache — see youtubeShortsProvider.js):
//   GET  /shorts/trending?category=&region=
//   GET  /shorts/search?q=&pageToken=
//   GET  /shorts/channel/:channelId?pageToken=
//   GET  /shorts/related/:videoId
//   GET  /shorts/recommended/:userId
//
// User data (own backend — never depends on YouTube for storage):
//   GET    /shorts/saved/:userId
//   POST   /shorts/saved
//   DELETE /shorts/saved/:userId/:videoId
//   GET    /shorts/reposts/:userId
//   POST   /shorts/repost
//   GET    /shorts/history/:userId
//   POST   /shorts/history
// ═══════════════════════════════════════════════════════════

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const router  = express.Router()

const {
  getTrendingShorts,
  searchShorts,
  getChannelShorts,
  getRelatedShorts,
  getRecommendedShorts
} = require('../utils/youtubeShortsProvider')

const savedFile    = path.join(__dirname, '../data/shortsSaved.json')
const repostsFile  = path.join(__dirname, '../data/shortsReposts.json')
const historyFile  = path.join(__dirname, '../data/shortsHistory.json')

// ── Generic JSON-file read/write helpers (same pattern as
// routes/music.js's saved-songs storage) ──
function readJson(file, fallback) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback))
  return JSON.parse(fs.readFileSync(file))
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

const getSavedData    = () => readJson(savedFile, {})
const writeSavedData   = (d) => writeJson(savedFile, d)
const getRepostsData  = () => readJson(repostsFile, [])
const writeRepostsData = (d) => writeJson(repostsFile, d)
const getHistoryData  = () => readJson(historyFile, {})
const writeHistoryData = (d) => writeJson(historyFile, d)

function simpleId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ══════════════════════════════════════════════════════════
// CONTENT — all backed by youtubeShortsProvider's cache layer
// ══════════════════════════════════════════════════════════

// ── GET /shorts/trending?category=all&region=US ───────────
router.get('/trending', async (req, res) => {
  const category = req.query.category || 'all'
  const region    = req.query.region   || 'US'
  try {
    const shorts = await getTrendingShorts(category, region)
    res.json({ success: true, shorts })
  } catch (e) {
    console.error('[Shorts] /trending error:', e.message)
    res.status(500).json({ success: false, error: 'Failed to load trending shorts' })
  }
})

// ── GET /shorts/search?q=&pageToken= ───────────────────────
router.get('/search', async (req, res) => {
  const query     = (req.query.q || '').trim()
  const pageToken = req.query.pageToken || ''
  if (!query) return res.json({ success: true, shorts: [] })
  try {
    const shorts = await searchShorts(query, pageToken)
    res.json({ success: true, shorts })
  } catch (e) {
    console.error('[Shorts] /search error:', e.message)
    res.status(500).json({ success: false, error: 'Search failed' })
  }
})

// ── GET /shorts/channel/:channelId?pageToken= ──────────────
router.get('/channel/:channelId', async (req, res) => {
  const pageToken = req.query.pageToken || ''
  try {
    const shorts = await getChannelShorts(req.params.channelId, pageToken)
    res.json({ success: true, shorts })
  } catch (e) {
    console.error('[Shorts] /channel error:', e.message)
    res.status(500).json({ success: false, error: 'Failed to load channel shorts' })
  }
})

// ── GET /shorts/related/:videoId ───────────────────────────
router.get('/related/:videoId', async (req, res) => {
  try {
    const shorts = await getRelatedShorts(req.params.videoId)
    res.json({ success: true, shorts })
  } catch (e) {
    console.error('[Shorts] /related error:', e.message)
    res.status(500).json({ success: false, error: 'Failed to load related shorts' })
  }
})

// ── GET /shorts/recommended/:userId ────────────────────────
// Rule-based, built from the user's own history/saves — NOT a call
// to any YouTube "recommendations" endpoint (none exists publicly).
router.get('/recommended/:userId', async (req, res) => {
  try {
    const history = getHistoryData()[req.params.userId] || []
    const saved   = getSavedData()[req.params.userId] || []

    // Pull tags from the most recent watched + saved videos as the
    // "interest signal" for this lightweight recommender.
    const tagPool = []
    ;[...history.slice(0, 20), ...saved.slice(0, 20)].forEach(entry => {
      if (Array.isArray(entry.tags)) tagPool.push(...entry.tags)
    })
    // Most frequent tags first
    const freq = {}
    tagPool.forEach(t => { freq[t] = (freq[t] || 0) + 1 })
    const topTags = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t)

    const shorts = await getRecommendedShorts(topTags, 'all')
    res.json({ success: true, shorts, basedOnTags: topTags })
  } catch (e) {
    console.error('[Shorts] /recommended error:', e.message)
    res.status(500).json({ success: false, error: 'Failed to load recommendations' })
  }
})

// ══════════════════════════════════════════════════════════
// SAVED SHORTS — own backend, never depends on YouTube playlists
// ══════════════════════════════════════════════════════════

// ── GET /shorts/saved/:userId ──────────────────────────────
router.get('/saved/:userId', (req, res) => {
  const data = getSavedData()
  res.json({ success: true, shorts: data[req.params.userId] || [] })
})

// ── POST /shorts/saved ──────────────────────────────────────
// body: { userId, video: { videoId, title, channelTitle, thumbnail, durationSeconds, tags } }
router.post('/saved', (req, res) => {
  const { userId, video } = req.body
  if (!userId || !video || !video.videoId) {
    return res.status(400).json({ success: false, message: 'Missing userId or video' })
  }
  const data = getSavedData()
  if (!data[userId]) data[userId] = []

  const exists = data[userId].some(v => v.videoId === video.videoId)
  if (!exists) {
    data[userId].unshift({ ...video, savedAt: Date.now() })   // newest first
    if (data[userId].length > 300) data[userId].pop()          // sane cap
  }
  writeSavedData(data)
  res.json({ success: true })
})

// ── DELETE /shorts/saved/:userId/:videoId ──────────────────
router.delete('/saved/:userId/:videoId', (req, res) => {
  const { userId, videoId } = req.params
  const data = getSavedData()
  if (data[userId]) {
    data[userId] = data[userId].filter(v => v.videoId !== videoId)
  }
  writeSavedData(data)
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════════
// REPOSTS — own backend records; original owner always preserved
// ══════════════════════════════════════════════════════════

// ── GET /shorts/reposts/:userId ────────────────────────────
router.get('/reposts/:userId', (req, res) => {
  const all = getRepostsData()
  const mine = all.filter(r => r.userId === req.params.userId)
  res.json({ success: true, reposts: mine })
})

// ── POST /shorts/repost ─────────────────────────────────────
// body: { userId, video: { videoId, title, channelId, channelTitle, thumbnail }, privacy }
router.post('/repost', (req, res) => {
  const { userId, video, privacy } = req.body
  if (!userId || !video || !video.videoId) {
    return res.status(400).json({ success: false, message: 'Missing userId or video' })
  }
  const all = getRepostsData()

  const record = {
    id: simpleId(),
    userId,
    videoId:            video.videoId,
    title:              video.title || '',
    thumbnail:          video.thumbnail || '',
    originalChannelId:    video.channelId || '',
    originalChannelTitle: video.channelTitle || '',
    privacy: privacy || 'public',
    timestamp: Date.now(),
    viewCount: 0,
    repostCount: 0
  }
  all.unshift(record)
  writeRepostsData(all)
  res.json({ success: true, repost: record })
})

// ── POST /shorts/repost/:id/view — increments view count ──
router.post('/repost/:id/view', (req, res) => {
  const all = getRepostsData()
  const record = all.find(r => r.id === req.params.id)
  if (record) {
    record.viewCount = (record.viewCount || 0) + 1
    writeRepostsData(all)
  }
  res.json({ success: true })
})

// ══════════════════════════════════════════════════════════
// WATCH HISTORY — own backend, feeds the recommender above
// ══════════════════════════════════════════════════════════

// ── GET /shorts/history/:userId ────────────────────────────
router.get('/history/:userId', (req, res) => {
  const data = getHistoryData()
  res.json({ success: true, history: data[req.params.userId] || [] })
})

// ── POST /shorts/history ────────────────────────────────────
// body: { userId, videoId, categoryId, tags, watchedSeconds }
router.post('/history', (req, res) => {
  const { userId, videoId, categoryId, tags, watchedSeconds } = req.body
  if (!userId || !videoId) {
    return res.status(400).json({ success: false, message: 'Missing userId or videoId' })
  }
  const data = getHistoryData()
  if (!data[userId]) data[userId] = []

  data[userId].unshift({
    videoId,
    categoryId: categoryId || '',
    tags: Array.isArray(tags) ? tags : [],
    watchedSeconds: watchedSeconds || 0,
    watchedAt: Date.now()
  })
  // Cap history length so the file doesn't grow unbounded
  if (data[userId].length > 500) data[userId] = data[userId].slice(0, 500)

  writeHistoryData(data)
  res.json({ success: true })
})

module.exports = router
