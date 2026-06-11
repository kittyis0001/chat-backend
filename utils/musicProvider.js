// ═══════════════════════════════════════════════════════════
// MUSIC PROVIDER — YouTube Data API v3 + Jamendo Fallback
// ═══════════════════════════════════════════════════════════

let fetch = globalThis.fetch
if (!fetch) fetch = require('node-fetch')

const YT_API_KEY  = process.env.YOUTUBE_API_KEY
const JM_CLIENT   = process.env.JAMENDO_CLIENT_ID

// ── YouTube Search ───────────────────────────────────────
async function searchYouTube(query, maxResults = 10) {
  if (!YT_API_KEY) return []
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&q=${encodeURIComponent(query)}&maxResults=${maxResults}&key=${YT_API_KEY}`
    const res  = await fetch(url)
    const data = await res.json()
    if (!data.items) return []
    return data.items.map(item => ({
      videoId:   item.id.videoId,
      title:     item.snippet.title,
      artist:    item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      source:    'youtube'
    }))
  } catch (e) {
    console.error('[Music] YouTube search error:', e.message)
    return []
  }
}

// ── YouTube Trending Music ────────────────────────────────
async function getTrendingYouTube(regionCode = 'BD', maxResults = 20) {
  if (!YT_API_KEY) return []
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&regionCode=${regionCode}&maxResults=${maxResults}&key=${YT_API_KEY}`
    const res  = await fetch(url)
    const data = await res.json()
    if (!data.items) return []
    return data.items.map(item => ({
      videoId:   item.id,
      title:     item.snippet.title,
      artist:    item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || '',
      source:    'youtube'
    }))
  } catch (e) {
    console.error('[Music] YouTube trending error:', e.message)
    return []
  }
}

// ── Jamendo Search (Fallback) ─────────────────────────────
async function searchJamendo(query, limit = 10) {
  if (!JM_CLIENT) return []
  try {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${JM_CLIENT}&format=json&limit=${limit}&search=${encodeURIComponent(query)}&include=musicinfo&imagesize=300`
    const res  = await fetch(url)
    const data = await res.json()
    if (!data.results) return []
    return data.results.map(track => ({
      videoId:   null,
      jamendoId: track.id,
      title:     track.name,
      artist:    track.artist_name,
      thumbnail: track.image || '',
      audioUrl:  track.audio,      // direct MP3 — Jamendo allows this
      source:    'jamendo'
    }))
  } catch (e) {
    console.error('[Music] Jamendo search error:', e.message)
    return []
  }
}

// ── Jamendo Trending ──────────────────────────────────────
async function getTrendingJamendo(limit = 20) {
  if (!JM_CLIENT) return []
  try {
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${JM_CLIENT}&format=json&limit=${limit}&order=popularity_total&include=musicinfo&imagesize=300`
    const res  = await fetch(url)
    const data = await res.json()
    if (!data.results) return []
    return data.results.map(track => ({
      videoId:   null,
      jamendoId: track.id,
      title:     track.name,
      artist:    track.artist_name,
      thumbnail: track.image || '',
      audioUrl:  track.audio,
      source:    'jamendo'
    }))
  } catch (e) {
    console.error('[Music] Jamendo trending error:', e.message)
    return []
  }
}

// ── Hybrid Search — YouTube first, Jamendo fallback ───────
async function searchMusic(query, maxResults = 12) {
  let results = await searchYouTube(query, maxResults)
  if (results.length < 3) {
    const jm = await searchJamendo(query, maxResults - results.length)
    results = [...results, ...jm]
  }
  return results
}

// ── Hybrid Trending ───────────────────────────────────────
async function getTrendingMusic() {
  let results = await getTrendingYouTube('BD', 15)
  if (results.length < 5) {
    const jm = await getTrendingJamendo(15)
    results = [...results, ...jm]
  }
  return results
}

// ── Recommendations by keywords ───────────────────────────
async function getRecommendations(keywords = []) {
  const query = keywords.slice(0, 4).join(' ') + ' music'
  return searchMusic(query, 10)
}

module.exports = {
  searchMusic,
  getTrendingMusic,
  getRecommendations,
  searchYouTube,
  searchJamendo,
  getTrendingJamendo
}
