require("dotenv").config()
const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")
const fs = require("fs")
const path = require("path")

// ─── Config ────────────────────────────────────────────────────────────────────

// WhatsApp number that receives booking notifications (format: countrycode+number@c.us)
const ADMIN_NUMBER = process.env.ADMIN_WHATSAPP || "97338161618@c.us"
const BOOKINGS_FILE = path.join(__dirname, "bookings.json")

// ─── Clinic Data ──────────────────────────────────────────────────────────────

const CLINIC = {
  name: "Lileva Medical Center",
  address: "41st Floor, United Tower, Manama, Bahrain",
  phone: "+973 17227755",
  whatsapp: "+973 38161618",
  email: "info@lilevabeauty.com",
  hours: "Sunday – Thursday: 12:00 PM – 9:00 PM\nFriday: Closed\nSaturday: Closed"
}

const SERVICES = {
  "💉 Injectables": [
    "Botox",
    "Dermal Fillers",
    "Lip Fillers",
    "Profhilo",
    "PRP (Platelet-Rich Plasma)"
  ],
  "✨ Facial Treatments": [
    "HydraFacial",
    "OxyGeneo",
    "Acne Treatment",
    "Microneedling",
    "Skin Peels"
  ],
  "🏃 Body Treatments": [
    "Laser Hair Removal",
    "Body Sculpting",
    "Fat Reduction",
    "Skin Tightening"
  ],
  "🦷 Dentistry": [
    "Teeth Whitening",
    "Veneers",
    "Dental Implants",
    "Root Canal"
  ]
}

// ─── Booking Persistence ────────────────────────────────────────────────────────

function saveBooking(booking, chatId) {
  let bookings = []
  if (fs.existsSync(BOOKINGS_FILE)) {
    try {
      bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8"))
    } catch {
      bookings = []
    }
  }
  bookings.push({
    ...booking,
    whatsappId: chatId.replace("@c.us", ""),
    receivedAt: new Date().toISOString()
  })
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2))
  console.log(`📋 Booking saved — ${booking.name} | ${booking.service} | ${booking.date} ${booking.time}`)
}

async function notifyAdmin(client, booking, chatId) {
  const whatsapp = chatId.replace("@c.us", "")
  const msg =
    `🔔 *New Appointment Request!*\n\n` +
    `👤 *Name:* ${booking.name}\n` +
    `📱 *Phone:* ${booking.phone}\n` +
    `💬 *WhatsApp:* +${whatsapp}\n` +
    `💆 *Service:* ${booking.service}\n` +
    `📅 *Date:* ${booking.date}\n` +
    `🕐 *Time:* ${booking.time}\n\n` +
    `⏰ *Received:* ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Bahrain" })}`
  try {
    await client.sendMessage(ADMIN_NUMBER, msg)
  } catch (err) {
    console.error("⚠️  Failed to notify admin:", err.message)
  }
}

// ─── Date Validation ────────────────────────────────────────────────────────────

function parseDate(input) {
  // DD/MM/YYYY or DD-MM-YYYY → construct as local date to avoid UTC day-shift
  const dmyMatch = input.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d))
  }
  // Natural language: "20 March 2026", "March 20 2026", etc.
  const parsed = new Date(input)
  return isNaN(parsed.getTime()) ? null : parsed
}

function isClosedDay(input) {
  const lower = input.toLowerCase()

  // Text-based day name check
  if (
    lower.includes("friday") ||
    lower.includes("saturday") ||
    lower.includes(" fri") ||
    lower.startsWith("fri") ||
    lower.includes(" sat") ||
    lower.startsWith("sat") ||
    lower.includes("جمعة") ||
    lower.includes("سبت")
  ) {
    return true
  }

  // Parse actual date and check day of week (0=Sun … 5=Fri, 6=Sat)
  const date = parseDate(input)
  if (date) {
    const day = date.getDay()
    return day === 5 || day === 6
  }

  return false
}

// ─── Time Validation ─────────────────────────────────────────────────────────

function isOutsideWorkingHours(input) {
  const normalized = input.toLowerCase().replace(/\s+/g, " ").trim()
  let hours = -1, minutes = 0

  // HH:MM am/pm  or  H am/pm  (e.g. "2:00 PM", "2pm", "9 PM")
  const ampmMatch = normalized.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/)
  if (ampmMatch) {
    hours = parseInt(ampmMatch[1])
    minutes = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0
    const isPM = ampmMatch[3] === "pm"
    if (isPM && hours !== 12) hours += 12
    if (!isPM && hours === 12) hours = 0
  } else {
    // 24-hour format: HH:MM or HH (e.g. "14:00", "14")
    const h24Match = normalized.match(/^(\d{1,2})(?::(\d{2}))?$/)
    if (h24Match) {
      hours = parseInt(h24Match[1])
      minutes = h24Match[2] ? parseInt(h24Match[2]) : 0
    }
  }

  if (hours === -1) return false // unrecognised format — let it through

  const totalMinutes = hours * 60 + minutes
  return totalMinutes < 12 * 60 || totalMinutes > 21 * 60 // before 12PM or after 9PM
}

