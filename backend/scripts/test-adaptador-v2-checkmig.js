// Adaptador 2.0 de CheckMig (H3.2, solo lectura): hechos canónicos, hash del HTML solo como
// diagnóstico, fuente_cambio con el verificador real, incompatibilidad sin consultar y lectura con
// fetch simulado (redirecciones validadas, tamaño limitado). Sin red, sin Mongo.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
// Falla por defecto: si una promesa quedara colgada y el proceso saliera solo, no daría exit 0.
process.exitCode = 1;
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ObjectId } = require('bson');
const fuente = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const adaptador = require('../services/propuestas/adaptadores/v2/migracion-colombia-checkmig');
const { ADAPTADORES_V2, elegirAdaptadorV2, ErrorSinAdaptadorV2 } = require('../services/propuestas/adaptadores/v2/index');
const { ADAPTADORES: ADAPTADORES_V1 } = require('../services/propuestas/adaptadores/index');
const { crearSobreRequisitoV2, hashHechos, ALGORITMO_HECHOS_HASH } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { verificarRevalidaciones } = require('../services/propuestas/plan-aplicacion-requisito-v2');

// Aislamiento: nada de lo anterior carga mongoose ni modelos.
assert.ok(!Object.keys(require.cache).some(k => /[\\/]node_modules[\\/]mongoose[\\/]|[\\/]models[\\/]/.test(k)), 'sin mongoose ni modelos');

const { URL_FICHA, BYTES_MAXIMOS } = fuente;
const fixture = n => readFileSync(path.join(__dirname, 'fixtures', 'checkmig', n), 'utf8').replace(/\r\n/g, '\n');
const sha256 = t => createHash('sha256').update(t).digest('hex');
const T = new Date('2026-11-12T02:00:00.000Z');
const ahora = () => new Date(T);
const html200 = (cuerpo, extra = {}) => new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
const HASH_SIN_OBLIGACION = 'f7becb92dcc9ba36dd6ca53a0218bab24e4a450eac17f7abcef931035c055321';
const HASH_CAMBIO = '99c64dfa4ddffc9c93d77e0f0fd4376928227f9f4016f41bdf004d770f568014';
const HECHOS_FICHA = {
  esquema: 'checkmig-hechos-v1', obligatoriedad: 'no_obligatorio',
  alcance: { viajeros: ['extranjeros', 'nacionales'], sentidos: ['ingreso', 'salida'] },
  ventana_horas_antes: { maximo_horas_antes: 72, minimo_horas_antes: 1 }
};

// Propuesta piloto de UNA fuente (la ficha real). La propuesta de test-aplicar-propuesta-v2 usa
// https://www.migracioncolombia.gov.co/checkmig y la base de test-payload-requisito-v2 tiene dos
// fuentes (/pagina-a y /pagina-b): ambas quedan abajo como casos de incompatibilidad.
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const requisito = {
  _id: ObjectId.createFromHexString('6aaddd0e9f54309f9d82727b'), tipo: 'formulario_digital', nombre: 'Check-Mig',
  obligatorio: 'si', descripcion: 'Formulario previo al viaje', fuente: 'Migración Colombia',
  link: 'https://www.migracioncolombia.gov.co/checkmig', estado: 'confirmado', costo: null, fecha_verificacion: '2026-08-18'
};
const fuenteDe = (hechos, extra = {}) => ({ nombre: adaptador.FUENTE_NOMBRE, url: URL_FICHA, capturado_en: '2026-11-12T01:37:02.406Z',
  hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos), ...extra });
const propuestaCon = fuentes => crearSobreRequisitoV2({
  fecha_propuesta: '2026-11-12T01:50:00.000Z', destino_id: '6a87828da8282a4aa6ddfbd4', requisito_id: '6aaddd0e9f54309f9d82727b',
  run_id_origen: '22222222-2222-4222-8222-222222222222', propuesta_id: '33333333-3333-4333-8333-333333333333',
  ...capturarIdentidadEInstantanea(requisito), cambios: [{ campo: 'obligatorio', propuesto: valor('no') }], fuentes, advertencias: ['quita_obligatoriedad']
});
const PILOTO = propuestaCon([fuenteDe(HECHOS_FICHA)]);

