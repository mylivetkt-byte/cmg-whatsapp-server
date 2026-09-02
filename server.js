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

// Almacén en memoria de conversaciones y mensajes entrantes/salientes
const chats = new Map(); // phone -> { phone, name, lastMessage, timestamp, unread }
const messageStore = []; // Array de mensajes para historial

const logger = pino({ level: "silent" }); // silenciar logs pesados de baileys

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

    // 2. 📩 RECEPTOR DE MENSAJES ENTRANTES (RECEPTOR COMPLETO)
    sock.ev.on("messages.upsert", async ({ messages: newMessages, type }) => {
      try {
        if (type !== "notify") return;
        const msg = newMessages[0];

        // Ignorar si no hay contenido o es mensaje de grupo
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
          (msg.message?.imageMessage ? "[Imagen]" : msg.message?.documentMessage ? "[Documento PDF]" : "[Mensaje de audio]");

        const contactName = msg.pushName || senderPhone;
        const timestamp = new Date().toISOString();

        console.log(`📩 [${isFromMe ? "ENVIADO" : "RECIBIDO"}] ${senderPhone}: "${incomingText}"`);

        const msgObj = {
          id: msg.key.id,
          phone: senderPhone,
          name: contactName,
          fromMe: isFromMe,
          text: incomingText,
          timestamp,
        };

        // Guardar mensaje en el almacén de mensajes
        messageStore.push(msgObj);
        if (messageStore.length > 2000) messageStore.shift(); // Límite en memoria

        // Actualizar tabla de chats activos
        chats.set(senderPhone, {
          phone: senderPhone,
          name: contactName,
          lastMessage: incomingText,
          timestamp,
          unread: isFromMe ? 0 : ((chats.get(senderPhone)?.unread || 0) + 1),
        });

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

// Ping automático para evitar suspensión en Render
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
    message: "CMG WhatsApp Server (Servidor Receptor y Emisor Conectado)",
    endpoints: {
      health: "/health",
      status: "/status",
      qr: "/qr",
      qrBase64: "/qr-base64",
      chats: "/chats",
      messages: "/messages?phone=57300...",
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
      <p>El servidor está listo para recibir y enviar mensajes.</p>
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

// 📥 ENDPOINT PARA OBTENER CHATS ACTIVOS
app.get("/chats", (req, res) => {
  const chatList = Array.from(chats.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  res.json({ ok: true, count: chatList.length, chats: chatList });
});

// 📥 ENDPOINT PARA OBTENER HISTORIAL DE MENSAJES DE UN NÚMERO
app.get("/messages", (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "Falta parámetro phone" });
  let cleanPhone = String(phone).replace(/\D/g, "");

  const filtered = messageStore.filter((m) => m.phone.endsWith(cleanPhone) || cleanPhone.endsWith(m.phone));
  res.json({ ok: true, phone: cleanPhone, messages: filtered });
});

// 📤 ENDPOINT PARA ENVIAR MENSAJES (SOPORTA TEXTO Y MEDIA PDF/IMAGEN)
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

    if (mediaUrl) {
      if (mediaUrl.includes(".pdf") || mediaUrl.startsWith("data:application/pdf")) {
        await sock.sendMessage(jid, {
          document: { url: mediaUrl },
          mimetype: "application/pdf",
          fileName: "Documento_Evento.pdf",
          caption: message || "",
        });
      } else {
        await sock.sendMessage(jid, {
          image: { url: mediaUrl },
          caption: message || "",
        });
      }
    } else {
      await sock.sendMessage(jid, { text: message });
    }

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
