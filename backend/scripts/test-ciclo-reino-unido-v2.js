// Mantenimiento automático de un segundo país (GB) con el ciclo 2.0 compartido:
//  1. Extracción determinista del resultado oficial de GOV.UK (fixtures reales y mutaciones).
//  2. Adaptador 2.0: compatibilidad disjunta con CheckMig y fallos de la fuente sin lanzar.
//  3. Perfiles visa y UK ETA: qué se autoaplica y qué va a revisión humana.
//  4. Autorizaciones en lista: cada perfil usa solo la entrada de su política; Colombia intacta.
//  5. Recorrido real en Mongo efímero con GET /api/destinos: fuente → cambio confirmado → API (A),
//     repetición sin duplicar (C), fuente ambigua o caída sin publicar (D), Colombia sigue (E),
//     concurrencia y resumen del job.
// Nada toca Atlas ni la red (preload solo-loopback). exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const F = require('../services/propuestas/fuentes/govuk-check-uk-visa');
const adaptador = require('../services/propuestas/adaptadores/v2/govuk-check-uk-visa');
const checkmig = require('../services/propuestas/adaptadores/v2/migracion-colombia-checkmig');
const { ADAPTADORES_V2 } = require('../services/propuestas/adaptadores/v2');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const GB = require('../services/propuestas/ciclo/perfil-govuk-reino-unido');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const CLI = require('./ciclo-checkmig-v2');

