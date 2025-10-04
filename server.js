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
const { Readable } = require("stream");

// ========================================
// CLIENTES Y CONFIGURACIÓN
// ========================================

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

// ========================================
// BASE DE DATOS SIMPLE (JSON)
// ========================================

const DB_PATH = path.join(__dirname, "memory.json");
let db = { users: {}, reminders: [] };

try {
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  }
} catch (err) {
  console.error("Error cargando DB:", err.message);
}

const saveDB = () => {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("Error guardando DB:", err.message);
  }
};

// ========================================
// UTILIDADES
// ========================================

// Partir texto largo para WhatsApp
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

// Generar audio TTS con OpenAI
async function makeTTS(text) {
  try {
    const mp3 = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text.substring(0, 4096) // límite de OpenAI
    });
    
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const filename = `wa-${uuidv4()}.mp3`;
    const outDir = path.join(__dirname, "tts");
    
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, filename), buffer);
    
    return `/tts/${filename}`;
  } catch (err) {
    console.error("Error TTS:", err.message);
    return null;
  }
}

// Responder por WhatsApp con texto + audio
async function replyWA(twiml, req, text) {
  const parts = splitForWhatsApp(text);
  let audioPath = null;
  
  try {
    audioPath = await makeTTS(text);
  } catch (e) {
    console.warn("TTS no disponible:", e.message);
  }

  parts.forEach((part, i) => {
    const msg = twiml.message(part);
    // Solo agregar audio al primer mensaje
    if (i === 0 && audioPath) {
      const publicUrl = `${req.protocol}://${req.get("host")}${audioPath}`;
      msg.media(publicUrl);
    }
  });
}

// Envío directo (fuera del webhook)
async function sendDirectWA(to, text) {
  try {
    const base = process.env.PUBLIC_BASE_URL || null;
    let mediaUrl = null;
    
    if (base) {
      const localPath = await makeTTS(text);
      if (localPath) mediaUrl = `${base}${localPath}`;
    }
    
    const payload = {
      from: WHATSAPP_FROM,
      to,
      body: text
    };
    
    if (mediaUrl) payload.mediaUrl = [mediaUrl];
    
    await twilioClient.messages.create(payload);
  } catch (err) {
    console.error("Error enviando WA directo:", err.message);
  }
}

// ========================================
// GOOGLE CALENDAR
// ========================================

function getOAuth2Client() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_REFRESH_TOKEN
  } = process.env;
  
  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  
  if (GOOGLE_REFRESH_TOKEN) {
    oAuth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  }
  
  return oAuth2Client;
}

// Normalizar fechas al futuro
const YEAR_RE = /\b20\d{2}\b/;
const WEEKDAY_RE = /(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)/i;

function normalizeToFuture(startISO, originalText) {
  let d = new Date(startISO);
  if (isNaN(d.getTime())) return null;
  
  const now = new Date();
  const userPutYear = YEAR_RE.test(originalText);
  const mentionsWeekday = WEEKDAY_RE.test(originalText);

  if (!userPutYear) {
    while (d - now > 370 * 24 * 3600 * 1000) {
      d.setFullYear(d.getFullYear() - 1);
    }
  }

  if (d <= now) {
    if (mentionsWeekday) {
      while (d <= now) {
        d = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
      }
    } else {
      while (d <= now) {
        d.setFullYear(d.getFullYear() + 1);
      }
    }
  }
  
  return d.toISOString();
}

// Crear evento en Google Calendar
async function createCalendarEvent({
  summary,
  description,
  startISO,
  endISO,
  attendeesEmails = []
}) {
  let startDate = new Date(startISO);
  
  // Failsafe: si está en pasado, mover al futuro
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
    end: {
      dateTime: endISO || new Date(Date.parse(startISO) + 60 * 60 * 1000).toISOString()
    },
    attendees: (attendeesEmails || []).map(email => ({ email })),
    reminders: { useDefault: true }
  };

  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
  const res = await calendar.events.insert({
    calendarId,
    requestBody: event
  });
  
  return res.data;
}

// ========================================
// INTELIGENCIA ARTIFICIAL
// ========================================

