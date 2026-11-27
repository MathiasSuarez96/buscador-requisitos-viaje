// Lote AR/BR/CL (IATA → fuentes oficiales del destino): AR visa, AR documento (cédula), BR visa, CL visa.
//  1. Extracción determinista con fixtures reales y mutaciones: condición dentro del texto admitido y al
//     final, listas, divs, texto suelto, contenedores anidados, duplicados, secciones faltantes y contexto
//     distinto. Una condición no interpretada da ambiguo, nunca confirmado. BR: texto del PDF escrito con
//     operadores que no se leen (' y ", fuera de BT, Do, anotaciones). CL: notas referenciadas ausentes,
//     cambiadas o con otro plazo, con la fila idéntica.
//  2. Adaptadores: hechos, caída y redirección sin lanzar; compatibilidades disjuntas.
//  3. Perfiles: requisito completo, cédula representada (pasaporte no obligatorio), sin cambio sin renovar.
//  4. Autorizaciones: cada perfil exige SU política.
//  5. Mongo efímero sembrado con la API pública del 25/11 + GET /api/destinos: fuente → clasificación →
//     aplicación → API; repetición sin escrituras; caída y recuperación (reintento); segunda lectura
//     distinta o ambigua sin publicar (incluidas una nota PDF y una nota chilena que aparecen en la segunda
//     lectura); regresión de los 13 perfiles activos.
// Nada toca Atlas ni la red (preload solo-loopback). exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const FA = require('../services/propuestas/fuentes/argentina-extranjeros-turismo');
const FD = require('../services/propuestas/fuentes/argentina-migraciones-documentacion-turista');
const FB = require('../services/propuestas/fuentes/itamaraty-qgrv');
const FC = require('../services/propuestas/fuentes/consulado-chile-visas');
const { leerPaginaOficial } = require('../services/propuestas/fuentes/lectura-http-oficial');
const FI = require('../services/propuestas/fuentes/embajada-italia-montevideo-visas');
const FV = require('../services/propuestas/fuentes/govuk-check-uk-visa');
const FDE = require('../services/propuestas/fuentes/auswaertiges-amt-visumpflicht');
const FE = require('../services/propuestas/fuentes/comision-europea-etias');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const { ADAPTADORES_V2, elegirAdaptadorV2 } = require('../services/propuestas/adaptadores/v2');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const L = require('../services/propuestas/ciclo/perfiles-ar-br-cl');
const { PERFILES, clavePolitica } = require('../services/propuestas/ciclo/perfiles');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const CLI = require('./ciclo-checkmig-v2');

