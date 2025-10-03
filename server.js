require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const { google } = require("googleapis");
const axios = require("axios");
const cron = require("node-cron");
const { v4: uuidv4 } = require("uuid");

// ---------- Clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

// ---------- Persistencia simple (JSON)
const DB_PATH = path.join(__dirname, "memory.json");
let db = { users: {}, reminders: [] };
try {
  if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
} catch {}
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// ---------- Helpers UI
function splitForWhatsApp(text, maxLen = 1200) {
  const parts = [];
  let chunk = "";
  for (const line of String(text).split("\n")) {
    if ((chunk + "\n" + line).length > maxLen) {
      if (chunk) parts.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) parts.push(chunk);
  return parts;
}

// --- generar TTS (OpenAI) y devolver ruta local /tts/archivo.mp3
async function makeTTS(text) {
  const mp3 = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
  });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const filename = `wa-${uuidv4()}.mp3`;
  const outDir = path.join(__dirname, "tts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, filename), buffer);
  return `/tts/${filename}`;
}

// --- responder por WhatsApp con texto + audio en el mismo mensaje
async function replyWA(twiml, req, text) {
  let audioPath = null;
  try { audioPath = await makeTTS(text); } catch (e) { console.warn("TTS fail:", e.message); }

  // 👉 primer mensaje: texto + audio
  const m = twiml.message();
  m.body(text);
  if (audioPath) {
    const publicUrl = `${req.protocol}://${req.get("host")}${audioPath}`;
    m.media(publicUrl);
  }
}

// --- envío directo (fuera del webhook) con texto + audio (usa PUBLIC_BASE_URL)
async function sendTextAndTTSDirect(to, text) {
  const base = process.env.PUBLIC_BASE_URL || null;
  let mediaUrl = null;
  try {
    const local = await makeTTS(text); // "/tts/xx.mp3"
    if (base) mediaUrl = `${base}${local}`;
  } catch (e) {
    console.warn("TTS (direct) fail:", e.message);
  }
  const payload = { from: WHATSAPP_FROM, to, body: text };
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(payload);
}

// ---------- Google OAuth / Calendar
function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN } = process.env;
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  if (GOOGLE_REFRESH_TOKEN) oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

// --- detectar si el usuario escribió un año explícito o un día de semana
const YEAR_RE = /\b20\d{2}\b/;
const WEEKDAY_RE = /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)/i;

// --- normalizar la fecha al FUTURO CERCANO
function normalizeToNearestFuture(startISO, originalText) {
  let d = new Date(startISO);
  if (isNaN(d.getTime())) return null;
  const now = new Date();

  const userPutYear = YEAR_RE.test(originalText);
  const mentionsWeekday = WEEKDAY_RE.test(originalText);

  // si quedó demasiado lejos (más de ~370 días) y el usuario NO escribió año,
  // traelo hacia este año/previo, 1 ciclo como máximo
  if (!userPutYear) {
    while (d - now > 370 * 24 * 3600 * 1000) d.setFullYear(d.getFullYear() - 1);
  }

  if (d <= now) {
    if (mentionsWeekday) {
      while (d <= now) d = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
    } else {
      while (d <= now) d.setFullYear(d.getFullYear() + 1);
    }
  }
  return d.toISOString();
}

// ---------- Crear evento Calendar (con failsafe)
async function createCalendarEvent({ summary, description, startISO, endISO, attendeesEmails = [] }) {
  // por las dudas, si vino pasado, empujá al futuro +1h
  let startDate = new Date(startISO);
  if (startDate.getTime() < Date.now()) {
    startDate.setFullYear(new Date().getFullYear() + 1);
    startISO = startDate.toISOString();
    endISO = new Date(startDate.getTime() + 60 * 60 * 1000).toISOString();
  }

  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: summary || "Evento",
    description: description || "",
    start: { dateTime: startISO },
    end: { dateTime: endISO || new Date(Date.parse(startISO) + 60 * 60 * 1000).toISOString() },
    attendees: (attendeesEmails || []).map(email => ({ email })),
    reminders: { useDefault: true }
  };

  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const res = await calendar.events.insert({ calendarId, requestBody: event });
  return res.data;
}

