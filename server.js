const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode  = require("qrcode");
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");

const app   = express();
const PORT  = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || "cmg-token-2024";

app.use(cors());
app.use(express.json());

let client = null;
let qrDataUrl = null;
let status = "disconnected";

async function startClient() {
  try {
    console.log("Iniciando WhatsApp Web...");

    client = new Client({
      authStrategy: new LocalAuth({ clientId: "cmg-eventos" }),
      puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--single-process",
        ],
      },
    });

    client.on("qr", async (qr) => {
      console.log("QR recibido, generando imagen...");
      try {
        qrDataUrl = await qrcode.toDataURL(qr);
        status = "qr";
        console.log("QR listo en /qr");
      } catch (e) {
        console.error("Error generando QR imagen:", e.message);
      }
    });

    client.on("ready", () => {
      console.log("✅ WhatsApp conectado");
      status = "connected";
      qrDataUrl = null;
    });

    client.on("authenticated", () => {
      console.log("Autenticado correctamente");
      status = "connected";
    });

    client.on("auth_failure", (msg) => {
      console.error("Error de autenticación:", msg);
      status = "disconnected";
      setTimeout(startClient, 20000);
    });

    client.on("disconnected", (reason) => {
      console.log("Desconectado:", reason);
      status = "disconnected";
      qrDataUrl = null;
      setTimeout(startClient, 20000);
    });

    await client.initialize();

  } catch (err) {
    console.error("Error iniciando cliente:", err.message);
    status = "disconnected";
    setTimeout(startClient, 30000);
  }
}

// Ping cada 14 min para no dormirse en Render
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/health`);
    console.log("Ping OK — estado:", status);
  } catch (_) {}
});

// ── Rutas ─────────────────────────────────────────────────────────────
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
      <h2>⏳ Generando QR... (estado: ${status})</h2>
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
  if (status !== "connected" || !client)
    return res.status(503).json({ error: "WhatsApp no conectado", status });

  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ error: "phone y message requeridos" });

  try {
    let number = String(phone).replace(/\D/g, "");
    if (number.startsWith("3") && number.length === 10) number = "57" + number;
    const chatId = `${number}@c.us`;
    await client.sendMessage(chatId, message);
    console.log(`✅ Enviado a ${number}`);
    res.json({ success: true, to: number });
  } catch (err) {
    console.error("Error enviando:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Arrancar Express primero, luego WhatsApp
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  setTimeout(startClient, 3000);
});
