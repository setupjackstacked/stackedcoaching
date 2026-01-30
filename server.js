/**
 * JackStacked Coaching Bot (Railway-ready)
 * Express + Telegram Webhook + Redis sessions
 *
 * MENU:
 * 1) ✅ Check-In Form
 * 2) 📣 Coaching Channel (link)
 * 3) 📸 Instagram (link)
 * 4) 💳 Payment (submenu):
 *    - Stan Store (link)
 *    - Crypto (submenu: BTC / USDT ERC20 / USDT TRC20 / ETH ERC20) + Back buttons
 *    - PayPal (shows email + optional QR if saved)
 *
 * CHECK-IN FORM (your exact questions):
 * 1. Overall compliance
 * 2. Sleep quantity & quality
 * 3. Nutrition adherence
 * 4. Nutrition notes
 * 5. Training adherence
 * 6. Training notes
 * 7. Weight (kg/lbs)
 * 8. Photos Front / Rear / Side (in enforced order)
 * 9. Additional notes
 *
 * Guardrails:
 * - If they send a photo early, bot tells them which question they're on.
 * - If they type text during photo stage, bot asks for the next required photo.
 *
 * ENV (Railway):
 * TELEGRAM_BOT_TOKEN=123:ABC
 * BASE_URL=https://your-app.up.railway.app
 * ADMIN_CHAT_ID=123456789   (your Telegram user id OR an admin group id)
 *
 * Redis (Railway plugin):
 * REDIS_URL or RAILWAY_REDIS_URL is auto-injected
 *
 * Admin PayPal QR:
 * - Send the QR as a PHOTO to the bot with caption: /paypalqr
 * - Bot will store its file_id in Redis and show it under Payment → PayPal
 */

import express from "express";
import { createClient } from "redis";

const app = express();
app.use(express.json({ limit: "10mb" }));

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // can be your user id OR an admin group id

if (!BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!BASE_URL) {
  console.log("⚠️ BASE_URL not set. /setWebhook will not work until you set it.");
}
if (!ADMIN_CHAT_ID) {
  console.log("⚠️ ADMIN_CHAT_ID not set. Check-ins will NOT be forwarded to you.");
}

// =====================
// Your links + payment details
// =====================
const LINKS = {
  coachingChannel: "https://t.me/JackStackedCoaching",
  instagram: "https://www.instagram.com/jackstackedfitness",
  stanStore: "https://stan.store/JackStackedFitness",
};

const PAYPAL_EMAIL = "jake@upscaledubai.com";

const CRYPTO = {
  btc: {
    label: "₿ Bitcoin (BTC)",
    address: "1CRTNxXy9PLu8SPV95WA5nuQ9mUKmih1AC",
  },
  usdt_erc20: {
    label: "USDT (ERC20)",
    address: "0x718c5Cc3859422504aCbb465c8CfC12Eaae5f3CA",
  },
  usdt_trc20: {
    label: "USDT (TRC20)",
    address: "TMDynpQiwjVVo2wChezeawv2JP36qK3atE",
  },
  eth_erc20: {
    label: "Ξ Ethereum (ERC20)",
    address: "0x718c5Cc3859422504aCbb465c8CfC12Eaae5f3CA",
  },
};

// =====================
// Identity helper (NEW)
// =====================
function buildClientIdentity(message) {
  const from = message?.from || {};
  const first = from.first_name || "";
  const last = from.last_name || "";
  const name = `${first} ${last}`.trim() || "Unknown";
  const username = from.username ? `@${from.username}` : "No username";
  const userId = from.id ? String(from.id) : "Unknown ID";
  const chatId = message?.chat?.id != null ? String(message.chat.id) : "Unknown chat";

  return {
    name,
    username,
    userId,
    chatId,
    line:
      `👤 Client: ${name}\n` +
      `🔗 Username: ${username}\n` +
      `🆔 User ID: ${userId}\n` +
      `💬 Chat ID: ${chatId}`,
  };
}

// =====================
// Telegram API helper
// =====================
async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) console.error("Telegram API error:", method, data);
  return data;
}

// =====================
// Redis (Railway plugin)
// =====================
const REDIS_URL = process.env.REDIS_URL || process.env.RAILWAY_REDIS_URL;

