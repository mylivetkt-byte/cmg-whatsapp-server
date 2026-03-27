const wppconnect = require("@wppconnect-team/wppconnect");
const express    = require("express");
const cors       = require("cors");
const cron       = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN || "cmg-secret-token";

app.use(cors());
app.use(express.json());

let client = null;
let qrCode = null;
let status = "disconnected"; // disconnected | qr | connected

// ── Inicializar WPPConnect ────────────────────────────────────────────
async function startClient() {
  try {
    console.log("Iniciando WPPConnect...");
    client = await wppconnect.create({
      session: "cmg-eventos",
      catchQR: (base64Qr) => {
        console.log("QR generado — escanea desde /qr");
        qrCode  = base64Qr;
        status  = "qr";
      },
      statusFind: (s) => {
        console.log("Estado WhatsApp:", s);
        if (s === "isLogged" || s === "inChat") {
          status = "connected";
          qrCode = null;
        }
        if (s === "notLogged" || s === "browserClose") {
          status = "disconnected";
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
      ],
      puppeteerOptions: {
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
      folderNameToken: "tokens",
      mkdirFolderToken: true,
    });

    status = "connected";
    console.log("✅ WhatsApp conectado correctamente");
  } catch (err) {
    console.error("Error iniciando WPPConnect:", err.message);
    status = "disconnected";
    // Reintentar en 30 seg
    setTimeout(startClient, 30000);
  }
}

// ── Ping propio para no dormirse en Render ────────────────────────────
cron.schedule("*/14 * * * *", async () => {
  try {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/health`);
    console.log("Ping enviado — servidor activo");
  } catch (_) {}
});

// ── Rutas ──────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status, ok: true, time: new Date().toISOString() });
});

// Ver QR para escanear
app.get("/qr", (req, res) => {
  if (status === "connected") {
    return res.send("<h2 style='color:green;font-family:sans-serif'>✅ WhatsApp ya está conectado</h2>");
  }
  if (!qrCode) {
    return res.send("<h2 style='font-family:sans-serif'>⏳ Generando QR... recarga en 10 segundos</h2><script>setTimeout(()=>location.reload(),10000)</script>");
  }
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0faf5">
        <h2 style="color:#005537">📱 Escanea este QR con WhatsApp</h2>
        <p style="color:#666">Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrCode}" style="width:300px;border:4px solid #005537;border-radius:12px;margin:20px auto;display:block">
        <p style="color:#999;font-size:13px">Esta página se recarga automáticamente cada 10 segundos</p>
        <script>setTimeout(()=>location.reload(),10000)</script>
      </body>
    </html>
  `);
});

// Estado de la conexión
app.get("/status", (req, res) => {
  res.json({ status, connected: status === "connected" });
});

// ── Enviar mensaje WhatsApp ───────────────────────────────────────────
app.post("/send", async (req, res) => {
  // Verificar token de seguridad
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
    // Formatear número colombiano: agregar 57 si no tiene código de país
    let number = phone.replace(/\D/g, "");
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

// ── Iniciar servidor ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  startClient();
});
