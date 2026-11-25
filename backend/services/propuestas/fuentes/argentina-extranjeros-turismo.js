/**
 * Fuente de solo lectura: «Extranjeros» de argentina.gob.ar (Gobierno de la Nación Argentina), guía
 * por motivo de viaje. Respalda la VISA de turismo para ciudadanos uruguayos.
 *
 * Contexto del buscador: NACIONALIDAD uruguaya (la página dice «Si eres ciudadano de…»), motivo
 * TURISMO, duración. No dice nada del documento con el que se ingresa (remite a otra página).
 *
 * Solo cuenta la rama Turismo → «Estado parte del Mercosur o estado asociado»: el bloque
 * <div id="section-turismo_mercosur">, dentro del único <div id="section-turismo">, con EXACTAMENTE
 *   V «Si eres ciudadano de Bolivia, Brasil, Paraguay o Uruguay (estados parte del Mercosur) o de Chile,
 *      Colombia, Ecuador, Guyana, Panamá, Perú o Surinam (estados asociados), puedes ingresar como
 *      turista sin visa por hasta N días.»  (anclada completa; N se captura)
 *   y los dos textos de navegación conocidos. Cualquier otro texto del bloque → ambiguo.
 * El resto de <main> (otros motivos: tránsito, trabajo, estudio…) no se interpreta, pero CADA texto
 * tiene que ser uno de los conocidos al 25/11/2026 (huellas en textos-conocidos/argentina-extranjeros.json).
 * Uno nuevo o cambiado → ambiguo: puede ser una condición nueva, en cualquier etiqueta (lista, div,
 * texto suelto, contenedor anidado). Quitar un texto no la deja ambigua (no agrega condiciones).
 * Nunca se deduce nada de la ausencia de un dato.
 *
 * - leerPagina(): una consulta GET (lectura-http-oficial.js), host www.argentina.gob.ar.
 * - extraer(html): pura. Campo 'visa' ({ requerida: 'no', dias }).
 * - normalizarHechos(valores): pura. 'argentina-extranjeros-turismo-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, recortar, segmentosTexto, interiorDiv } = require('./lectura-http-oficial');

const URL_PAGINA = 'https://www.argentina.gob.ar/tema/extranjeros';
const HOST_OFICIAL = 'www.argentina.gob.ar';
const FUENTE_NOMBRE = 'Gobierno de la Nación Argentina (argentina.gob.ar)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-argentina-extranjeros';
const ESQUEMA_HECHOS = 'argentina-extranjeros-turismo-hechos-v1';
const CAMPOS = Object.freeze(['visa']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY', motivo: 'turismo' });

const V = /^Si eres ciudadano de Bolivia, Brasil, Paraguay o Uruguay \(estados parte del Mercosur\) o de Chile, Colombia, Ecuador, Guyana, Panamá, Perú o Surinam \(estados asociados\), puedes ingresar como turista sin visa por hasta (\d{1,3}) días\.$/;
const NAVEGACION = Object.freeze(['El documento con el que puedes ingresar a la Argentina depende del país del que eres ciudadano.', 'Conoce cuáles son']);
// TODOS los textos de <main> fuera de la frase V (otros motivos, navegación), 25/11/2026: una lista de
// palabras clave nunca es completa, así que cualquier texto nuevo o cambiado deja la lectura ambigua.
const CONOCIDOS = new Set(require('./textos-conocidos/argentina-extranjeros.json').huellas);
const huella = t => createHash('sha256').update(t).digest('hex').slice(0, 16);

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });
const unDiv = (marcado, id) => [...marcado.matchAll(new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`, 'gi'))];

function extraerCampo(main) {
  const turismo = unDiv(main, 'section-turismo');
  if (turismo.length !== 1) return ambiguo(`sin_evidencia: hay ${turismo.length} secciones de turismo (se esperaba una)`);
  const interiorTurismo = interiorDiv(main, turismo[0].index);
  if (interiorTurismo === null) return ambiguo('no_reconocido: la sección de turismo no cierra; no se puede delimitar');
  // La rama Mercosur debe ser la que abre la opción «Estado parte del Mercosur o estado asociado» de turismo.
  if (!/data-parent="turismo"\s+data-target="turismo_mercosur"/.test(interiorTurismo)) return ambiguo('no_reconocido: la opción de turismo para el Mercosur no lleva a la rama esperada');
  const rama = unDiv(main, 'section-turismo_mercosur');
  if (rama.length !== 1 || unDiv(interiorTurismo, 'section-turismo_mercosur').length !== 1) return ambiguo(`sin_evidencia: la rama de turismo del Mercosur aparece ${rama.length} veces o fuera de turismo`);
  const interiorRama = interiorDiv(main, rama[0].index);
  if (interiorRama === null) return ambiguo('no_reconocido: la rama del Mercosur no cierra; no se puede delimitar');
  const enRama = segmentosTexto(interiorRama).map(t => t.normalize('NFC'));
  const frases = segmentosTexto(main).map(t => t.normalize('NFC')).filter(s => /puedes ingresar como turista sin visa/i.test(s));
  if (frases.length !== 1 || enRama.filter(s => /puedes ingresar como turista sin visa/i.test(s)).length !== 1) {
    return ambiguo(`sin_evidencia: la frase de ingreso sin visa aparece ${frases.length} veces en la página`, frases.slice(0, 3));
  }
  const m = frases[0].match(V);
  if (!m) return ambiguo('no_reconocido: la frase de ingreso sin visa no tiene la redacción admitida', frases);
  const otrosRama = enRama.filter(s => s !== frases[0] && !NAVEGACION.includes(s));
  if (otrosRama.length) return ambiguo(`condicionada: la rama del Mercosur tiene otro texto (${otrosRama.length}); no se interpreta`, [frases[0], ...otrosRama]);
  // Resto de <main>: solo textos conocidos (por posición, la frase V se excluye una vez).
  const segmentos = segmentosTexto(main).map(t => t.normalize('NFC'));
  const iV = segmentos.indexOf(frases[0]);
  const nuevos = segmentos.filter((s, i) => i !== iV && !CONOCIDOS.has(huella(s)));
  if (nuevos.length) return ambiguo(`condicionada: la página tiene textos nuevos o cambiados (${nuevos.length}); no se interpretan`, [frases[0], ...nuevos.slice(0, 4)]);
  return { estado: 'ok', valor: { requerida: 'no', dias: Number(m[1]) }, evidencia: [recortar(frases[0])] };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const visa = main === null ? ambiguo('sin_evidencia: no hay exactamente un <main>') : extraerCampo(main);
  return { estado: visa.estado, fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos: { visa } };
}

// Pura. Acepta los valores extraídos ({ visa }) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.visa ?? (l?.esquema === ESQUEMA_HECHOS ? { requerida: l.visa_requerida, dias: l.estancia_dias_max } : null);
  if (v === null || typeof v !== 'object' || v.requerida !== 'no' || !Number.isInteger(v.dias) || v.dias < 1 || v.dias > 365) return { ok: false, campo: 'visa' };
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== Object.keys(CONTEXTO).length
    || Object.keys(CONTEXTO).some(k => c[k] !== CONTEXTO[k]))) return { ok: false, campo: 'visa' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visa_requerida: 'no', estancia_dias_max: v.dias } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_PAGINA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, huella, extraer, normalizarHechos, leerPagina };