let redis = null;
if (REDIS_URL) {
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();
  console.log("✅ Redis connected");
} else {
  console.log("⚠️ No REDIS_URL found — sessions will NOT persist across restarts.");
}

const sessionKey = (chatId) => `session:${chatId}`;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function getSession(chatId) {
  if (!redis) return { mode: "idle" };
  const raw = await redis.get(sessionKey(chatId));
  if (!raw) return { mode: "idle" };
  try {
    return JSON.parse(raw);
  } catch {
    return { mode: "idle" };
  }
}

async function setSession(chatId, obj) {
  if (!redis) return;
  await redis.set(sessionKey(chatId), JSON.stringify(obj), { EX: SESSION_TTL_SECONDS });
}

async function resetSession(chatId) {
  if (!redis) return;
  await redis.del(sessionKey(chatId));
}

// PayPal QR stored as Telegram file_id (no public URL needed)
const PAYPAL_QR_KEY = "paypal:qr:file_id";
async function getPaypalQrFileId() {
  if (!redis) return null;
  return await redis.get(PAYPAL_QR_KEY);
}
async function setPaypalQrFileId(fileId) {
  if (!redis) return;
  await redis.set(PAYPAL_QR_KEY, fileId);
}

// =====================
// Menus
// =====================
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "✅ Check-In Form", callback_data: "menu_checkin" }],
      [{ text: "📣 Coaching Channel", url: LINKS.coachingChannel }],
      [{ text: "📸 Instagram", url: LINKS.instagram }],
      [{ text: "💳 Payment", callback_data: "menu_payment" }],
      [
        { text: "▶️ Resume Check-In", callback_data: "checkin_resume" },
        { text: "🛑 Cancel", callback_data: "checkin_cancel" },
      ],
    ],
  };
}

function paymentMenu() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Stan Store", url: LINKS.stanStore }],
      [{ text: "💸 Crypto", callback_data: "menu_crypto" }],
      [{ text: "🅿️ PayPal", callback_data: "menu_paypal" }],
      [{ text: "⬅️ Back", callback_data: "menu_back" }],
    ],
  };
}

function cryptoMenu() {
  return {
    inline_keyboard: [
      [{ text: CRYPTO.btc.label, callback_data: "coin_btc" }],
      [{ text: CRYPTO.usdt_erc20.label, callback_data: "coin_usdt_erc20" }],
      [{ text: CRYPTO.usdt_trc20.label, callback_data: "coin_usdt_trc20" }],
      [{ text: CRYPTO.eth_erc20.label, callback_data: "coin_eth_erc20" }],
      [{ text: "⬅️ Back to Payment", callback_data: "menu_payment" }],
      [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
    ],
  };
}

function coinBackMenu() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Back to Crypto", callback_data: "menu_crypto" }],
      [{ text: "⬅️ Back to Payment", callback_data: "menu_payment" }],
      [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
    ],
  };
}

function paypalMenu() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Back to Payment", callback_data: "menu_payment" }],
      [{ text: "🏠 Main Menu", callback_data: "menu_main" }],
    ],
  };
}

function checkinControlRow() {
  return { inline_keyboard: [[{ text: "🛑 Cancel Check-In", callback_data: "checkin_cancel" }]] };
}

async function sendMenu(chatId, text = "Choose an option:") {
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: mainMenu() });
}

// =====================
// Check-in Flow (your exact questions)
// =====================
const CHECKIN_STEPS = [
  { key: "overallCompliance", prompt: "1) Overall compliance this week (0–10)?\n(0 = off plan, 10 = perfect)" },
  { key: "sleep", prompt: "2) Sleep quantity + quality?\nExample: 7.5h avg / quality 6-7/10 + notes" },
  { key: "nutritionAdherence", prompt: "3) Nutrition adherence (0–10)?" },
  { key: "nutritionNotes", prompt: "4) Nutrition notes:\nLikes/dislikes, issues, hunger, digestion, cravings, social events etc." },
  { key: "trainingAdherence", prompt: "5) Training adherence?\nReply: ✅ Hit all / ⚠️ Missed 1–2 / ❌ Off-plan" },
  { key: "trainingNotes", prompt: "6) Training notes:\nLikes/dislikes, issues, pumps, strength changes, any pain/niggles" },
  { key: "weight", prompt: "7) Weight (kg or lbs)?\nExample: 112.4kg or 248lbs" },
  { key: "additionalNotes", prompt: "9) Additional notes:\nAnything else you want me to know this week?" },
];

