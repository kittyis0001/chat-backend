// ═══════════════════════════════════════════════════════════
// AI ROUTES — Telegram-style chat text assistant
// POST /ai/translate — Bangla↔English auto-detect translate
// POST /ai/style      — rewrite message in a chosen style
// POST /ai/fix        — grammar/spelling/punctuation correction
// ═══════════════════════════════════════════════════════════

const express = require('express')
const router  = express.Router()

let fetch = globalThis.fetch
if (!fetch) fetch = require('node-fetch')

const GEMINI_KEY = process.env.GEMINI_API_KEY

// ── Shared Gemini text call ───────────────────────────────
// Returns the raw text response (NOT JSON-parsed — translate/style/fix
// all just need plain rewritten text back, unlike musicMood's JSON).
async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured')

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 500 }
      })
    }
  )
  const data = await res.json()

  if (data.error || !data.candidates) {
    console.error('[AI] Gemini API error response:', JSON.stringify(data, null, 2))
    throw new Error(data.error?.message || 'Gemini returned no candidates')
  }

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  // Strip any accidental markdown fences / quote wrapping — we always
  // want plain message text back, ready to drop straight into the
  // chat input.
  return raw.replace(/```[\s\S]*?```/g, m => m.replace(/```(text)?/g, '').trim())
            .replace(/^["'`]+|["'`]+$/g, '')
            .trim()
}

// ── POST /ai/translate ────────────────────────────────────
// body: { text }
router.post('/translate', async (req, res) => {
  const { text } = req.body
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: 'No text provided' })
  }

  const prompt = `You are a precise bilingual translator for a private chat app.

Detect whether the following message is written in Bangla (Bengali, including Banglish/romanized Bangla) or English, then translate it into the OTHER language.

Rules:
- Preserve the exact meaning — never add or remove information.
- Keep all emojis exactly where they are.
- Keep all URLs unchanged.
- Keep all @mentions unchanged.
- Keep all #hashtags unchanged.
- Preserve line breaks.
- Return ONLY the translated message text. No explanation, no labels, no quotes.

Message:
"""
${text}
"""`

  try {
    const result = await callGemini(prompt)
    res.json({ success: true, result })
  } catch (e) {
    console.error('[AI] /translate error:', e.message)
    res.status(500).json({ success: false, error: 'Translation failed' })
  }
})

// ── POST /ai/style ────────────────────────────────────────
// body: { text, style }
const STYLE_DESCRIPTIONS = {
  create:        'Improve and polish the message creatively while keeping its core meaning.',
  zenpro:        'Rewrite calmly and minimally, like a wise, composed person — concise and thoughtful.',
  zen:           'Rewrite in a peaceful, gentle, mindful tone.',
  short:         'Make the message as short and to the point as possible, keeping the core meaning.',
  formal:        'Rewrite in a formal, professional tone suitable for polite communication.',
  tribal:        'Rewrite with a bold, primal, straightforward, strong-voiced tone.',
  viking:        'Rewrite with a fierce, bold, adventurous, larger-than-life tone.',
  professional:  'Rewrite in a clear, professional, business-appropriate tone.',
  friendly:      'Rewrite in a warm, friendly, approachable tone.',
  romantic:      'Rewrite in a romantic, affectionate, loving tone.',
  cute:          'Rewrite in a cute, playful, adorable tone.',
  casual:        'Rewrite in a relaxed, casual, everyday conversational tone.',
  long:          'Expand the message with more detail while keeping the same core meaning and tone.',
  funny:         'Rewrite in a funny, witty, lighthearted tone.',
  confident:     'Rewrite in a bold, self-assured, confident tone.',
  motivational:  'Rewrite in an uplifting, motivational, encouraging tone.',
  flirty:        'Rewrite in a playful, flirty, charming tone.',
  poetic:        'Rewrite in a poetic, lyrical, expressive tone.',
  respectful:    'Rewrite in a respectful, courteous, considerate tone.',
  emojify:       'Rewrite the message keeping the same words and meaning, but naturally add fitting emojis throughout.',
  socialmedia:   'Rewrite in an engaging, catchy social-media caption style.',
  business:      'Rewrite in a concise, professional business-communication tone.'
}

router.post('/style', async (req, res) => {
  const { text, style } = req.body
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: 'No text provided' })
  }
  const styleKey = (style || 'friendly').toLowerCase().replace(/\s+/g, '')
  const instruction = STYLE_DESCRIPTIONS[styleKey] || `Rewrite the message in a ${style} style.`

  const prompt = `You are a message style rewriter for a private chat app.

${instruction}

Rules:
- Preserve the original meaning — never add new facts or remove information.
- Keep the same language the message is written in (do not translate).
- Keep emojis unless the style explicitly calls for removing/adding them.
- Return ONLY the rewritten message text. No explanation, no labels, no quotes.

Message:
"""
${text}
"""`

  try {
    const result = await callGemini(prompt)
    res.json({ success: true, result })
  } catch (e) {
    console.error('[AI] /style error:', e.message)
    res.status(500).json({ success: false, error: 'Style rewrite failed' })
  }
})

// ── POST /ai/fix ──────────────────────────────────────────
// body: { text }
router.post('/fix', async (req, res) => {
  const { text } = req.body
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, error: 'No text provided' })
  }

  const prompt = `You are a precise grammar and spelling correction tool for a private chat app.

Correct ONLY grammar, spelling, and punctuation mistakes in the following message.

Rules:
- Do NOT change the tone or wording style.
- Do NOT rewrite sentences unnecessarily.
- Do NOT remove emojis.
- Do NOT shorten the message.
- Do NOT expand the message.
- Do NOT translate the message — keep the same language.
- Only fix actual errors. If there are no errors, return the message unchanged.
- Return ONLY the corrected message text. No explanation, no labels, no quotes.

Message:
"""
${text}
"""`

  try {
    const result = await callGemini(prompt)
    res.json({ success: true, result })
  } catch (e) {
    console.error('[AI] /fix error:', e.message)
    res.status(500).json({ success: false, error: 'Fix failed' })
  }
})

module.exports = router
