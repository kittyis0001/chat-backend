// ═══════════════════════════════════════════════════════════
// MUSIC ROUTES
// POST /music/recommend  — Gemini mood → song recommendations
// GET  /music/trending   — Trending music
// GET  /music/search     — Search music
// POST /music/saved      — Save a song
// GET  /music/saved/:userId — Get saved songs
// DELETE /music/saved/:userId/:songId — Remove saved
// ═══════════════════════════════════════════════════════════

const express = require('express')
const fs      = require('fs')
const path    = require('path')
const router  = express.Router()

const { searchMusic, getTrendingMusic, getRecommendations } = require('../utils/musicProvider')
const { analyzeMoodFromCaption, analyzeMoodFromImage }       = require('../utils/musicMood')

const savedFile = path.join(__dirname, '../data/savedMusic.json')

// ── Saved songs helpers ───────────────────────────────────
function getSaved() {
  if (!fs.existsSync(savedFile)) fs.writeFileSync(savedFile, '{}')
  return JSON.parse(fs.readFileSync(savedFile))
}
function writeSaved(data) {
  fs.writeFileSync(savedFile, JSON.stringify(data, null, 2))
}

// ── GET /music/trending ───────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const songs = await getTrendingMusic()
    res.json({ success: true, songs })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── GET /music/search?q=lofi+sad ─────────────────────────
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim()
  if (!query) return res.json({ success: true, songs: [] })
  try {
    const songs = await searchMusic(query, 15)
    res.json({ success: true, songs })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── POST /music/recommend ─────────────────────────────────
// body: { caption, imageUrl, userId }
router.post('/recommend', async (req, res) => {
  const { caption = '', imageUrl = '' } = req.body
  try {
    // Gemini mood analysis
    let mood
    if (imageUrl) {
      mood = await analyzeMoodFromImage(imageUrl, caption)
    } else {
      mood = await analyzeMoodFromCaption(caption)
    }

    // Search songs with keywords
    const songs = await getRecommendations(mood.keywords || [])

    res.json({
      success:  true,
      mood:     mood.mood,
      vibe:     mood.vibe,
      keywords: mood.keywords,
      songs
    })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// ── GET /music/saved/:userId ──────────────────────────────
router.get('/saved/:userId', (req, res) => {
  const data  = getSaved()
  const songs = data[req.params.userId] || []
  res.json({ success: true, songs })
})

// ── POST /music/saved ─────────────────────────────────────
// body: { userId, song: { videoId, jamendoId, title, artist, thumbnail, audioUrl, source } }
router.post('/saved', (req, res) => {
  const { userId, song } = req.body
  if (!userId || !song) {
    return res.status(400).json({ success: false, message: 'Missing userId or song' })
  }
  const data = getSaved()
  if (!data[userId]) data[userId] = []

  // Avoid duplicates
  const id = song.videoId || song.jamendoId
  const exists = data[userId].some(s => (s.videoId || s.jamendoId) === id)
  if (!exists) {
    song.savedAt = Date.now()
    data[userId].unshift(song)            // newest first
    if (data[userId].length > 50) data[userId].pop()  // max 50
  }
  writeSaved(data)
  res.json({ success: true })
})

// ── DELETE /music/saved/:userId/:songId ───────────────────
router.delete('/saved/:userId/:songId', (req, res) => {
  const { userId, songId } = req.params
  const data = getSaved()
  if (data[userId]) {
    data[userId] = data[userId].filter(
      s => (s.videoId || s.jamendoId) !== songId
    )
  }
  writeSaved(data)
  res.json({ success: true })
})

module.exports = router
