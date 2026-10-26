# Decisiones del panel

`decisiones-panel.json` define los cuatro cuerpos HTTP para aprobar/rechazar contratos 1.0 y 2.0. `$payload_hash` se sustituye por el hash real de la propuesta de cada prueba; los demás campos y las claves se comparan exactamente.

- Frontend: `tests/panel/decisiones.prueba.tsx` comprueba el POST generado por el controlador real, incluyendo selección, aceptación de advertencias y confirmación.
- Backend: `scripts/test-panel-decisiones-mongo.js` envía esos mismos cuerpos a la ruta real con Mongo efímero y comprueba CAS, evento y estado persistido.
- La suite Mongo también verifica GET incompleto y POST 422 sin escrituras para un cambio de descripción de 10 001 caracteres.

Son dos suites enlazadas por un fixture compartido; no una ejecución única del navegador contra Mongo.