const FX = path.join(__dirname, 'fixtures', 'govuk-check-uk-visa');
const html = n => readFileSync(path.join(FX, n), 'utf8').replace(/\r\n/g, '\n');
const UY = html('resultado-uy-turismo-2026-11-22.html');
const PREGUNTA = html('pregunta-motivo-uy-2026-11-22.html');
const CO_VISA = html('resultado-co-turismo-sin-familia-2026-11-22.html');
const FICHA_CO = readFileSync(path.join(__dirname, 'fixtures', 'checkmig', 'valida.html'), 'utf8').replace(/\r\n/g, '\n');
const PUBLICADO = JSON.parse(readFileSync(path.join(FX, 'registro-publicado-gb-2026-11-22.json'), 'utf8'));
const conId = r => ({ ...r, _id: new ObjectId(r._id) });
const sinId = ({ _id, ...r }) => r;
// Resultado «visa» con el contexto de Uruguay: título y cuerpo del resultado real de visa.
const TITULO_ETA = "You'll need an electronic travel authorisation (ETA) or a visa";
const UY_VISA = UY.replace(TITULO_ETA, 'You’ll need a visa to come to the UK');
const okHtml = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
const T0 = new Date('2026-11-22T12:00:00.000Z');
const leer = (fabrica, ahora = () => T0) => adaptador.leer({ fetch: async () => fabrica(), ahora });

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Extracción ----
    const e = F.extraer(UY);
    assert.deepEqual([e.estado, e.campos.resultado.valor, e.campos.contexto.valor], ['ok', 'eta_o_visa', { nacionalidad: 'UY', doble_ciudadania_britanica_o_irlandesa: 'no', motivo: 'turismo' }]);
    assert.match(e.campos.resultado.evidencia[1], /^You must apply for either: an electronic travel authorisation \(ETA\); a Standard Visitor visa$/);
    assert.equal(F.extraer(UY_VISA).campos.resultado.valor, 'visa');
    assert.equal(F.extraer(CO_VISA).campos.resultado.valor, 'visa', 'el título real de visa se reconoce');
    for (const [nombre, h, campo, motivo] of [
      ['pregunta, no resultado', PREGUNTA, 'resultado', 'sin_evidencia'],
      ['otra nacionalidad (Colombia, una pregunta más)', CO_VISA, 'contexto', 'sin_evidencia'],
      ['otra nacionalidad', UY.replace('<dd class="govuk-summary-list__value">Uruguay</dd>', '<dd class="govuk-summary-list__value">Argentina</dd>'), 'contexto', 'contexto_no_coincide'],
      ['doble ciudadanía', UY.replace('<dd class="govuk-summary-list__value">No</dd>', '<dd class="govuk-summary-list__value">Yes</dd>'), 'contexto', 'contexto_no_coincide'],
      ['otro motivo', UY.replace('>Tourism or visiting family and friends<', '>Study<'), 'contexto', 'contexto_no_coincide'],
      ['título desconocido', UY.replace(TITULO_ETA, 'You may need an ETA'), 'resultado', 'no_reconocido'],
      ['lista con una sola opción', UY.replace(/<li>a <a href="\/standard-visitor">Standard Visitor visa<\/a>\s*<\/li>/, ''), 'resultado', 'contradiccion'],
      ['sin la lista', UY.replace('You must apply for either:', 'You can apply for:'), 'resultado', 'contradiccion'],
      ['dos <main>', UY.replace('</main>', '</main><main></main>'), 'resultado', 'sin_evidencia']
    ]) {
      const x = F.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      assert.equal(x.campos[campo].estado, 'ambiguo', nombre);
      assert.equal(x.campos[campo].motivo.split(':')[0], motivo, `${nombre}: ${x.campos[campo].motivo}`);
    }

    // ---- 2. Adaptador ----
    const h1 = await leer(okHtml(UY));
    assert.deepEqual([h1.tipo, h1.url, h1.fuente_nombre, h1.hechos.resultado, h1.diagnostico.http_status], ['hechos', F.URL_RESULTADO, 'GOV.UK', 'eta_o_visa', 200]);
    assert.equal(h1.hechos_hash, (await leer(okHtml(UY))).hechos_hash, 'mismo HTML, mismos hechos');
    for (const [nombre, f, motivo] of [
      ['503', caida, 'http_503'], ['no HTML', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), 'no_html'],
      ['red', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, 'red:ECONNRESET'],
      ['redirección ajena', () => new Response(null, { status: 302, headers: { location: 'https://ejemplo.invalid/x' } }), 'redireccion_fuera_del_sitio']
    ]) {
      const r = await leer(f);
      assert.deepEqual([r.tipo, r.motivo], ['no_disponible', motivo], nombre);
    }
    const amb = await leer(okHtml(PREGUNTA));
    assert.deepEqual([amb.tipo, amb.motivo], ['ambiguo', 'resultado:sin_evidencia,contexto:sin_evidencia']);
    const llamadas = [];
    await adaptador.leer({ fetch: async (u, o) => { llamadas.push([u, o.redirect, o.headers['user-agent']]); return okHtml(UY)(); } });
    assert.deepEqual(llamadas, [[F.URL_RESULTADO, 'manual', 'buscador-requisitos-viaje/adaptador-govuk-check-uk-visa']], 'una consulta por lectura');
    assert.ok(ADAPTADORES_V2.includes(adaptador) && ADAPTADORES_V2.includes(checkmig));

    // ---- 3. Perfiles ----
    const HOY = fechaMontevideo(T0);
    const cl = (perfil, req, l) => ciclo.clasificar(req, l, perfil, { hoy: HOY });
    const visaReal = cl(GB.visa, PUBLICADO.visa, h1);
    assert.deepEqual([visaReal.accion, visaReal.guardado, visaReal.esperado, visaReal.cambios.map(c => [c.campo, c.propuesto.valor])],
      ['cambio_aplicable', 'si', 'no', [['obligatorio', 'no'], ['fuente', F.URL_RESULTADO]]], 'GB visa publicado: si → no con la fuente oficial');
    const etaReal = cl(GB.eta, PUBLICADO.eta, h1);
    assert.deepEqual([etaReal.accion, etaReal.esperado, etaReal.fecha_verificacion.efecto], ['sin_cambio', 'si', 'no_se_renueva']);
    assert.ok(etaReal.observaciones.some(o => o.codigo === 'fuente_no_es_la_oficial'), 'no cambia solo la fuente (renovaría la fecha)');
    const hVisa = await leer(okHtml(UY_VISA));
    assert.equal(cl(GB.visa, { ...PUBLICADO.visa, obligatorio: 'no' }, hVisa).motivo, 'descripcion_contradice', 'visa requerida con descripción «No requiere visa»');
    assert.equal(cl(GB.eta, PUBLICADO.eta, hVisa).motivo, 'eta_no_aplicaria');
    assert.equal(cl(GB.visa, { ...PUBLICADO.visa, descripcion: 'No requiere visa. Requiere visa para turismo.' }, h1).motivo, 'descripcion_ambigua');
    assert.equal(cl(GB.visa, { ...PUBLICADO.visa, descripcion: 'Visa obligatoria antes del viaje.' }, h1).motivo, 'descripcion_contradice');
    assert.equal(cl(GB.visa, PUBLICADO.visa, amb).motivo, 'lectura_ambigua');
    assert.equal(cl(GB.visa, PUBLICADO.visa, await leer(caida)).accion, 'fuente_no_disponible');
    assert.equal(cl(GB.visa, PUBLICADO.eta, h1).motivo, 'requisito_fuera_de_perfil');
    assert.equal(cl(GB.visa, PUBLICADO.visa, { ...h1, evidencia: { ...h1.evidencia, resultado: [] } }).motivo, 'sin_evidencia_confirmada');
    assert.equal(cl(GB.visa, PUBLICADO.visa, { ...h1, fuente_nombre: 'Migración Colombia' }).motivo, 'sin_evidencia_confirmada');
    assert.deepEqual(GB.afirmacionesVisa(PUBLICADO.visa.descripcion), { afirma: false, niega: true });

    // ---- 4. Autorizaciones ----
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const env = (extra = {}) => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...extra });
    const aut = (politica, desde = Date.now() - 60_000, hasta = Date.now() + 86_400_000) => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: new Date(desde).toISOString(), vence_en: new Date(hasta).toISOString() });
    const CO = aut('checkmig-colombia-obligatoriedad@1'), UK = aut('govuk-reino-unido-turismo-uy@1');
    const conf = (a, perfil) => R.cargarConfigCicloReal(env(a === undefined ? {} : { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(a) }), new Date(), perfil ? { perfil } : {});
    assert.deepEqual([conf(CO).perfil.nombre, conf(CO).politica_habilitada], ['checkmig-colombia', true], 'forma original (objeto) sin cambios para Colombia');
    assert.deepEqual([conf(CO, 'govuk-gb-visa').politica_habilitada, conf(CO, 'govuk-gb-visa').motivo_sin_politica], [false, 'CICLO_V2_AUTORIZACION_JSON no incluye govuk-reino-unido-turismo-uy@1'], 'la autorización de CheckMig no se reutiliza');
    assert.deepEqual([conf([CO, UK], 'govuk-gb-visa').politica_habilitada, conf([CO, UK], 'govuk-gb-eta').politica_habilitada, conf([CO, UK]).politica_habilitada], [true, true, true]);
    assert.equal(conf([CO, aut(UK.politica, Date.now() - 2 * 86_400_000, Date.now() - 86_400_000)], 'govuk-gb-visa').motivo_sin_politica, 'la autorización venció');
    for (const [nombre, a, perfil] of [['política repetida', [CO, CO]], ['lista vacía', []], ['desconocida en la lista', [CO, aut('todo@1')]],
      ['entrada inválida aunque no sea la propia', [UK, { ...CO, vence_en: 'mañana' }], 'govuk-gb-visa'], ['perfil desconocido', CO, 'xx']]) {
      assert.throws(() => conf(a, perfil), err => err instanceof R.ErrorConfiguracionCiclo && !/SECRETO/.test(err.message), nombre);
    }

    // ---- 5. Recorrido en Mongo efímero ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_gb'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const crearIndices = async () => {
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
    };
    const CO_CORREGIDO = { _id: new ObjectId(), tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.',
      fuente: URL_FICHA, link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17', estado: 'confirmado' };
    const sembrar = async () => {
      await conexion.db.dropDatabase(); await crearIndices();
      await col('destinos').insertMany([
        { _id: new ObjectId(PUBLICADO.destino._id), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [conId(PUBLICADO.visa), conId(PUBLICADO.eta)] },
        { _id: new ObjectId(), pais: 'Colombia', codigo_iso: 'CO', requisitos: [CO_CORREGIDO] }
      ]);
    };
    // Fuente simulada por URL: cada perfil consume solo sus respuestas.
    let colas = {};
    const fuente = async u => { const c = colas[u]; if (!c?.length) throw new Error(`consulta no esperada a ${u}`); return c.shift()(); };
    const consumidas = () => Object.values(colas).every(c => c.length === 0);
    const resumen = [];
    const correr = async (perfil, e, respuestas) => {
      colas = respuestas;
      const lineas = [];
      const codigo = await CLI.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }],
        fetch: fuente, uuid: () => crypto.randomUUID(), resumen: l => resumen.push(l) }, { perfil });
      const reg = lineas.filter(l => l.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1);
      assert.ok(consumidas(), `${perfil}: quedaron respuestas sin consumir`);
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')));
      return { codigo, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)), lineas };
    };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));
    const gbApi = async () => (await api()).find(d => d.codigo_iso === 'GB').requisitos;
    const GOV = F.URL_RESULTADO;
    const soloCo = env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify(CO) });
    const ambas = env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify([CO, UK]) });

    await sembrar();
    const antesApi = await gbApi();
    assert.deepEqual([antesApi[0].obligatorio, antesApi[0].fuente], ['si', 'https://www.iatatravelcentre.com/']);

    // Solo la autorización de Colombia: GB informa el cambio y no escribe (exit 2).
    let h = await huella();
    const informe = await correr('govuk-gb-visa', soloCo, { [GOV]: [okHtml(UY)] });
    assert.deepEqual([informe.codigo, informe.registro.modo, informe.registro.resultado, informe.registro.motivo, informe.registro.perfil], [2, 'informe', 'cambio_aplicable', 'politica_no_habilitada', 'govuk-gb-visa']);
    assert.equal(await huella(), h, 'sin la política de GB no se escribe nada');

    // D. Fuente ambigua y caída con la política vigente: nada publicado.
    const d1 = await correr('govuk-gb-visa', ambas, { [GOV]: [okHtml(PREGUNTA)] });
    assert.deepEqual([d1.codigo, d1.registro.resultado, d1.registro.motivo, d1.registro.pendiente.campos.map(c => c.campo)], [3, 'revision_humana', 'lectura_ambigua', ['resultado', 'contexto']]);
    const d2 = await correr('govuk-gb-visa', ambas, { [GOV]: [caida] });
    assert.deepEqual([d2.codigo, d2.registro.resultado, d2.registro.fuente.http_status], [4, 'fuente_no_disponible', 503]);
    assert.equal(await huella(), h, 'ambigua o caída: cero escrituras');

    // A. Fuente oficial → cambio confirmado (dos lecturas: detección + revalidación H3.3) → API.
    const a = await correr('govuk-gb-visa', ambas, { [GOV]: [okHtml(UY), okHtml(UY)] });
    assert.deepEqual([a.codigo, a.registro.modo, a.registro.resultado, a.registro.estado_propuesta, a.registro.valor_aplicado, a.registro.objetivo.requisito, a.registro.politica.nombre],
      [0, 'politica_automatica', 'exito', 'aplicada', 'no', 'visa', 'govuk-reino-unido-turismo-uy@1'], a.lineas.join('\n'));
    const despues = await gbApi();
    const hoy = fechaMontevideo(new Date());
    assert.deepEqual([despues[0].obligatorio, despues[0].fuente, String(despues[0].fecha_verificacion).slice(0, 10), despues[0].descripcion],
      ['no', GOV, hoy, PUBLICADO.visa.descripcion], 'GET /api/destinos muestra el cambio');
    assert.deepEqual(sinId(despues[1]), { ...sinId(PUBLICADO.eta), fecha_verificacion: '2026-08-20T00:00:00.000Z' }, 'el UK ETA no se toca');
    const intento = await col('intentos_aplicacion').findOne({ intento_id: a.registro.intento_id });
    assert.deepEqual([intento.auditoria.operador, intento.revalidaciones[0].url, intento.adaptador.nombre], ['proceso.ciclo', GOV, 'govuk-check-uk-visa']);
    const prop = await col('propuestas_cambio').findOne({ propuesta_id: a.registro.propuesta_id });
    assert.deepEqual([prop.payload.fuentes[0].hechos.resultado, prop.payload.advertencias], ['eta_o_visa', ['quita_obligatoriedad']]);
    const ev = await col('eventos_propuesta').findOne({ propuesta_id: a.registro.propuesta_id, tipo_evento: 'aprobacion' });
    assert.deepEqual([ev.actor.identificador, ev.detalle.identidad_operador.metodo, ev.detalle.identidad_operador.politica], ['persona.autorizante', 'politica_automatica', 'govuk-reino-unido-turismo-uy@1']);
    assert.match(resumen.at(-1), /^\| govuk-gb-visa \| GB \| politica_automatica \| exito \| 0 \| HTTP 200 .* \| APLICADO: obligatorio → "no" \(propuesta [0-9a-f-]{36}\) \|$/);

    // UK ETA con la misma fuente: sin cambio, la fecha NO se renueva (solo cambiaría la fuente).
    h = await huella();
    const eta1 = await correr('govuk-gb-eta', ambas, { [GOV]: [okHtml(UY)] });
    assert.deepEqual([eta1.codigo, eta1.registro.resultado, eta1.registro.fecha_verificacion.efecto, eta1.registro.observaciones], [0, 'sin_cambio', 'no_se_renueva', ['fuente_no_es_la_oficial']]);
    assert.equal(await huella(), h);

    // C. Repetir: sin propuestas, eventos ni escrituras nuevas.
    const c1 = await correr('govuk-gb-visa', ambas, { [GOV]: [okHtml(UY)] });
    assert.deepEqual([c1.codigo, c1.registro.resultado], [0, 'sin_cambio']);
    assert.equal(await huella(), h, 'la repetición no duplica nada');
    assert.deepEqual([await col('propuestas_cambio').countDocuments(), await col('historial_cambios').countDocuments(), await col('destinos').countDocuments()], [1, 1, 2]);

    // E. Colombia sigue funcionando con la autorización en lista.
    const e1 = await correr('checkmig-colombia', ambas, { [URL_FICHA]: [okHtml(FICHA_CO)] });
    assert.deepEqual([e1.codigo, e1.registro.perfil, e1.registro.modo, e1.registro.resultado], [0, 'checkmig-colombia', 'politica_automatica', 'sin_cambio']);
    assert.equal(await huella(), h);

    // D (segunda lectura). La revalidación de H3.3 resulta ambigua: revisión humana, destino intacto;
    // la corrida siguiente no crea otra propuesta (la activa se informa).
    await sembrar();
    const destinoAntes = JSON.stringify(await col('destinos').findOne({ codigo_iso: 'GB' }));
    const d3 = await correr('govuk-gb-visa', ambas, { [GOV]: [okHtml(UY), okHtml(PREGUNTA)] });
    assert.deepEqual([d3.codigo, d3.registro.estado_propuesta, d3.registro.pendiente.tipo], [3, 'revision_requerida', 'revision_humana']);
    assert.equal(JSON.stringify(await col('destinos').findOne({ codigo_iso: 'GB' })), destinoAntes, 'nada publicado sin confirmar');
    const d4 = await correr('govuk-gb-visa', ambas, {});
    assert.deepEqual([d4.codigo, d4.registro.resultado, await col('propuestas_cambio').countDocuments()], [3, 'propuesta_activa_existente', 1]);

    // Concurrencia: dos corridas simultáneas del mismo perfil escriben una sola vez.
    await sembrar();
    const p = await R.prepararEjecucionReal(R.cargarConfigCicloReal(ambas, new Date(), { perfil: 'govuk-gb-visa' }), {
      conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: async () => okHtml(UY)(), ahora: () => new Date(), uuid: () => crypto.randomUUID() });
    const [x, y] = await Promise.all([ciclo.ejecutarCicloV2(p.objetivo, p.perfil, p.contexto), ciclo.ejecutarCicloV2(p.objetivo, p.perfil, p.contexto)]);
    const resultados = [x.resultado, y.resultado];
    assert.equal(resultados.filter(r => r === 'exito').length, 1, JSON.stringify(resultados));
    assert.equal(await col('historial_cambios').countDocuments(), 1, 'un solo cambio aplicado');
    assert.equal(await col('propuestas_cambio').countDocuments({ estado: { $in: ['pendiente_aprobacion', 'aprobada', 'revision_requerida'] } }), 0, 'ninguna propuesta queda colgada');
    assert.equal((await gbApi())[0].obligatorio, 'no');

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log(`Ciclo GB 2.0: extracción GOV.UK, adaptador, perfiles visa/UK ETA, autorizaciones en lista, A/C/D/E y concurrencia (${resultados.join(' + ')}) en Mongo efímero: OK`);
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
