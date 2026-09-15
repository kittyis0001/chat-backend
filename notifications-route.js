// ═══════════════════════════════════════════════════════
// FCM push-notification route.
// Merge this into your EXISTING Render/Express server (the
// same one that already serves /upload, /login, /voice, /notify).
// Nothing in your current server code needs to change — just
// add these lines.
//
// SETUP:
//   1. npm install firebase-admin
//   2. Firebase Console → Project Settings → Service accounts
//      → Generate new private key → download the JSON.
//   3. On Render: add an env var FIREBASE_SERVICE_ACCOUNT with
//      the ENTIRE JSON file content pasted as one line.
//   4. Add an env var FIREBASE_DB_URL:
//      https://private-chat-318a6-default-rtdb.asia-southeast1.firebasedatabase.app
//   5. In your main server file:
//        const express = require("express")
//        const app = express()
//        const attachNotificationRoute = require("./notifications-route")
//        attachNotificationRoute(app)
// ═══════════════════════════════════════════════════════

const admin = require("firebase-admin")
const express = require("express")

let adminApp = null
function getAdminApp() {
  if (adminApp) return adminApp
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  adminApp = admin.initializeApp(
    {
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    },
    "notifyApp" // named app so it never collides with anything else you init
  )
  return adminApp
}

module.exports = function attachNotificationRoute(app) {
  app.post("/send-notification", express.json(), async (req, res) => {
    try {
      const { toUser, fromUser, fromNick, avatar, type, preview, replyPreview, msgKey } = req.body || {}
      if (!toUser || !fromUser) {
        return res.status(400).json({ ok: false, error: "missing fields" })
      }

      const fbApp = getAdminApp()
      const db = fbApp.database()

      // Skip the push entirely if the recipient already has this chat
      // open and focused right now — they'll see the message live.
      // Uses a heartbeat (active + last-updated timestamp) instead of a
      // plain boolean: if the flag is older than 20s it's treated as
      // stale/not-active, so a missed "went to background" event can
      // never permanently block notifications.
      const activeSnap = await db.ref("activeViewers/" + toUser).once("value")
      const activeVal = activeSnap.val()
      const isRecipientActive =
        activeVal && activeVal.active === true && (Date.now() - (activeVal.last || 0)) < 20000
      if (isRecipientActive) {
        return res.json({ ok: true, skipped: "recipient active" })
      }

      const tokensSnap = await db.ref("fcmTokens/" + toUser).once("value")
      const tokensObj = tokensSnap.val() || {}
      const deviceIds = Object.keys(tokensObj)
      const tokens = deviceIds.map((id) => tokensObj[id] && tokensObj[id].token).filter(Boolean)

      if (!tokens.length) {
        console.log(`[notify] no FCM tokens stored for ${toUser} — nothing to send`)
        return res.json({ ok: true, skipped: "no tokens" })
      }

      const message = {
        tokens,
        data: {
          fromUser: String(fromUser),
          fromNick: String(fromNick || fromUser),
          avatar: String(avatar || ""),
          type: String(type || "text"),
          preview: String(preview || ""),
          replyPreview: String(replyPreview || ""),
          msgKey: String(msgKey || "")
        },
        webpush: {
          fcmOptions: {} // deep link handled client-side via notificationclick
        }
      }

      const response = await fbApp.messaging().sendEachForMulticast(message)

      // Clean up dead/expired tokens so multi-device stays accurate.
      const deadIds = []
      response.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error && r.error.code
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            deadIds.push(deviceIds[i])
          }
        }
      })
      if (deadIds.length) {
        await Promise.all(deadIds.map((id) => db.ref("fcmTokens/" + toUser + "/" + id).remove().catch(() => {})))
      }

      res.json({ ok: true, sent: response.successCount, failed: response.failureCount })
      console.log(`[notify] to=${toUser} tokens=${tokens.length} sent=${response.successCount} failed=${response.failureCount}`)
    } catch (e) {
      console.error("send-notification error:", e)
      res.status(500).json({ ok: false, error: "internal error" })
    }
  })
}
