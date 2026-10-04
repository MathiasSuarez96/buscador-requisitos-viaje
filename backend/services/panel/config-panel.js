/**
 * Configuración del panel a partir del entorno. Todo o nada: si una
 * variable falta o es inválida se lanza ErrorConfiguracionPanel y el panel
 * entero responde 503 (falla cerrado); la API pública no se ve afectada.
 *
 *  - GOOGLE_CLIENT_ID: client ID de Google (forma <n>-<x>.apps.googleusercontent.com).
 *  - OPERADORES_PANEL_JSON: ver operadores-panel.js (`[]` es válido).
 *  - PANEL_ORIGENES_PERMITIDOS: orígenes exactos separados por coma
 *    (https://host[:puerto], sin ruta ni barra final). http solo para
 *    localhost / 127.0.0.1 (desarrollo).
 *
 * Los mensajes nunca repiten los valores de las variables.
 */

const { CLIENT_ID_GOOGLE } = require('./verificar-token-google');
const { ErrorConfiguracionPanel, cargarOperadoresPanel, congelarProfundo } = require('./operadores-panel');

const HOSTS_HTTP_PERMITIDOS = ['localhost', '127.0.0.1'];

function cargarOrigenes(texto) {
  const falla = (m) => {
    throw new ErrorConfiguracionPanel(`PANEL_ORIGENES_PERMITIDOS: ${m}`);
  };
  if (typeof texto !== 'string' || texto.trim() === '') falla('ausente o vacía.');
  const origenes = texto.split(',').map((o) => o.trim());
  for (const [i, o] of origenes.entries()) {
    let url;
    try {
      url = new URL(o);
    } catch {
      falla(`el origen ${i} no es una URL.`);
    }
    if (url.origin !== o) falla(`el origen ${i} debe ser exactamente esquema://host[:puerto], sin ruta ni barra final.`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && HOSTS_HTTP_PERMITIDOS.includes(url.hostname))) {
      falla(`el origen ${i} debe ser https (http solo para localhost).`);
    }
  }
  if (new Set(origenes).size !== origenes.length) falla('orígenes repetidos.');
  return origenes;
}

function cargarConfigPanel(env = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (typeof clientId !== 'string' || !CLIENT_ID_GOOGLE.test(clientId)) {
    throw new ErrorConfiguracionPanel('GOOGLE_CLIENT_ID: ausente o con forma inválida.');
  }
  const operadores = cargarOperadoresPanel(env.OPERADORES_PANEL_JSON);
  const origenes = cargarOrigenes(env.PANEL_ORIGENES_PERMITIDOS);
  return congelarProfundo({ clientId, operadores, origenes });
}

module.exports = { cargarConfigPanel, cargarOrigenes, ErrorConfiguracionPanel };
