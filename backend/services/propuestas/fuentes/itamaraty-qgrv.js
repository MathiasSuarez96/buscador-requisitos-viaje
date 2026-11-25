/**
 * Fuente de solo lectura: Quadro Geral de Regime de Vistos (QGRV) del Ministerio de Relaciones
 * Exteriores de Brasil (Itamaraty, gov.br/mre). Respalda la VISA de visita para nacionales de Uruguay.
 *
 * Contexto del buscador: NACIONALIDAD uruguaya (fila «Uruguai» del cuadro «para a Entrada de
 * Estrangeiros no Brasil»), columna VIVIS = «Visto de Visita, para portadores de passaporte comum»
 * (motivo: visita; documento: pasaporte común). La marca «#» = «Ingresso permitido com Cédula de
 * Identidade Civil». El cuadro NO dice ninguna vigencia del documento: no se publica (el requisito de
 * validez de Brasil queda pendiente, ver docs/lote-ar-br-cl.md).
 *
 * El nombre del PDF cambia con cada versión (p. ej. qgrv-simples-port-07out26.pdf). Una lectura hace
 * DOS consultas: la página del cuadro, donde debe haber EXACTAMENTE un enlace con el texto «Quadro
 * Geral de Regime de Vistos (QGRV) - Versão em Português» a un PDF de la misma carpeta oficial, y ese
 * PDF. Si el enlace falta o se repite, la lectura es ambigua (no se adivina otro archivo); si alguna
 * consulta falla, la fuente no está disponible.
 *
 * Del PDF (texto-pdf.js) solo cuentan, anclados completos:
 *  - en la leyenda: «VIVIS ·Visto de Visita, para portadores de passaporte comum», «#·Ingresso
 *    permitido com Cédula de Identidade Civil» y «4. Dispensa de visto, por até 90 dias.» (N días);
 *  - la ÚNICA línea de todo el PDF que menciona Uruguay: país exactamente «Uruguai», en una página con
 *    el encabezado «PAÍS/REGIÃO · PADIP · PASOF · VIVIS», y en la columna VIVIS EXACTAMENTE «4 #».
 * Otra marca en la celda (*, @, otra nota), otro código, otra leyenda, otra mención de Uruguay o un
 * PDF que no se puede leer → ambiguo. Además, toda línea que no sea una fila de país (leyenda, base
 * legal, notas, encabezados) tiene que ser una de las conocidas (textos-conocidos/itamaraty-qgrv.json);
 * solo se ignoran fragmentos de códigos, la fecha de actualización y la paginación. Una nota general
 * nueva → ambiguo. Las filas de OTROS países no se interpretan. Nunca se deduce nada de la ausencia de un dato.
 *
 * - leerPagina(): dos consultas GET (lectura-http-oficial.js), host www.gov.br.
 * - extraer(sobre): pura. Campo 'visa' ({ requerida: 'no', dias, cedula: 'ingreso_permitido' }).
 * - normalizarHechos(valores): pura. 'itamaraty-qgrv-hechos-v1'.
 */
const { createHash } = require('node:crypto');
const { leerPaginaOficial, recortar, decodificar } = require('./lectura-http-oficial');
const { lineasPdf, ErrorPdfNoReconocido } = require('./texto-pdf');

const URL_PAGINA = 'https://www.gov.br/mre/pt-br/assuntos/portal-consular/vistos/quadro-geral-de-regime-de-vistos-para-entrada-de-estrangeiros-no-brasil';
const HOST_OFICIAL = 'www.gov.br';
const CARPETA_PDF = /^https:\/\/www\.gov\.br\/mre\/pt-br\/assuntos\/portal-consular\/vistos\/[a-z0-9-]{1,80}\.pdf$/;
const TEXTO_ENLACE = 'Quadro Geral de Regime de Vistos (QGRV) - Versão em Português';
const FUENTE_NOMBRE = 'Ministério das Relações Exteriores do Brasil (Itamaraty)';
const AGENTE = 'buscador-requisitos-viaje/adaptador-itamaraty-qgrv';
const ESQUEMA_HECHOS = 'itamaraty-qgrv-hechos-v1';
const CAMPOS = Object.freeze(['visa']);
const CONTEXTO = Object.freeze({ nacionalidad: 'UY', documento: 'passaporte_comum', motivo: 'visita' });

