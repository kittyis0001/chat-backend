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

  fs.writeFileSync(
    storiesFile,
    JSON.stringify(data, null, 2)
  )

}

// ✅ CREATE STORY
router.post("/create", (req, res) => {

  const {
    userId,
    type,
    media,
    caption,
    music
  } = req.body

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

    createdAt: Date.now(),

    expiresAt: Date.now() + 86400000

  }

  stories.push(newStory)

  saveStories(stories)

  res.json({
    success: true,
    story: newStory
  })

})

// ✅ GET STORIES
router.get("/", (req, res) => {

  const stories = getStories()

  const activeStories = stories.filter(
    story => Date.now() < story.expiresAt
  )

  saveStories(activeStories)

  res.json({
    success: true,
    stories: activeStories
  })

})

module.exports = router
