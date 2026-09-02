const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const qrcode  = require("qrcode");
const pino    = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app   = express();
const PORT  = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || "cmg-token-2024";

app.use(cors());
app.use(express.json());

let sock      = null;
let qrDataUrl = null;
let status    = "disconnected"; // disconnected | qr | connected

// Almacén en memoria de conversaciones y mensajes
const chatsMap = new Map(); // phone -> { id, name, lastMessage, timestamp, unreadCount }
const messageStore = [];    // Array de mensajes: { id, phone, name, fromMe, body, text, timestamp }

const logger = pino({ level: "silent" }); // silenciar logs pesados de baileys

// 🤖 MOTOR IA SERVIDOR - Respuestas automáticas 24/7
function getBotResponse(text) {
  if (!text) return null;
  const clean = text.toLowerCase().trim();

  if (clean === "1" || clean.includes("confirmar") || clean.includes("asistir")) {
    return "✅ ¡Excelente! Tu asistencia ha sido confirmada con éxito. Te esperamos en el evento.";
  }
  if (clean === "2" || clean.includes("cancelar") || clean.includes("no puedo")) {
    return "ℹ️ Entendido. Hemos registrado tu respuesta. Lamentamos que no puedas acompañarnos.";
  }
  if (clean.includes("fecha") || clean.includes("hora") || clean.includes("cuando")) {
    return "📅 El evento se llevará a cabo según el horario programado en el auditorio central. ¡Te esperamos!";
  }
  if (clean.includes("donde") || clean.includes("lugar") || clean.includes("ubicacion") || clean.includes("direccion")) {
    return "📍 Ubicación: Auditorio Central de la Sede Principal. Por favor llega 15 minutos antes.";
  }
  if (clean.includes("qr") || clean.includes("pase") || clean.includes("entrada") || clean.includes("ticket")) {
    return "🎟️ Puedes presentar tu Pase QR o código de registro en la entrada del evento.";
  }
  if (clean.includes("hola") || clean.includes("buenas") || clean.includes("menu")) {
    return "👋 ¡Hola! Soy el Asistente Virtual Inteligente IA de Doxa Eventos. ¿En qué te puedo ayudar hoy?\n\n1️⃣ Responde '1' para Confirmar Asistencia\n2️⃣ Responde '2' para Cancelar\n3️⃣ Escribe 'fecha', 'ubicación' o 'qr'";
  }
  return null;
}

