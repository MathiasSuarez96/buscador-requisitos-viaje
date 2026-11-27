/**
 * Fuente de solo lectura: tabla de visas de la Red Consular de Chile (Ministerio de Relaciones
 * Exteriores, consulado.gob.cl). La página «Información sobre visas para ingresar a Chile» carga, con
 * su script oficial (/consulados/js-local/v1/ArancelesVisas.class.js), DOS JSON: la tabla por
 * nacionalidad (info_visas.json) y el texto de las notas (notas_visas.json). Al elegir la nacionalidad
 * muestra «¿Requiere visa?», plazos y aranceles, y debajo el texto de cada nota que la fila referencia.
 * Respalda la VISA para nacionales de Uruguay.
 *
 * Contexto del buscador: NACIONALIDAD uruguaya (el selector de la página es «Nacionalidad»). La fila no
 * dice el documento: no se publica. El motivo sale SOLO de las notas referenciadas: las columnas son
 * visas de «permanencia transitoria». No se publican prórrogas ni pasajes de regreso (no están).
 *
 * Solo cuenta la ÚNICA fila con pais exactamente "URUGUAY", con EXACTAMENTE estas claves y valores:
 *   visa "NO" · visa_simple_estadia N (dígitos) · visa_multiple_estadia igual a N ·
 *   visa_simple_arancel "0" · visa_multiple_arancel "0" · notas "1,2,17".
 * Y cada nota referenciada tiene que estar en notas_visas.json con EXACTAMENTE el texto interpretado
 * (NOTAS, abajo; vigente al 26/11/2026). El significado de una nota se toma de SU texto, nunca de la
 * fila de otro país:
 *   (1) «Visa de permanencia transitoria simple, una entrada, plazo máximo D días.»  → la columna
 *       simple es la de una entrada; D tiene que ser igual a N.
 *   (2) «Visa de permanencia transitoria múltiple, varias entradas, plazo máximo D días, salvo
 *       excepciones. Contempla arancel acorde a…» → la columna múltiple es la de varias entradas,
 *       «salvo excepciones»; D tiene que ser igual a N.
 *   (17) recargo del 10 % sobre el valor base si el cobro es en moneda local → solo modifica un
 *       arancel; los de Uruguay son "0". No agrega una condición de ingreso.
 * Nota ausente, con otro texto, otro plazo, nota no interpretada, otra fila de Uruguay, otra clave u
 * otro valor → ambiguo. JSON inválido o sin la forma esperada → ambiguo. Nunca se deduce nada de la
 * ausencia de un dato. El texto de las tres notas forma parte de los hechos: si cambia entre la
 * detección y la revalidación, la lectura no coincide.
 *
 * - leerPagina(): dos consultas GET (lectura-http-oficial.js, contenido 'json'), host www.consulado.gob.cl.
 * - extraer(sobre): pura. `sobre` = JSON { tabla, notas } (los dos cuerpos). Campo 'visa'
 *   ({ requerida: 'no', dias, notas: [{ numero, texto }] }).
 * - normalizarHechos(valores): pura. 'consulado-chile-visas-hechos-v2'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, recortar } = require('./lectura-http-oficial');

const URL_TABLA = 'https://www.consulado.gob.cl/consulados/stat/info_visas/info_visas.json';
const URL_NOTAS = 'https://www.consulado.gob.cl/consulados/site/edic/base/port/notas_visas.json';
// Página que el viajero puede abrir (la que muestra la tabla y las notas al elegir la nacionalidad).
const URL_PAGINA = 'https://www.consulado.gob.cl/informacion-sobre-visas-para-ingresar-a-chile';
const HOST_OFICIAL = 'www.consulado.gob.cl';
const FUENTE_NOMBRE = 'Red Consular de Chile (Ministerio de Relaciones Exteriores)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-consulado-chile';
const ESQUEMA_HECHOS = 'consulado-chile-visas-hechos-v2';
const CAMPOS = Object.freeze(['visa']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY' });
const CLAVES = Object.freeze(['notas', 'pais', 'visa', 'visa_multiple_arancel', 'visa_multiple_estadia', 'visa_simple_arancel', 'visa_simple_estadia']);
const NOTAS_FILA = '1,2,17';
// Texto interpretado de cada nota (función del plazo D cuando lo tiene).
const NOTAS = Object.freeze({
  1: d => `(1) Visa de permanencia transitoria simple, una entrada, plazo máximo ${d} días.`,
  2: d => `(2) Visa de permanencia transitoria múltiple, varias entradas, plazo máximo ${d} días, salvo excepciones. Contempla arancel acorde a lo dispuesto en el artículo 13 del Decreto Supremo N°296, de 2021, del Ministerio del Interior y Seguridad Pública.`,
  17: () => 'En aquellos países donde el cobro se realice en moneda local, se aplicará un recargo del 10 % sobre el valor base.'
});
const notasPara = dias => NOTAS_FILA.split(',').map(n => ({ numero: n, texto: NOTAS[n](dias) }));
const PLAZO_NOTA = { 1: /^\(1\) Visa de permanencia transitoria simple, una entrada, plazo máximo (\d{1,3}) días\.$/, 2: /^\(2\) Visa de permanencia transitoria múltiple, varias entradas, plazo máximo (\d{1,3}) días, salvo excepciones\./ };

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });
const ordenada = f => JSON.stringify(Object.fromEntries(Object.keys(f).sort().map(k => [k, f[k]])));

function extraerCampo(tablaTexto, notasTexto) {
  let tabla, notas;
  try { tabla = JSON.parse(tablaTexto); } catch { return ambiguo('no_reconocido: la tabla no es JSON'); }
  if (!Array.isArray(tabla)) return ambiguo('no_reconocido: la tabla no es una lista');
  const filas = tabla.filter(f => f !== null && typeof f === 'object' && typeof f.pais === 'string' && /urugu/i.test(f.pais));
  if (filas.length !== 1) return ambiguo(`sin_evidencia: Uruguay aparece ${filas.length} veces en la tabla`, filas.slice(0, 3).map(f => JSON.stringify(f)));
  const [f] = filas;
  const ev = [ordenada(f)];
  if (f.pais !== 'URUGUAY') return ambiguo('no_reconocido: el país de la fila no es exactamente URUGUAY', ev);
  if (Object.keys(f).sort().join(',') !== CLAVES.join(',')) return ambiguo('no_reconocido: la fila de Uruguay tiene otras columnas', ev);
  if (f.notas !== NOTAS_FILA) return ambiguo(`condicionada: la fila de Uruguay tiene otras notas (${String(f.notas).slice(0, 40)}); no se interpretan`, ev);
  if (f.visa !== 'NO') return ambiguo(`no_reconocido: «¿Requiere visa?» dice ${JSON.stringify(String(f.visa).slice(0, 20))}`, ev);
  if (!/^\d{1,3}$/.test(f.visa_simple_estadia) || f.visa_multiple_estadia !== f.visa_simple_estadia || f.visa_simple_arancel !== '0' || f.visa_multiple_arancel !== '0') {
    return ambiguo('no_reconocido: plazos o aranceles de Uruguay fuera de la forma admitida', ev);
  }
  // Las notas que la fila referencia: cada una tiene que estar y decir EXACTAMENTE lo interpretado.
  try { notas = JSON.parse(notasTexto); } catch { return ambiguo('no_reconocido: las notas no son JSON', ev); }
  if (notas === null || typeof notas !== 'object' || Array.isArray(notas)) return ambiguo('no_reconocido: las notas no son un objeto por número', ev);
  const dias = Number(f.visa_simple_estadia);
  const leidas = [];
  for (const n of NOTAS_FILA.split(',')) {
    if (!Object.hasOwn(notas, n)) return ambiguo(`sin_evidencia: la nota ${n} que referencia Uruguay no está publicada`, ev);
    if (typeof notas[n] !== 'string') return ambiguo(`no_reconocido: la nota ${n} no es texto`, ev);
    const texto = notas[n].normalize('NFC');
    leidas.push(`nota ${n}: ${texto}`);
    const plazo = PLAZO_NOTA[n] && texto.match(PLAZO_NOTA[n]);
    if (plazo && Number(plazo[1]) !== dias) return ambiguo(`condicionada: la nota ${n} indica ${plazo[1]} días y la fila ${dias}; no se interpreta`, [...ev, ...leidas]);
    if (texto !== NOTAS[n](dias)) return ambiguo(`condicionada: la nota ${n} tiene un texto que no se interpreta`, [...ev, ...leidas]);
  }
  return { estado: 'ok', valor: { requerida: 'no', dias, notas: notasPara(dias) }, evidencia: [...ev, ...leidas].map(recortar) };
}

// Pura. `sobre` es el JSON que arma leerPagina: { tabla, notas } con los dos cuerpos como texto.
function extraer(sobre, fuente = {}) {
  const huella = createHash('sha256').update(String(sobre)).digest('hex');
  let s;
  try { s = JSON.parse(sobre); } catch { s = null; }
  const visa = s === null || typeof s !== 'object' || typeof s.tabla !== 'string' || typeof s.notas !== 'string'
    ? ambiguo('no_reconocido: lectura sin la tabla y las notas') : extraerCampo(s.tabla, s.notas);
  return { estado: visa.estado, fuente: { ...fuente, contenido_sha256: huella }, campos: { visa } };
}

const notasIguales = (a, b) => Array.isArray(a) && a.length === b.length
  && a.every((x, i) => x !== null && typeof x === 'object' && Object.keys(x).sort().join(',') === 'numero,texto' && x.numero === b[i].numero && x.texto === b[i].texto);

// Pura. Acepta los valores extraídos ({ visa }) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.visa ?? (l?.esquema === ESQUEMA_HECHOS ? { requerida: l.visa_requerida, dias: l.plazo_maximo_estadia_dias, notas: l.notas, categoria: l.categoria } : null);
  if (v === null || typeof v !== 'object' || v.requerida !== 'no' || !Number.isInteger(v.dias) || v.dias < 1 || v.dias > 365) return { ok: false, campo: 'visa' };
  if (!notasIguales(v.notas, notasPara(v.dias)) || (Object.hasOwn(v, 'categoria') && v.categoria !== 'permanencia_transitoria')) return { ok: false, campo: 'visa' };
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== 1 || c.nacionalidad !== 'UY')) return { ok: false, campo: 'visa' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visa_requerida: 'no', categoria: 'permanencia_transitoria', plazo_maximo_estadia_dias: v.dias, notas: notasPara(v.dias) } };
}

// Dos consultas: la tabla y las notas. Si alguna falla, la fuente no está disponible.
async function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  const op = { hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, contenido: 'json', ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const tabla = await leerPaginaOficial({ ...op, url: URL_TABLA });
  if (tabla.tipo === 'fallo') return tabla;
  const notas = await leerPaginaOficial({ ...op, url: URL_NOTAS });
  const diagnostico = { ...notas.diagnostico, consultado_en: tabla.diagnostico.consultado_en, tabla: { url_final: tabla.diagnostico.url_final, http_status: tabla.diagnostico.http_status } };
  if (notas.tipo === 'fallo') return { ...notas, diagnostico };
  return { tipo: 'respuesta', html: JSON.stringify({ tabla: tabla.html, notas: notas.html }), recibida_en: notas.recibida_en, diagnostico };
}

module.exports = { URL_TABLA, URL_NOTAS, URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, NOTAS_FILA, extraer, normalizarHechos, leerPagina };
