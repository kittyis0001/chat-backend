// ═══════════════════════════════════════════════════════════
// MUSIC MOOD — Gemini AI mood/vibe analysis
// ═══════════════════════════════════════════════════════════

let fetch = globalThis.fetch
if (!fetch) fetch = require('node-fetch')

const GEMINI_KEY = process.env.GEMINI_API_KEY

// ── Fallback moods when Gemini fails ─────────────────────
const FALLBACK_MOODS = [
  { mood: 'chill', vibe: 'lofi', keywords: ['lofi', 'chill', 'relaxing', 'aesthetic'] },
  { mood: 'happy', vibe: 'upbeat', keywords: ['happy', 'upbeat', 'feel good', 'pop'] },
  { mood: 'romantic', vibe: 'soft', keywords: ['romantic', 'love', 'soft', 'acoustic'] },
  { mood: 'sad', vibe: 'emotional', keywords: ['sad', 'emotional', 'heartbreak', 'slow'] },
  { mood: 'energetic', vibe: 'hype', keywords: ['energetic', 'hype', 'party', 'dance'] }
]

// ── Analyze caption text with Gemini ─────────────────────
async function analyzeMoodFromCaption(caption = '') {
  if (!GEMINI_KEY || !caption.trim()) {
    return FALLBACK_MOODS[Math.floor(Math.random() * FALLBACK_MOODS.length)]
  }

  const prompt = `You are a music mood analyzer.

Analyze this story caption and return ONLY a JSON object with no markdown.

Caption: "${caption}"

Return exactly:
{
  "mood": "one word mood",
  "vibe": "2-3 word vibe description",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"]
}

Examples:
- "miss you tonight" → {"mood":"sad","vibe":"night emotional","keywords":["sad","romantic","lofi","night"]}
- "beach day 🌊" → {"mood":"happy","vibe":"summer upbeat","keywords":["happy","summer","beach","chill"]}
- "studying hard" → {"mood":"focused","vibe":"study lofi","keywords":["lofi","study","focus","calm"]}

Only return the JSON. No explanation.`

  try {
    const res  = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 200 }
        })
      }
    )
    const data = await res.json()
    const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''

    // JSON parse — remove markdown fences if any
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed  = JSON.parse(cleaned)

    if (parsed.mood && parsed.keywords && Array.isArray(parsed.keywords)) {
      return parsed
    }
    throw new Error('Invalid response structure')

  } catch (e) {
    console.error('[MusicMood] Gemini error:', e.message)
    return FALLBACK_MOODS[Math.floor(Math.random() * FALLBACK_MOODS.length)]
  }
}

// ── Analyze image URL with Gemini Vision ─────────────────
async function analyzeMoodFromImage(imageUrl = '', caption = '') {
  if (!GEMINI_KEY || !imageUrl) {
    return analyzeMoodFromCaption(caption)
  }

  const prompt = `You are a music mood analyzer.

Look at this story image${caption ? ` with caption: "${caption}"` : ''}.

Analyze the visual mood, colors, subject, and emotion.

Return ONLY a JSON object:
{
  "mood": "one word",
  "vibe": "2-3 word vibe",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4"]
}

Only return JSON. No markdown. No explanation.`

  try {
    // fetch image as base64
    const imgRes  = await fetch(imageUrl)
    const imgBuf  = await imgRes.arrayBuffer()
    const b64     = Buffer.from(imgBuf).toString('base64')
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: b64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 200 }
        })
      }
    )
    const data    = await res.json()
    const raw     = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleaned = raw.replace(/```json|```/g, '').trim()
    const parsed  = JSON.parse(cleaned)

    if (parsed.mood && parsed.keywords) return parsed
    throw new Error('Invalid')

  } catch (e) {
    console.error('[MusicMood] Gemini vision error:', e.message)
    // fallback to caption analysis
    return analyzeMoodFromCaption(caption)
  }
}

module.exports = { analyzeMoodFromCaption, analyzeMoodFromImage }