// ----- Parser de intenciones
async function classifyAndExtractIntent(userText) {
  const sys = `Sos un parser. Tu salida debe ser SOLO JSON válido:
{
  "intent": "calendar_event" | "local_reminder" | "chitchat" | "none",
  "summary": "string",
  "description": "string",
  "startISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "endISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "attendees": ["correo@ej.com", "..."]
}
Reglas:
- "agendar/reunión/turno/cita + fecha/hora" -> calendar_event
- "recordame/recordatorio" sin fecha clara -> local_reminder
- saludos/preguntas comunes -> chitchat
- si dice "recordame" con hora precisa, tratálo como calendar_event
- si falta endISO, usá +60 min
- Fechas siempre futuras (si ya pasó este año, mover al siguiente).`;

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText }
      ]
    });
    return JSON.parse(c.choices?.[0]?.message?.content || "{}");
  } catch {
    return { intent: "none", summary: "", description: "", startISO: "", endISO: "", attendees: [] };
  }
}

// ---------- Recordatorio 1h antes (para eventos de Calendar)
function scheduleReminder(eventId, eventSummary, startISO, minutesBefore, toWa) {
  if (!startISO || !toWa) return;
  const fireAt = new Date(new Date(startISO).getTime() - minutesBefore * 60 * 1000).getTime();
  const delay = fireAt - Date.now();
  if (delay <= 0) return;
  setTimeout(async () => {
    try {
      await sendTextAndTTSDirect(toWa, `⏰ Recordatorio: "${eventSummary}" en ${minutesBefore} minutos.`);
    } catch (e) { console.error("WA reminder error:", e.message); }
  }, delay);
}

// ---------- Resumen del día (24h)
async function getDayDigestForUser(identity) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let eventsText = "• (Sin eventos en Google Calendar)";
  try {
    const ev = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: now.toISOString(),
      timeMax: in24h.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });
    const items = ev.data.items || [];
    if (items.length) {
      eventsText = items.map(e => {
        const startISO = e.start?.dateTime || e.start?.date || e.start;
        const when = startISO
          ? new Date(startISO).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
          : "(sin hora)";
        return `• ${when} — ${e.summary || "(Sin título)"}`;
      }).join("\n");
    }
  } catch {
    eventsText = "• (No se pudo leer Calendar)";
  }

  const localRems = (db.reminders || []).filter(r => r.identity === identity && !r.done && r.dueAt <= in24h.getTime());
  const remsText = localRems.length
    ? localRems.map(r => `• ${new Date(r.dueAt).toLocaleTimeString("es-AR", { hour:"2-digit", minute:"2-digit" })} — ${r.text}`).join("\n")
    : "• (Sin recordatorios locales)";

  return `📋 *Resumen del día*\n\n🗓️ *Eventos (próximas 24h)*:\n${eventsText}\n\n⏰ *Recordatorios locales*:\n${remsText}`;
}

// ---------- App
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/tts", express.static(path.join(__dirname, "tts"))); // servir MP3

app.get("/health", (_, res) => res.send("OK"));

// OAuth: sacar refresh token
app.get("/get_token", (req, res) => {
  const o = getOAuth2Client();
  const url = o.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"]
  });
  res.send(`<a href="${url}" target="_blank">Autorizar Google Calendar</a>`);
});

app.get("/oauth2callback", async (req, res) => {
  if (!req.query.code) return res.send("Falta ?code");
  try {
    const { tokens } = await getOAuth2Client().getToken(req.query.code);
    res.send(`<h3>Copiá este refresh_token y guardalo en Railway (GOOGLE_REFRESH_TOKEN):</h3><pre>${tokens.refresh_token || "Ya existe uno activo"}</pre>`);
  } catch (e) {
    res.send("Error: " + e.message);
  }
});