const dir = (...p) => path.join(__dirname, 'fixtures', ...p);
const fx = (...p) => readFileSync(dir(...p), 'utf8').replace(/\r\n/g, '\n');
const AR = fx('ar-br-cl', 'argentina-extranjeros-2026-11-25.html');
const ARD = fx('ar-br-cl', 'argentina-documentacion-turista-2026-11-25.html');
const BRP = fx('ar-br-cl', 'itamaraty-qgrv-pagina-2026-11-25.html');
const PDF = readFileSync(dir('ar-br-cl', 'qgrv-simples-port-07out26.pdf'));
const CLJ = readFileSync(dir('ar-br-cl', 'consulado-chile-info-visas-2026-11-25.json'), 'utf8');
const CLN = readFileSync(dir('ar-br-cl', 'consulado-chile-notas-visas-2026-11-26.json'), 'utf8');
const sobreCl = (t, n = CLN) => JSON.stringify({ tabla: t, notas: n });
const API = JSON.parse(readFileSync(dir('ar-br-cl', 'api-destinos-2026-11-25.json'), 'utf8'));
const PDF_URL = 'https://www.gov.br/mre/pt-br/assuntos/portal-consular/vistos/qgrv-simples-port-07out26.pdf';
const html = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = t => () => new Response(t, { status: 200, headers: { 'content-type': 'application/json' } });
const pdf = b => () => new Response(b, { status: 200, headers: { 'content-type': 'application/pdf' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
const T0 = new Date('2026-11-25T12:00:00.000Z');

// PDF mutado: se descomprime la página que contiene `marca`, se edita su contenido y se vuelve a comprimir.
function mutarPdf(marca, editar) {
  const s = PDF.toString('latin1');
  let hecho = 0;
  const salida = s.replace(/(stream\r?\n)([\s\S]*?)(\r?\nendstream)/g, (todo, a, datos, b) => {
    let t;
    try { t = zlib.inflateSync(Buffer.from(datos, 'latin1')).toString('latin1'); } catch { return todo; }
    if (!t.includes(marca)) return todo;
    const nuevo = editar(t);
    assert.notEqual(nuevo, t, `la mutación del PDF se aplicó (${marca})`);
    hecho++;
    return a + zlib.deflateSync(Buffer.from(nuevo, 'latin1')).toString('latin1') + b;
  });
  assert.equal(hecho, 1, `una sola página contiene ${marca}`);
  return Buffer.from(salida, 'latin1');
}
const extraerBr = (b, pagina = BRP) => { const e = FB.enlacePdf(pagina); return FB.extraer(JSON.stringify(e.enlace === null ? e : { enlace: e.enlace, pdf: b.toString('latin1') })); };
const URUGUAI = '[(Uru)-3(gu)-3(ai)] TJ';
const celdaBr = (t, x, nuevo) => t.replace(new RegExp(`(1 0 0 1 ${x.replace('.', '\\.')} 454\\.75 Tm\\r\\n0 g\\r\\n0 G\\r\\n)\\[\\((.)\\)\\] TJ`), (_, p) => `${p}${nuevo}`);
const soloPagUruguai = f => t => (t.includes(URUGUAI) ? f(t) : t);

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Extracción ----
    const okA = FA.extraer(AR).campos.visa, okD = FD.extraer(ARD).campos.documento, okB = extraerBr(PDF).campos.visa, okC = FC.extraer(sobreCl(CLJ)).campos.visa;
    assert.deepEqual([okA.estado, okA.valor], ['ok', { requerida: 'no', dias: 90 }]);
    assert.deepEqual([okD.estado, okD.valor], ['ok', { aceptados: ['pasaporte', 'cedula_identidad', 'documento_viaje_habil'], vigencia: 'vigente' }]);
    assert.deepEqual([okB.estado, okB.valor], ['ok', { requerida: 'no', dias: 90, cedula: 'ingreso_permitido' }]);
    assert.deepEqual([okC.estado, okC.valor.requerida, okC.valor.dias, okC.valor.notas.map(n => n.numero)], ['ok', 'no', 90, ['1', '2', '17']]);
    const NOTAS_CL = JSON.parse(CLN);
    assert.deepEqual(okC.valor.notas.map(n => n.texto), ['1', '2', '17'].map(n => NOTAS_CL[n]), 'CL: el texto de las notas es el publicado, sin cambios');

    // AR visa: rama Turismo › Mercosur.
    const V = 'puedes ingresar como turista sin visa por hasta 90 días.</p>';
    const enRama = extra => AR.replace(V, `${V}${extra}`);
    const COND = 'Los uruguayos deben presentar pasaporte con seis meses de vigencia.';
    const MUT_AR = [
      ['condición dentro de la frase', AR.replace('como turista sin visa por hasta', 'como turista sin visa, con pasaje de regreso, por hasta'), 'no_reconocido'],
      ['condición al final de la frase', AR.replace('sin visa por hasta 90 días.</p>', `sin visa por hasta 90 días. ${COND}</p>`), 'no_reconocido'],
      ['párrafo nuevo en la rama', enRama(`<p>${COND}</p>`), 'condicionada'],
      ['lista en la rama', enRama(`<ul><li>${COND}</li></ul>`), 'condicionada'],
      ['div en la rama', enRama(`<div>${COND}</div>`), 'condicionada'],
      ['texto suelto en la rama', enRama(COND), 'condicionada'],
      ['contenedor anidado en la rama', enRama(`<div class="alerta"><div><p>${COND}</p></div></div>`), 'condicionada'],
      ['texto conocido de otra rama movido a la del Mercosur', enRama('<p>Debes gestionar tu visa para turismo en una representación consular de la República Argentina.</p>'), 'condicionada'],
      ['condición fuera de la rama (aviso general)', AR.replace('<main', `<main`).replace(/(<main\b[^>]*>)/, `$1<div class="alert"><p>${COND}</p></div>`), 'condicionada'],
      ['frase duplicada en otra sección', AR.replace('<!-- SECCIÓN TURISMO -->', `<div><p>Si eres ciudadano de Bolivia, Brasil, Paraguay o Uruguay (estados parte del Mercosur) o de Chile, Colombia, Ecuador, Guyana, Panamá, Perú o Surinam (estados asociados), puedes ingresar como turista sin visa por hasta 30 días.</p></div><!-- SECCIÓN TURISMO -->`), 'sin_evidencia'],
      ['sin la rama del Mercosur', AR.replace('id="section-turismo_mercosur"', 'id="section-otra"'), 'sin_evidencia'],
      ['sin la sección de turismo', AR.replace('id="section-turismo"', 'id="section-x"'), 'sin_evidencia'],
      ['contexto distinto (la opción lleva a otra rama)', AR.replace('data-parent="turismo" data-target="turismo_mercosur"', 'data-parent="turismo" data-target="turismo_check_visa"'), 'no_reconocido'],
      ['contexto distinto (no es turismo)', AR.replace('puedes ingresar como turista sin visa', 'puedes ingresar como trabajador sin visa'), 'sin_evidencia'],
      ['Uruguay fuera de la lista', AR.replace('Paraguay o Uruguay (estados parte', 'o Paraguay (estados parte'), 'no_reconocido'],
      ['dos <main>', AR.replace('</main>', '</main><main></main>'), 'sin_evidencia']
    ];
    for (const [nombre, h, motivo] of MUT_AR) {
      assert.notEqual(h, AR, `${nombre}: mutación aplicada`);
      const x = FA.extraer(h).campos.visa;
      assert.deepEqual([x.estado, x.motivo?.split(':')[0]], ['ambiguo', motivo], `AR visa / ${nombre}: ${x.motivo}`);
    }
    // AR documento: cuerpo de Migraciones.
    const C_AR = 'Ecuador y Colombia).</li>';
    const enCuerpo = extra => ARD.replace(C_AR, `${C_AR}${extra}`);
    const MUT_ARD = [
      ['condición dentro de la cédula', ARD.replace('Cédula de Identidad (vigente)', 'Cédula de Identidad (vigente, con 6 meses)'), 'no_reconocido'],
      ['condición al final de la cédula', ARD.replace('Ecuador y Colombia).', 'Ecuador y Colombia). Los menores necesitan autorización.'), 'no_reconocido'],
      ['ítem nuevo en la lista', enCuerpo('<li>Pasaje de regreso.</li>'), 'condicionada'],
      ['div en el cuerpo', ARD.replace('</ul>', '</ul><div>Se exige seguro médico.</div>'), 'condicionada'],
      ['texto suelto en el cuerpo', ARD.replace('</ul>', '</ul>Se exige seguro médico.'), 'condicionada'],
      ['contenedor anidado en el cuerpo', ARD.replace('</ul>', '</ul><div><div><p>Se exige seguro médico.</p></div></div>'), 'condicionada'],
      ['aviso fuera del cuerpo', ARD.replace(/(<main\b[^>]*>)/, '$1<div class="alert"><p>Desde 2027 los turistas deben ingresar con pasaporte.</p></div>'), 'condicionada'],
      ['pasaporte duplicado', ARD.replace('<li>Pasaporte (vigente), o</li>', '<li>Pasaporte (vigente), o</li><li>Pasaporte (vigente), o</li>'), 'no_reconocido'],
      ['sin la cédula', ARD.replace(/<li>Cédula de Identidad[\s\S]*?<\/li>/, ''), 'sin_evidencia'],
      ['Uruguay fuera de la lista', ARD.replace('Bolivia, Uruguay, Paraguay', 'Bolivia, Paraguay'), 'no_reconocido'],
      ['contexto distinto (residencia, no origen)', ARD.replace('de su país de origen', 'de su país de residencia'), 'no_reconocido'],
      ['segundo cuerpo con texto', ARD.replace('</main>', '<div property="content:encoded"><p>Otro.</p></div></main>'), 'sin_evidencia']
    ];
    for (const [nombre, h, motivo] of MUT_ARD) {
      assert.notEqual(h, ARD, `${nombre}: mutación aplicada`);
      const x = FD.extraer(h).campos.documento;
      assert.deepEqual([x.estado, x.motivo?.split(':')[0]], ['ambiguo', motivo], `AR documento / ${nombre}: ${x.motivo}`);
    }
    // BR: enlace de la página y celdas/leyenda del PDF.
    const MUT_BR = [
      ['sin la marca de cédula', mutarPdf(URUGUAI, t => celdaBr(t, '488.62', '[( )] TJ')), 'condicionada'],
      ['otra marca en la celda (*)', mutarPdf(URUGUAI, t => celdaBr(t, '488.62', '[(# *)] TJ')), 'condicionada'],
      ['visto exigido (código 1)', mutarPdf(URUGUAI, t => celdaBr(t, '482.5', '[(1)] TJ')), 'condicionada'],
      ['condición agregada en la fila', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 500.5 454.75 Tm\r\n[(somente aeroportos)] TJ`)), 'condicionada'],
      ['leyenda de # cambiada', mutarPdf('(In)-2(gresso)', t => t.replace('(In)-2(gresso)', '(N)-2(\\343o in)-2(gresso)')), 'no_reconocido'],
      ['Uruguay en otra línea (duplicado)', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 100.5 Tm\r\n[(Uruguai \\(nota\\))] TJ`)), 'sin_evidencia'],
      ['sin la fila de Uruguay', mutarPdf(URUGUAI, t => t.replace(URUGUAI, '[(Atl\\342ntida)] TJ')), 'sin_evidencia'],
      ['fila con otro nombre', mutarPdf(URUGUAI, t => t.replace(URUGUAI, '[(Uruguai e Paraguai)] TJ')), 'no_reconocido'],
      ['nota general nueva en la leyenda', mutarPdf('(In)-2(gresso)', t => t.replace('[(#)] TJ', '[(#)] TJ\r\nET\r\nBT\r\n1 0 0 1 36.48 60.5 Tm\r\n[(Todos os visitantes devem apresentar seguro sa\\372de.)] TJ')), 'condicionada'],
      ['nota nueva en la página de la tabla', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 60.5 Tm\r\n[(Obs: exige-se comprovante de hospedagem.)] TJ`)), 'condicionada'],
      ['PDF ilegible', Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n'), 'no_reconocido'],
      // Texto escrito con formas que el lector no interpreta: nunca desaparece, siempre ambiguo.
      ['nota con el operador \' (bloque propio)', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 60.5 Tm\r\n(Somente portadores de passaporte biometrico.) '`)), 'no_reconocido'],
      ['nota con el operador "', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 60.5 Tm\r\n0 0 (Somente portadores de passaporte biometrico.) "`)), 'no_reconocido'],
      ['nota con \' dentro del bloque de la fila', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\n(Somente portadores de passaporte biometrico.) '`)), 'no_reconocido'],
      ['nota con posición relativa (Td)', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 60.5 Tm\r\n0 -12 Td\r\n[(Somente portadores de passaporte biometrico.)] TJ`)), 'no_reconocido'],
      ['texto fuera de un bloque BT…ET', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\n(Somente portadores de passaporte biometrico.) Tj\r\nBT`)), 'no_reconocido'],
      ['texto alternativo de una sección marcada', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\n/Span <</ActualText (Somente portadores de passaporte biometrico.)>> BDC\r\nEMC\r\nBT`)), 'no_reconocido'],
      ['objeto externo dibujado (Do)', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\n/Fm1 Do\r\nBT`)), 'no_reconocido'],
      ['operador desconocido en un bloque', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\n3 Tr`)), 'no_reconocido'],
      ['cadena sin terminar', mutarPdf(URUGUAI, t => t.replace(URUGUAI, '[(Uruguai] TJ')), 'no_reconocido'],
      ['anotación en una página', Buffer.from(PDF.toString('latin1').replace('/Type/Page/Parent', '/Type/Page/Annots[]/Parent'), 'latin1'), 'no_reconocido'],
      // Paréntesis anidados: se leen completos y la nota nueva se detecta.
      ['nota con paréntesis anidados', mutarPdf(URUGUAI, t => t.replace(URUGUAI, `${URUGUAI}\r\nET\r\nBT\r\n1 0 0 1 28.44 60.5 Tm\r\n[(Obs \\(1\\): somente (biometrico))] TJ`)), 'condicionada']
    ];
    for (const [nombre, b, motivo] of MUT_BR) {
      assert.ok(!b.equals(PDF), `BR / ${nombre}: mutación aplicada`);
      const x = extraerBr(b).campos.visa;
      assert.deepEqual([x.estado, x.motivo?.split(':')[0]], ['ambiguo', motivo], `BR visa / ${nombre}: ${x.motivo}`);
    }
    assert.match(extraerBr(MUT_BR.find(m => m[0].startsWith('nota con el operador \'')) [1]).campos.visa.motivo, /operador "'"/, 'BR: el motivo nombra el operador no leído');
    for (const [nombre, pagina] of [
      ['sin enlace al cuadro', BRP.replace(/Quadro Geral de Regime de Vistos \(QGRV\) - Versão em Português/, 'Quadro (arquivo)')],
      ['dos enlaces distintos', BRP.replace('</ul>', `<li><a href="${PDF_URL.replace('07out26', '01dez26')}">Quadro Geral de Regime de Vistos (QGRV) - Versão em Português</a></li></ul>`)],
      ['enlace fuera de la carpeta oficial', BRP.replace(PDF_URL, 'https://www.gov.br/outro/qgrv.pdf')]
    ]) {
      assert.notEqual(pagina, BRP, nombre);
      const x = extraerBr(PDF, pagina).campos.visa;
      assert.deepEqual([x.estado, x.motivo?.split(':')[0]], ['ambiguo', 'sin_evidencia'], `BR enlace / ${nombre}: ${x.motivo}`);
    }
    // CL: fila URUGUAY de la tabla JSON.
    const tabla = JSON.parse(CLJ);
    const conFila = f => JSON.stringify(tabla.map(x => (x.pais === 'URUGUAY' ? f({ ...x }) : x)));
    // Notas: el mismo archivo con una nota cambiada (la fila de Uruguay queda IDÉNTICA).
    const conNotas = f => JSON.stringify(f({ ...NOTAS_CL }));
    const MUT_CL = [
      ['requiere visa', conFila(x => ({ ...x, visa: 'SI' })), CLN, 'no_reconocido'],
      ['nota particular nueva', conFila(x => ({ ...x, notas: '1,2,17,19' })), CLN, 'condicionada'],
      ['columna nueva', conFila(x => ({ ...x, condicion: 'pasaporte' })), CLN, 'no_reconocido'],
      ['plazo no numérico', conFila(x => ({ ...x, visa_simple_estadia: 'noventa' })), CLN, 'no_reconocido'],
      ['arancel', conFila(x => ({ ...x, visa_simple_arancel: '30' })), CLN, 'no_reconocido'],
      ['Uruguay duplicado', JSON.stringify([...tabla, tabla.find(x => x.pais === 'URUGUAY')]), CLN, 'sin_evidencia'],
      ['sin Uruguay', JSON.stringify(tabla.filter(x => x.pais !== 'URUGUAY')), CLN, 'sin_evidencia'],
      ['otro nombre de país', conFila(x => ({ ...x, pais: 'URUGUAY (RESIDENTES)' })), CLN, 'no_reconocido'],
      ['no es JSON', '<html>', CLN, 'no_reconocido'],
      ['no es una lista', JSON.stringify({ datos: tabla }), CLN, 'no_reconocido'],
      ['nota 17 modificada', CLJ, conNotas(n => ({ ...n, 17: n[17].replace('10 %', '20 %') })), 'condicionada'],
      ['nota 2 con una condición agregada', CLJ, conNotas(n => ({ ...n, 2: `${n[2]} Se exige pasaporte con seis meses de vigencia.` })), 'condicionada'],
      ['nota 1 con otra entrada', CLJ, conNotas(n => ({ ...n, 1: n[1].replace('una entrada', 'una entrada, solo por vía aérea') })), 'condicionada'],
      ['nota 1 con otro plazo que la fila', CLJ, conNotas(n => ({ ...n, 1: n[1].replace('90 días', '60 días') })), 'condicionada'],
      ['nota 2 con otro plazo que la fila', CLJ, conNotas(n => ({ ...n, 2: n[2].replace('90 días', '30 días') })), 'condicionada'],
      ['nota 1 ausente', CLJ, conNotas(n => { delete n[1]; return n; }), 'sin_evidencia'],
      ['nota 17 ausente', CLJ, conNotas(n => { delete n[17]; return n; }), 'sin_evidencia'],
      ['nota vacía', CLJ, conNotas(n => ({ ...n, 2: '' })), 'condicionada'],
      ['nota que no es texto', CLJ, conNotas(n => ({ ...n, 17: { texto: n[17] } })), 'no_reconocido'],
      ['notas que no son JSON', CLJ, '<html>', 'no_reconocido'],
      ['notas en una lista', CLJ, JSON.stringify(Object.values(NOTAS_CL)), 'no_reconocido']
    ];
    for (const [nombre, t, n, motivo] of MUT_CL) {
      assert.ok(t !== CLJ || n !== CLN, `CL / ${nombre}: mutación aplicada`);
      if (n !== CLN) assert.deepEqual(JSON.parse(t).find(x => x.pais === 'URUGUAY'), tabla.find(x => x.pais === 'URUGUAY'), `CL / ${nombre}: fila idéntica`);
      const x = FC.extraer(sobreCl(t, n)).campos.visa;
      assert.deepEqual([x.estado, x.motivo?.split(':')[0]], ['ambiguo', motivo], `CL visa / ${nombre}: ${x.motivo}`);
    }
    for (const sobre of [JSON.stringify({ tabla: CLJ }), CLJ, 'x']) assert.equal(FC.extraer(sobre).campos.visa.motivo.split(':')[0], 'no_reconocido', 'CL: lectura sin las dos partes');
    // Controles positivos: otras notas (no referenciadas por Uruguay) cambiadas, y la tabla con otro orden
    // de claves (el servidor lo cambia entre consultas): mismos hechos.
    const mismo = (t, n, nombre) => assert.deepEqual(FC.extraer(sobreCl(t, n)).campos.visa.valor, okC.valor, nombre);
    mismo(CLJ, conNotas(n => ({ ...n, 4: 'Otra nota.', 19: 'Nota nueva de otro país.' })), 'CL: notas no referenciadas no afectan');
    mismo(JSON.stringify(tabla.map(x => Object.fromEntries(Object.entries(x).reverse()))), CLN, 'CL: orden de claves distinto');

    // ---- 2. Adaptadores y lector ----
    const ADS = { ar: require('../services/propuestas/adaptadores/v2/argentina-extranjeros-turismo'), ard: require('../services/propuestas/adaptadores/v2/argentina-migraciones-documentacion-turista'),
      br: require('../services/propuestas/adaptadores/v2/itamaraty-qgrv'), cl: require('../services/propuestas/adaptadores/v2/consulado-chile-visas') };
    const leerCon = (a, rutas) => a.leer({ fetch: async u => { const r = rutas[u]; if (!r?.length) throw new Error(`consulta no esperada a ${u}`); return r.shift()(); }, ahora: () => T0 });
    const RUTAS = () => ({ [FA.URL_PAGINA]: [html(AR)], [FD.URL_PAGINA]: [html(ARD)], [FB.URL_PAGINA]: [html(BRP)], [PDF_URL]: [pdf(PDF)], [FC.URL_TABLA]: [json(CLJ)], [FC.URL_NOTAS]: [json(CLN)] });
    const lect = {};
    for (const [k, a] of Object.entries(ADS)) {
      lect[k] = await leerCon(a, RUTAS());
      assert.equal(lect[k].tipo, 'hechos', `${k}: ${JSON.stringify(lect[k].campos ?? lect[k].motivo)}`);
      assert.ok(ADAPTADORES_V2.includes(a));
      const prop = { payload: { version_contrato: '2.0', campo: 'requisito', fuentes: [{ nombre: lect[k].fuente_nombre, url: lect[k].url, algoritmo_hechos_hash: lect[k].algoritmo_hechos_hash, hechos: lect[k].hechos, hechos_hash: lect[k].hechos_hash }] } };
      assert.equal(elegirAdaptadorV2(prop), a, `${k}: compatibilidad única`);
    }
    assert.equal(lect.br.diagnostico.http_status, 200);
    assert.deepEqual([(await leerCon(ADS.br, { [FB.URL_PAGINA]: [html(BRP)], [PDF_URL]: [caida] })).motivo, (await leerCon(ADS.br, { [FB.URL_PAGINA]: [caida] })).motivo], ['http_503', 'http_503'], 'BR: página o PDF caídos');
    assert.equal((await leerCon(ADS.cl, { [FC.URL_TABLA]: [html('<p>x</p>')] })).motivo, 'no_html', 'CL: contenido que no es JSON');
    assert.deepEqual([(await leerCon(ADS.cl, { [FC.URL_TABLA]: [json(CLJ)], [FC.URL_NOTAS]: [caida] })).tipo, (await leerCon(ADS.cl, { [FC.URL_TABLA]: [json(CLJ)], [FC.URL_NOTAS]: [caida] })).motivo], ['no_disponible', 'http_503'], 'CL: notas caídas');
    assert.equal((await leerCon(ADS.cl, { [FC.URL_TABLA]: [json(CLJ)], [FC.URL_NOTAS]: [html('<p>x</p>')] })).motivo, 'no_html', 'CL: notas que no son JSON');
    // Hechos de Chile: incluyen el texto de las notas; un texto distinto (aun con hash recalculado) o el
    // esquema anterior sin notas no son compatibles.
    assert.deepEqual([lect.cl.hechos.esquema, lect.cl.hechos.categoria, lect.cl.hechos.notas.map(n => n.texto)], ['consulado-chile-visas-hechos-v2', 'permanencia_transitoria', ['1', '2', '17'].map(n => NOTAS_CL[n])]);
    assert.deepEqual(lect.cl.evidencia.visa.slice(1).map(e => e.split(':')[0]), ['nota 1', 'nota 2', 'nota 17'], 'CL: la evidencia muestra las notas');
    const { hashHechos } = require('../services/propuestas/payload-requisito-v2');
    const propCl = hechos => ({ payload: { version_contrato: '2.0', campo: 'requisito', fuentes: [{ nombre: lect.cl.fuente_nombre, url: lect.cl.url, algoritmo_hechos_hash: lect.cl.algoritmo_hechos_hash, hechos, hechos_hash: hashHechos(hechos) }] } });
    const notaOtra = { ...lect.cl.hechos, notas: lect.cl.hechos.notas.map(n => (n.numero === '17' ? { ...n, texto: n.texto.replace('10 %', '20 %') } : n)) };
    const sinNotas = { esquema: 'consulado-chile-visas-hechos-v1', contexto: { nacionalidad: 'UY' }, visa_requerida: 'no', plazo_maximo_estadia_dias: 90 };
    const { notas: _n, ...v2SinNotas } = lect.cl.hechos;
    assert.deepEqual([ADS.cl.compatibilidad(propCl(notaOtra)).codigo, ADS.cl.compatibilidad(propCl(sinNotas)).codigo, ADS.cl.compatibilidad(propCl(v2SinNotas)).codigo, ADS.cl.compatibilidad(propCl(lect.cl.hechos)).compatible],
      ['hechos_guardados_no_canonicos', 'esquema_hechos_no_soportado', 'hechos_guardados_no_canonicos', true]);
    assert.equal(ADS.cl.version, '2');
    assert.deepEqual([FC.normalizarHechos(notaOtra).ok, FC.normalizarHechos(v2SinNotas).ok, FC.normalizarHechos({ ...lect.cl.hechos, categoria: 'turismo' }).ok, FC.normalizarHechos(lect.cl.hechos).ok], [false, false, false, true], 'CL: normalizarHechos solo admite las notas interpretadas');
    assert.ok(lect.cl.evidencia.visa.every(e => e.length <= 240), 'CL: evidencia dentro del límite de auditoría');
    assert.equal((await leerCon(ADS.ar, { [FA.URL_PAGINA]: [() => new Response(null, { status: 302, headers: { location: 'https://ejemplo.invalid/' } })] })).motivo, 'redireccion_fuera_del_sitio');
    assert.equal((await leerPaginaOficial({ url: PDF_URL, hosts: ['www.gov.br'], agente: 'x', contenido: 'pdf', fetch: async () => pdf(PDF)() })).html.length, PDF.length, 'el PDF se lee byte a byte');
    await assert.rejects(leerPaginaOficial({ url: PDF_URL, hosts: ['www.gov.br'], agente: 'x', contenido: 'otro', fetch: async () => pdf(PDF)() }), /contenido desconocido/);

    // ---- 3. Perfiles ----
    const HOY = fechaMontevideo(T0);
    const pub = (iso, tipo) => API.find(d => d.codigo_iso === iso).requisitos.find(r => r.tipo === tipo);
    const sinT = r => ({ ...r, _id: new ObjectId(r._id), fecha_verificacion: typeof r.fecha_verificacion === 'string' ? r.fecha_verificacion.slice(0, 10) : r.fecha_verificacion });
    const CASOS = [[L.arVisa, 'AR', 'visa', lect.ar], [L.arDocumento, 'AR', 'validez_pasaporte', lect.ard], [L.brVisa, 'BR', 'visa', lect.br], [L.clVisa, 'CL', 'visa', lect.cl]];
    const ESPERADO = {
      'argentina-ar-visa': ['procedencia', L.descripcionArVisa(lect.ar.hechos), FA.URL_PAGINA],
      'migraciones-ar-documento': ['valor', L.DESCRIPCION_AR_DOCUMENTO, FD.URL_PAGINA],
      'itamaraty-br-visa': ['procedencia', L.descripcionBrVisa(lect.br.hechos), FB.URL_PAGINA],
      'consulado-cl-visa': ['procedencia', L.descripcionClVisa(lect.cl.hechos), FC.URL_PAGINA]
    };
    for (const [p, iso, tipo, l] of CASOS) {
      const r = ciclo.clasificar(sinT(pub(iso, tipo)), l, p, { hoy: HOY });
      const [tc, desc, fuente] = ESPERADO[p.nombre];
      assert.deepEqual([r.accion, r.tipo_cambio, r.esperado, r.cambios.find(c => c.campo === 'descripcion').propuesto.valor, r.cambios.find(c => c.campo === 'fuente').propuesto.valor, r.fecha_verificacion.efecto],
        ['cambio_aplicable', tc, 'no', desc, fuente, 'se_fija_al_aplicar'], p.nombre);
      const canon = { ...sinT(pub(iso, tipo)), obligatorio: 'no', descripcion: desc, fuente };
      assert.deepEqual([ciclo.clasificar(canon, l, p, { hoy: HOY }).accion, ciclo.clasificar(canon, l, p, { hoy: HOY }).fecha_verificacion.efecto], ['sin_cambio', 'no_se_renueva'], `${p.nombre}: canónico`);
      assert.equal(ciclo.clasificar({ ...canon, link: 'https://ejemplo.gob/' }, l, p, { hoy: HOY }).motivo, 'campos_sin_respaldo');
      assert.equal(ciclo.clasificar({ ...canon, estado: 'verificar' }, l, p, { hoy: HOY }).motivo, 'estado_no_confirmado');
    }
    // Cédula: el pasaporte deja de ser obligatorio y la descripción nombra las alternativas y su vigencia.
    const doc = ciclo.clasificar(sinT(pub('AR', 'validez_pasaporte')), lect.ard, L.arDocumento, { hoy: HOY });
    assert.deepEqual(doc.cambios.map(c => [c.campo, c.propuesto.valor]).find(c => c[0] === 'obligatorio'), ['obligatorio', 'no']);
    for (const t of ['no requieren visa de permanencia transitoria', 'plazo máximo de estadía de 90 días', 'para una entrada o para varias', '«salvo excepciones»']) assert.ok(L.descripcionClVisa(lect.cl.hechos).includes(t), `CL: ${t}`);
    for (const t of ['no se exige pasaporte', 'pasaporte vigente', 'cédula de identidad vigente', 'documento de viaje hábil vigente', 'como turista']) assert.ok(L.DESCRIPCION_AR_DOCUMENTO.includes(t), t);
    for (const [d, sin] of [[L.descripcionArVisa(lect.ar.hechos), ['pasaporte normal', 'extender', 'pasaje']], [L.descripcionBrVisa(lect.br.hechos), ['extensión']], [L.descripcionClVisa(lect.cl.hechos), ['extender', 'pasaje', 'recargo', 'arancel', 'turismo', 'pasaporte']], [L.DESCRIPCION_AR_DOCUMENTO, ['meses adicionales']]]) {
      for (const t of sin) assert.ok(!d.includes(t), `no se publica lo que la fuente no dice: ${t}`);
    }
    // Fuente de otro país u otro requisito: no respalda.
    assert.equal(ciclo.clasificar(sinT(pub('AR', 'visa')), lect.cl, L.arVisa, { hoy: HOY }).motivo, 'sin_evidencia_confirmada');
    assert.equal(ciclo.clasificar(sinT(pub('AR', 'validez_pasaporte')), lect.ar, L.arDocumento, { hoy: HOY }).motivo, 'sin_evidencia_confirmada');

    // ---- 4. Autorizaciones ----
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const env = lista => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...(lista ? { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) } : {}) });
    const aut = politica => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() });
    const VIGENTES = ['checkmig-colombia-obligatoriedad@1', 'govuk-reino-unido-turismo-uy@1', 'auswaertiges-amt-alemania-visa@1', 'alta-auswaertiges-amt-alemania@1', 'govuk-gb-pasaporte-uy@1',
      'embajada-italia-it-visa-uy@1', 'embajada-italia-it-pasaporte-uy@1', 'comision-europea-etias-uy@1'].map(aut);
    const LOTE = L.PERFILES_AR_BR_CL.map(p => aut(clavePolitica(p)));
    assert.deepEqual(LOTE.map(a => a.politica), ['argentina-gob-ar-visa-uy@1', 'migraciones-ar-documento-uy@1', 'itamaraty-br-visa-uy@1', 'consulado-chile-cl-visa-uy@1']);
    const conVigentes = env(VIGENTES), conLote = env([...VIGENTES, ...LOTE]);
    for (const p of L.PERFILES_AR_BR_CL) {
      assert.deepEqual([R.cargarConfigCicloReal(conVigentes, new Date(), { perfil: p.nombre }).politica_habilitada, R.cargarConfigCicloReal(conLote, new Date(), { perfil: p.nombre }).politica_habilitada], [false, true], p.nombre);
    }
    assert.equal(R.cargarConfigCicloReal(env([...VIGENTES, LOTE[0]]), new Date(), { perfil: 'migraciones-ar-documento' }).politica_habilitada, false, 'la política de AR visa no habilita AR documento');

    // ---- 5. Mongo efímero sembrado con la API pública ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_lote_ar_br_cl'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const reqApi = async (iso, tipo) => (await api()).find(d => d.codigo_iso === iso).requisitos.find(r => r.tipo === tipo);
    const sembrar = async () => {
      await conexion.db.dropDatabase();
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
      // Atlas guarda fecha_verificacion como texto AAAA-MM-DD (o null); la API la serializa con hora.
      await col('destinos').insertMany(API.map(d => ({ ...d, _id: new ObjectId(d._id), requisitos: d.requisitos.map(sinT) })));
    };
    // Fuente simulada por URL: cada consulta toma la siguiente respuesta de su cola o la vigente por defecto.
    const PORDEFECTO = { [FA.URL_PAGINA]: html(AR), [FD.URL_PAGINA]: html(ARD), [FB.URL_PAGINA]: html(BRP), [PDF_URL]: pdf(PDF), [FC.URL_TABLA]: json(CLJ), [FC.URL_NOTAS]: json(CLN),
      [URL_FICHA]: html(fx('checkmig', 'valida.html')), [FV.URL_RESULTADO]: html(fx('govuk-check-uk-visa', 'resultado-uy-turismo-2026-11-22.html')),
      [FDE.URL_LISTA]: html(fx('auswaertiges-amt', 'extracto-staatenliste-2026-11-22.html')), [FI.URL_PAGINA]: html(fx('embajada-italia-montevideo', 'extracto-visas-2026-11-23.html')),
      [FE.URL_PAGINA]: html(fx('comision-europea-etias', 'extracto-etias-2026-11-24.html')) };
    let colas = {}, consultas = [];
    const fuente = async u => { consultas.push(u); const c = colas[u]; if (c?.length) return c.shift()(); if (!PORDEFECTO[u]) throw new Error(`consulta no esperada a ${u}`); return PORDEFECTO[u](); };
    const correr = async (perfil, e, respuestas = {}) => {
      colas = Object.fromEntries(Object.entries(respuestas).map(([k, v]) => [k, [...v]])); consultas = [];
      const lineas = [];
      const codigo = await CLI.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: fuente, uuid: () => crypto.randomUUID() }, { perfil });
      const reg = lineas.filter(l => l.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1);
      assert.ok(Object.values(colas).every(c => c.length === 0), `${perfil}: quedaron respuestas sin consumir\n${lineas.join('\n')}`);
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')), 'sin credenciales en la salida');
      return { codigo, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)), lineas, consultas: [...consultas] };
    };
    const huellaDestinos = async () => JSON.stringify(await col('destinos').find({}).sort({ _id: 1 }).toArray());
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));
    const ACTIVOS = PERFILES.filter(p => !L.PERFILES_AR_BR_CL.includes(p)).map(p => p.nombre);
    assert.equal(ACTIVOS.length, 13);

    await sembrar();
    let h = await huella();
    // Regresión: los 13 perfiles activos, sobre el estado publicado real, siguen sin cambio y sin escribir.
    for (const perfil of ACTIVOS) {
      const r = await correr(perfil, conLote);
      assert.deepEqual([r.codigo, r.registro.resultado], [0, 'sin_cambio'], `${perfil}: ${r.lineas.join('\n')}`);
    }
    // Modo informe: las políticas vigentes no habilitan el lote (exit 2, cero escrituras).
    for (const p of L.PERFILES_AR_BR_CL) {
      const r = await correr(p.nombre, conVigentes);
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.motivo, r.registro.tipo_cambio], [2, 'informe', 'cambio_aplicable', 'politica_no_habilitada', ESPERADO[p.nombre][0]], p.nombre);
    }
    assert.equal(await huella(), h, 'regresión e informe: cero escrituras');
    // Con la política: caída, condiciones nuevas y ambigüedad no publican nada.
    for (const [perfil, resp] of [['argentina-ar-visa', { [FA.URL_PAGINA]: [caida] }], ['itamaraty-br-visa', { [FB.URL_PAGINA]: [html(BRP)], [PDF_URL]: [caida] }], ['consulado-cl-visa', { [FC.URL_TABLA]: [caida] }], ['consulado-cl-visa', { [FC.URL_TABLA]: [json(CLJ)], [FC.URL_NOTAS]: [caida] }]]) {
      assert.equal((await correr(perfil, conLote, resp)).codigo, 4, perfil);
    }
    for (const [perfil, url, muts, tipo] of [['argentina-ar-visa', FA.URL_PAGINA, MUT_AR, html], ['migraciones-ar-documento', FD.URL_PAGINA, MUT_ARD, html]]) {
      for (const [nombre, contenido] of muts) {
        const r = await correr(perfil, conLote, { [url]: [tipo(contenido)] });
        assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo], [3, 'revision_humana', 'lectura_ambigua'], `${perfil} / ${nombre}`);
      }
    }
    // Chile: fila idéntica con una nota modificada o ausente (y el resto de las mutaciones): nada se publica.
    for (const [nombre, t, n] of MUT_CL) {
      const r = await correr('consulado-cl-visa', conLote, { [FC.URL_TABLA]: [json(t)], [FC.URL_NOTAS]: [json(n)] });
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo], [3, 'revision_humana', 'lectura_ambigua'], `consulado-cl-visa / ${nombre}`);
      assert.deepEqual(r.consultas, [FC.URL_TABLA, FC.URL_NOTAS], `consulado-cl-visa / ${nombre}: lee la tabla y las notas`);
    }
    for (const [nombre, b] of MUT_BR) {
      const r = await correr('itamaraty-br-visa', conLote, { [FB.URL_PAGINA]: [html(BRP)], [PDF_URL]: [pdf(b)] });
      assert.deepEqual([r.codigo, r.registro.motivo], [3, 'lectura_ambigua'], `BR / ${nombre}`);
    }
    assert.equal(await huella(), h, 'caída, ambigua o condición nueva: cero escrituras');

    // Fuente → clasificación → aplicación (detección + revalidación H3.3) → GET /api/destinos.
    const hoy = fechaMontevideo(new Date());
    const otrosAntes = JSON.stringify((await api()).filter(d => !['AR', 'BR', 'CL'].includes(d.codigo_iso)));
    const restoAntes = JSON.stringify((await api()).filter(d => ['AR', 'BR', 'CL'].includes(d.codigo_iso)).map(d => d.requisitos.filter(r => !(['visa', 'validez_pasaporte'].includes(r.tipo) && (d.codigo_iso === 'AR' || r.tipo === 'visa')))));
    for (const [p, iso, tipo] of CASOS) {
      const r = await correr(p.nombre, conLote);
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.estado_propuesta, r.registro.politica.nombre, r.registro.objetivo.codigo_iso], [0, 'politica_automatica', 'exito', 'aplicada', clavePolitica(p), iso], r.lineas.join('\n'));
      const [, desc, fuenteUrl] = ESPERADO[p.nombre];
      const a = await reqApi(iso, tipo);
      assert.deepEqual([a.obligatorio, a.descripcion, a.fuente, a.estado, String(a.fecha_verificacion).slice(0, 10)], ['no', desc, fuenteUrl, 'confirmado', hoy], p.nombre);
      const intento = await col('intentos_aplicacion').findOne({ intento_id: r.registro.intento_id });
      assert.equal(intento.adaptador.nombre, p.adaptador.nombre);
    }
    assert.equal(JSON.stringify((await api()).filter(d => !['AR', 'BR', 'CL'].includes(d.codigo_iso))), otrosAntes, 'los otros 25 destinos no cambian');
    assert.equal(JSON.stringify((await api()).filter(d => ['AR', 'BR', 'CL'].includes(d.codigo_iso)).map(d => d.requisitos.filter(r => !(['visa', 'validez_pasaporte'].includes(r.tipo) && (d.codigo_iso === 'AR' || r.tipo === 'visa'))))), restoAntes, 'los demás requisitos de AR/BR/CL no cambian (incluidos BR y CL validez_pasaporte)');
    const props = await col('propuestas_cambio').find({}).toArray();
    assert.equal(props.length, 4);
    assert.deepEqual(props.map(p => p.payload.advertencias).sort(), [[], [], [], ['quita_obligatoriedad']], 'solo AR documento quita obligatoriedad (pasaporte → no obligatorio)');
    assert.ok(props.every(p => p.payload.instantanea_anterior.fuente.valor === 'https://www.iatatravelcentre.com/'), 'la auditoría conserva la procedencia IATA anterior');

    // Repetición: sin propuestas, intentos ni escrituras nuevas (incluida la regresión de los 13).
    h = await huella();
    for (const perfil of [...L.PERFILES_AR_BR_CL.map(p => p.nombre), ...ACTIVOS]) {
      const r = await correr(perfil, conLote);
      assert.deepEqual([r.codigo, r.registro.resultado], [0, 'sin_cambio'], perfil);
    }
    assert.equal(await huella(), h, 'repetición sin escrituras');

    // Caída en la revalidación de H3.3 y recuperación: el reintento aplica la MISMA propuesta una vez.
    await sembrar();
    const c1 = await correr('itamaraty-br-visa', conLote, { [FB.URL_PAGINA]: [html(BRP), html(BRP)], [PDF_URL]: [pdf(PDF), caida] });
    assert.deepEqual([c1.codigo, c1.registro.estado_propuesta, (await reqApi('BR', 'visa')).fuente], [4, 'aprobada', 'https://www.iatatravelcentre.com/'], c1.lineas.join('\n'));
    const c2 = await correr('itamaraty-br-visa', conLote);
    assert.deepEqual([c2.codigo, c2.registro.resultado, c2.registro.propuesta_id, c2.registro.reintento.admitido, (await reqApi('BR', 'visa')).fuente], [0, 'exito', c1.registro.propuesta_id, true, FB.URL_PAGINA]);
    assert.deepEqual([await col('propuestas_cambio').countDocuments(), await col('historial_cambios').countDocuments(), await col('eventos_propuesta').countDocuments({ tipo_evento: 'aprobacion' })], [1, 1, 1]);
    // Segunda lectura distinta (la tabla de Chile pasa a 60 días en las dos lecturas de H3.3): obsoleta, nada publicado.
    const CL60 = conFila(x => ({ ...x, visa_simple_estadia: '60', visa_multiple_estadia: '60' }));
    const N60 = conNotas(n => ({ ...n, 1: n[1].replace('90 días', '60 días'), 2: n[2].replace('90 días', '60 días') }));
    assert.equal(FC.extraer(sobreCl(CL60, N60)).campos.visa.valor.dias, 60, 'CL: tabla y notas a 60 días se leen');
    assert.equal(FC.extraer(sobreCl(CL60)).campos.visa.estado, 'ambiguo', 'CL: tabla a 60 con notas a 90 no se interpreta');
    const clAntes = JSON.stringify(await reqApi('CL', 'visa'));
    const d1 = await correr('consulado-cl-visa', conLote, { [FC.URL_TABLA]: [json(CLJ), json(CL60), json(CL60)], [FC.URL_NOTAS]: [json(CLN), json(N60), json(N60)] });
    assert.deepEqual([d1.codigo, d1.registro.resultado, d1.registro.estado_propuesta], [3, 'fuente_cambio', 'obsoleta'], d1.lineas.join('\n'));
    assert.equal(JSON.stringify(await reqApi('CL', 'visa')), clAntes, 'segunda lectura distinta: nada publicado con los hechos viejos');
    // Segunda lectura ambigua (condición nueva en la rama de Argentina): revisión humana, nada publicado.
    const arAntes = JSON.stringify(await reqApi('AR', 'visa'));
    const d2 = await correr('argentina-ar-visa', conLote, { [FA.URL_PAGINA]: [html(AR), html(MUT_AR[2][1])] });
    assert.deepEqual([d2.codigo, d2.registro.resultado, d2.registro.estado_propuesta], [3, 'extraccion_ambigua', 'revision_requerida'], d2.lineas.join('\n'));
    assert.equal(JSON.stringify(await reqApi('AR', 'visa')), arAntes, 'segunda lectura ambigua: nada publicado');
    // La siguiente corrida de Chile propone con los hechos nuevos (60 días) y aplica.
    const d3 = await correr('consulado-cl-visa', conLote, { [FC.URL_TABLA]: [json(CL60), json(CL60)], [FC.URL_NOTAS]: [json(N60), json(N60)] });
    assert.deepEqual([d3.codigo, d3.registro.resultado, (await reqApi('CL', 'visa')).descripcion.includes('de 60 días')], [0, 'exito', true]);

    // Condición que aparece en la SEGUNDA lectura (revalidación de H3.3): una nota PDF con ' en Brasil y
    // la nota 17 de Chile cambiada con la fila idéntica. Revisión humana, nada publicado.
    await sembrar();
    const PDF_COMILLA = MUT_BR.find(m => m[0].startsWith('nota con el operador \''))[1];
    const N17 = MUT_CL.find(m => m[0] === 'nota 17 modificada')[2];
    for (const [perfil, iso, resp] of [
      ['itamaraty-br-visa', 'BR', { [FB.URL_PAGINA]: [html(BRP), html(BRP)], [PDF_URL]: [pdf(PDF), pdf(PDF_COMILLA)] }],
      ['consulado-cl-visa', 'CL', { [FC.URL_TABLA]: [json(CLJ), json(CLJ)], [FC.URL_NOTAS]: [json(CLN), json(N17)] }]
    ]) {
      const antes = await huellaDestinos();
      const r = await correr(perfil, conLote, resp);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.estado_propuesta], [3, 'extraccion_ambigua', 'revision_requerida'], `${perfil}: ${r.lineas.join('\n')}`);
      assert.equal(await huellaDestinos(), antes, `${perfil}: segunda lectura con condición nueva, nada publicado`);
      assert.equal((await reqApi(iso, 'visa')).fuente, 'https://www.iatatravelcentre.com/', `${perfil}: sigue la fuente anterior`);
      assert.equal(await col('historial_cambios').countDocuments(), 0, perfil);
    }

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Lote AR/BR/CL 2.0: extracción con mutaciones, adaptadores, perfiles (cédula), políticas propias, aplicación → API, repetición, caída y recuperación, segunda lectura distinta/ambigua (nota PDF y nota chilena incluidas) y regresión de los 13 perfiles en Mongo efímero: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
