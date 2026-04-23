const express = require("express")
const cors = require("cors")
const multer = require("multer")
const cloudinary = require("cloudinary").v2
const streamifier = require("streamifier")
const fs = require("fs")

let fetch = globalThis.fetch
if (!fetch) fetch = require("node-fetch")

const app = express()

app.set("trust proxy", true)

app.use(cors({
  origin: [
    "https://kittyis1.online",
    "https://www.kittyis1.online",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]
}))

app.use(express.json())

// ✅ Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
})

// ✅ Secrets
const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID
const ACCESS_KEY = process.env.ACCESS_KEY

if (!BOT_TOKEN || !CHAT_ID || !ACCESS_KEY) {
  console.error("❌ Missing environment variables")
  process.exit(1)
}

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error("❌ Missing Cloudinary environment variables")
  process.exit(1)
}

const USERS = {
  "katis1": "8822",
  "kittyis0001": "9911"
}

// ✅ multer — memory storage (Cloudinary তে যাবে)
const upload = multer({ storage: multer.memoryStorage() })

app.get("/", (req, res) => {
  res.send("Server is alive 🚀")
})

// ✅ Cloudinary upload helper
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
    streamifier.createReadStream(buffer).pipe(stream)
  })
}

// 📤 IMAGE UPLOAD → Cloudinary
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" })
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "chat/images",
      resource_type: "image"
    })
    res.json({ url: result.secure_url })
  } catch(e) {
    console.error("Image upload error:", e.message)
    res.status(500).json({ error: "Upload failed" })
  }
})

// 🎤 VOICE UPLOAD → Cloudinary
app.post("/voice", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" })
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "chat/voices",
      resource_type: "video" // Cloudinary audio = video resource type
    })
    res.json({ url: result.secure_url })
  } catch(e) {
    console.error("Voice upload error:", e.message)
    res.status(500).json({ error: "Upload failed" })
  }
})

// 🔑 ACCESS KEY CHECK
app.post("/check-access", (req, res) => {
  const { key } = req.body
  res.json({ ok: key === ACCESS_KEY })
})

// 🔐 LOGIN CHECK + TELEGRAM NOTIFY
app.post("/login", async (req, res) => {
  const { username, password, battery } = req.body
  if (!username || !password) return res.sendStatus(400)
  if (!USERS[username] || USERS[username] !== password) return res.json({ ok: false })

  res.json({ ok: true })

  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""
  ip = ip.split(",")[0].trim()

  const userAgent = req.headers["user-agent"] || ""
  let device = "Unknown"
  if (userAgent.includes("Android")) device = "Android"
  else if (userAgent.includes("iPhone")) device = "iPhone"
  else device = "PC"

  let isp = "Unknown"
  let location = "Unknown"
  try {
    const geo = await fetch(`https://ipwho.is/${ip}`)
    const geoData = await geo.json()
    if (geoData.success) {
      isp = geoData.connection?.isp || "Unknown"
      location = `${geoData.city || "?"}, ${geoData.country || "?"}`
    }
  } catch(e) {
    console.error("Geo API error:", e.message)
  }

  const now = new Date()
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

  const msg = `🔐 New Login
👤 Username: ${username}
📱 Device: ${device}
🌐 IP: ${ip}
📍 Location: ${location}
🏢 ISP: ${isp}
🔋 Battery: ${battery || "Unknown"}
🕒 Time: ${time}`

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    })
  } catch(e) {
    console.error("Telegram login notify error:", e.message)
  }
})

// 💬 TELEGRAM MESSAGE NOTIFY
app.post("/notify", async (req, res) => {
  const { text, time } = req.body
  if (!text) return res.sendStatus(400)

  const msg = `💬 Kitty:\n${text}\n\n🕒 Today at ${time}`

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    })
  } catch(e) {
    console.error("Telegram notify error:", e.message)
  }

  res.json({ ok: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("Server running 🚀"))