// ---------- Webhook WhatsApp
app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  db.users[from] = db.users[from] || { prefs: {} };
  saveDB();

  // Resumen diario manual
  if (/^resumen/i.test(body)) {
    const digest = await getDayDigestForUser(from);
    await replyWA(twiml, req, digest);
    return res.type("text/xml").send(twiml.toString());
  }

  // Intent
  const intent = await classifyAndExtractIntent(body);

  // Evento de Calendar
  if (intent.intent === "calendar_event" && intent.startISO) {
    try {
      const fixedStartISO = normalizeToNearestFuture(intent.startISO, body);
      if (!fixedStartISO) throw new Error("Fecha inválida");

      let fixedEndISO = intent.endISO || null;
      if (fixedEndISO) {
        const delta = new Date(fixedStartISO).getTime() - new Date(intent.startISO).getTime();
        fixedEndISO = new Date(new Date(intent.endISO).getTime() + delta).toISOString();
      }

      const e = await createCalendarEvent({
        summary: intent.summary || "Evento",
        description: intent.description || "Creado por asistente",
        startISO: fixedStartISO,
        endISO: fixedEndISO,
        attendeesEmails: intent.attendees || []
      });

      scheduleReminder(e.id, e.summary, fixedStartISO, 60, from);

      const fecha = new Date(e.start.dateTime || e.start.date).toLocaleString("es-AR", {
        day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"
      });

      await replyWA(twiml, req, `✅ Agendado: *${e.summary}* el ${fecha}`);
    } catch (err) {
      await replyWA(twiml, req, "⚠️ No pude crear el evento. Decime fecha y hora claras (ej: 'jueves 10:00').");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // Recordatorio local (sin fecha precisa)
  if (intent.intent === "local_reminder" && !intent.startISO) {
    const r = { id: `r_${Date.now()}`, identity: from, text: intent.summary || body, dueAt: Date.now() + 30*60*1000, done: false };
    db.reminders.push(r); saveDB();
    await replyWA(twiml, req, "📝 Listo, lo guardé como recordatorio. Si querés hora exacta: 'recordame hoy a las 21 ...'.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Charla normal
  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Sos un asistente argentino, amable y natural. Charlá con el usuario. Si la respuesta es larga, usá párrafos cortos y viñetas. También podés ayudar con agenda." },
        { role: "user", content: body }
      ],
      max_tokens: 800,
      temperature: 0.9
    });
    const reply = aiResponse.choices[0].message.content;
    await replyWA(twiml, req, reply);
  } catch (e) {
    await replyWA(twiml, req, "⚠️ Perdón, tuve un problema entendiendo tu mensaje.");
  }

  return res.type("text/xml").send(twiml.toString());
});

// ---------- Disparo de recordatorios locales (texto + audio)
setInterval(async () => {
  const now = Date.now();
  const due = (db.reminders || []).filter(r => !r.done && r.dueAt <= now);
  for (const r of due) {
    try {
      await sendTextAndTTSDirect(r.identity, `⏰ Recordatorio: ${r.text}`);
    } catch (e) {
      console.error("Recordatorio local WA error:", e.message);
    }
    r.done = true;
  }
  if (due.length) saveDB();
}, 5000);

// ---------- Resumen diario 06:30 AR
cron.schedule("30 6 * * *", async () => {
  console.log("⏰ Enviando resumen diario (06:30)...");
  for (const id of Object.keys(db.users)) {
    try {
      const digest = await getDayDigestForUser(id);
      await sendTextAndTTSDirect(id, digest);
    } catch (e) {
      console.error("Resumen WA error:", id, e.message);
    }
  }
}, { timezone: "America/Argentina/Buenos_Aires" });

// ---------- Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Asistente WA en puerto ${PORT}`));
