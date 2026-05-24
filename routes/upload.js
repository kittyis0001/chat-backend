const express = require("express")
const multer = require("multer")
const streamifier = require("streamifier")
const cloudinary = require("../utils/cloudinary")

const router = express.Router()

const storage = multer.memoryStorage()

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
})

router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      })
    }

    const isVideo = req.file.mimetype.startsWith("video")

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: isVideo ? "video" : "image",
        folder: "stories"
      },
      (error, result) => {
        if (error) {
          return res.status(500).json({
            success: false,
            error: error.message
          })
        }

        res.json({
          success: true,
          url: result.secure_url,
          type: isVideo ? "video" : "image"
        })
      }
    )

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream)

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    })
  }
})

module.exports = router
