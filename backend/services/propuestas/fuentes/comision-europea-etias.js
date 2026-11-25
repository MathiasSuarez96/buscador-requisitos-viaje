/**
 * Fuente de solo lectura: página ETIAS de la Dirección General de Migración y Asuntos de Interior de
 * la Comisión Europea (home-affairs.ec.europa.eu). Es HTML servido por el servidor (el sitio
 * travel-europe.europa.eu es una aplicación de JavaScript y no se interpreta).
 *
 * Qué respalda: el ETIAS (autorización de viaje para viajeros exentos de visado) NO está en
 * funcionamiento y no se reciben solicitudes. El hecho no depende de la nacionalidad ni del país
 * Schengen de destino: mientras el sistema no funcione, nadie tiene que tramitarlo. Por eso sirve,
 * sin deducir nada, para los requisitos «ETIAS (Schengen)» de todos los destinos del catálogo.
 *
 * Solo cuentan, con su redacción COMPLETA (anclada), dentro del único bloque «Important notice»:
 *   N «The European Travel Information and Authorisation System (ETIAS) is currently not in
 *      operation and no applications for travel authorisations are collected at this point. The
 *      European Union will inform about the specific date for the start of ETIAS several months
 *      prior to its launch.»
 *   E «ETIAS is a new travel requirement for visa-free travellers visiting N European countries for
 *      a short stay (i.e. for up to D days within any P-day period). …» (alcance de la estadía corta).
 * Cualquier OTRO texto de <main> (dentro o fuera del bloque, en cualquier etiqueta) que hable de
 * funcionamiento, inicio, fechas, años, solicitudes u obligatoriedad y no sea uno de los textos
 * conocidos de abajo deja el campo ambiguo: puede anunciar la fecha de inicio o la obligatoriedad.
 * De E solo se da por validada la primera oración: el resto del párrafo se revisa igual que cualquier
 * otro texto. Si N o E faltan, se repiten (en cualquier lugar de <main>) o cambian, también es
 * ambiguo. Nunca se deduce nada de la ausencia de un dato.
 *
 * Reutilización: el contenido de la Comisión se puede reutilizar citando la fuente (Decisión
 * 2011/833/UE). Igual se publica redacción propia, se enlaza la página y se guardan fragmentos breves.
 *
 * - leerPagina(): una consulta GET (lectura-http-oficial.js), host home-affairs.ec.europa.eu.
 * - extraer(html): pura. Campo 'etias' ({ en_funcionamiento:'no', paises, estancia_dias, periodo_dias }).
 * - normalizarHechos(valores): pura. 'comision-europea-etias-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, recortar, segmentosTexto, interiorDiv } = require('./lectura-http-oficial');

const URL_PAGINA = 'https://home-affairs.ec.europa.eu/policies/schengen/smart-borders/european-travel-information-authorisation-system_en';
const HOST_OFICIAL = 'home-affairs.ec.europa.eu';
const FUENTE_NOMBRE = 'Comisión Europea (Migración y Asuntos de Interior)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-comision-europea-etias';
const ESQUEMA_HECHOS = 'comision-europea-etias-hechos-v1';
const CAMPOS = Object.freeze(['etias']);

const N = /^The European Travel Information and Authorisation System \(ETIAS\) is currently not in operation and no applications for travel authorisations are collected at this point\. The European Union will inform about the specific date for the start of ETIAS several months prior to its launch\.$/;
const E = /^ETIAS is a new travel requirement for visa-free travellers visiting (\d{1,2}) European countries for a short stay \(i\.e\. for up to (\d{1,3}) days within any (\d{1,3})-day period\)\. /;
// Palabras que podrían anunciar el inicio, una fecha o la obligatoriedad.
const SENSIBLE = /operation|operational|go(?:es)? live|start|launch|mandatory|compulsory|obligator|required|requirement|must|need to|apply|applica|\b(?:19|20)\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december/i;
// Textos del bloque conocidos al 24/11/2026 que mencionan esas palabras sin cambiar el hecho (qué
// pasará cuando funcione, la tasa futura, quién lo desarrolla, antecedentes). Si cambian, ambiguo.
const CONOCIDOS = Object.freeze([
  'Applicants will be able to apply via an official website and/or app for mobile devices once the system goes live.',
  'ETIAS fee has been set at EUR 20 instead of the previous EUR 7. The new fee takes into account the rise in inflation since 2018 and additional operational costs related to new technical features integrated into the system. It also brings the cost for an ETIAS travel authorisation in line with similar travel authorisation programmes around the globe. The adjustment of the fee is now undergoing a two-month review period of the Council and the European Parliament (renewable once). It will enter into effect as soon as ETIAS is operational.',
  'The European Agency for the operational management of large-scale IT systems in the area of freedom, security and justice (eu-LISA) is responsible for developing the system.',
  'The European Commission first introduced the idea of a ETIAS in April 2016 in the Communication "Stronger and Smarter Information Systems for Borders and Security" and adopted the proposal on 16 November 2016. After negotiations with the European Parliament and the Council the ETIAS Regulation (EU) 2018/1240 was adopted on 12 September 2018 and entered into force on 9 October 2018.'
]);

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });

function extraerCampo(main) {
  const aperturas = [...main.matchAll(/<div\b[^>]*>(?=\s*<h2\b[^>]*>\s*Important notice\s*<\/h2>)/gi)];
  if (aperturas.length !== 1) return ambiguo(`sin_evidencia: hay ${aperturas.length} bloques «Important notice» (se esperaba uno)`);
  const interior = interiorDiv(main, aperturas[0].index);
  if (interior === null) return ambiguo('no_reconocido: el bloque del aviso no cierra; no se puede delimitar');
  const enBloque = segmentosTexto(interior).map(t => t.normalize('NFC'));
  // Todo el texto de <main> (también el que rodea al bloque). Las exclusiones son por POSICIÓN: un
  // texto igual al aviso en otro lugar no se omite, y del párrafo de definición solo se excluye lo
  // que la gramática consumió.
  const segmentos = segmentosTexto(main).map(t => t.normalize('NFC'));
  const esAviso = s => /in operation/i.test(s) && /ETIAS/.test(s);
  const esAlcance = s => /^ETIAS is a new travel requirement/.test(s);
  const avisos = segmentos.filter(esAviso);
  if (avisos.length !== 1 || enBloque.filter(esAviso).length !== 1) return ambiguo(`sin_evidencia: el aviso sobre el funcionamiento aparece ${avisos.length} veces`, avisos.slice(0, 3));
  if (!N.test(avisos[0])) return ambiguo('no_reconocido: el aviso sobre el funcionamiento no tiene la redacción admitida', avisos);
  const alcances = segmentos.filter(esAlcance);
  if (alcances.length !== 1 || enBloque.filter(esAlcance).length !== 1) return ambiguo(`sin_evidencia: la definición de la estadía corta aparece ${alcances.length} veces`, avisos);
  const m = alcances[0].match(E);
  if (!m) return ambiguo('no_reconocido: la definición de la estadía corta no tiene la redacción admitida', [avisos[0], alcances[0]]);
  const iAviso = segmentos.indexOf(avisos[0]), iAlcance = segmentos.indexOf(alcances[0]);
  // Lo que sigue a la primera oración de la definición no está validado: se revisa como cualquier otro texto.
  const resto = alcances[0].slice(m[0].length);
  const otros = segmentos.map((s, i) => (i === iAviso ? '' : i === iAlcance ? resto : s))
    .filter(s => s !== '' && SENSIBLE.test(s) && !CONOCIDOS.includes(s));
  if (otros.length) return ambiguo(`condicionada: otro texto de la página menciona funcionamiento, fechas u obligatoriedad (${otros.length}); no se interpreta`, [avisos[0], ...otros]);
  return { estado: 'ok', valor: { en_funcionamiento: 'no', paises: Number(m[1]), estancia_dias: Number(m[2]), periodo_dias: Number(m[3]) },
    evidencia: [avisos[0], m[0].trim()].map(recortar) };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const etias = main === null ? ambiguo('sin_evidencia: no hay exactamente un <main>') : extraerCampo(main);
  return { estado: etias.estado, fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos: { etias } };
}

const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

// Pura. Acepta los valores extraídos ({ etias }) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.etias ?? (l?.esquema === ESQUEMA_HECHOS ? { en_funcionamiento: l.etias_en_funcionamiento, paises: l.paises, estancia_dias: l.estancia_corta?.dias, periodo_dias: l.estancia_corta?.periodo_dias } : null);
  if (v === null || typeof v !== 'object' || v.en_funcionamiento !== 'no' || !entero(v.paises, 1, 60) || !entero(v.estancia_dias, 1, 365) || !entero(v.periodo_dias, 1, 365)) return { ok: false, campo: 'etias' };
  if (l?.esquema === ESQUEMA_HECHOS && (l.solicitudes !== 'no_se_reciben' || l.fecha_inicio !== 'sin_anunciar')) return { ok: false, campo: 'etias' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, etias_en_funcionamiento: 'no', solicitudes: 'no_se_reciben', fecha_inicio: 'sin_anunciar',
    paises: v.paises, estancia_corta: { dias: v.estancia_dias, periodo_dias: v.periodo_dias } } };
}

function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_PAGINA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONOCIDOS, extraer, normalizarHechos, leerPagina };