const PHOTO_ORDER = ["Front", "Rear", "Side"];

function extractBestPhotoFileId(message) {
  if (!message.photo || !message.photo.length) return null;
  return message.photo[message.photo.length - 1].file_id;
}

async function startCheckin(chatId) {
  const s = {
    mode: "checkin",
    stepIndex: 0,
    answers: {},
    photos: [], // will store: { label, fileId }
    collectingPhotos: false,
    photoIndex: 0,
    startedAt: Date.now(),
  };
  await setSession(chatId, s);

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "Week Check-In ✅\n\n" +
      "Answer the questions below. When finished, you’ll upload 3 progress photos (Front / Rear / Side).",
    reply_markup: checkinControlRow(),
  });

  await tg("sendMessage", {
    chat_id: chatId,
    text: CHECKIN_STEPS[0].prompt,
    reply_markup: checkinControlRow(),
  });
}

async function resumeCheckin(chatId) {
  const s = await getSession(chatId);

  if (s.mode !== "checkin") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "No active check-in found. Tap ✅ Check-In Form to start.",
      reply_markup: mainMenu(),
    });
    return;
  }

  if (s.collectingPhotos) {
    const needed = PHOTO_ORDER[s.photoIndex || 0] || "Front";
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Resume ✅\n\nPlease upload your **${needed}** photo to continue.`,
      parse_mode: "Markdown",
      reply_markup: checkinControlRow(),
    });
    return;
  }

  const step = CHECKIN_STEPS[s.stepIndex] || CHECKIN_STEPS[0];
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Resume ✅\n\n${step.prompt}`,
    reply_markup: checkinControlRow(),
  });
}

async function cancelCheckin(chatId) {
  const s = await getSession(chatId);
  if (s.mode !== "checkin") {
    await tg("sendMessage", { chat_id: chatId, text: "No active check-in to cancel.", reply_markup: mainMenu() });
    return;
  }
  await resetSession(chatId);
  await tg("sendMessage", { chat_id: chatId, text: "Check-in cancelled ✅", reply_markup: mainMenu() });
}

