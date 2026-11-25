/**
 * Fuente de solo lectura: «Documentación para ingresar al país como turista» de la Dirección Nacional
 * de Migraciones (argentina.gob.ar/migraciones). Respalda el DOCUMENTO con el que un turista uruguayo
 * puede ingresar a la Argentina y su vigencia.
 *
 * Contexto del buscador: país de ORIGEN del documento Uruguay (la página dice «de su país de origen»,
 * no residencia), motivo TURISMO («descanso o esparcimiento»; el turista no puede realizar tareas
 * remuneradas). Documento: pasaporte vigente, o cédula de identidad vigente o documento de viaje hábil
 * vigente de los países listados (Uruguay incluido EXPRESAMENTE). La vigencia exigida es «vigente»: no
 * se publica ningún mínimo de meses, porque la página no lo da.
 *
 * Solo cuenta el cuerpo de la página (<div … property="content:encoded">, único) con EXACTAMENTE
 * estos cuatro textos, anclados completos:
 *   T «Turista: Es aquel extranjero que ingresa al país con propósito de descanso o esparcimiento, con
 *      un plazo de permanencia autorizado de hasta TRES (3) MESES PRORROGABLE POR OTRO PERÍODO SIMILAR.
 *      El extranjero que ingresa como turista no puede realizar tareas remuneradas.»
 *   «Requisitos:» · «Pasaporte (vigente), o» ·
 *   C «Cédula de Identidad (vigente) o Documento de viaje hábil (vigente) de su país de origen, siendo
 *      cualquiera de los siguientes Brasil, Bolivia, Uruguay, Paraguay, Chile, Perú, Venezuela, Ecuador y
 *      Colombia).»
 * Cualquier otro texto del cuerpo (en cualquier etiqueta) → ambiguo. Fuera del cuerpo, dentro de
 * <main>, CADA texto tiene que ser uno de los conocidos (navegación, título y botones para compartir;
 * textos-conocidos/argentina-migraciones-documentacion-turista.json); si no, ambiguo. Nunca se deduce nada de la ausencia de un dato.
 *
 * - leerPagina(): una consulta GET (lectura-http-oficial.js), host www.argentina.gob.ar.
 * - extraer(html): pura. Campo 'documento' ({ aceptados, vigencia }).
 * - normalizarHechos(valores): pura. 'argentina-migraciones-documentacion-turista-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, recortar, segmentosTexto, interiorDiv } = require('./lectura-http-oficial');

const URL_PAGINA = 'https://www.argentina.gob.ar/migraciones/documentacion-para-ingresar-al-pais-como-turista';
const HOST_OFICIAL = 'www.argentina.gob.ar';
const FUENTE_NOMBRE = 'Dirección Nacional de Migraciones (Argentina)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-argentina-migraciones';
const ESQUEMA_HECHOS = 'argentina-migraciones-documentacion-turista-hechos-v1';
const CAMPOS = Object.freeze(['documento']);
const CONTEXTO = Object.freeze({ pais_documento: 'UY', motivo: 'turismo' });
const ACEPTADOS = Object.freeze(['pasaporte', 'cedula_identidad', 'documento_viaje_habil']);

const T = 'Turista: Es aquel extranjero que ingresa al país con propósito de descanso o esparcimiento, con un plazo de permanencia autorizado de hasta TRES (3) MESES PRORROGABLE POR OTRO PERÍODO SIMILAR. El extranjero que ingresa como turista no puede realizar tareas remuneradas.';
const REQUISITOS = 'Requisitos:';
const P = 'Pasaporte (vigente), o';
const C = 'Cédula de Identidad (vigente) o Documento de viaje hábil (vigente) de su país de origen, siendo cualquiera de los siguientes Brasil, Bolivia, Uruguay, Paraguay, Chile, Perú, Venezuela, Ecuador y Colombia).';
const ESPERADOS = Object.freeze([T, REQUISITOS, P, C]);
// TODOS los textos de <main> fuera del cuerpo (navegación, título, compartir), 25/11/2026: una lista de
// palabras clave nunca es completa, así que cualquier texto nuevo o cambiado deja la lectura ambigua.
const CONOCIDOS = new Set(require('./textos-conocidos/argentina-migraciones-documentacion-turista.json').huellas);
const huella = t => createHash('sha256').update(t).digest('hex').slice(0, 16);

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });

function extraerCampo(main) {
  // La plantilla publica un cuerpo vacío antes del real: debe haber exactamente UNO con texto.
  const cuerpos = [...main.matchAll(/<div\b[^>]*\bproperty="content:encoded"[^>]*>/gi)].map(a => ({ a, interior: interiorDiv(main, a.index) }));
  if (cuerpos.some(c => c.interior === null)) return ambiguo('no_reconocido: un cuerpo de la página no cierra; no se puede delimitar');
  const conTexto = cuerpos.filter(c => segmentosTexto(c.interior).length > 0);
  if (conTexto.length !== 1) return ambiguo(`sin_evidencia: hay ${conTexto.length} cuerpos de página con texto (se esperaba uno)`);
  const [{ a: apertura, interior }] = conTexto;
  const aperturas = [apertura];
  const cuerpo = segmentosTexto(interior).map(t => t.normalize('NFC'));
  for (const [texto, nombre] of [[T, 'la definición de turista'], [P, 'el pasaporte'], [C, 'la cédula y los países']]) {
    const n = cuerpo.filter(s => s === texto).length;
    if (n !== 1) {
      const parecidos = cuerpo.filter(s => s.slice(0, 12) === texto.slice(0, 12));
      return parecidos.length ? ambiguo(`no_reconocido: ${nombre} no tiene la redacción admitida`, parecidos) : ambiguo(`sin_evidencia: ${nombre} aparece ${n} veces`);
    }
  }
  const otros = cuerpo.filter(s => !ESPERADOS.includes(s));
  if (otros.length || cuerpo.length !== ESPERADOS.length) return ambiguo(`condicionada: el cuerpo tiene otro texto (${otros.length}); no se interpreta`, [C, ...otros]);
  // Fuera del cuerpo: solo textos conocidos (cualquier texto nuevo o cambiado → ambiguo). El cuerpo se excluye por posición.
  const inicio = aperturas[0].index;
  const fuera = segmentosTexto(`${main.slice(0, inicio)} ${main.slice(inicio + aperturas[0][0].length + interior.length + '</div>'.length)}`).map(t => t.normalize('NFC'));
  const nuevos = fuera.filter(s => !CONOCIDOS.has(huella(s)));
  if (nuevos.length) return ambiguo(`condicionada: la página tiene textos nuevos o cambiados fuera del cuerpo (${nuevos.length}); no se interpretan`, [C, ...nuevos.slice(0, 4)]);
  return { estado: 'ok', valor: { aceptados: [...ACEPTADOS], vigencia: 'vigente' }, evidencia: [P, C, T].map(recortar) };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const documento = main === null ? ambiguo('sin_evidencia: no hay exactamente un <main>') : extraerCampo(main);
  return { estado: documento.estado, fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos: { documento } };
}

const mismaLista = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

// Pura. Acepta los valores extraídos ({ documento }) o hechos ya normalizados.
function normalizarHechos(l) {
  const d = l?.documento ?? (l?.esquema === ESQUEMA_HECHOS ? { aceptados: l.documentos_aceptados, vigencia: l.vigencia } : null);
  if (d === null || typeof d !== 'object' || !mismaLista(d.aceptados, ACEPTADOS) || d.vigencia !== 'vigente') return { ok: false, campo: 'documento' };
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== Object.keys(CONTEXTO).length
    || Object.keys(CONTEXTO).some(k => c[k] !== CONTEXTO[k]))) return { ok: false, campo: 'documento' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, documentos_aceptados: [...ACEPTADOS], vigencia: 'vigente' } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_PAGINA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, ACEPTADOS, extraer, normalizarHechos, leerPagina };
