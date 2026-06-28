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

const logger = pino({ level: "silent" }); // silenciar logs de baileys

async function startClient() {
  try {
    console.log("Iniciando Baileys 7.0...");

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

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log("QR recibido, generando imagen...");
        try {
          qrDataUrl = await qrcode.toDataURL(qr);
          status = "qr";
          console.log("QR listo en /qr");
        } catch (e) {
          console.error("Error generando QR:", e.message);
        }
      }

      if (connection === "open") {
        console.log("✅ WhatsApp conectado con Baileys 7.0");
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

  } catch (err) {
    console.error("Error Baileys:", err.message);
    status = "disconnected";
    setTimeout(startClient, 30000);
  }
}

// Ping para no dormirse en Render
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/health`);
    console.log("Ping OK — estado:", status);
  } catch (_) {}
});

// ── Rutas ────────────────────────────────────────────────────────────[...]
app.get("/", (req, res) => {
  res.json({
    ok: true,
    status,
    message: "CMG WhatsApp Server",
    endpoints: {
      health: "/health",
      status: "/status",
      qr: "/qr",
      qrBase64: "/qr-base64",
      send: "POST /send"
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
      <p>El servidor está listo para enviar mensajes.</p>
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

app.post("/send", async (req, res) => {
  if (req.headers["authorization"] !== `Bearer ${TOKEN}`)
    return res.status(401).json({ error: "No autorizado" });
  if (status !== "connected" || !sock)
    return res.status(503).json({ error: "WhatsApp no conectado", status });

  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ error: "phone y message requeridos" });

  try {
    let number = String(phone).replace(/\D/g, "");
    if (number.startsWith("3") && number.length === 10) number = "57" + number;
    const jid = `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Enviado a ${number}`);
    res.json({ success: true, to: number });
  } catch (err) {
    console.error("Error enviando:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Arrancar Express primero, luego Baileys
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  setTimeout(startClient, 2000);
});
