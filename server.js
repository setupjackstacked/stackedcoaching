import express from "express";
import fetch from "node-fetch";
import Redis from "ioredis";

const app = express();
app.use(express.json());

/* =======================
   ENV
======================= */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const REDIS_URL = process.env.REDIS_URL || process.env.RAILWAY_REDIS_URL;

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!BASE_URL) throw new Error("Missing BASE_URL");
if (!REDIS_URL) throw new Error("Missing REDIS_URL");

const redis = new Redis(REDIS_URL);

/* =======================
   TELEGRAM HELPERS
======================= */
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function formatUserIdentity(message) {
  const from = message.from || {};
  const username = from.username ? `@${from.username}` : "No username";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const id = from.id ? `ID: ${from.id}` : "ID unknown";

  return `👤 Client: ${name || "Unknown"}\n🔗 Username: ${username}\n🆔 ${id}`;
}

/* =======================
   CHECK-IN QUESTIONS
======================= */
const QUESTIONS = [
  { key: "overallCompliance", text: "Overall compliance (1–10)?" },
  { key: "sleep", text: "Sleep (1–10)?" },
  { key: "nutritionAdherence", text: "Nutrition adherence (1–10)?" },
  { key: "nutritionNotes", text: "Nutrition notes?" },
  { key: "trainingAdherence", text: "Training adherence?" },
  { key: "trainingNotes", text: "Training notes?" },
  { key: "weight", text: "Current weight?" },
  { key: "additionalNotes", text: "Any additional notes?" },
];

/* =======================
   STATE HELPERS
======================= */
async function getState(userId) {
  const raw = await redis.get(`checkin:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveState(userId, state) {
  await redis.set(`checkin:${userId}`, JSON.stringify(state));
}

async function clearState(userId) {
  await redis.del(`checkin:${userId}`);
}

/* =======================
   ROUTES
======================= */
app.get("/", (_, res) => res.send("OK"));

app.get("/setWebhook", async (_, res) => {
  const result = await tg("setWebhook", {
    url: `${BASE_URL}/webhook`,
  });
  res.json(result);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const message = req.body.message;
  if (!message || !message.from) return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;

  let state = await getState(userId);

  /* START CHECK-IN */
  if (text === "/start" || text === "📩 New Check-In") {
    state = { step: 0, answers: {} };
    await saveState(userId, state);

    return tg("sendMessage", {
      chat_id: chatId,
      text: QUESTIONS[0].text,
    });
  }

  /* CANCEL */
  if (text === "🛑 Cancel") {
    await clearState(userId);
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Check-in cancelled.",
    });
  }

  if (!state) return;

  /* ANSWER QUESTIONS */
  if (state.step < QUESTIONS.length) {
    const q = QUESTIONS[state.step];
    state.answers[q.key] = text;
    state.step++;

    if (state.step < QUESTIONS.length) {
      await saveState(userId, state);
      return tg("sendMessage", {
        chat_id: chatId,
        text: QUESTIONS[state.step].text,
      });
    }

    await saveState(userId, state);
    return tg("sendMessage", {
      chat_id: chatId,
      text: "Please upload your progress photos (front / side / back).",
    });
  }

  /* HANDLE PHOTOS */
  if (message.photo) {
    const identity = formatUserIdentity(message);
    const a = state.answers;

    const summary =
      `📩 NEW CHECK-IN\n\n` +
      `${identity}\n\n` +
      `Overall compliance: ${a.overallCompliance || "-"}\n` +
      `Sleep: ${a.sleep || "-"}\n\n` +
      `Nutrition adherence: ${a.nutritionAdherence || "-"}\n` +
      `Nutrition notes:\n${a.nutritionNotes || "-"}\n\n` +
      `Training adherence: ${a.trainingAdherence || "-"}\n` +
      `Training notes:\n${a.trainingNotes || "-"}\n\n` +
      `Weight: ${a.weight || "-"}\n\n` +
      `Additional notes:\n${a.additionalNotes || "-"}`;

    if (ADMIN_CHAT_ID) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: summary,
      });

      await tg("sendPhoto", {
        chat_id: ADMIN_CHAT_ID,
        photo: message.photo.at(-1).file_id,
      });
    }

    await clearState(userId);

    return tg("sendMessage", {
      chat_id: chatId,
      text: "✅ Check-in complete. I’ll review and respond soon.",
    });
  }
});

/* =======================
   START SERVER
======================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on port:", PORT);
});