async function startClient() {
  try {
    console.log("Iniciando Baileys 6.7.9...");

    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["CMG Eventos", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    // 1. EVENTO DE CONEXIÓN Y ESTADO
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("QR recibido, generando imagen...");
        try {
          qrDataUrl = await qrcode.toDataURL(qr);
          status = "qr";
          console.log("QR listo en /qr y /qr-base64");
        } catch (e) {
          console.error("Error generando QR:", e.message);
        }
      }

      if (connection === "open") {
        console.log("✅ WhatsApp conectado exitosamente con Baileys");
        status = "connected";
        qrDataUrl = null;
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log("Desconectado, código:", code, "— Reconectar:", shouldReconnect);
        status = "disconnected";
        qrDataUrl = null;
        if (shouldReconnect) {
          setTimeout(startClient, 5000);
        }
      }
    });

    // 2. 📩 RECEPTOR DE MENSAJES ENTRANTES Y AUTO-RESPUESTA DEL CHATBOT IA
    sock.ev.on("messages.upsert", async ({ messages: newMessages, type }) => {
      try {
        if (type !== "notify") return;
        const msg = newMessages[0];

        // Ignorar mensajes sin contenido o de grupos
        if (!msg || !msg.message || msg.key.remoteJid.endsWith("@g.us")) return;

        const senderJid = msg.key.remoteJid;
        let senderPhone = senderJid.replace("@s.whatsapp.net", "");
        if (senderPhone.startsWith("573") && senderPhone.length === 12) {
          senderPhone = senderPhone.substring(2); // formato colombiano
        }

        const isFromMe = Boolean(msg.key.fromMe);
        const incomingText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          (msg.message?.imageMessage ? "[Imagen]" : msg.message?.documentMessage ? "[Documento PDF]" : "[Mensaje]");

        const contactName = msg.pushName || senderPhone;
        const nowTs = Math.floor(Date.now() / 1000);

        console.log(`📩 [${isFromMe ? "ENVIADO" : "RECIBIDO"}] ${senderPhone} (${contactName}): "${incomingText}"`);

        const msgObj = {
          id: msg.key.id || `msg-${Date.now()}`,
          phone: senderPhone,
          name: contactName,
          fromMe: isFromMe,
          body: incomingText,
          text: incomingText,
          timestamp: nowTs,
        };

        // Guardar mensaje en memoria
        messageStore.push(msgObj);
        if (messageStore.length > 2000) messageStore.shift();

        // Actualizar conversación
        const existing = chatsMap.get(senderPhone) || chatsMap.get(contactName) || {};
        const chatData = {
          id: senderPhone,
          phone: senderPhone,
          name: contactName,
          lastMessage: incomingText,
          timestamp: nowTs,
          unreadCount: isFromMe ? 0 : ((existing.unreadCount || 0) + 1),
        };

        chatsMap.set(senderPhone, chatData);
        if (contactName && contactName !== senderPhone) {
          chatsMap.set(contactName, chatData);
        }

        // 🤖 SI ES UN MENSAJE ENTRANTE DEL USUARIO, PROCESAR Y ENVIAR RESPUESTA VÍA WHATSAPP REAL
        if (!isFromMe) {
          const autoReply = getBotResponse(incomingText);
          if (autoReply) {
            console.log(`🤖 Chatbot respondiendo a ${senderPhone}: "${autoReply}"`);
            
            // Simular estado "escribiendo..." anti-baneo
            await sock.sendPresenceUpdate("composing", senderJid);
            await new Promise((r) => setTimeout(r, 1500));

            // Enviar mensaje de respuesta por WhatsApp
            const botSent = await sock.sendMessage(senderJid, { text: autoReply });

            // Registrar mensaje del bot en el historial local
            const botTs = Math.floor(Date.now() / 1000);
            messageStore.push({
              id: botSent?.key?.id || `bot-${Date.now()}`,
              phone: senderPhone,
              name: contactName,
              fromMe: true,
              body: autoReply,
              text: autoReply,
              timestamp: botTs,
            });

            chatsMap.set(senderPhone, {
              ...chatData,
              lastMessage: autoReply,
              timestamp: botTs,
              unreadCount: 0,
            });
          }
        }

      } catch (err) {
        console.error("Error al procesar mensaje entrante:", err.message);
      }
    });

  } catch (err) {
    console.error("Error Baileys:", err.message);
    status = "disconnected";
    setTimeout(startClient, 30000);
  }
}

