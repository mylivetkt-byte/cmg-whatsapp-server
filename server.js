const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");

const app   = express();
const PORT  = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || "cmg-token-2024";

app.use(cors());
app.use(express.json());

let client = null;
let qrCode = null;
let status = "disconnected";

function normalizeQR(raw) {
  if (!raw) return null;
  if (raw.startsWith("data:image")) return raw;
  return "data:image/png;base64," + raw;
}

async function startClient() {
  try {
    console.log("Cargando wppconnect...");
    const wppconnect = require("@wppconnect-team/wppconnect");
    console.log("wppconnect cargado OK");

    client = await wppconnect.create({
      session: "cmg-eventos",
      catchQR: (base64Qr, asciiQR, attempts) => {
        console.log(`QR generado intento ${attempts}`);
        qrCode = normalizeQR(base64Qr);
        status = "qr";
      },
      statusFind: (s) => {
        console.log("Estado:", s);
        if (s === "isLogged" || s === "inChat") {
          status = "connected";
          qrCode = null;
        }
        if (s === "notLogged" || s === "browserClose" || s === "desconnectedMobile") {
          status = "disconnected";
          qrCode = null;
          setTimeout(startClient, 20000);
        }
      },
      headless: "new",
      logQR: false,
      browserArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
      ],
      puppeteerOptions: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      },
      folderNameToken: "tokens",
      mkdirFolderToken: true,
      disableWelcome: true,
      updatesLog: false,
    });

    status = "connected";
    qrCode = null;
    console.log("✅ WhatsApp conectado");

  } catch (err) {
    console.error("Error WPPConnect:", err.message);
    status = "disconnected";
    setTimeout(startClient, 30000);
  }
}

// Ping para no dormirse
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/health`);
    console.log("Ping OK — estado:", status);
  } catch (_) {}
});

app.get("/health", (req, res) => res.json({ ok: true, status, time: new Date().toISOString() }));
app.get("/status", (req, res) => res.json({ status, connected: status === "connected" }));

app.get("/qr-base64", (req, res) => {
  if (status === "connected") return res.json({ connected: true, qr: null });
  if (!qrCode)               return res.json({ connected: false, qr: null, status });
  res.json({ connected: false, qr: qrCode, status });
});

app.get("/qr", (req, res) => {
  if (status === "connected") {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
      <h2 style="color:#16a34a">✅ WhatsApp conectado</h2>
      <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`);
  }
  if (!qrCode) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>⏳ Generando QR... estado: ${status}</h2>
      <p>Recarga en unos segundos</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
  }
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
    <h2 style="color:#005537">📱 Escanea con WhatsApp</h2>
    <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrCode}" style="width:280px;height:280px;border:4px solid #16a34a;border-radius:12px;margin:20px auto;display:block">
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
    await client.sendText(`${number}@c.us`, message);
    console.log(`✅ Enviado a ${number}`);
    res.json({ success: true, to: number });
  } catch (err) {
    console.error("Error enviando:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Arrancar servidor PRIMERO, luego WhatsApp en segundo plano
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  // Delay de 3s para que Render registre el puerto antes de iniciar Chromium
  setTimeout(startClient, 3000);
});