async function classifyIntent(userText) {
  const systemPrompt = `Sos un parser JSON. Analizá el texto y devolvé SOLO JSON válido:
{
  "intent": "calendar_event" | "local_reminder" | "chitchat",
  "summary": "título del evento/recordatorio",
  "description": "descripción adicional",
  "startISO": "YYYY-MM-DDTHH:mm:ssZ o vacío",
  "endISO": "YYYY-MM-DDTHH:mm:ssZ o vacío",
  "attendees": ["email@ejemplo.com"]
}

Reglas:
- "agendar/reunión/turno/cita" con fecha/hora → calendar_event
- "recordame/recordatorio" sin fecha clara → local_reminder  
- Saludos/preguntas generales → chitchat
- Si dice "recordame" con hora precisa, es calendar_event
- Fechas siempre futuras`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    });
    
    return JSON.parse(completion.choices[0].message.content || "{}");
  } catch (err) {
    console.error("Error clasificando intent:", err.message);
    return {
      intent: "chitchat",
      summary: "",
      description: "",
      startISO: "",
      endISO: "",
      attendees: []
    };
  }
}

// ========================================
// RECORDATORIOS Y RESUMEN DIARIO
// ========================================

function scheduleReminder(eventSummary, startISO, minutesBefore, toWa) {
  if (!startISO || !toWa) return;
  
  const fireAt = new Date(
    new Date(startISO).getTime() - minutesBefore * 60 * 1000
  ).getTime();
  
  const delay = fireAt - Date.now();
  if (delay <= 0) return;
  
  setTimeout(async () => {
    try {
      await sendDirectWA(
        toWa,
        `Recordatorio: "${eventSummary}" en ${minutesBefore} minutos.`
      );
    } catch (e) {
      console.error("Error recordatorio:", e.message);
    }
  }, delay);
}

async function getDayDigest(identity) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let eventsText = "(Sin eventos en Google Calendar)";
  
  try {
    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      timeMin: now.toISOString(),
      timeMax: in24h.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    });
    
    const items = response.data.items || [];
    
    if (items.length) {
      eventsText = items
        .map(e => {
          const startISO = e.start?.dateTime || e.start?.date;
          const when = startISO
            ? new Date(startISO).toLocaleString("es-AR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })
            : "(sin hora)";
          return `${when} - ${e.summary || "(Sin título)"}`;
        })
        .join("\n");
    }
  } catch (err) {
    console.error("Error leyendo Calendar:", err.message);
    eventsText = "(No se pudo leer Calendar)";
  }

  const localRems = (db.reminders || []).filter(
    r => r.identity === identity && !r.done && r.dueAt <= in24h.getTime()
  );
  
  const remsText = localRems.length
    ? localRems
        .map(
          r =>
            `${new Date(r.dueAt).toLocaleTimeString("es-AR", {
              hour: "2-digit",
              minute: "2-digit"
            })} - ${r.text}`
        )
        .join("\n")
    : "(Sin recordatorios locales)";

  return `RESUMEN DEL DÍA\n\nEventos próximas 24h:\n${eventsText}\n\nRecordatorios locales:\n${remsText}`;
}

// ========================================
// SERVIDOR EXPRESS
// ========================================

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/tts", express.static(path.join(__dirname, "tts")));

app.get("/health", (req, res) => res.send("OK"));

// OAuth Google Calendar
app.get("/get_token", (req, res) => {
  const oauth = getOAuth2Client();
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"]
  });
  res.send(`<a href="${url}" target="_blank">Autorizar Google Calendar</a>`);
});

app.get("/oauth2callback", async (req, res) => {
  if (!req.query.code) return res.send("Falta código de autorización");
  
  try {
    const { tokens } = await getOAuth2Client().getToken(req.query.code);
    res.send(
      `<h3>Copiá este refresh_token en Railway:</h3><pre>${
        tokens.refresh_token || "Ya existe uno activo"
      }</pre>`
    );
  } catch (e) {
    res.send("Error: " + e.message);
  }
});

// ========================================
// WEBHOOK WHATSAPP
// ========================================

app.post("/webhook/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  let body = (req.body.Body || "").trim();

  // Manejo de audio de WhatsApp
  if (!body && req.body.NumMedia && parseInt(req.body.NumMedia) > 0) {
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0 || "";

    console.log("Recibido media:", { mediaUrl, mediaType });

    if (mediaType.includes("audio") || mediaType.includes("ogg")) {
      try {
        const response = await axios.get(mediaUrl, {
          responseType: "arraybuffer",
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
          }
        });

        const buffer = Buffer.from(response.data);
        const tempPath = path.join(__dirname, "temp-audio.ogg");
        fs.writeFileSync(tempPath, buffer);

        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1"
        });

        body = transcription.text.trim();
        console.log("Transcripción exitosa:", body);

        fs.unlinkSync(tempPath);
      } catch (e) {
        console.error("Error transcribiendo audio:", e.message);
        await replyWA(twiml, req, "No pude entender tu audio, intenta de nuevo.");
        return res.type("text/xml").send(twiml.toString());
      }
    }
  }

  // Verificar que hay contenido
