/**
 * Fuente de solo lectura: sección «What you need at the UK border» del MISMO resultado oficial de
 * GOV.UK que ya usan los perfiles de visa y UK ETA (govuk-check-uk-visa.js): pasaporte de Uruguay,
 * sin doble ciudadanía británica o irlandesa, turismo. Esquema de hechos PROPIO: un cambio en esta
 * sección no vuelve ambigua la lectura de visa/ETA, y viceversa (las compatibilidades no se
 * superponen: misma URL, distinto esquema).
 *
 * - extraer(html): pura. Campos:
 *     pasaporte: dentro del único bloque de resultado, el único <h2> «What you need at the UK border»
 *                y, hasta el <h2> siguiente, el párrafo EXACTO «You must provide a valid passport or
 *                travel document. Your passport should be valid for the whole of your stay in the
 *                UK.» → 'toda_la_estadia'. Otro párrafo de la sección que mencione el pasaporte o el
 *                documento de viaje (p. ej. un mínimo de meses) → ambiguo ('condicionada').
 *     contexto:  las tres respuestas del resumen (misma regla que govuk-check-uk-visa.js).
 * - normalizarHechos(valores): pura. 'govuk-check-uk-visa-frontera-hechos-v1'.
 * Contenido bajo la Open Government Licence v3.0.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, texto, recortar } = require('./lectura-http-oficial');
const V = require('./govuk-check-uk-visa');

const AGENTE = 'buscador-requisitos-viaje/adaptador-govuk-check-uk-visa-frontera';
const ESQUEMA_HECHOS = 'govuk-check-uk-visa-frontera-hechos-v1';
const CAMPOS = Object.freeze(['pasaporte', 'contexto']);
const PARRAFO = 'You must provide a valid passport or travel document. Your passport should be valid for the whole of your stay in the UK.';
const norm = t => t.replace(/[’']/g, '’').replace(/\s+/g, ' ').trim();
const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });

function campoPasaporte(main) {
  if ((main.match(/\bid="result-info"/gi) ?? []).length !== 1) return ambiguo('sin_evidencia: no hay exactamente un bloque de resultado');
  const bloque = main.slice(main.search(/\bid="result-info"/i));
  const titulos = [...bloque.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)];
  const propios = titulos.filter(t => norm(texto(t[1])).toLowerCase() === 'what you need at the uk border');
  if (propios.length !== 1) return ambiguo(`sin_evidencia: la sección «What you need at the UK border» aparece ${propios.length} veces`);
  const desde = propios[0].index + propios[0][0].length;
  const siguiente = titulos.find(t => t.index > propios[0].index);
  const seccion = bloque.slice(desde, siguiente ? siguiente.index : undefined);
  const parrafos = [...seccion.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => norm(texto(m[2])));
  const exactos = parrafos.filter(p => p === norm(PARRAFO));
  if (exactos.length !== 1) return ambiguo('no_reconocido: la sección no tiene el párrafo admitido sobre la validez del pasaporte', parrafos.slice(0, 2));
  const otros = parrafos.filter(p => p !== norm(PARRAFO) && /passport|travel document|valid/i.test(p));
  if (otros.length) return ambiguo('condicionada: otra frase de la sección habla del pasaporte o de su validez; no se interpreta', [exactos[0], ...otros]);
  return { estado: 'ok', valor: 'toda_la_estadia', evidencia: [recortar(`What you need at the UK border: ${exactos[0]}`)] };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const campos = main === null
    ? Object.fromEntries(CAMPOS.map(c => [c, ambiguo('sin_evidencia: no hay exactamente un <main>')]))
    : { pasaporte: campoPasaporte(main), contexto: V.campoContexto(main) };
  return { estado: Object.values(campos).every(c => c.estado === 'ok') ? 'ok' : 'ambiguo',
    fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos };
}

// Pura.
function normalizarHechos(l) {
  const p = l?.pasaporte ?? l?.pasaporte_validez;
  if (p !== 'toda_la_estadia') return { ok: false, campo: 'pasaporte' };
  const c = l?.contexto;
  if (c === null || typeof c !== 'object' || Object.keys(V.CONTEXTO).some(k => c[k] !== V.CONTEXTO[k])) return { ok: false, campo: 'contexto' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...V.CONTEXTO }, pasaporte_validez: 'toda_la_estadia' } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: V.URL_RESULTADO, hosts: [V.HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_RESULTADO: V.URL_RESULTADO, FUENTE_NOMBRE: V.FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, PARRAFO, extraer, normalizarHechos, leerPagina };
