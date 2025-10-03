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

// ---------- OpenAI (parser de intenciones)
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

// ---------- Persistencia simple
const DB_PATH = path.join(__dirname, "memory.json");
let db = { users: {}, reminders: [] };
try { if (fs.existsSync(DB_PATH)) db = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch {}
const saveDB = () => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

// ---------- Google OAuth / Calendar
function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN } = process.env;
  const oAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  if (GOOGLE_REFRESH_TOKEN) oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return oAuth2Client;
}

async function createCalendarEvent({ summary, description, startISO, endISO, attendeesEmails = [] }) {
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

async function classifyAndExtractIntent(userText) {
  const sys = `Sos un parser. Tu salida debe ser SOLO JSON válido:
{
  "intent": "calendar_event" | "local_reminder" | "none",
  "summary": "string",
  "description": "string",
  "startISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "endISO": "YYYY-MM-DDTHH:mm:ssZ | ''",
  "attendees": ["correo@ej.com", "..."]
}
Reglas: "agendar/reunión/turno/cita + fecha/hora" -> calendar_event. 
"recordame/recordatorio" sin fecha clara -> local_reminder.
Si hay hora pero dice "recordame", tratálo como calendar_event.
Si falta endISO, usá +60 min.`;
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

// ---------- Recordatorio 1h antes de evento (push por WhatsApp)
function scheduleReminder(eventId, eventSummary, startISO, minutesBefore, toWa) {
  if (!startISO || !toWa) return;
  const fireAt = new Date(new Date(startISO).getTime() - minutesBefore * 60 * 1000).getTime();
  const delay = fireAt - Date.now();
  if (delay <= 0) return;
  setTimeout(async () => {
    try {
      await twilioClient.messages.create({ from: WHATSAPP_FROM, to: toWa, body: `⏰ Recordatorio: "${eventSummary}" en ${minutesBefore} minutos.` });
    } catch (e) { console.error("WA reminder error:", e.message); }
  }, delay);
}

// ---------- Resumen diario (24h)
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
        const when = startISO ? new Date(startISO).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "(sin hora)";
        return `• ${when} — ${e.summary || "(Sin título)"}`;
      }).join("\n");
    }
  } catch {
    eventsText = "• (No se pudo leer Calendar)";
  }

  // Recordatorios locales próximos (si usás db.reminders)
  const localRems = (db.reminders || []).filter(r => r.identity === identity && !r.done && r.dueAt <= (now.getTime() + 24 * 60 * 60 * 1000));
  const remsText = localRems.length
    ? localRems.map(r => `• ${new Date(r.dueAt).toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})} — ${r.text}`).join("\n")
    : "• (Sin recordatorios locales)";

  return `📋 *Resumen del día*\n\n🗓️ *Eventos (próximas 24h)*:\n${eventsText}\n\n⏰ *Recordatorios locales*:\n${remsText}`;
}

// ---------- App
const app = express();
app.use(cors());

// aceptar JSON y formularios
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// endpoint para probar que está vivo
app.get("/health", (_, res) => res.send("OK"));

// OAuth helper para sacar refresh_token (usá una vez)
app.get("/get_token", (req, res) => {
  const o = getOAuth2Client();
  const url = o.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/calendar"] });
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

// ---------- WhatsApp webhook
app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;                // whatsapp:+54...
  const body = (req.body.Body || "").trim();
  db.users[from] = db.users[from] || { prefs: {} }; // registrar usuario
  saveDB();

  // Pedidos rápidos
  if (/^resumen/i.test(body)) {
    const digest = await getDayDigestForUser(from);
    twiml.message(digest);
    return res.type("text/xml").send(twiml.toString());
  }

  // Parsear intención
  const intent = await classifyAndExtractIntent(body);

  if (intent.intent === "calendar_event" && intent.startISO) {
    try {
      const e = await createCalendarEvent({
        summary: intent.summary || "Evento",
        description: intent.description || "Creado por asistente",
        startISO: intent.startISO,
        endISO: intent.endISO,
        attendeesEmails: intent.attendees || []
      });
      scheduleReminder(e.id, e.summary, intent.startISO, 60, from); // 1h antes
      const fecha = new Date(e.start.dateTime || e.start.date).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
      twiml.message(`✅ Agendado: *${e.summary}* el ${fecha}`);
    } catch (err) {
      twiml.message("⚠️ No pude crear el evento. Pasame fecha y hora claras (ej: 'jueves 10:00').");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  if (intent.intent === "local_reminder" && !intent.startISO) {
    const r = { id: `r_${Date.now()}`, identity: from, text: intent.summary || body, dueAt: Date.now() + 30*60*1000, done: false };
    db.reminders.push(r); saveDB();
    twiml.message("📝 Listo, lo guardé como recordatorio. Si querés hora exacta: 'recordame hoy a las 21 ...'.");
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.message("Puedo agendar eventos en Google Calendar, crear recordatorios y mandarte cada día a las 06:30 un resumen. Probá con: 'agendame reunión mañana 10:00' o 'recordame comprar pan'.");
  return res.type("text/xml").send(twiml.toString());
});

// ---------- Disparo de recordatorios locales
setInterval(async () => {
  const now = Date.now();
  const due = db.reminders.filter(r => !r.done && r.dueAt <= now);
  for (const r of due) {
    try {
      await twilioClient.messages.create({ from: WHATSAPP_FROM, to: r.identity, body: `⏰ Recordatorio: ${r.text}` });
    } catch (e) { console.error("Recordatorio local WA error:", e.message); }
    r.done = true;
  }
  if (due.length) saveDB();
}, 5000);

// ---------- Resumen diario 06:30 AR por WhatsApp
cron.schedule("30 6 * * *", async () => {
  console.log("⏰ Enviando resumen diario (06:30)...");
  for (const id of Object.keys(db.users)) {
    try {
      const digest = await getDayDigestForUser(id);
      await twilioClient.messages.create({ from: WHATSAPP_FROM, to: id, body: digest });
    } catch (e) {
      console.error("Resumen WA error:", id, e.message);
    }
  }
}, { timezone: "America/Argentina/Buenos_Aires" });

// ---------- Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Asistente WA en puerto ${PORT}`));