// Una invocación de revalidar() con un fetch simulado que registra cada llamada.
async function revalidarCon(respuestas, propuesta = PILOTO, opciones = {}) {
  const llamadas = [];
  const cola = [...respuestas];
  const r = await adaptador.revalidar(propuesta, { ahora, ...opciones, fetch: async (u, o) => {
    llamadas.push({ u, o });
    const siguiente = cola.shift();
    return typeof siguiente === 'function' ? siguiente(u, o) : siguiente;
  } });
  return { r, llamadas };
}

(async () => {
  // ---- 1. Evidencia suficiente: hechos canónicos, URL, fecha y evidencia por campo ----
  for (const [nombre, html, hechosEsperados, hash] of [
    ['valida.html', fixture('valida.html'), HECHOS_FICHA, HASH_SIN_OBLIGACION],
    ['oficial-muestra.html', fixture('oficial-muestra.html'), HECHOS_FICHA, HASH_SIN_OBLIGACION],
    ['cambio.html', fixture('cambio.html'), { esquema: 'checkmig-hechos-v1', obligatoriedad: 'obligatorio',
      alcance: { viajeros: ['extranjeros'], sentidos: ['ingreso'] }, ventana_horas_antes: { maximo_horas_antes: 48, minimo_horas_antes: 2 } }, HASH_CAMBIO]
  ]) {
    const { r, llamadas } = await revalidarCon([html200(html)]);
    assert.equal(r.tipo, 'hechos', `${nombre}: ${JSON.stringify(r)}`);
    assert.equal(llamadas.length, 1, `${nombre}: una lectura por invocación`);
    assert.deepEqual(r.hechos, hechosEsperados, nombre);
    assert.equal(r.hechos_hash, hashHechos(r.hechos), nombre);
    assert.equal(r.hechos_hash, hash, `${nombre}: hechos_hash fijado`);
    assert.deepEqual([r.url, r.fuente_nombre, r.algoritmo_hechos_hash], [URL_FICHA, 'Migración Colombia', ALGORITMO_HECHOS_HASH]);
    assert.ok(r.revalidada_en instanceof Date && r.revalidada_en.getTime() === T.getTime(), `${nombre}: revalidada_en`);
    assert.deepEqual(Object.keys(r.evidencia), ['obligatoriedad', 'alcance', 'ventana_horas_antes']);
    for (const ev of Object.values(r.evidencia)) assert.ok(ev.length >= 1 && ev.every(e => typeof e === 'string' && e.length <= 240), `${nombre}: evidencia breve`);
    assert.deepEqual([r.diagnostico.consultado_en, r.diagnostico.url_final, r.diagnostico.http_status, r.diagnostico.redirecciones],
      [T.toISOString(), URL_FICHA, 200, []]);
    assert.equal(r.diagnostico.contenido_sha256, sha256(html), `${nombre}: el hash del HTML queda en diagnóstico`);
    assert.equal(r.diagnostico.bytes, Buffer.byteLength(html));
    const serializados = JSON.stringify(r.hechos);
    assert.ok(!serializados.includes(r.diagnostico.contenido_sha256) && !/texto|evidencia|sha256|consultado/.test(serializados), `${nombre}: hechos sin HTML, texto ni fechas`);
  }
  assert.match(fixture('oficial-muestra.html'), /de uso no obligatorio/);

  // ---- 2. Muestra mínima del marcado oficial: URL, fecha y alcance del hash ----
  const meta = JSON.parse(fixture('oficial-muestra.json'));
  assert.equal(meta.url, URL_FICHA);
  assert.match(meta.capturado_en, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(meta.muestra.sha256, sha256(fixture('oficial-muestra.html')), 'hash de la muestra (LF)');
  assert.equal(meta.muestra.bytes, Buffer.byteLength(fixture('oficial-muestra.html')));
  for (const k of ['pagina', 'main', 'muestra']) { assert.match(meta[k].sha256, /^[0-9a-f]{64}$/); assert.ok(meta[k].cubre.length > 10, `${k}.cubre`); }

  // ---- 3. P1: HTML distinto con los mismos hechos no produce fuente_cambio (verificador real) ----
  const muestra = fixture('oficial-muestra.html');
  const variante = muestra
    .replace('id="c1969"', 'id="c9999"')
    .replace('completamente gratuito', 'gratuito para todos los viajeros')
    .replace('Viajeros nacionales y extranjeros que ingresen o salgan', 'Viajeros extranjeros y nacionales que salgan o ingresen')
    .replace('<h4><span><strong>Costos</strong></span></h4>', '\n\n   <h4> <span><strong>Costos</strong></span> </h4>');
  assert.notEqual(variante, muestra);
  const a = (await revalidarCon([html200(muestra)])).r, b = (await revalidarCon([html200(variante)])).r;
  assert.equal(b.tipo, 'hechos', JSON.stringify(b));
  assert.notEqual(a.diagnostico.contenido_sha256, b.diagnostico.contenido_sha256, 'HTML distinto');
  assert.equal(a.hechos_hash, b.hechos_hash, 'mismos hechos (listas ordenadas)');
  const tPlan = new Date(T.getTime() + 60_000);
  const propuestaMuestra = propuestaCon([fuenteDe(a.hechos)]);
  const fecha = verificarRevalidaciones(propuestaMuestra.payload, [adaptador.proyectarRevalidacion(b)], tPlan);
  assert.equal(fecha.getTime(), T.getTime(), 'P1: el verificador acepta la revalidación');

  // ---- 4. P2: un cambio de hechos SÍ produce fuente_cambio (verificador real) ----
  // Solo se prueba la detección: la orquestación pedirá una segunda lectura válida con los mismos
  // hechos cambiados antes de marcar la propuesta obsoleta (docs/adaptador-checkmig-v2.md).
  const cambio = (await revalidarCon([html200(fixture('cambio.html'))])).r;
  assert.throws(() => verificarRevalidaciones(PILOTO.payload, [adaptador.proyectarRevalidacion(cambio)], tPlan), e => e.message === 'fuente_cambio');
  // Control: el mismo cambio con una exclusión en «Dirigido a:» es ambiguo y nunca llega al verificador.
  const cambioAmbiguo = fixture('cambio.html').replace('Viajeros extranjeros que ingresen a Colombia', 'Viajeros extranjeros que ingresen a Colombia, no para los que salgan,');
  const amb = (await revalidarCon([html200(cambioAmbiguo)])).r;
  assert.equal(amb.tipo, 'ambiguo');
  assert.equal(amb.motivo, 'alcance:exclusion');
  assert.ok(!('hechos' in amb) && !('hechos_hash' in amb) && !JSON.stringify(amb).includes('"valor"'), 'ambiguo sin hechos ni valores parciales');
  assert.throws(() => adaptador.proyectarRevalidacion(amb), /solo un resultado 'hechos'/);

  // ---- 5. Evidencia insuficiente: ambiguo con motivo por campo, URL, fecha y evidencia ----
  const r3 = (await revalidarCon([html200(fixture('ambigua.html'))])).r;
  assert.deepEqual(Object.keys(r3).sort(), ['campos', 'diagnostico', 'fuente_nombre', 'motivo', 'revalidada_en', 'tipo', 'url']);
  assert.equal(r3.motivo, 'obligatoriedad:no_atribuible,alcance:sin_evidencia,ventana_horas_antes:sin_evidencia');
  assert.equal(r3.revalidada_en.getTime(), T.getTime());
  assert.equal(r3.campos.obligatoriedad.evidencia.length, 2);
  for (const c of Object.values(r3.campos)) assert.ok(c.estado === 'ambiguo' && typeof c.motivo === 'string' && Array.isArray(c.evidencia));
  const v = fixture('valida.html');
  const sinOb = v.replace('l&iacute;nea, de uso no obligatorio que permite', 'l&iacute;nea que permite');
  const solo = f => sinOb.replace('</div>\n</main>', `<p>${f}</p>\n  </div>\n</main>`);
  for (const [html, motivo] of [
    [solo('El pasaporte es obligatorio para usar CheckMig.'), 'obligatoriedad:sin_evidencia'],
    [solo('Para usar CheckMig es obligatorio el pasaporte.'), 'obligatoriedad:sin_evidencia'],
    [solo('Para solicitar la visa de turismo, el formulario es obligatorio.'), 'obligatoriedad:no_atribuible'],
    // Revisión de 3235202: condición y vigencia → ambiguo, sin hechos ni hechos_hash.
    [solo('CheckMig es obligatorio si el viaje es por vía aérea.'), 'obligatoriedad:condicionada'],
    [solo('CheckMig no es obligatorio desde el 1 de diciembre.'), 'obligatoriedad:condicionada'],
    [v.replace('hasta con 72 horas', 'hasta con 800 horas'), 'ventana_horas_antes:fuera_de_dominio'],
    [v.replace(/<\/?main[^>]*>/g, ''), 'obligatoriedad:sin_evidencia,alcance:sin_evidencia,ventana_horas_antes:sin_evidencia']
  ]) {
    const r = (await revalidarCon([html200(html)])).r;
    assert.deepEqual([r.tipo, r.motivo], ['ambiguo', motivo], JSON.stringify(r));
    const claves = o => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, x]) => [k, ...claves(x)]) : []);
    assert.ok(!claves(r).some(k => k === 'hechos' || k === 'hechos_hash' || k === 'valor'), `${motivo}: una lectura ambigua no emite hechos, hechos_hash ni valores`);
    assert.throws(() => adaptador.proyectarRevalidacion(r), /solo un resultado 'hechos'/);
  }

  // ---- 6. normalizarHechos: dominio exacto y listas ordenadas ----
  const base = { obligatoriedad: 'no_obligatorio', alcance: { viajeros: ['nacionales', 'extranjeros'], sentidos: ['salida', 'ingreso'], texto: 'x' }, ventana_horas_antes: { maximo_horas_antes: 72, minimo_horas_antes: 1 } };
  assert.deepEqual(fuente.normalizarHechos(base), { ok: true, hechos: HECHOS_FICHA }, 'ordena y descarta texto');
  for (const [campo, cambiar] of [
    ['obligatoriedad', l => { l.obligatoriedad = 'si'; }],
    ['alcance', l => { l.alcance.viajeros = []; }],
    ['alcance', l => { l.alcance.viajeros = ['residentes']; }],
    ['alcance', l => { l.alcance.sentidos = ['ingreso', 'ingreso']; }],
    ['ventana_horas_antes', l => { l.ventana_horas_antes.maximo_horas_antes = 0; }],
    ['ventana_horas_antes', l => { l.ventana_horas_antes.maximo_horas_antes = 721; }],
    ['ventana_horas_antes', l => { l.ventana_horas_antes.maximo_horas_antes = 1.5; }],
    ['ventana_horas_antes', l => { l.ventana_horas_antes.minimo_horas_antes = 72; }]
  ]) {
    const l = structuredClone(base); cambiar(l);
    assert.deepEqual(fuente.normalizarHechos(l), { ok: false, campo });
  }

  // ---- 7. Incompatibilidad: código cerrado y SIN consultar la fuente ----
  const base2 = propuestaCon([fuenteDe(HECHOS_FICHA)]).payload;
  const conPayload = cambiar => { const p = structuredClone(base2); cambiar(p); return { payload: p }; };
  const hechosPagina = { visa: false };
  const casosIncompatibles = [
    // La base de dos fuentes de test-payload-requisito-v2: el verificador exige una lectura por URL.
    ['dos fuentes (/pagina-a y /pagina-b)', propuestaCon([
      { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/pagina-b', capturado_en: '2026-10-15T20:29:00.000Z', hechos: hechosPagina, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechosPagina) },
      { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/pagina-a', capturado_en: '2026-10-15T20:28:00.000Z', hechos: hechosPagina, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechosPagina) }
    ]), 'varias_fuentes'],
    ['la ficha más otra fuente', propuestaCon([fuenteDe(HECHOS_FICHA), { ...fuenteDe(hechosPagina), url: 'https://www.migracioncolombia.gov.co/pagina-a' }]), 'varias_fuentes'],
    // La propuesta de test-aplicar-propuesta-v2 (URL /checkmig y hechos ad hoc).
    ['URL /checkmig del fixture del aplicador', propuestaCon([{ ...fuenteDe({ obligatorio: false, formulario: 'Check-Mig' }), url: 'https://www.migracioncolombia.gov.co/checkmig' }]), 'fuente_no_soportada'],
    ['otro nombre de fuente', propuestaCon([fuenteDe(HECHOS_FICHA, { nombre: 'Cancillería' })]), 'fuente_no_soportada'],
    // URL EXACTA de la ficha informativa: el enlace al formulario cumple otra función (es el
    // link del requisito, no la fuente que se revalida), y tampoco valen variantes de la ficha.
    ...[
      'https://apps.migracioncolombia.gov.co/check-mig/',
      'https://apps.migracioncolombia.gov.co/pre-registro/',
      `${URL_FICHA}/`,
      `${URL_FICHA}?origen=panel`,
      'https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/CheckMig'
    ].map(url => [`URL no exacta: ${url}`, propuestaCon([fuenteDe(HECHOS_FICHA, { url })]), 'fuente_no_soportada']),
    ['URL http (payload deserializado)', conPayload(p => { p.fuentes[0].url = URL_FICHA.replace('https:', 'http:'); }), 'fuente_no_soportada'],
    ['otro esquema', propuestaCon([fuenteDe({ ...HECHOS_FICHA, esquema: 'checkmig-hechos-v2' })]), 'esquema_hechos_no_soportado'],
    ['hechos sin esquema', propuestaCon([fuenteDe({ obligatorio: false })]), 'esquema_hechos_no_soportado'],
    ['listas sin ordenar', propuestaCon([fuenteDe({ ...HECHOS_FICHA, alcance: { viajeros: ['nacionales', 'extranjeros'], sentidos: ['ingreso', 'salida'] } })]), 'hechos_guardados_no_canonicos'],
    ['clave de más', propuestaCon([fuenteDe({ ...HECHOS_FICHA, nota: 'x' })]), 'hechos_guardados_no_canonicos'],
    ['algoritmo distinto', conPayload(p => { p.fuentes[0].algoritmo_hechos_hash = 'sha256-otro'; }), 'algoritmo_hechos_no_soportado'],
    ['sin fuentes', conPayload(p => { p.fuentes = []; }), 'sin_fuentes'],
    ['versión 1.0', conPayload(p => { p.version_contrato = '1.0'; }), 'version_contrato_no_soportada'],
    ['campo costo', conPayload(p => { p.campo = 'costo'; }), 'campo_no_soportado'],
    ['sin payload', {}, 'propuesta_invalida']
  ];
  const vistos = new Set();
  for (const [nombre, propuesta, codigo] of casosIncompatibles) {
    const { r, llamadas } = await revalidarCon([html200(v)], propuesta);
    assert.deepEqual(r, { tipo: 'incompatible', codigo }, nombre);
    assert.equal(llamadas.length, 0, `${nombre}: no consulta la fuente`);
    assert.equal(adaptador.soporta(propuesta), false, nombre);
    vistos.add(codigo);
  }
  assert.deepEqual([...vistos].sort(), [...adaptador.CODIGOS_INCOMPATIBILIDAD].sort(), 'cada código cerrado tiene un caso');
  assert.equal(adaptador.soporta(PILOTO), true);

  // Registro 2.0 separado del 1.0.
  assert.equal(elegirAdaptadorV2(PILOTO), adaptador);
  assert.throws(() => elegirAdaptadorV2(casosIncompatibles[0][1]), e => e instanceof ErrorSinAdaptadorV2
    && JSON.stringify(e.incompatibilidades) === JSON.stringify([{ adaptador: 'migracion-colombia-checkmig', codigo: 'varias_fuentes' }, { adaptador: 'govuk-check-uk-visa', codigo: 'varias_fuentes' }, { adaptador: 'auswaertiges-amt-visumpflicht', codigo: 'varias_fuentes' },
      { adaptador: 'govuk-check-uk-visa-frontera', codigo: 'varias_fuentes' }, { adaptador: 'embajada-italia-montevideo', codigo: 'varias_fuentes' },
      { adaptador: 'comision-europea-etias', codigo: 'varias_fuentes' }]));
  // El otro adaptador del registro nunca acepta una propuesta de la ficha de CheckMig.
  assert.equal(ADAPTADORES_V2.filter(a => a.soporta(PILOTO)).length, 1);
  assert.ok(ADAPTADORES_V2.includes(adaptador) && !ADAPTADORES_V1.some(x => x.nombre === adaptador.nombre));
  assert.ok(Object.isFrozen(adaptador));

  // ---- 8. Lectura: opciones de la consulta, redirecciones validadas antes de seguirlas ----
  const ok = await revalidarCon([html200(v)]);
  assert.equal(ok.llamadas.length, 1);
  const [{ u, o }] = ok.llamadas;
  assert.deepEqual([u, o.method, o.redirect, o.headers], [URL_FICHA, 'GET', 'manual', { 'user-agent': 'buscador-requisitos-viaje/adaptador-checkmig', accept: 'text/html' }]);
  assert.ok(o.signal instanceof AbortSignal);
  const redir = (status, location) => new Response(null, { status, headers: location ? { location } : {} });

  const interna = await revalidarCon([redir(301, '/tramites-y-servicios/aplicativos/checkmig/#x'), html200(v)]);
  assert.equal(interna.r.tipo, 'hechos');
  assert.deepEqual(interna.llamadas.map(l => l.u), [URL_FICHA, `${URL_FICHA}/`]);
  assert.deepEqual([interna.r.diagnostico.url_final, interna.r.diagnostico.redirecciones], [`${URL_FICHA}/`, [{ http_status: 301, hacia: `${URL_FICHA}/` }]]);
  assert.equal(interna.llamadas[1].o.signal, interna.llamadas[0].o.signal, 'un solo plazo para toda la lectura');

  for (const [nombre, location] of [
    ['otro host', 'https://ejemplo.invalid/checkmig?token=secreto'],
    ['http', 'http://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig'],
    ['credenciales', 'https://usuario:clave@www.migracioncolombia.gov.co/x'],
    ['puerto', 'https://www.migracioncolombia.gov.co:8443/x'],
    ['subdominio', 'https://apps.migracioncolombia.gov.co/check-mig/'],
    ['URL inválida', 'https://[mal']
  ]) {
    const { r, llamadas } = await revalidarCon([redir(302, location), html200(v)]);
    assert.deepEqual([r.tipo, r.motivo], ['no_disponible', 'redireccion_fuera_del_sitio'], nombre);
    assert.equal(llamadas.length, 1, `${nombre}: el destino ajeno nunca se consulta`);
    assert.ok(!JSON.stringify(r).includes('secreto') && !JSON.stringify(r).includes('clave'), `${nombre}: sin query ni credenciales en el diagnóstico`);
  }
  const bucle = await revalidarCon([1, 2, 3, 4, 5].map(() => redir(302, '/otra')));
  assert.deepEqual([bucle.r.motivo, bucle.llamadas.length, bucle.r.diagnostico.redirecciones.length], ['demasiadas_redirecciones', 4, 3]);
  assert.equal((await revalidarCon([redir(302)])).r.motivo, 'redireccion_sin_destino');

  // ---- 9. Fallos HTTP y de transporte: no_disponible, sin revalidada_en ----
  const texto = (status, tipo = 'text/html') => new Response('x', { status, headers: { 'content-type': tipo } });
  const fallos = [
    ...[404, 410, 429, 500, 503].map(s => [`HTTP ${s}`, [texto(s)], `http_${s}`]),
    ['no HTML', [texto(200, 'application/json')], 'no_html'],
    ['red', [() => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }], 'red:ENOTFOUND'],
    ['código raro', [() => { throw new TypeError('x', { cause: { code: 'algo raro\n' } }); }], 'red:desconocido'],
    ['tiempo agotado', [() => { throw new DOMException('timeout', 'TimeoutError'); }], 'tiempo_agotado'],
    ['cuerpo ilegible', [new Response(new ReadableStream({ pull(c) { c.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'text/html' } })], 'cuerpo_ilegible']
  ];
  for (const [nombre, respuestas, motivo] of fallos) {
    const { r } = await revalidarCon(respuestas);
    assert.deepEqual(Object.keys(r).sort(), ['diagnostico', 'fuente_nombre', 'motivo', 'tipo', 'url'], nombre);
    assert.deepEqual([r.tipo, r.motivo, r.url, r.fuente_nombre], ['no_disponible', motivo, URL_FICHA, 'Migración Colombia'], nombre);
    assert.equal(r.diagnostico.consultado_en, T.toISOString(), nombre);
  }
  // Plazo real: el mismo signal corta la consulta. AbortSignal.timeout no mantiene vivo el proceso
  // (con red real lo mantiene el socket), así que la prueba lo sostiene con un temporizador propio.
  const sosten = setTimeout(() => {}, 5000);
  const plazo = await revalidarCon([(_, o) => new Promise((_r, rechazar) => o.signal.addEventListener('abort', () => rechazar(o.signal.reason)))], PILOTO, { timeoutMs: 20 });
  clearTimeout(sosten);
  assert.deepEqual([plazo.r.tipo, plazo.r.motivo], ['no_disponible', 'tiempo_agotado']);

  // ---- 10. Tamaño limitado DURANTE la lectura ----
  let lecturas = 0;
  const declarado = new ReadableStream({ pull(c) { lecturas++; c.enqueue(new Uint8Array(10)); } });
  const grandeDeclarado = await revalidarCon([html200(declarado, { 'content-length': String(BYTES_MAXIMOS + 1) })]);
  assert.deepEqual([grandeDeclarado.r.tipo, grandeDeclarado.r.motivo], ['no_disponible', 'demasiado_grande']);
  assert.ok(lecturas <= 1, `content-length excesivo: no se lee el cuerpo (${lecturas})`);
  let partes = 0, cancelado = false;
  const PARTE = 64 * 1024;
  // Finito pero mayor que el máximo: sin el corte, la lectura terminaría y fallaría una aserción
  // (no un tiempo agotado ni la memoria).
  const TOTAL_PARTES = Math.ceil(BYTES_MAXIMOS / PARTE) + 8;
  const infinito = new ReadableStream({
    pull(c) { partes++; if (partes > TOTAL_PARTES) c.close(); else c.enqueue(new Uint8Array(PARTE)); },
    cancel() { cancelado = true; }
  });
  const grande = await revalidarCon([html200(infinito)]);
  assert.deepEqual([grande.r.tipo, grande.r.motivo], ['no_disponible', 'demasiado_grande']);
  assert.ok(cancelado, 'se cancela el cuerpo');
  assert.ok(partes <= Math.ceil(BYTES_MAXIMOS / PARTE) + 3, `se corta al superar el máximo (${partes} partes)`);
  const justo = await revalidarCon([html200(v + ' '.repeat(BYTES_MAXIMOS - Buffer.byteLength(v)))]);
  assert.equal(justo.r.tipo, 'hechos', 'exactamente el máximo se acepta');

  assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión real');
  process.exitCode = 0;
  console.log('Adaptador 2.0 CheckMig: hechos canónicos, muestra oficial, P1/P2 con el verificador real, ambiguo, incompatibilidad, redirecciones y tamaño: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