// ─── Session State ─────────────────────────────────────────────────────────────
// sessions[chatId] = { step, booking: { name, service, date, time }, lastActivity }

const sessions = {}

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { step: "idle", booking: {}, lastActivity: Date.now() }
  } else {
    sessions[chatId].lastActivity = Date.now()
  }
  return sessions[chatId]
}

// Clean up sessions inactive for more than 2 hours (runs every 30 minutes)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  let removed = 0
  for (const chatId in sessions) {
    if (sessions[chatId].lastActivity < cutoff) {
      delete sessions[chatId]
      removed++
    }
  }
  if (removed > 0) console.log(`🧹 Cleaned up ${removed} inactive session(s)`)
}, 30 * 60 * 1000)

// ─── Message Builders ──────────────────────────────────────────────────────────

function mainMenu() {
  return (
    `👋 Welcome to *${CLINIC.name}*!\n\n` +
    `How can we help you today? Please choose an option:\n\n` +
    `*1️⃣* Our Services\n` +
    `*2️⃣* Book an Appointment\n` +
    `*3️⃣* Location & Hours\n` +
    `*4️⃣* Contact Us\n\n` +
    `_Reply with a number (1–4)_`
  )
}

function servicesMenu() {
  let text = `🏥 *${CLINIC.name} — Services*\n\n`
  for (const [category, treatments] of Object.entries(SERVICES)) {
    text += `*${category}*\n`
    treatments.forEach(t => (text += `  • ${t}\n`))
    text += "\n"
  }
  text += `─────────────────────\nTo book any of these, reply *2*.\nTo go back to the main menu, reply *0* or *menu*.`
  return text
}

function locationMenu() {
  return (
    `📍 *Location & Hours*\n\n` +
    `🏢 *Address:*\n${CLINIC.address}\n\n` +
    `🗺️ *Google Maps:*\nhttps://maps.google.com/?q=United+Tower+Manama+Bahrain\n\n` +
    `🕐 *Working Hours:*\n${CLINIC.hours}\n\n` +
    `─────────────────────\nReply *0* or *menu* to go back.`
  )
}

function contactMenu() {
  return (
    `📞 *Contact Us*\n\n` +
    `📱 *Phone:* ${CLINIC.phone}\n` +
    `💬 *WhatsApp:* ${CLINIC.whatsapp}\n` +
    `📧 *Email:* ${CLINIC.email}\n\n` +
    `Our team is available Sunday–Thursday, 12PM–9PM.\n\n` +
    `─────────────────────\nReply *0* or *menu* to go back.`
  )
}

function buildServicesList() {
  const all = []
  for (const treatments of Object.values(SERVICES)) {
    treatments.forEach(t => all.push(t))
  }
  return all
}

// ─── Booking Flow ──────────────────────────────────────────────────────────────

function bookingStart() {
  return (
    `📅 *Book an Appointment*\n\n` +
    `Let's get you scheduled! I'll need a few details.\n\n` +
    `*Step 1 of 5* — Please send your *full name*:`
  )
}

function bookingAskPhone() {
  return (
    `✅ Got it!\n\n` +
    `*Step 2 of 5* — Please send your *phone number*:\n\n` +
    `_(e.g. +973 3816 1618)_`
  )
}

function bookingAskService() {
  let text = `✅ Got it!\n\n*Step 3 of 5* — Which service are you interested in?\n\n`
  let i = 1
  for (const [category, treatments] of Object.entries(SERVICES)) {
    text += `*${category}*\n`
    treatments.forEach(t => {
      text += `  ${i}. ${t}\n`
      i++
    })
    text += "\n"
  }
  text += `_Reply with the name of the service (e.g. "Botox")_`
  return text
}

function bookingAskDate() {
  return (
    `✅ Great choice!\n\n` +
    `*Step 4 of 5* — What is your *preferred date*?\n\n` +
    `_(e.g. Monday 23 March, or 23/03/2026)_\n` +
    `Note: We are open Sunday–Thursday only.`
  )
}

