const express = require("express")
const multer = require("multer")
const cors = require("cors")
const path = require("path")

const app = express()
app.use(cors())
app.use(express.json())

// 🔥 YOUR TELEGRAM INFO
const BOT_TOKEN = "8706773948:AAGEEWhwYeP2e44k73DBFzQrEaFi5lGZj1c"
const CHAT_ID = "8782681794"

// login memory (1 time send)
let loggedUsers = {}

// file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/")
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname))
  }
})

const upload = multer({ storage })

// serve uploaded files
app.use("/uploads", express.static("uploads"))

// 📤 IMAGE UPLOAD API (FIXED)
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({
    url: req.protocol + "://" + req.get("host") + "/uploads/" + req.file.filename
  })
})

// 🔐 LOGIN TRACK (Telegram send)
app.post("/login", async (req, res) => {
  const { username } = req.body

  if (!username) return res.sendStatus(400)

  if (loggedUsers[username]) {
    return res.json({ status: "already_sent" })
  }

  loggedUsers[username] = true

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress
  const userAgent = req.headers["user-agent"]

  let device = "Unknown"
  if (userAgent.includes("Android")) device = "Android"
  else if (userAgent.includes("iPhone")) device = "iPhone"
  else device = "PC"

  const msg = `
👤 New Login
Username: ${username}
Device: ${device}
IP: ${ip}
`

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: msg
    })
  })

  res.json({ status: "sent" })
})

// 🎤 VOICE UPLOAD (FIXED)
app.post("/voice", upload.single("file"), (req, res) => {
  res.json({
    url: req.protocol + "://" + req.get("host") + "/uploads/" + req.file.filename
  })
})

// 🔥 PORT FIX (IMPORTANT FOR RENDER)
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log("Server running")
})
