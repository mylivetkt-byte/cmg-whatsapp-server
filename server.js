const wppconnect = require("@wppconnect-team/wppconnect");
const express    = require("express");
const cors       = require("cors");
const cron       = require("node-cron");

const app   = express();
const PORT  = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || "cmg-token-2024";

app.use(cors());
app.use(express.json());

let client = null;
let qrCode = null;  // siempre guardamos como data URL completa
let status = "disconnected"; // disconnected | qr | connected

// ── Normalizar QR a data URL ──────────────────────────────────────────
function normalizeQR(raw) {
  if (!raw) return null;
  if (raw.startsWith("data:image")) return raw;
  return "data:image/png;base64," + raw;
}

// ── Inicializar WPPConnect ─────────────────────────────────────────────
async function startClient() {
  try {
    console.log("Iniciando WPPConnect...");

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    client = await wppconnect.create({
      session: "cmg-eventos",
      catchQR: (base64Qr, asciiQR, attempts) => {
        console.log(`QR generado (intento ${attempts}) — escanea desde /qr`);
        qrCode = normalizeQR(base64Qr);
        status = "qr";
      },
      statusFind: (s) => {
        console.log("Estado WhatsApp:", s);
        if (s === "isLogged" || s === "inChat") {
          status = "connected";
          qrCode = null;
        }
        if (s === "notLogged" || s === "browserClose" || s === "desconnectedMobile") {
          status = "disconnected";
          qrCode = null;
          // Reintentar conexión
          setTimeout(startClient, 15000);
        }
      },
      headless: true,
      logQR: false,
      browserArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-software-rasterizer",
      ],
      puppeteerOptions: {
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--single-process",
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
    console.log("✅ WhatsApp conectado correctamente");

  } catch (err) {
    console.error("Error iniciando WPPConnect:", err.message);
    status = "disconnected";
    qrCode = null;
    console.log("Reintentando en 30 segundos...");
    setTimeout(startClient, 30000);
  }
}

// ── Ping propio para no dormirse en Render ────────────────────────────
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const res = await fetch(`${url}/health`);
    console.log("Ping OK — servidor activo, estado:", status);
  } catch (_) {
    console.log("Ping falló");
  }
});

// ── Rutas ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true, status, time: new Date().toISOString() });
});

app.get("/status", (req, res) => {
  res.json({ status, connected: status === "connected" });
});

// QR como JSON para el panel admin
app.get("/qr-base64", (req, res) => {
  if (status === "connected") return res.json({ connected: true, qr: null });
  if (!qrCode)               return res.json({ connected: false, qr: null, status });
  res.json({ connected: false, qr: qrCode, status });
});

// QR como página HTML para escanear directamente
app.get("/qr", (req, res) => {
  if (status === "connected") {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
        <h2 style="color:#16a34a">✅ WhatsApp conectado correctamente</h2>
        <p style="color:#666">El servidor está listo para enviar mensajes.</p>
        <script>setTimeout(()=>location.reload(), 15000)</script>
      </body></html>
    `);
  }
  if (!qrCode) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#fff8e1">
        <h2 style="color:#b45309">⏳ Generando QR...</h2>
        <p style="color:#666">Estado actual: <strong>${status}</strong></p>
        <p style="color:#999">Esta página se recarga automáticamente</p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
      </body></html>
    `);
  }
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
        <h2 style="color:#005537">📱 Escanea este QR con WhatsApp</h2>
        <p style="color:#555">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCode}" style="width:280px;height:280px;border:4px solid #16a34a;border-radius:12px;margin:20px auto;display:block">
        <p style="color:#999;font-size:13px">Se recarga automáticamente cada 8 segundos</p>
        <script>setTimeout(()=>location.reload(), 8000)</script>
      </body>
    </html>
  `);
});

// ── Enviar mensaje WhatsApp ───────────────────────────────────────────
app.post("/send", async (req, res) => {
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "No autorizado" });
  }
  if (status !== "connected" || !client) {
    return res.status(503).json({ error: "WhatsApp no conectado", status });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone y message son requeridos" });
  }

  try {
    // Formatear número colombiano
    let number = String(phone).replace(/\D/g, "");
    if (number.startsWith("3") && number.length === 10) {
      number = "57" + number;
    }
    const chatId = `${number}@c.us`;

    await client.sendText(chatId, message);
    console.log(`✅ Mensaje enviado a ${number}`);
    res.json({ success: true, to: number });
  } catch (err) {
    console.error("Error enviando mensaje:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Iniciar ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  startClient();
});
