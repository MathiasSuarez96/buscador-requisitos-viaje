/**
 * Fuente de solo lectura: resultado oficial de «Check if you need a UK visa» (GOV.UK) para el
 * contexto del buscador: pasaporte de Uruguay, sin doble ciudadanía británica o irlandesa,
 * turismo o visita a familia y amigos. La URL codifica esas tres respuestas; el resultado se
 * acepta solo si el resumen «Your answers» de la propia página repite exactamente las mismas.
 *
 * Contenido publicado bajo la Open Government Licence v3.0 (GOV.UK, «Terms and conditions»):
 * se puede reproducir citando la fuente. Se consulta a lo sumo unas pocas veces por día.
 *
 * - leerResultado(): una consulta GET (lectura-http-oficial.js), host www.gov.uk.
 * - extraer(html): pura. Campos 'resultado' y 'contexto', con evidencia; sin evidencia
 *   suficiente el campo queda 'ambiguo' y nunca se elige un valor.
 *     resultado: 'eta_o_visa'  título «You'll need an electronic travel authorisation (ETA) or a
 *                               visa» Y la lista «You must apply for either:» con exactamente
 *                               ETA y Standard Visitor visa;
 *                'visa'        título «You'll need a visa to come to the UK».
 *                Cualquier otro título → ambiguo (no se interpreta). La ausencia de un país en
 *                una lista nunca se usa: solo cuenta la respuesta afirmativa de la página.
 *     contexto:  las tres respuestas del resumen, exactamente las de la consulta.
 * - normalizarHechos(lectura): pura. 'govuk-check-uk-visa-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, texto, recortar } = require('./lectura-http-oficial');

const URL_RESULTADO = 'https://www.gov.uk/check-uk-visa/y/uruguay/no/tourism';
const HOST_OFICIAL = 'www.gov.uk';
const FUENTE_NOMBRE = 'GOV.UK';
const AGENTE = 'buscador-requisitos-viaje/adaptador-govuk-check-uk-visa';
const ESQUEMA_HECHOS = 'govuk-check-uk-visa-hechos-v1';
const CAMPOS = Object.freeze(['resultado', 'contexto']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY', doble_ciudadania_britanica_o_irlandesa: 'no', motivo: 'turismo' });
// Preguntas del resumen → respuesta esperada para el contexto de la consulta.
const RESPUESTAS = Object.freeze([
  ['what’s your nationality as shown on your passport or travel document?', 'uruguay', 'nacionalidad'],
  ['are you a dual british or irish citizen?', 'no', 'doble_ciudadania_britanica_o_irlandesa'],
  ['what are you coming to the uk to do?', 'tourism or visiting family and friends', 'motivo']
]);
const RESULTADOS = Object.freeze(['eta_o_visa', 'visa']);

const norm = t => t.replace(/[’']/g, '’').replace(/\s+/g, ' ').trim().toLowerCase();
const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });
const definido = (valor, ev) => ({ estado: 'ok', valor, evidencia: ev.map(recortar) });

function resumenRespuestas(main) {
  const pares = [...main.matchAll(/<dt\b[^>]*govuk-summary-list__key[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*govuk-summary-list__value[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map(m => [texto(m[1]), texto(m[2])]);
  return pares;
}

function campoContexto(main) {
  const pares = resumenRespuestas(main);
  const ev = pares.map(([p, r]) => `${p} ${r}`);
  if (pares.length !== RESPUESTAS.length) return ambiguo(`sin_evidencia: el resumen tiene ${pares.length} respuestas (se esperaban ${RESPUESTAS.length})`, ev);
  for (const [pregunta, esperada] of RESPUESTAS) {
    const r = pares.filter(([p]) => norm(p) === pregunta);
    if (r.length !== 1) return ambiguo(`sin_evidencia: falta o se repite la pregunta «${pregunta}»`, ev);
    if (norm(r[0][1]) !== esperada) return ambiguo(`contexto_no_coincide: «${pregunta}» respondida «${r[0][1]}»`, ev);
  }
  return definido({ ...CONTEXTO }, ev);
}

function campoResultado(main) {
  const bloque = main.match(/<div\b[^>]*\bid="result-info"[^>]*>([\s\S]*)$/i);
  if (!bloque || (main.match(/\bid="result-info"/gi) ?? []).length !== 1) return ambiguo('sin_evidencia: no hay exactamente un bloque de resultado');
  const h1 = bloque[1].match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  if (!h1 || !/information based on your answers/i.test(texto(h1[1]))) return ambiguo('sin_evidencia: la página no es un resultado («Information based on your answers»)');
  const resto = bloque[1].slice(h1.index + h1[0].length);
  const h2 = resto.match(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i);
  if (!h2) return ambiguo('sin_evidencia: el resultado no tiene título');
  const titulo = texto(h2[1]);
  const t = norm(titulo);
  if (t === norm("You'll need an electronic travel authorisation (ETA) or a visa")) {
    const cuerpo = resto.slice(h2.index + h2[0].length);
    const lista = cuerpo.match(/^[\s\S]*?<p>\s*You must apply for either:\s*<\/p>\s*<ul>([\s\S]*?)<\/ul>/i);
    if (!lista) return ambiguo('contradiccion: el título dice ETA o visa, pero falta la lista «You must apply for either:»', [titulo]);
    const items = [...lista[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(m => texto(m[1]));
    const claves = items.map(i => norm(i)).sort();
    if (claves.join('|') !== ['a standard visitor visa', 'an electronic travel authorisation (eta)'].join('|')) {
      return ambiguo('contradiccion: la lista de opciones no es exactamente ETA o Standard Visitor visa', [titulo, ...items]);
    }
    return definido('eta_o_visa', [titulo, `You must apply for either: ${items.join('; ')}`]);
  }
  if (t === norm("You'll need a visa to come to the UK")) return definido('visa', [titulo]);
  return ambiguo('no_reconocido: el título del resultado no es una redacción admitida', [titulo]);
}

// Pura. Resultado completo a partir del HTML.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const campos = main === null
    ? Object.fromEntries(CAMPOS.map(c => [c, ambiguo('sin_evidencia: no hay exactamente un <main>')]))
    : { resultado: campoResultado(main), contexto: campoContexto(main) };
  return {
    estado: Object.values(campos).every(c => c.estado === 'ok') ? 'ok' : 'ambiguo',
    fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') },
    campos
  };
}

// Pura. Solo los datos canónicos (lo único que entra en hechos_hash).
function normalizarHechos(l) {
  if (!RESULTADOS.includes(l?.resultado)) return { ok: false, campo: 'resultado' };
  const c = l?.contexto;
  if (c === null || typeof c !== 'object' || Object.keys(CONTEXTO).some(k => c[k] !== CONTEXTO[k])) return { ok: false, campo: 'contexto' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, resultado: l.resultado } };
}

function leerResultado({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_RESULTADO, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

// campoContexto lo reutiliza la fuente de la misma página para la frontera (govuk-check-uk-visa-frontera.js).
module.exports = { URL_RESULTADO, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, RESULTADOS, extraer, normalizarHechos, leerResultado, campoContexto };