function bookingAskTime() {
  return (
    `✅ Perfect!\n\n` +
    `*Step 5 of 5* — What is your *preferred time*?\n\n` +
    `_(e.g. 2:00 PM)_\n` +
    `Available: 12:00 PM – 9:00 PM`
  )
}

function bookingConfirm(booking) {
  return (
    `🎉 *Appointment Request Received!*\n\n` +
    `Here's a summary:\n\n` +
    `👤 *Name:* ${booking.name}\n` +
    `📱 *Phone:* ${booking.phone}\n` +
    `💆 *Service:* ${booking.service}\n` +
    `📅 *Date:* ${booking.date}\n` +
    `🕐 *Time:* ${booking.time}\n\n` +
    `Our team will confirm your appointment shortly.\n\n` +
    `📱 For urgent inquiries:\n` +
    `Phone: ${CLINIC.phone}\n` +
    `WhatsApp: ${CLINIC.whatsapp}\n\n` +
    `Thank you for choosing *${CLINIC.name}*! 💙\n\n` +
    `─────────────────────\nReply *0* or *menu* to start over.`
  )
}

// ─── Message Handler ───────────────────────────────────────────────────────────

async function handleMessage(client, message) {
  const chatId = message.from
  const input = (message.body || "").trim()
  const lower = input.toLowerCase()

  // Ignore group messages
  if (message.from.includes("@g.us")) return

  const session = getSession(chatId)

  // ── Global resets ──
  if (["0", "menu", "back", "main menu", "home", "start"].includes(lower)) {
    sessions[chatId] = { step: "idle", booking: {} }
    await client.sendMessage(chatId, mainMenu())
    return
  }

  // ── Greetings ──
  const greetings = ["hi", "hello", "hey", "salam", "مرحبا", "ahlan", "hii", "helo"]
  if (greetings.some(g => lower === g || lower.startsWith(g + " "))) {
    sessions[chatId] = { step: "main_menu", booking: {} }
    await client.sendMessage(chatId, mainMenu())
    return
  }

  // ── Booking flow (takes priority over menu) ──
  if (session.step === "booking_name") {
    if (input.length < 2) {
      await client.sendMessage(chatId, "Please enter a valid name.")
      return
    }
    session.booking.name = input
    session.step = "booking_phone"
    await client.sendMessage(chatId, bookingAskPhone())
    return
  }

  if (session.step === "booking_phone") {
    if (input.length < 5) {
      await client.sendMessage(chatId, "Please enter a valid phone number (e.g. +973 3816 1618).")
      return
    }
    session.booking.phone = input
    if (session.booking.service) {
      // Service was pre-detected from the user's initial message — skip service step
      session.step = "booking_date"
      await client.sendMessage(chatId, `✅ Noted! We'll book *${session.booking.service}* for you.\n\n` + bookingAskDate())
    } else {
      session.step = "booking_service"
      await client.sendMessage(chatId, bookingAskService())
    }
    return
  }

  if (session.step === "booking_service") {
    const allServices = buildServicesList()
    const matched = allServices.find(
      s => s.toLowerCase() === lower || s.toLowerCase().includes(lower)
    )
    if (!matched) {
      await client.sendMessage(
        chatId,
        `❓ I didn't recognise that service. Please type the service name exactly as listed.\n\nExample: _Botox_ or _HydraFacial_`
      )
      return
    }
    session.booking.service = matched
    session.step = "booking_date"
    await client.sendMessage(chatId, bookingAskDate())
    return
  }

  if (session.step === "booking_date") {
    if (input.length < 3) {
      await client.sendMessage(chatId, "Please enter a valid date (e.g. Monday 23 March).")
      return
    }
    if (isClosedDay(input)) {
      await client.sendMessage(
        chatId,
        `⚠️ We're closed on Fridays and Saturdays.\n\nPlease choose a date from *Sunday to Thursday*.\n\n_What is your preferred date?_`
      )
      return
    }
    session.booking.date = input
    session.step = "booking_time"
    await client.sendMessage(chatId, bookingAskTime())
    return
  }

  if (session.step === "booking_time") {
    if (input.length < 2) {
      await client.sendMessage(chatId, "Please enter a valid time (e.g. 2:00 PM).")
      return
    }
    if (isOutsideWorkingHours(input)) {
      await client.sendMessage(
        chatId,
        `⚠️ Sorry, that time is outside our working hours.\n\nWe're available *12:00 PM – 9:00 PM*, Sunday to Thursday.\n\nPlease choose a time within those hours. _(e.g. 2:00 PM)_`
      )
      return
    }
    session.booking.time = input
    const completedBooking = { ...session.booking }
    session.step = "idle"
    session.booking = {}
    saveBooking(completedBooking, chatId)
    await notifyAdmin(client, completedBooking, chatId)
    await client.sendMessage(chatId, bookingConfirm(completedBooking))
    return
  }

  // ── Main menu selections ──
  if (session.step === "main_menu" || session.step === "idle") {
    switch (input) {
      case "1":
        session.step = "main_menu"
        await client.sendMessage(chatId, servicesMenu())
        return

      case "2":
        session.step = "booking_name"
        await client.sendMessage(chatId, bookingStart())
        return

      case "3":
        session.step = "main_menu"
        await client.sendMessage(chatId, locationMenu())
        return

      case "4":
        session.step = "main_menu"
        await client.sendMessage(chatId, contactMenu())
        return
    }
  }

  // ── Keyword shortcuts (anytime) ──
  if (
    lower.includes("book") || lower.includes("appointment") ||
    lower.includes("reserve") || lower.includes("schedule") ||
    lower.includes("i want to come") || lower.includes("i'd like to book") ||
    lower.includes("make an appointment") || lower.includes("get an appointment")
  ) {
    session.step = "booking_name"
    session.booking = {}
    await client.sendMessage(chatId, bookingStart())
    return
  }

  if (
    lower.includes("service") || lower.includes("treatment") ||
    lower.includes("price") || lower.includes("offer") ||
    lower.includes("what do you do") || lower.includes("what do you offer") ||
    lower.includes("what do you have") || lower.includes("show me")
  ) {
    session.step = "main_menu"
    await client.sendMessage(chatId, servicesMenu())
    return
  }

  if (
    lower.includes("location") || lower.includes("address") ||
    lower.includes("where") || lower.includes("hour") ||
    lower.includes("open") || lower.includes("directions") ||
    lower.includes("map") || lower.includes("find you") ||
    lower.includes("how to get")
  ) {
    session.step = "main_menu"
    await client.sendMessage(chatId, locationMenu())
    return
  }

  if (
    lower.includes("contact") || lower.includes("call") ||
    lower.includes("email") || lower.includes("reach") ||
    lower.includes("get in touch") || lower.includes("speak to")
  ) {
    session.step = "main_menu"
    await client.sendMessage(chatId, contactMenu())
    return
  }

  // ── Service name detection — e.g. "I want botox", "interested in hydrafacial" ──
  {
    const allServices = buildServicesList()
    const mentionedService = allServices.find(s => lower.includes(s.toLowerCase()))
    if (mentionedService) {
      session.step = "booking_name"
      session.booking = { service: mentionedService }
      await client.sendMessage(
        chatId,
        `💉 Great choice — *${mentionedService}*! Let's get you booked in.\n\n` + bookingStart()
      )
      return
    }
  }

  // ── Fallback ──
  session.step = "main_menu"
  await client.sendMessage(
    chatId,
    `🤔 I'm not sure I understood that.\n\n` + mainMenu()
  )
}