const SEP = '�';
const LEYENDA_VIVIS = `VIVIS ${SEP}Visto de Visita, para portadores de passaporte comum`;
const LEYENDA_CEDULA = `#${SEP}Ingresso permitido com Cédula de Identidade Civil`;
const LEYENDA_4 = /^4\. Dispensa de visto, por até (\d{1,3}) dias\.$/;
const ENCABEZADO = Object.freeze(['PAÍS', '/REGIÃO', 'PADIP', 'PASOF', 'VIVIS']);
const MARGEN = 30;
// Líneas que no son filas de países (leyenda, base legal, notas, encabezados), 07/10/2026: cada una
// tiene que ser conocida. Se ignoran solo fragmentos de códigos, la fecha de actualización y la paginación.
const CONOCIDAS = new Set(require('./textos-conocidos/itamaraty-qgrv.json').huellas);
const IGNORADAS = /^[\d#*@\-� ]+$|^\(Atualizado em .{1,40} de \d{4}\)$|^(pág\.|Pg\. \d{1,2})$/;
const huella = t => createHash('sha256').update(t).digest('hex').slice(0, 16);

const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(recortar), motivo });

function extraerDelPdf(pdf) {
  let lineas;
  try { lineas = lineasPdf(pdf).map(l => ({ ...l, texto: l.texto.normalize('NFC') })); }
  catch (e) { if (e instanceof ErrorPdfNoReconocido) return ambiguo(`no_reconocido: el PDF no se puede leer (${e.message})`); throw e; }
  const unica = (pred, nombre) => {
    const ls = lineas.filter(pred);
    return ls.length === 1 ? ls[0] : nombre;
  };
  const vivis = unica(l => l.texto === LEYENDA_VIVIS, 'la leyenda de VIVIS');
  const cedula = unica(l => l.texto === LEYENDA_CEDULA, 'la leyenda de #');
  const cuatro = unica(l => LEYENDA_4.test(l.texto), 'la leyenda del código 4');
  for (const x of [vivis, cedula, cuatro]) if (typeof x === 'string') return ambiguo(`no_reconocido: ${x} no aparece exactamente una vez con la redacción admitida`);
  const urug = lineas.filter(l => /urugu/i.test(l.texto));
  if (urug.length !== 1) return ambiguo(`sin_evidencia: Uruguay aparece en ${urug.length} líneas del cuadro (se esperaba una)`, urug.slice(0, 3).map(l => l.texto));
  const [fila] = urug;
  const encabezados = lineas.filter(l => l.pagina === fila.pagina && l.bloques.length === ENCABEZADO.length && l.bloques.every((b, i) => b.texto.trim() === ENCABEZADO[i]));
  if (encabezados.length !== 1) return ambiguo('no_reconocido: la fila de Uruguay no está bajo el encabezado PAÍS/REGIÃO · PADIP · PASOF · VIVIS', [fila.texto]);
  const x = Object.fromEntries(encabezados[0].bloques.slice(2).map(b => [b.texto.trim(), b.x]));
  const columna = b => (b.x < x.PADIP - MARGEN ? 'pais' : b.x < x.PASOF - MARGEN ? 'PADIP' : b.x < x.VIVIS - MARGEN ? 'PASOF' : 'VIVIS');
  const celda = c => fila.bloques.filter(b => columna(b) === c).map(b => b.texto.trim()).filter(Boolean).join(' ');
  const ev = [`Uruguai · VIVIS ${celda('VIVIS')}`, cuatro.texto, LEYENDA_VIVIS.replace(SEP, '– '), LEYENDA_CEDULA.replace(SEP, ' – ')];
  if (celda('pais') !== 'Uruguai') return ambiguo('no_reconocido: la fila no es exactamente «Uruguai»', [fila.texto]);
  if (celda('VIVIS') !== '4 #') return ambiguo(`condicionada: la columna VIVIS de Uruguay dice «${celda('VIVIS').slice(0, 20)}»; solo se admite «4 #»`, ev);
  // Fuera de las filas de países, cada línea tiene que ser conocida: una nota general nueva puede
  // agregar condiciones para todos (también para Uruguay).
  const columnas = {};
  for (const l of lineas) if (l.bloques.length === ENCABEZADO.length && l.bloques.every((b, i) => b.texto.trim() === ENCABEZADO[i])) columnas[l.pagina] = Object.fromEntries(l.bloques.slice(2).map(b => [b.texto.trim(), b.x]));
  const esFila = l => { const c = columnas[l.pagina]; return !!c && l.bloques[0].x < c.PADIP - MARGEN && l.bloques.some(b => b.x >= c.PADIP - MARGEN) && l.bloques.every(b => b.x < c.PADIP - MARGEN || /^[\d#*@ ]*$/.test(b.texto.trim())); };
  const nuevas = lineas.filter(l => l !== fila && !esFila(l) && !IGNORADAS.test(l.texto) && !CONOCIDAS.has(huella(l.texto)));
  if (nuevas.length) return ambiguo(`condicionada: el cuadro tiene notas o leyendas nuevas o cambiadas (${nuevas.length}); no se interpretan`, [ev[0], ...nuevas.slice(0, 3).map(l => l.texto)]);
  return { estado: 'ok', valor: { requerida: 'no', dias: Number(cuatro.texto.match(LEYENDA_4)[1]), cedula: 'ingreso_permitido' }, evidencia: ev };
}

// Pura. `sobre` es el JSON que arma leerPagina: { enlace, pdf } o { enlace: null, motivo }.
function extraer(sobre, fuente = {}) {
  const huella = createHash('sha256').update(String(sobre)).digest('hex');
  let s;
  try { s = JSON.parse(sobre); } catch { s = null; }
  const visa = s === null || typeof s !== 'object' ? ambiguo('no_reconocido: lectura sin la forma esperada')
    : s.enlace === null ? ambiguo(`sin_evidencia: ${String(s.motivo).slice(0, 120)}`)
      : !CARPETA_PDF.test(s.enlace) || typeof s.pdf !== 'string' ? ambiguo('no_reconocido: el PDF no es de la carpeta oficial del cuadro')
        : extraerDelPdf(s.pdf);
  return { estado: visa.estado, fuente: { ...fuente, contenido_sha256: huella }, campos: { visa } };
}

// Pura. Acepta los valores extraídos ({ visa }) o hechos ya normalizados.
function normalizarHechos(l) {
  const v = l?.visa ?? (l?.esquema === ESQUEMA_HECHOS ? { requerida: l.visto_visita_requerido, dias: l.dispensa_dias_max, cedula: l.cedula_identidade_civil } : null);
  if (v === null || typeof v !== 'object' || v.requerida !== 'no' || !Number.isInteger(v.dias) || v.dias < 1 || v.dias > 365 || v.cedula !== 'ingreso_permitido') return { ok: false, campo: 'visa' };
  const c = l.contexto;
  if (Object.hasOwn(l, 'contexto') && (c === null || typeof c !== 'object' || Object.keys(c).length !== Object.keys(CONTEXTO).length
    || Object.keys(CONTEXTO).some(k => c[k] !== CONTEXTO[k]))) return { ok: false, campo: 'visa' };
  return { ok: true, hechos: { esquema: ESQUEMA_HECHOS, contexto: { ...CONTEXTO }, visto_visita_requerido: 'no', dispensa_dias_max: v.dias, cedula_identidade_civil: 'ingreso_permitido' } };
}

// Pura. Enlace al PDF vigente en la página del cuadro.
function enlacePdf(html) {
  const enlaces = [...String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .filter(m => decodificar(m[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() === TEXTO_ENLACE)
    .map(m => (m[1].match(/\bhref="([^"]*)"/i) ?? [])[1] ?? null);
  const unicos = [...new Set(enlaces)];
  if (unicos.length !== 1) return { enlace: null, motivo: `hay ${unicos.length} enlaces distintos al cuadro en portugués (se esperaba uno)` };
  if (!CARPETA_PDF.test(decodificar(unicos[0] ?? ''))) return { enlace: null, motivo: 'el enlace al cuadro no apunta a un PDF de la carpeta oficial' };
  return { enlace: decodificar(unicos[0]) };
}

async function leerPagina({ fetch, ahora, timeoutMs } = {}) {
  const op = { hosts: [HOST_OFICIAL], agente: AGENTE, fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const pagina = await leerPaginaOficial({ ...op, url: URL_PAGINA });
  if (pagina.tipo === 'fallo') return pagina;
  const e = enlacePdf(pagina.html);
  if (e.enlace === null) return { ...pagina, html: JSON.stringify(e) };
  const pdf = await leerPaginaOficial({ ...op, url: e.enlace, contenido: 'pdf', bytesMaximos: 8 * 1024 * 1024 });
  const diagnostico = { ...pdf.diagnostico, consultado_en: pagina.diagnostico.consultado_en, pagina: { url_final: pagina.diagnostico.url_final, http_status: pagina.diagnostico.http_status } };
  if (pdf.tipo === 'fallo') return { ...pdf, diagnostico };
  return { tipo: 'respuesta', html: JSON.stringify({ enlace: e.enlace, pdf: pdf.html }), recibida_en: pdf.recibida_en, diagnostico };
}

module.exports = { URL_PAGINA, HOST_OFICIAL, FUENTE_NOMBRE, ESQUEMA_HECHOS, CAMPOS, CONTEXTO, TEXTO_ENLACE, extraer, enlacePdf, normalizarHechos, leerPagina };
