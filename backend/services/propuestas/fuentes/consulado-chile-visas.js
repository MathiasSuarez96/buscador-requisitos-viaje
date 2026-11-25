/**
 * Fuente de solo lectura: tabla de visas de la Red Consular de Chile (Ministerio de Relaciones
 * Exteriores, consulado.gob.cl). La página «Información sobre visas para ingresar a Chile» carga esta
 * tabla JSON por nacionalidad y la muestra como «¿Requiere visa?» y «Plazo máximo estadía». Respalda
 * la VISA para nacionales de Uruguay.
 *
 * Contexto del buscador: NACIONALIDAD uruguaya (el selector de la página es «Nacionalidad»). La tabla
 * no dice el motivo del viaje ni el documento: no se publican. Tampoco se publican prórrogas ni
 * pasajes de regreso (no están en la tabla).
 *
 * Solo cuenta la ÚNICA fila con pais exactamente "URUGUAY", con EXACTAMENTE estas claves y valores:
 *   visa "NO" · visa_simple_estadia N (dígitos; el plazo máximo de estadía) · visa_simple_arancel "0" ·
 *   visa_multiple_arancel "0" · visa_multiple_estadia igual a N · notas "1,2,17" (las notas generales
 *   de la tabla, iguales a las de los países vecinos al 25/11/2026).
 * Otra fila de Uruguay, otra clave, otra nota (puede ser una condición particular) u otro valor →
 * ambiguo. JSON inválido o que no es una lista → ambiguo. Nunca se deduce nada de la ausencia de un dato.
 *
 * - leerPagina(): una consulta GET (lectura-http-oficial.js, contenido 'json'), host www.consulado.gob.cl.
 * - extraer(json): pura. Campo 'visa' ({ requerida: 'no', dias }).
 * - normalizarHechos(valores): pura. 'consulado-chile-visas-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, recortar } = require('./lectura-http-oficial');

const URL_TABLA = 'https://www.consulado.gob.cl/consulados/stat/info_visas/info_visas.json';
// Página que el viajero puede abrir (la que muestra esta tabla al elegir la nacionalidad).
const URL_PAGINA = 'https://www.consulado.gob.cl/informacion-sobre-visas-para-ingresar-a-chile';
const HOST_OFICIAL = 'www.consulado.gob.cl';
const FUENTE_NOMBRE = 'Red Consular de Chile (Ministerio de Relaciones Exteriores)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-consulado-chile';
const ESQUEMA_HECHOS = 'consulado-chile-visas-hechos-v1';
const CAMPOS = Object.freeze(['visa']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY' });
const CLAVES = Object.freeze(['notas', 'pais', 'visa', 'visa_multiple_arancel', 'visa_multiple_estadia', 'visa_simple_arancel', 'visa_simple_estadia']);
const NOTAS = '1,2,17';

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });

function extraerCampo(texto) {
  let tabla;
  try { tabla = JSON.parse(texto); } catch { return ambiguo('no_reconocido: la tabla no es JSON'); }
  if (!Array.isArray(tabla)) return ambiguo('no_reconocido: la tabla no es una lista');
  const filas = tabla.filter(f => f !== null && typeof f === 'object' && typeof f.pais === 'string' && /urugu/i.test(f.pais));
  if (filas.length !== 1) return ambiguo(`sin_evidencia: Uruguay aparece ${filas.length} veces en la tabla`, filas.slice(0, 3).map(f => JSON.stringify(f)));
  const [f] = filas;
  const ev = [JSON.stringify(Object.fromEntries(Object.keys(f).sort().map(k => [k, f[k]])))];
  if (f.pais !== 'URUGUAY') return ambiguo('no_reconocido: el país de la fila no es exactamente URUGUAY', ev);
  if (Object.keys(f).sort().join(',') !== CLAVES.join(',')) return ambiguo('no_reconocido: la fila de Uruguay tiene otras columnas', ev);
  if (f.notas !== NOTAS) return ambiguo(`condicionada: la fila de Uruguay tiene otras notas (${String(f.notas).slice(0, 40)}); no se interpretan`, ev);
  if (f.visa !== 'NO') return ambiguo(`no_reconocido: «¿Requiere visa?» dice ${JSON.stringify(String(f.visa).slice(0, 20))}`, ev);
  if (!/^\d{1,3}$/.test(f.visa_simple_estadia) || f.visa_multiple_estadia !== f.visa_simple_estadia || f.visa_simple_arancel !== '0' || f.visa_multiple_arancel !== '0') {
    return ambiguo('no_reconocido: plazos o aranceles de Uruguay fuera de la forma admitida', ev);
  }
  return { estado: 'ok', valor: { requerida: 'no', dias: Number(f.visa_simple_estadia) }, evidencia: ev };
}

// Pura.
function extraer(texto, fuente = {}) {
  const visa = extraerCampo(String(texto));
  return { estado: visa.estado, fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(texto)).digest('hex') }, campos: { visa } };
}

// Pura. Acepta los valores extraídos ({ visa }) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.visa ?? (l?.esquema === ESQUEMA_HECHOS ? { requerida: l.visa_requerida, dias: l.plazo_maximo_estadia_dias } : null);
  if (v === null || typeof v !== 'object' || v.requerida !== 'no' || !Number.isInteger(v.dias) || v.dias < 1 || v.dias > 365) return { ok: false, campo: 'visa' };
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== 1 || c.nacionalidad !== 'UY')) return { ok: false, campo: 'visa' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visa_requerida: 'no', plazo_maximo_estadia_dias: v.dias } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_TABLA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, contenido: 'json', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_TABLA, URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, extraer, normalizarHechos, leerPagina };
