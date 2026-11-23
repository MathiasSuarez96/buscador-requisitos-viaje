/**
 * Fuente de solo lectura: página «Visas» de la Embajada de Italia en Montevideo (Ministerio de
 * Asuntos Exteriores de Italia, esteri.it). Es la única fuente oficial italiana probada que responde
 * a un cliente automático y habla EXPLÍCITAMENTE de viajeros uruguayos (vistoperitalia.esteri.it
 * no respondió; ver docs/lote-procedencia-gb-it.md).
 *
 * Contexto del buscador: uruguayo NATURAL residente en Uruguay, pasaporte uruguayo, turismo. Solo
 * cuentan dos párrafos con su redacción oficial COMPLETA (anclada):
 *   P1 «Los residentes en Uruguay que sean naturales uruguayos no necesitan de visa de ingreso al
 *      espacio Schengen para viajes por turismo de hasta N días. Será suficiente una vigencia residual
 *      del pasaporte de M meses a la fecha prevista de salida del espacio Schengen.»
 *   P2 «Los residentes en Uruguay que sean ciudadanos legales uruguayos pueden necesitar de una visa,
 *      aunque sea por turismo, según su nacionalidad de origen. …» (condición de nacionalidad que la
 *      descripción publicada debe repetir).
 * Se analiza TODO el texto del contenedor (delimitado contando divs anidados), en cualquier etiqueta
 * (párrafo, lista, div). Si P1 o P2 faltan, se repiten o cambian, o si OTRO segmento menciona Uruguay, Schengen, pasaporte,
 * turismo o estadías (una condición nueva que no se interpreta), los dos campos quedan ambiguos.
 * Nunca se deduce nada de la ausencia de un dato.
 *
 * Condiciones de uso (notas legales de esteri.it): textos protegidos y prohibido el uso NO transparente
 * de partes del sitio. Se guarda el hecho normalizado, fragmentos breves como evidencia interna y el
 * enlace; la descripción publicada es redacción propia.
 *
 * - leerPagina(): una consulta GET (lectura-http-oficial.js), host ambmontevideo.esteri.it.
 * - extraer(html): pura. Campos 'visa' ({ requerida:'no', dias }) y 'pasaporte' ({ meses_tras_salida }).
 * - normalizarHechos(valores): pura. 'embajada-italia-montevideo-visas-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, recortar, segmentosTexto, interiorDiv } = require('./lectura-http-oficial');

const URL_PAGINA = 'https://ambmontevideo.esteri.it/es/servizi-consolari-e-visti/servizi-per-il-cittadino-straniero/visas/';
const HOST_OFICIAL = 'ambmontevideo.esteri.it';
const FUENTE_NOMBRE = 'Embajada de Italia en Montevideo';
const AGENTE = 'buscador-requisitos-viaje/adaptador-embajada-italia-montevideo';
const ESQUEMA_HECHOS = 'embajada-italia-montevideo-visas-hechos-v1';
const CAMPOS = Object.freeze(['visa', 'pasaporte']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY', condicion_nacionalidad: 'natural', residencia: 'UY', documento: 'pasaporte', motivo: 'turismo' });

const P1 = /^Los residentes en Uruguay que sean naturales uruguayos no necesitan de visa de ingreso al espacio Schengen para viajes por turismo de hasta (\d{1,3}) días\. Será suficiente una vigencia residual del pasaporte de (\d{1,2}) meses a la fecha prevista de salida del espacio Schengen\.$/;
const P2 = /^Los residentes en Uruguay que sean ciudadanos legales uruguayos pueden necesitar de una visa, aunque sea por turismo, según su nacionalidad de origen\. La visa requerida se expedirá en el pasaporte nacional de origen\.$/;
// Cualquier otro párrafo con estas palabras podría agregar o quitar condiciones: no se interpreta.
const SENSIBLE = /urugua|schengen|pasaporte|turismo|tur[ií]stic|estad[ií]a|estancia|\bd[ií]as\b|exent|exim/i;

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });
const definido = (valor, ev) => ({ estado: 'ok', valor, evidencia: ev.map(recortar) });

function extraerCampos(main) {
  const ambos = (motivo, ev = []) => ({ visa: ambiguo(motivo, ev), pasaporte: ambiguo(motivo, ev) });
  const aperturas = [...main.matchAll(/<div\b[^>]*class="entry-content"[^>]*>/gi)];
  if (aperturas.length !== 1) return ambos(`sin_evidencia: hay ${aperturas.length} bloques de contenido (se esperaba uno)`);
  // Límite real del contenedor (con divs anidados) y TODO su texto, en cualquier etiqueta.
  const interior = interiorDiv(main, aperturas[0].index);
  if (interior === null) return ambos('no_reconocido: el bloque de contenido no cierra; no se puede delimitar');
  const parrafos = segmentosTexto(interior).map(t => t.normalize('NFC'));
  const p1 = parrafos.filter(p => /naturales uruguayos/i.test(p));
  const p2 = parrafos.filter(p => /ciudadanos legales uruguayos/i.test(p));
  if (p1.length !== 1) return ambos(`sin_evidencia: el párrafo de los uruguayos naturales aparece ${p1.length} veces`);
  if (p2.length !== 1) return ambos(`sin_evidencia: el párrafo de los ciudadanos legales aparece ${p2.length} veces`, p1);
  const m = p1[0].match(P1);
  if (!m) return ambos('no_reconocido: el párrafo de los uruguayos naturales no tiene la redacción admitida', p1);
  if (!P2.test(p2[0])) return ambos('no_reconocido: el párrafo de los ciudadanos legales no tiene la redacción admitida', [p1[0], p2[0]]);
  const otros = parrafos.filter(p => p !== p1[0] && p !== p2[0] && SENSIBLE.test(p));
  if (otros.length) return ambos(`condicionada: otro párrafo menciona condiciones de ingreso (${otros.length}); no se interpreta`, [p1[0], ...otros]);
  const [oracionVisa, oracionPasaporte] = p1[0].split(/(?<=\.)\s+/);
  return {
    visa: definido({ requerida: 'no', dias: Number(m[1]) }, [oracionVisa, p2[0]]),
    pasaporte: definido({ meses_tras_salida: Number(m[2]) }, [oracionPasaporte])
  };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const campos = main === null
    ? Object.fromEntries(CAMPOS.map(c => [c, ambiguo('sin_evidencia: no hay exactamente un <main>')]))
    : extraerCampos(main);
  return { estado: Object.values(campos).every(c => c.estado === 'ok') ? 'ok' : 'ambiguo',
    fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos };
}

// Pura. Acepta los valores extraídos ({visa, pasaporte}) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.visa ?? (l?.visa_requerida === 'no' ? { requerida: 'no', dias: l?.estancia_dias_max } : null);
  if (v === null || typeof v !== 'object' || v.requerida !== 'no' || !Number.isInteger(v.dias) || v.dias < 1 || v.dias > 365) return { ok: false, campo: 'visa' };
  const p = l?.pasaporte ?? (Object.hasOwn(l ?? {}, 'pasaporte_meses_tras_salida') ? { meses_tras_salida: l.pasaporte_meses_tras_salida } : null);
  if (p === null || typeof p !== 'object' || !Number.isInteger(p.meses_tras_salida) || p.meses_tras_salida < 0 || p.meses_tras_salida > 24) return { ok: false, campo: 'pasaporte' };
  // Hechos guardados: el contexto debe ser exactamente el de la consulta (sin depender del orden de claves).
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== Object.keys(CONTEXTO).length
    || Object.keys(CONTEXTO).some(k => c[k] !== CONTEXTO[k]))) return { ok: false, campo: 'visa' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visa_requerida: 'no', estancia_dias_max: v.dias,
    pasaporte_meses_tras_salida: p.meses_tras_salida, ciudadanos_legales: 'segun_nacionalidad_de_origen' } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_PAGINA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, extraer, normalizarHechos, leerPagina };