// ─── Bot Init ──────────────────────────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "lileva-bot" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  }
})

client.on("qr", qr => {
  console.log("\n📱 Scan this QR code with WhatsApp to connect the bot:\n")
  qrcode.generate(qr, { small: true })
})

client.on("authenticated", () => {
  console.log("✅ Authenticated successfully")
})

client.on("auth_failure", msg => {
  console.error("❌ Authentication failed:", msg)
})

client.on("ready", () => {
  console.log(`\n🚀 ${CLINIC.name} WhatsApp Bot is LIVE!`)
  console.log("──────────────────────────────────────")
  console.log(`📍 ${CLINIC.address}`)
  console.log(`📞 ${CLINIC.phone}`)
  console.log("──────────────────────────────────────")
  console.log("Waiting for messages...\n")
})

client.on("message", async message => {
  try {
    await handleMessage(client, message)
  } catch (err) {
    console.error("Error handling message:", err)
  }
})

client.on("disconnected", reason => {
  console.log("Bot disconnected:", reason)
  initializeWithRetry()
})

async function initializeWithRetry(attempt = 1, maxAttempts = 5, delay = 5000) {
  try {
    await client.initialize()
  } catch (err) {
    console.error(`❌ Initialization attempt ${attempt}/${maxAttempts} failed: ${err.message}`)
    if (attempt < maxAttempts) {
      console.log(`⏳ Retrying in ${delay / 1000}s...`)
      setTimeout(() => initializeWithRetry(attempt + 1, maxAttempts, delay), delay)
    } else {
      console.error("❌ All initialization attempts failed. Please check your network and restart the bot.")
      process.exit(1)
    }
  }
}

initializeWithRetry()