async function handleCheckinText(chatId, text) {
  const s = await getSession(chatId);
  if (s.mode !== "checkin") return;

  // If user is in photo stage, reject text and request the next required photo
  if (s.collectingPhotos) {
    const needed = PHOTO_ORDER[s.photoIndex || 0] || "Front";
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Please upload your **${needed}** photo to continue.`,
      parse_mode: "Markdown",
      reply_markup: checkinControlRow(),
    });
    return;
  }

  const step = CHECKIN_STEPS[s.stepIndex];
  if (!step) return;

  s.answers[step.key] = text;
  s.stepIndex += 1;

  // Next question or move into photo stage
  if (s.stepIndex < CHECKIN_STEPS.length) {
    await setSession(chatId, s);
    await tg("sendMessage", {
      chat_id: chatId,
      text: CHECKIN_STEPS[s.stepIndex].prompt,
      reply_markup: checkinControlRow(),
    });
  } else {
    // All questions answered -> start photo stage
    s.collectingPhotos = true;
    s.photoIndex = 0;
    await setSession(chatId, s);

    await tg("sendMessage", {
      chat_id: chatId,
      text: `8) Upload progress photos 📸\n\nSend **${PHOTO_ORDER[s.photoIndex]}** photo first.`,
      parse_mode: "Markdown",
      reply_markup: checkinControlRow(),
    });
  }
}

async function handleCheckinPhoto(chatId, message) {
  const s = await getSession(chatId);
  if (s.mode !== "checkin") return;

  // If user sends a photo too early, tell them which question they’re on
  if (!s.collectingPhotos) {
    const step = CHECKIN_STEPS[s.stepIndex] || CHECKIN_STEPS[0];
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "Hold that photo for a sec 📸\n\n" +
        `We’re still on question ${s.stepIndex + 1}:\n\n` +
        `${step.prompt}`,
      reply_markup: checkinControlRow(),
    });
    return;
  }

  const fileId = extractBestPhotoFileId(message);
  if (!fileId) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Please send the image as a *photo* (not a file) so I can log it.",
      parse_mode: "Markdown",
      reply_markup: checkinControlRow(),
    });
    return;
  }

  if (typeof s.photoIndex !== "number") s.photoIndex = 0;
  if (!Array.isArray(s.photos)) s.photos = [];

  const label = PHOTO_ORDER[s.photoIndex] || `Photo ${s.photoIndex + 1}`;
  s.photos.push({ label, fileId });
  s.photoIndex += 1;

  // Need more photos
  if (s.photoIndex < PHOTO_ORDER.length) {
    await setSession(chatId, s);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `${label} photo received ✅\nNow send **${PHOTO_ORDER[s.photoIndex]}** photo.`,
      parse_mode: "Markdown",
      reply_markup: checkinControlRow(),
    });
    return;
  }

  // Completed ✅
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Check-in complete ✅\nI’ll review and respond soon.",
    reply_markup: mainMenu(),
  });

  // Forward to admin
  if (ADMIN_CHAT_ID) {
    const identity = buildClientIdentity(message);

    const summary =
      `📩 NEW CHECK-IN\n\n` +
      `${identity.line}\n\n` +
      `Overall compliance: ${s.answers.overallCompliance || "-"}\n` +
      `Sleep: ${s.answers.sleep || "-"}\n\n` +
      `Nutrition adherence: ${s.answers.nutritionAdherence || "-"}\n` +
      `Nutrition notes:\n${s.answers.nutritionNotes || "-"}\n\n` +
      `Training adherence: ${s.answers.trainingAdherence || "-"}\n` +
      `Training notes:\n${s.answers.trainingNotes || "-"}\n\n` +
      `Weight: ${s.answers.weight || "-"}\n\n` +
      `Additional notes:\n${s.answers.additionalNotes || "-"}`;

    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: summary });

    // Send photos as media group (first caption indicates order + identity)
    const media = s.photos.slice(0, 3).map((p, idx) => ({
      type: "photo",
      media: p.fileId,
      caption:
        idx === 0
          ? `Client: ${identity.name} (${identity.username}) | User ID: ${identity.userId}\nProgress Photos (order): ${s.photos.map((x) => x.label).join(", ")}`
          : p.label,
    }));

    await tg("sendMediaGroup", { chat_id: ADMIN_CHAT_ID, media });
  }

  await resetSession(chatId);
}

// =====================
// Payment helpers
// =====================
function coinMessage(label, address) {
  return `${label}\n\nCopy this address:\n\`${address}\`\n\nTip: Tap and hold the address to copy.`;
}

async function showPaypal(chatId) {
  const qrFileId = await getPaypalQrFileId();

  await tg("sendMessage", {
    chat_id: chatId,
    text: `PayPal\n\nSend payment to:\n\`${PAYPAL_EMAIL}\`\n\nTip: Tap and hold to copy.`,
    parse_mode: "Markdown",
    reply_markup: paypalMenu(),
  });

  if (qrFileId) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: qrFileId,
      caption: "PayPal QR",
      reply_markup: paypalMenu(),
    });
  }
}

// Admin: save PayPal QR file_id by sending a PHOTO with caption "/paypalqr"
async function trySavePaypalQr(message) {
  if (!ADMIN_CHAT_ID) return false;

  // Allow only the admin user to set this (safest). If ADMIN_CHAT_ID is a group id, this will not work.
  const fromId = message.from?.id ? String(message.from.id) : null;
  if (!fromId || fromId !== String(ADMIN_CHAT_ID)) return false;

  const caption = (message.caption || "").trim().toLowerCase();
  if (caption !== "/paypalqr") return false;

  const fileId = extractBestPhotoFileId(message);
  if (!fileId) return false;

  await setPaypalQrFileId(fileId);
  await tg("sendMessage", {
    chat_id: message.chat.id,
    text: "✅ PayPal QR saved. It will now show under Payment → PayPal.",
  });

  return true;
}

// =====================
// Webhook routes
// =====================
app.get("/", (req, res) => res.send("OK - Coaching bot running"));

app.get("/setWebhook", async (req, res) => {
  if (!BASE_URL) return res.status(400).send("Missing BASE_URL env var");
  const webhookUrl = `${BASE_URL}/webhook`;
  const result = await tg("setWebhook", { url: webhookUrl });
  res.json({ webhookUrl, result });
});