// Ping automático para no dormirse en Render
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/health`);
    console.log("Ping OK — estado:", status);
  } catch (_) {}
});

// ── RUTAS DE LA API ──────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    ok: true,
    status,
    message: "CMG WhatsApp Server (Motor IA Conectado 24/7)",
    endpoints: {
      health: "/health",
      status: "/status",
      qr: "/qr",
      qrBase64: "/qr-base64",
      chats: "GET /chats",
      messages: "GET /chats/:id/messages o GET /messages?phone=...",
      send: "POST /send (phone, message, mediaUrl)",
      presence: "POST /presence (phone, state)"
    }
  });
});

app.get("/health", (req, res) => res.json({ ok: true, status, time: new Date().toISOString() }));
app.get("/status", (req, res) => res.json({ status, connected: status === "connected" }));

app.get("/qr-base64", (req, res) => {
  if (status === "connected") return res.json({ connected: true, qr: null });
  if (!qrDataUrl)             return res.json({ connected: false, qr: null, status });
  res.json({ connected: false, qr: qrDataUrl, status });
});

app.get("/qr", (req, res) => {
  if (status === "connected") {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
      <h2 style="color:#16a34a">✅ WhatsApp conectado</h2>
      <p>El servidor está listo para recibir y enviar mensajes con Chatbot IA 24/7.</p>
      <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`);
  }
  if (!qrDataUrl) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>⏳ Iniciando... (estado: ${status})</h2>
      <p>Espera unos segundos y recarga</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
  }
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
    <h2 style="color:#005537">📱 Escanea con WhatsApp</h2>
    <p style="color:#555">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrDataUrl}" style="width:280px;height:280px;border:4px solid #16a34a;border-radius:12px;margin:20px auto;display:block">
    <p style="color:#999;font-size:13px">Se recarga cada 8 segundos</p>
    <script>setTimeout(()=>location.reload(),8000)</script>
  </body></html>`);
});

// 📥 ENDPOINT PARA CHATS
app.get("/chats", (req, res) => {
  const uniqueChats = new Map();
  Array.from(chatsMap.values()).forEach((c) => {
    uniqueChats.set(c.id, c);
  });

  const chatList = Array.from(uniqueChats.values()).sort(
    (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
  );
  res.json(chatList);
});

// 📥 ENDPOINT DE MENSAJES POR CHAT ID (`/chats/:id/messages`)
app.get("/chats/:id/messages", (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const cleanId = rawId.replace(/\D/g, "");

  const filtered = messageStore.filter((m) => {
    if (!cleanId) {
      return (
        m.phone.toLowerCase() === rawId.toLowerCase() ||
        (m.name && m.name.toLowerCase() === rawId.toLowerCase())
      );
    }
    const mDigits = m.phone.replace(/\D/g, "");
    return (
      (mDigits && (mDigits.endsWith(cleanId) || cleanId.endsWith(mDigits))) ||
      m.phone.toLowerCase() === rawId.toLowerCase() ||
      (m.name && m.name.toLowerCase() === rawId.toLowerCase())
    );
  });

  res.json(filtered);
});

// 📥 ENDPOINT DE MENSAJES POR PHONE QUERY (`/messages?phone=...`)
app.get("/messages", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "Falta parámetro phone" });

  const rawId = String(phone).trim();
  const cleanId = rawId.replace(/\D/g, "");

  const filtered = messageStore.filter((m) => {
    if (!cleanId) {
      return (
        m.phone.toLowerCase() === rawId.toLowerCase() ||
        (m.name && m.name.toLowerCase() === rawId.toLowerCase())
      );
    }
    const mDigits = m.phone.replace(/\D/g, "");
    return (
      (mDigits && (mDigits.endsWith(cleanId) || cleanId.endsWith(mDigits))) ||
      m.phone.toLowerCase() === rawId.toLowerCase() ||
      (m.name && m.name.toLowerCase() === rawId.toLowerCase())
    );
  });

  res.json(filtered);
});

// 📤 ENDPOINT PARA ENVIAR MENSAJES (TEXTO Y MEDIA PDF/IMAGEN)
app.post("/send", async (req, res) => {
  if (req.headers["authorization"] !== `Bearer ${TOKEN}`)
    return res.status(401).json({ error: "No autorizado" });
  if (status !== "connected" || !sock)
    return res.status(503).json({ error: "WhatsApp no conectado", status });

  const { phone, message, mediaUrl } = req.body;
  if (!phone || (!message && !mediaUrl))
    return res.status(400).json({ error: "phone y (message o mediaUrl) requeridos" });

  try {
    let number = String(phone).replace(/\D/g, "");
    if (number.startsWith("3") && number.length === 10) number = "57" + number;
    const jid = `${number}@s.whatsapp.net`;

    let sentMsg;
    if (mediaUrl) {
      if (mediaUrl.includes(".pdf") || mediaUrl.startsWith("data:application/pdf")) {
        sentMsg = await sock.sendMessage(jid, {
          document: { url: mediaUrl },
          mimetype: "application/pdf",
          fileName: "Documento_Evento.pdf",
          caption: message || "",
        });
      } else {
        sentMsg = await sock.sendMessage(jid, {
          image: { url: mediaUrl },
          caption: message || "",
        });
      }
    } else {
      sentMsg = await sock.sendMessage(jid, { text: message });
    }

    const nowTs = Math.floor(Date.now() / 1000);
    const msgText = message || (mediaUrl ? "[Archivo Adjunto]" : "");

    // Registrar mensaje enviado en el almacén local
    messageStore.push({
      id: sentMsg?.key?.id || `sent-${Date.now()}`,
      phone: number,
      name: number,
      fromMe: true,
      body: msgText,
      text: msgText,
      timestamp: nowTs,
    });

    chatsMap.set(number, {
      id: number,
      phone: number,
      name: number,
      lastMessage: msgText,
      timestamp: nowTs,
      unreadCount: 0,
    });

    console.log(`✅ Enviado a ${number}`);
    res.json({ success: true, to: number });
  } catch (err) {
    console.error("Error enviando:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PRESENCIA "ESCRIBIENDO..."
app.post("/presence", async (req, res) => {
  const { phone, state } = req.body;
  if (!phone || !sock || status !== "connected") return res.json({ ok: false });
  try {
    let number = String(phone).replace(/\D/g, "");
    if (number.startsWith("3") && number.length === 10) number = "57" + number;
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendPresenceUpdate(state || "composing", jid);
    res.json({ ok: true });
  } catch (_) {
    res.json({ ok: false });
  }
});

// Arrancar Express primero, luego Baileys
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  setTimeout(startClient, 2000);
});