if (!body || body.trim() === "") {
  console.log("❌ Body vacío después de procesamiento");
  await replyWA(twiml, req, "No entendí tu mensaje.");
  return res.type("text/xml").send(twiml.toString());
}

console.log("✅ Body procesado:", body);

  // Guardar usuario
  db.users[from] = db.users[from] || { prefs: {} };
  saveDB();
  console.log("📝 Procesando mensaje:", body);
  console.log("👤 Usuario:", from);

  // Comando: Resumen diario manual
  if (/^resumen/i.test(body)) {
    const digest = await getDayDigest(from);
    await replyWA(twiml, req, digest);
    return res.type("text/xml").send(twiml.toString());
  }

  // Clasificar intención
  const intent = await classifyIntent(body);

  // CASO 1: Evento de calendario
  if (intent.intent === "calendar_event" && intent.startISO) {
    try {
      const fixedStartISO = normalizeToFuture(intent.startISO, body);
      if (!fixedStartISO) throw new Error("Fecha inválida");

      let fixedEndISO = intent.endISO || null;
      if (fixedEndISO) {
        const delta =
          new Date(fixedStartISO).getTime() - new Date(intent.startISO).getTime();
        fixedEndISO = new Date(new Date(intent.endISO).getTime() + delta).toISOString();
      }

      const event = await createCalendarEvent({
        summary: intent.summary || "Evento",
        description: intent.description || "Creado por asistente",
        startISO: fixedStartISO,
        endISO: fixedEndISO,
        attendeesEmails: intent.attendees || []
      });

      scheduleReminder(event.summary, fixedStartISO, 60, from);

      const fecha = new Date(event.start.dateTime || event.start.date).toLocaleString(
        "es-AR",
        {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }
      );

      await replyWA(twiml, req, `Agendado: ${event.summary} el ${fecha}`);
    } catch (err) {
      console.error("Error creando evento:", err.message);
      await replyWA(
        twiml,
        req,
        "No pude crear el evento. Dame fecha y hora claras (ej: jueves 10:00)"
      );
    }

    return res.type("text/xml").send(twiml.toString());
  }

  // CASO 2: Recordatorio local (sin fecha precisa)
  if (intent.intent === "local_reminder" && !intent.startISO) {
    const reminder = {
      id: `r_${Date.now()}`,
      identity: from,
      text: intent.summary || body,
      dueAt: Date.now() + 30 * 60 * 1000, // 30 min
      done: false
    };
    
    db.reminders.push(reminder);
    saveDB();
    
    await replyWA(
      twiml,
      req,
      "Listo, guardé el recordatorio. Si querés hora exacta decime: 'recordame hoy a las 21...'"
    );
    
    return res.type("text/xml").send(twiml.toString());
  }

  // CASO 3: Charla general
  try {
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Sos un asistente personal argentino, amable y natural. Ayudás con agenda, recordatorios y charla. Respondé con claridad y calidez.`
        },
        { role: "user", content: body }
      ],
      max_tokens: 800,
      temperature: 0.9
    });
    
    const reply = aiResponse.choices[0].message.content;
    await replyWA(twiml, req, reply);
  } catch (e) {
    console.error("Error IA:", e.message);
    await replyWA(twiml, req, "Perdón, tuve un problema. Intentá de nuevo.");
  }

  return res.type("text/xml").send(twiml.toString());
});

// ========================================
// RECORDATORIOS AUTOMÁTICOS
// ========================================

// Chequear recordatorios locales cada 5 segundos
setInterval(async () => {
  const now = Date.now();
  const due = (db.reminders || []).filter(r => !r.done && r.dueAt <= now);
  
  for (const r of due) {
    try {
      await sendDirectWA(r.identity, `Recordatorio: ${r.text}`);
      r.done = true;
    } catch (e) {
      console.error("Error enviando recordatorio:", e.message);
    }
  }
  
  if (due.length) saveDB();
}, 5000);

// Resumen diario automático a las 06:30 AM Argentina
cron.schedule(
  "30 6 * * *",
  async () => {
    console.log("Enviando resumen diario 06:30...");
    
    for (const userId of Object.keys(db.users)) {
      try {
        const digest = await getDayDigest(userId);
        await sendDirectWA(userId, digest);
      } catch (e) {
        console.error("Error resumen diario:", userId, e.message);
      }
    }
  },
  { timezone: "America/Argentina/Buenos_Aires" }
);

// ========================================
// INICIAR SERVIDOR
// ========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Asistente WhatsApp corriendo en puerto ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});