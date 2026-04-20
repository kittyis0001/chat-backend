const express = require("express")
const multer = require("multer")
const cors = require("cors")
const path = require("path")
const fs = require("fs")

let fetch = globalThis.fetch
if (!fetch) {
  fetch = require("node-fetch")
}

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

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads")
}

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID
const ACCESS_KEY = process.env.ACCESS_KEY

if (!BOT_TOKEN || !CHAT_ID || !ACCESS_KEY) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID or ACCESS_KEY in environment variables")
  process.exit(1)
}

const USERS = {
  "katis1": "8822",
  "kittyis0001": "9911"
}

app.get("/", (req, res) => {
  res.send("Server is alive 🚀")
})

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/")
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname))
  }
})

const upload = multer({ storage })

app.use("/uploads", express.static("uploads"))

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" })
  }
  res.json({
    url: req.protocol + "://" + req.get("host") + "/uploads/" + req.file.filename
  })
})

app.post("/check-access", (req, res) => {
  const { key } = req.body
  res.json({ ok: key === ACCESS_KEY })
})

app.post("/login", async (req, res) => {
  const { username, password, battery } = req.body

  if (!username || !password) return res.sendStatus(400)

  if (!USERS[username] || USERS[username] !== password) {
    return res.json({ ok: false })
  }

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

app.post("/notify", async (req, res) => {
  const { text, time } = req.body
  if (!text) return res.sendStatus(400)

  const msg = `💬 Kitty:
${text}

🕒 Today at ${time}`

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
app.listen(PORT, () => {
  console.log("Server running 🚀")
})