app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // Button clicks
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data;

      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      if (!chatId) return res.sendStatus(200);

      // Navigation
      if (data === "menu_main") {
        await sendMenu(chatId, "Choose an option:");
        return res.sendStatus(200);
      }
      if (data === "menu_back") {
        await sendMenu(chatId, "Back to menu:");
        return res.sendStatus(200);
      }

      // Payment menus
      if (data === "menu_payment") {
        await tg("sendMessage", { chat_id: chatId, text: "Payment options:", reply_markup: paymentMenu() });
        return res.sendStatus(200);
      }
      if (data === "menu_crypto") {
        await tg("sendMessage", { chat_id: chatId, text: "Choose a crypto coin/network:", reply_markup: cryptoMenu() });
        return res.sendStatus(200);
      }
      if (data === "menu_paypal") {
        await showPaypal(chatId);
        return res.sendStatus(200);
      }

      // Coin callbacks
      if (data === "coin_btc") {
        await tg("sendMessage", { chat_id: chatId, text: coinMessage(CRYPTO.btc.label, CRYPTO.btc.address), parse_mode: "Markdown", reply_markup: coinBackMenu() });
        return res.sendStatus(200);
      }
      if (data === "coin_usdt_erc20") {
        await tg("sendMessage", { chat_id: chatId, text: coinMessage(CRYPTO.usdt_erc20.label, CRYPTO.usdt_erc20.address), parse_mode: "Markdown", reply_markup: coinBackMenu() });
        return res.sendStatus(200);
      }
      if (data === "coin_usdt_trc20") {
        await tg("sendMessage", { chat_id: chatId, text: coinMessage(CRYPTO.usdt_trc20.label, CRYPTO.usdt_trc20.address), parse_mode: "Markdown", reply_markup: coinBackMenu() });
        return res.sendStatus(200);
      }
      if (data === "coin_eth_erc20") {
        await tg("sendMessage", { chat_id: chatId, text: coinMessage(CRYPTO.eth_erc20.label, CRYPTO.eth_erc20.address), parse_mode: "Markdown", reply_markup: coinBackMenu() });
        return res.sendStatus(200);
      }

      // Check-in controls
      if (data === "menu_checkin") {
        await startCheckin(chatId);
        return res.sendStatus(200);
      }
      if (data === "checkin_cancel") {
        await cancelCheckin(chatId);
        return res.sendStatus(200);
      }
      if (data === "checkin_resume") {
        await resumeCheckin(chatId);
        return res.sendStatus(200);
      }

      // Default
      await sendMenu(chatId);
      return res.sendStatus(200);
    }

    // Messages
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text?.trim();

      // Admin: save PayPal QR (send photo with caption /paypalqr)
      if (msg.photo?.length && msg.caption) {
        const saved = await trySavePaypalQr(msg);
        if (saved) return res.sendStatus(200);
      }

      // Photos (can be early or during photo stage)
      if (msg.photo?.length) {
        await handleCheckinPhoto(chatId, msg);
        return res.sendStatus(200);
      }

      // Commands
      if (text === "/start" || text === "/menu") {
        await sendMenu(chatId, "Choose an option:");
        return res.sendStatus(200);
      }
      if (text === "/checkin") {
        await startCheckin(chatId);
        return res.sendStatus(200);
      }
      if (text === "/cancel") {
        await cancelCheckin(chatId);
        return res.sendStatus(200);
      }
      if (text === "/resume") {
        await resumeCheckin(chatId);
        return res.sendStatus(200);
      }

      // Text answers (during check-in)
      if (typeof text === "string" && text.length) {
        await handleCheckinText(chatId, text);
        return res.sendStatus(200);
      }

      // Fallback
      await sendMenu(chatId, "Use the menu below:");
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

// =====================
// Start server
// =====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Listening on ${PORT}`));

/**
 * Railway setup checklist:
 * 1) Deploy this service
 * 2) Add Redis plugin
 * 3) Set env vars:
 *    - TELEGRAM_BOT_TOKEN
 *    - BASE_URL
 *    - ADMIN_CHAT_ID
 * 4) Visit: https://YOUR_BASE_URL/setWebhook
 * 5) In Telegram: /start
 *
 * To set PayPal QR:
 * - From your ADMIN user: send the QR image to the bot as a PHOTO with caption /paypalqr
 */
