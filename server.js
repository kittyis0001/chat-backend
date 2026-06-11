const express = require("express")
const cors = require("cors")
const multer = require("multer")
const cloudinary = require("cloudinary").v2
const streamifier = require("streamifier")
const fs = require("fs")

const uploadRoute = require("./routes/upload")
const storyRoute  = require("./routes/story")
const musicRoute  = require("./routes/music")   // ✅ NEW

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

app.use(express.json({ limit: '10mb' }))   // ✅ increased for image base64

// ✅ Routes
app.use("/upload",  uploadRoute)
app.use("/stories", storyRoute)
app.use("/music",   musicRoute)             // ✅ NEW

// ✅ Cloudinary config
cloudinary.config({
  cloud_name: "dlnomi3ny",
  api_key: "576225117181211",
  api_secret: "CB0duPoZmja7TyXz-4G_h1GlGkY"
})

// ✅ Secrets
const BOT_TOKEN  = process.env.BOT_TOKEN
const CHAT_ID    = process.env.CHAT_ID
const ACCESS_KEY = process.env.ACCESS_KEY

if (!BOT_TOKEN || !CHAT_ID || !ACCESS_KEY) {
  console.error("❌ Missing environment variables")
  process.exit(1)
}

const USERS = {
  "katis1":      "8822",
  "kittyis0001": "9911"
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
})

app.get("/", (req, res) => res.send("Server is alive 🚀"))

function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
    streamifier.createReadStream(buffer).pipe(stream)
  })
}

app.post("/image", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" })
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "chat/images", resource_type: "image"
    })
    res.json({ success: true, url: result.secure_url })
  } catch (e) {
    console.error("Image upload error:", e.message)
    res.status(500).json({ success: false, error: "Upload failed" })
  }
})

app.post("/voice", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" })
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: "chat/voices", resource_type: "video"
    })
    res.json({ success: true, url: result.secure_url })
  } catch (e) {
    console.error("Voice upload error:", e.message)
    res.status(500).json({ success: false, error: "Upload failed" })
  }
})

app.post("/check-access", (req, res) => {
  const { key } = req.body
  res.json({ ok: key === ACCESS_KEY })
})

app.post("/login", async (req, res) => {
  const { username, password, battery } = req.body
  if (!username || !password) return res.sendStatus(400)
  if (!USERS[username] || USERS[username] !== password) return res.json({ ok: false })

  res.json({ ok: true })

  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""
  ip = ip.split(",")[0].trim()

  const userAgent = req.headers["user-agent"] || ""
  let device = userAgent.includes("Android") ? "Android" : userAgent.includes("iPhone") ? "iPhone" : "PC"

  let isp = "Unknown", location = "Unknown"
  try {
    const geo = await fetch(`https://ipwho.is/${ip}`)
    const geoData = await geo.json()
    if (geoData.success) {
      isp      = geoData.connection?.isp || "Unknown"
      location = `${geoData.city || "?"}, ${geoData.country || "?"}`
    }
  } catch (e) {}

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

  const msg = `🔐 New Login\n👤 Username: ${username}\n📱 Device: ${device}\n🌐 IP: ${ip}\n📍 Location: ${location}\n🏢 ISP: ${isp}\n🔋 Battery: ${battery || "Unknown"}\n🕒 Time: ${time}`

  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
    })
  } catch (e) {}
})

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
  } catch (e) {}

  res.json({ ok: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("Server running 🚀"))
