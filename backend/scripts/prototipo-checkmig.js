/**
 * CLI de SOLO LECTURA sobre la fuente de CheckMig (services/propuestas/fuentes/migracion-colombia-checkmig.js).
 * El parser vive en ese módulo; este script solo imprime el resultado por campo en JSON.
 *
 * Uso:
 *   node scripts/prototipo-checkmig.js               consulta real de la ficha (una lectura)
 *   node scripts/prototipo-checkmig.js --html f.html  extrae de un archivo local (sin red)
 *
 * Estados: 'ok' (exit 0), 'ambiguo' (exit 2) y 'no_disponible' (exit 3). Independiente de Mongo,
 * Atlas, el aplicador 2.0 y el frontend: no escribe nada.
 */
const { readFileSync } = require('node:fs');
const { URL_FICHA, CAMPOS, bloquesPrincipales, tituloPrincipal, extraer, leerFicha } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');

function noDisponible(fuente, motivo) {
  return { estado: 'no_disponible', fuente, campos: Object.fromEntries(CAMPOS.map(c => [c, { estado: 'no_disponible', valor: null, evidencia: [], motivo }])) };
}

// Consulta real (fetch inyectable para las pruebas). Nunca lanza: todo fallo es no_disponible.
async function consultar({ fetch, ahora } = {}) {
  const l = await leerFicha({ fetch, ahora });
  const fuente = { url: URL_FICHA, ...l.diagnostico };
  if (l.tipo === 'fallo') return noDisponible(fuente, `consulta_fallida: ${l.motivo}`);
  return extraer(l.html, fuente);
}

module.exports = { URL_FICHA, bloquesPrincipales, tituloPrincipal, extraer, consultar };

if (require.main === module) {
  const i = process.argv.indexOf('--html');
  const salida = i > 0
    ? Promise.resolve(extraer(readFileSync(process.argv[i + 1], 'utf8'), { url: URL_FICHA, archivo_local: process.argv[i + 1], consultado_en: new Date().toISOString() }))
    : consultar();
  salida.then(r => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); process.exitCode = r.estado === 'ok' ? 0 : r.estado === 'ambiguo' ? 2 : 3; });
}
