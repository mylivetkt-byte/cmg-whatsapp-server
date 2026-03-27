# CMG Eventos - WhatsApp Server

Servidor WPPConnect para envío automático de invitaciones por WhatsApp.

## Endpoints
- GET /health — Estado del servidor
- GET /qr — Escanear QR para conectar WhatsApp
- GET /status — Estado de la conexión
- POST /send — Enviar mensaje (requiere Bearer token)

## Variables de entorno
- API_TOKEN — Token de seguridad para el endpoint /send
- RENDER_EXTERNAL_URL — URL pública del servidor en Render
