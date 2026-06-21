Actualiza la dependencia @whiskeysockets/baileys a la versión 7.0.0-rc13 (release candidate).

Motivo:
- Probar compatibilidad con Baileys v7 y aprovechar correcciones/novedades.
- NOTA: es una release candidate; probar en staging antes de desplegar en producción.

Cambios
- package.json: "@whiskeysockets/baileys": "7.0.0-rc13"

Pruebas recomendadas antes del merge
1. Instalar dependencias limpias:
   npm ci
2. Arrancar la aplicación:
   npm start
3. Comprobar endpoints:
   - GET /health → { ok: true, status, time }
   - GET /qr → genera QR cuando status === "qr"
   - GET /status → mostrar connected cuando vinculado
4. Escanear QR y verificar conexión:
   - /status debe pasar a connected
   - /qr debe dejar de mostrar QR
5. Envío de prueba:
   - POST /send con Authorization: Bearer <TOKEN> y body { phone, message } → confirmar entrega
6. Persistencia de credenciales:
   - Reiniciar servicio y confirmar que no solicita re-vinculación (credenciales en carpeta auth_info)
7. Revisar logs por errores/warnings relacionados con la API de Baileys (eventos, sendMessage, connection.update)
8. Probar reconexión: forzar desconexión y verificar que reconecta (excepto DisconnectReason.loggedOut)

Notas y riesgos
- v7 introduce cambios breaking en algunos puntos; aunque el código usa patrones v7-friendly (useMultiFileAuthState, fetchLatestBaileysVersion), pueden aparecer cambios sutiles en shape de eventos o mensajes.
- Recomendado: merge solo después de validar en staging. No desplegar directamente a producción sin pruebas.
- Asegúrate de Node >= 18 (engines en package.json).

Cómo crear la PR
Opción A — desde el navegador (rápido):
- Abrir: https://github.com/mylivetkt-byte/cmg-whatsapp-server/compare/main...update/baileys-7?expand=1
- Completar título y pegar el cuerpo anterior, luego "Create pull request".

Opción B — con GitHub CLI:
- (si ya tienes la rama remota) desde tu repositorio local:
  git fetch origin
  git checkout update/baileys-7
- Crear PR con gh:
  gh pr create --base main --head update/baileys-7 --title "chore: update @whiskeysockets/baileys to 7.0.0-rc13" --body-file ./pr_body.md

Cómo revertir si hay problemas
- Revertir el commit de la PR o restaurar package.json a la versión 6.x:
  npm install @whiskeysockets/baileys@6.7.9 --save
- O revertir el commit en la rama y push:
  git revert <commit-sha>
  git push origin update/baileys-7
