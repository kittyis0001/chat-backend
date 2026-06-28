const express = require("express")
const fs = require("fs")
const path = require("path")
const { v4: uuidv4 } = require("uuid")

const router = express.Router()

const storiesFile = path.join(__dirname, "../data/stories.json")

function getStories() {
  if (!fs.existsSync(storiesFile)) {
    fs.writeFileSync(storiesFile, "[]")
  }
  return JSON.parse(fs.readFileSync(storiesFile))
}

function saveStories(data) {
  fs.writeFileSync(storiesFile, JSON.stringify(data, null, 2))
}

// ✅ CREATE STORY
router.post("/create", (req, res) => {
  const { userId, type, media, caption, music, edit } = req.body

  if (!userId || !type || !media) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields"
    })
  }

  const stories = getStories()

  const newStory = {
    id: uuidv4(),
    userId,
    type,
    media,
    caption: caption || "",
    music: music || null,
    edit: edit || null,   // ✅ video overlay edit data (filter/text/sticker/draw)
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000  // 24 ঘণ্টা
  }

  stories.push(newStory)
  saveStories(stories)

  res.json({ success: true, story: newStory })
})

// ✅ GET STORIES — expired গুলো filter করে দাও
router.get("/", (req, res) => {
  const stories = getStories()
  const activeStories = stories.filter(s => Date.now() < s.expiresAt)
  saveStories(activeStories)  // expired clean করো
  res.json({ success: true, stories: activeStories })
})

// ✅ DELETE STORY — এই route আগে ছিল না, এখন add করা হলো
router.delete("/:id", (req, res) => {
  const { id } = req.params
  const stories = getStories()
  const index = stories.findIndex(s => s.id === id)

  if (index === -1) {
    return res.status(404).json({ success: false, message: "Story not found" })
  }

  stories.splice(index, 1)
  saveStories(stories)

  res.json({ success: true, message: "Story deleted" })
})

module.exports = router
