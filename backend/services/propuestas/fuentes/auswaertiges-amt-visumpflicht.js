/**
 * Fuente de solo lectura: «Staatenliste zur Visumpflicht» del Auswärtiges Amt (Ministerio Federal de
 * Relaciones Exteriores de Alemania), tabla oficial de obligación de visa para ingresar a Alemania.
 *
 * Contexto del buscador: pasaporte nacional uruguayo, turismo (estadía corta sin actividad
 * remunerada). Solo cuenta la fila POSITIVA «Uruguay | Ja/Nein (notas)»: si la fila no existe o se
 * repite, el campo queda ambiguo. La ausencia en la tabla nunca se interpreta.
 *
 * Condiciones de uso (Impressum del sitio): los textos están protegidos por derechos de autor y el
 * sitio pide enlazar en lugar de copiar. Por eso se guarda solo el hecho normalizado, fragmentos breves
 * como evidencia interna (≤ 240 caracteres) y un enlace; la descripción publicada es redacción propia.
 *
 * - leerLista(): una consulta GET (lectura-http-oficial.js), host www.auswaertiges-amt.de.
 * - extraer(html): pura. Campos:
 *     visa:     de la única fila «Uruguay» bajo el encabezado «Visumpflicht für Deutschland: Ja/Nein».
 *               Formas admitidas, y solo con la celda del país EXACTAMENTE «Uruguay» (sin notas):
 *                 «Ja» sin notas → 'si' (estancia null);
 *                 «Nein (1)»     → 'no', con la nota 1) en su redacción oficial COMPLETA (anclada):
 *                                  pasaportes nacionales, hasta N días por período de M, sin actividad
 *                                  remunerada → estancia {dias, periodo_dias, actividad_remunerada}.
 *               Cualquier otra nota (en la celda del país o en la del valor, con Ja o con Nein), una
 *               nota 1) restringida o con texto agregado, u otro valor: los DOS campos quedan ambiguos
 *               ('condicionada' o 'no_reconocido'). Una condición particular nunca se generaliza.
 * - normalizarHechos(lectura): pura. 'auswaertiges-amt-visumpflicht-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, marcadoPrincipal, decodificar, texto, recortar } = require('./lectura-http-oficial');

const URL_LISTA = 'https://www.auswaertiges-amt.de/de/service/visa-und-aufenthalt/staatenliste-zur-visumpflicht/207820';
const HOST_OFICIAL = 'www.auswaertiges-amt.de';
const FUENTE_NOMBRE = 'Auswärtiges Amt';
const AGENTE = 'buscador-requisitos-viaje/adaptador-auswaertiges-amt';
const ESQUEMA_HECHOS = 'auswaertiges-amt-visumpflicht-hechos-v1';
const CAMPOS = Object.freeze(['visa', 'estancia']);
const NACIONALIDAD = 'Uruguay';
const CONTEXTO = Object.freeze({ nacionalidad: 'UY', documento: 'pasaporte_nacional', motivo: 'turismo' });
const NOTAS_ADMITIDAS = Object.freeze(['1']);
// Redacción oficial completa de la nota 1) (texto normalizado: espacios simples). Días y período se
// capturan y deben repetirse igual en la oración de los acuerdos bilaterales.
const NOTA_1_ADMITIDA = new RegExp('^Inhaber von Nationalpässen der Staaten, die zur Einreise nach Deutschland kein Visum benötigen '
  + '\\(Angabe: [„"“]Nein[“"”]\\), dürfen sich ohne Visum grundsätzlich nicht länger als (\\d{1,3}) Tage je Zeitraum von (\\d{1,3}) Tagen '
  + 'im Bundesgebiet aufhalten\\. Zudem dürfen sie während dieses Zeitraums keine Erwerbstätigkeit aufnehmen\\. '
  + 'Mit bestimmten Staaten hat Deutschland bilaterale Visumbefreiungsabkommen abgeschlossen, die unter Umständen einen längeren '
  + 'Aufenthalt in Deutschland über (\\d{1,3}) Tage je Zeitraum von (\\d{1,3}) Tagen hinaus ermöglichen\\. '
  + 'Nähere Informationen hierzu enthalten die Websites der deutschen Auslandsvertretungen in den betroffenen Staaten\\.$');

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });
const definido = (valor, ev) => ({ estado: 'ok', valor, evidencia: ev.map(recortar) });
const norm = t => t.normalize('NFC').replace(/\s+/g, ' ').trim();
const BLOQUE = /<\/?(p|li|ul|ol|h[1-6]|div|section|article|table|tr|td|th|br|dd|dt)\b[^>]*>/gi;

function filas(tabla) {
  return [...tabla.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(m => [...m[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(c => norm(texto(c[1]))));
}

// Notas al pie del contenido principal, después de la tabla: «N) texto».
function notas(main) {
  const despues = main.slice(main.search(/<\/table\s*>/i));
  const lineas = decodificar(despues.replace(BLOQUE, '\n').replace(/<[^>]*>/g, ' ')).split('\n').map(norm).filter(Boolean);
  const mapa = new Map();
  for (const l of lineas) {
    const m = l.match(/^(\d{1,2})\)\s+(.+)$/);
    if (m) mapa.set(m[1], [...(mapa.get(m[1]) ?? []), m[2]]);
  }
  return mapa;
}

function extraerCampos(main) {
  const tablas = main.match(/<table\b[\s\S]*?<\/table\s*>/gi) ?? [];
  if (tablas.length !== 1) return { visa: ambiguo(`sin_evidencia: hay ${tablas.length} tablas (se esperaba una)`), estancia: ambiguo('sin_evidencia: sin tabla') };
  const fs = filas(tablas[0]);
  const encabezado = fs.find(f => f.length === 2 && /visumpflicht\s+f[üu]r\s+deutschland/i.test(f[1]) && /ja\s*\/\s*nein/i.test(f[1]));
  if (!encabezado) return { visa: ambiguo('sin_evidencia: la tabla no tiene el encabezado «Visumpflicht für Deutschland: Ja/Nein»'), estancia: ambiguo('sin_evidencia: sin encabezado') };
  // La fila se ubica por el nombre con o sin notas, pero solo se interpreta si la celda del país es
  // EXACTAMENTE «Uruguay»: una nota del país es una condición que no se generaliza.
  const propias = fs.filter(f => f.length >= 1 && f[0].replace(/\s*\(\d+(?:\s*,\s*\d+)*\)\s*$/, '') === NACIONALIDAD);
  if (propias.length !== 1) return { visa: ambiguo(`sin_evidencia: la fila «${NACIONALIDAD}» aparece ${propias.length} veces`), estancia: ambiguo('sin_evidencia: sin fila') };
  const fila = propias[0];
  const evFila = `${fila.join(': ')} (${encabezado[1]})`;
  // Sin hechos confirmados: los dos campos quedan ambiguos, nunca uno solo.
  const ambos = (motivo, ev = [evFila]) => ({ visa: ambiguo(motivo, ev), estancia: ambiguo(motivo, ev) });
  if (fila.length !== 2) return ambos('no_reconocido: la fila no tiene dos celdas');
  if (fila[0] !== NACIONALIDAD) return ambos(`condicionada: la celda del país cita notas («${fila[0]}»); no se interpretan`);
  const m = fila[1].match(/^(Ja|Nein)\s*(?:\(\s*(\d{1,2}(?:\s*,\s*\d{1,2})*)\s*\))?$/);
  if (!m) return ambos('no_reconocido: el valor no es «Ja» ni «Nein (notas)»');
  const citadas = (m[2] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  // Únicas formas admitidas: «Ja» sin notas y «Nein (1)».
  if (m[1] === 'Ja') {
    if (citadas.length) return ambos(`condicionada: «Ja» cita las notas (${citadas.join(', ')}); no se interpretan`);
    return { visa: definido('si', [evFila]), estancia: definido(null, [evFila]) };
  }
  if (citadas.join(',') !== NOTAS_ADMITIDAS.join(',')) {
    return ambos(`condicionada: la fila cita las notas (${citadas.join(', ') || 'ninguna'}); solo se interpreta la nota 1`);
  }
  const textos = notas(main).get('1') ?? [];
  if (textos.length !== 1) return ambos(`sin_evidencia: la nota 1) aparece ${textos.length} veces`);
  const t = textos[0];
  // La nota 1) se acepta solo con la redacción oficial COMPLETA (anclada): cualquier restricción o
  // agregado (p. ej. «Nur … mit biometrischen Pässen») la deja sin interpretar.
  const plazo = t.match(NOTA_1_ADMITIDA);
  if (!plazo || plazo[1] !== plazo[3] || plazo[2] !== plazo[4]) return ambos('no_reconocido: la nota 1) no tiene la redacción completa admitida', [evFila, `1) ${t}`]);
  const oracion = t.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
  const visa = definido('no', [evFila]);
  return { visa, estancia: definido({ dias: Number(plazo[1]), periodo_dias: Number(plazo[2]), actividad_remunerada: 'no_permitida' }, [evFila, `1) ${oracion}`]) };
}

// Pura.
function extraer(html, fuente = {}) {
  const main = marcadoPrincipal(html);
  const campos = main === null ? { visa: ambiguo('sin_evidencia: no hay exactamente un <main>'), estancia: ambiguo('sin_evidencia: no hay exactamente un <main>') } : extraerCampos(main);
  return { estado: Object.values(campos).every(c => c.estado === 'ok') ? 'ok' : 'ambiguo',
    fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos };
}

// Pura. Ignora la evidencia; valores fuera de dominio → {ok:false, campo}.
function normalizarHechos(l) {
  const visa = l?.visa ?? l?.visa_requerida;
  if (visa !== 'si' && visa !== 'no') return { ok: false, campo: 'visa' };
  const e = l?.estancia;
  if (visa === 'si') {
    if (e !== null) return { ok: false, campo: 'estancia' };
  } else {
    const ok = e !== null && typeof e === 'object' && Number.isInteger(e.dias) && e.dias >= 1 && e.dias <= 365
      && Number.isInteger(e.periodo_dias) && e.periodo_dias >= e.dias && e.periodo_dias <= 730 && e.actividad_remunerada === 'no_permitida';
    if (!ok) return { ok: false, campo: 'estancia' };
  }
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visa_requerida: visa,
    estancia: visa === 'si' ? null : { dias: e.dias, periodo_dias: e.periodo_dias, actividad_remunerada: e.actividad_remunerada } } };
}

function leerLista({ fetch, ahora, timeoutMs } = {}) {
  return leerPaginaOficial({ url: URL_LISTA, hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

module.exports = { URL_LISTA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, extraer, normalizarHechos, leerLista };
