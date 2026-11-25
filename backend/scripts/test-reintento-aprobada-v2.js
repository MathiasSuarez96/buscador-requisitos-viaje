// Reintento automático de una propuesta APROBADA cuya aplicación falló por una caída de la fuente:
//  1. Pura: qué fallos son transitorios y qué condiciones admite evaluarReintento.
//  2. Mongo efímero + ciclo real (ejecutarReal) + GET /api/destinos:
//     caída → caída otra vez (nuevo intento, sin escribir) → recuperación → aplicación ÚNICA → API;
//     repeticiones sin escrituras; autorización vencida, renovada o ausente sin escritura (modo
//     informe: solo comandos de lectura); fallos no transitorios, integridad rota, pendiente,
//     revisión, rechazada y cancelada sin reintento; intento en curso, corridas simultáneas y
//     carrera directa en H3.3 sin duplicar propuesta, aprobación, historial ni escritura.
// Nada toca Atlas ni la red (preload solo-loopback). exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const FI = require('../services/propuestas/fuentes/embajada-italia-montevideo-visas');
const FV = require('../services/propuestas/fuentes/govuk-check-uk-visa');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const P = require('../services/propuestas/ciclo/perfiles-procedencia-gb-it');
const { PERFILES, clavePolitica } = require('../services/propuestas/ciclo/perfiles');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const D = require('../services/propuestas/decidir-propuesta');
const { aplicarConRevalidacionV2 } = require('../services/propuestas/orquestar-aplicacion-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const CLI = require('./ciclo-checkmig-v2');

const fx = (...p) => readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf8').replace(/\r\n/g, '\n');
const IT = fx('embajada-italia-montevideo', 'extracto-visas-2026-11-23.html');
const GBH = fx('govuk-check-uk-visa', 'resultado-uy-turismo-2026-11-22.html');
const FICHA_CO = fx('checkmig', 'valida.html');
const PUB_IT = JSON.parse(fx('embajada-italia-montevideo', 'registro-publicado-it-2026-11-23.json'));
const PUB_GB = JSON.parse(fx('govuk-check-uk-visa', 'registro-publicado-gb-2026-11-22.json'));
const PUB_GBP = JSON.parse(fx('govuk-check-uk-visa', 'registro-publicado-gb-pasaporte-2026-11-23.json'));
const conId = r => ({ ...r, _id: new ObjectId(r._id) });
const okHtml = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const status = s => () => new Response('x', { status: s, headers: { 'content-type': 'text/html' } });
const caida = status(503);
const sinRed = () => { throw new TypeError('fetch failed'); };
const fuera = () => new Response(null, { status: 302, headers: { location: 'https://ejemplo.invalid/' } });
const ITU = FI.URL_PAGINA, GOV = FV.URL_RESULTADO;
const PERFIL = 'embajada-it-pasaporte';
const COMANDOS_ESCRITURA = ['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'commitTransaction', 'drop'];

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Pura ----
    const l = (codigo_fallo, http_status) => ({ tipo: 'no_disponible', codigo_fallo, ...(http_status ? { http_status } : {}) });
    for (const x of [l('red'), l('tiempo_agotado'), l('http', 500), l('http', 502), l('http', 503), l('http', 504), l('http', 408), l('http', 429)]) assert.equal(ciclo.lecturaTransitoria(x), true, JSON.stringify(x));
    for (const x of [l('http', 404), l('http', 403), l('http', 410), l('http'), l('redireccion_fuera_del_sitio'), l('redireccion_sin_destino'), l('demasiadas_redirecciones'),
      l('no_html'), l('cuerpo_ilegible'), l('demasiado_grande'), { tipo: 'ambiguo' }, { tipo: 'hechos' }, null]) assert.equal(ciclo.lecturaTransitoria(x), false, JSON.stringify(x));

    // ---- 2. Mongo efímero ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_reintento'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const reqApi = async (iso, tipo) => (await api()).find(d => d.codigo_iso === iso).requisitos.find(r => r.tipo === tipo);
    const CO = { _id: new ObjectId(), tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.',
      fuente: URL_FICHA, link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17', estado: 'confirmado' };
    const sembrar = async () => {
      await conexion.db.dropDatabase();
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
      await col('destinos').insertMany([
        { _id: new ObjectId(PUB_IT.destino._id), pais: 'Italia', codigo_iso: 'IT', requisitos: [conId(PUB_IT.visa), conId(PUB_IT.validez_pasaporte)] },
        { _id: new ObjectId(PUB_GB.destino._id), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [conId(PUB_GB.visa), conId(PUB_GB.eta), conId(PUB_GBP.requisito)] },
        { _id: new ObjectId(), pais: 'Colombia', codigo_iso: 'CO', requisitos: [CO] }
      ]);
    };
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const env = lista => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...(lista ? { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) } : {}) });
    const AUT_EN = new Date(Date.now() - 60_000).toISOString(), VENCE = new Date(Date.now() + 86_400_000).toISOString();
    const aut = (politica, a = AUT_EN, v = VENCE) => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: a, vence_en: v });
    const TODAS = [...new Set(PERFILES.map(clavePolitica))].map(p => aut(p));
    const conTodas = env(TODAS);
    const otras = TODAS.filter(a => a.politica !== 'embajada-italia-it-pasaporte-uy@1');
    const conVencida = env([...otras, aut('embajada-italia-it-pasaporte-uy@1', new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString())]);
    const conOtroAutorizante = env([...otras, { ...aut('embajada-italia-it-pasaporte-uy@1'), autorizada_por: 'otra.persona' }]);
    const conRenovada = env([...otras, aut('embajada-italia-it-pasaporte-uy@1', new Date(Date.now() - 30_000).toISOString(), new Date(Date.now() + 2 * 86_400_000).toISOString())]);
    const sinPolitica = env(otras);

    const comandos = [];
    conexion.getClient().on('commandStarted', e => comandos.push(e.commandName));
    const correr = async (e, fetch, perfil = PERFIL) => {
      const lineas = [], resumen = [];
      const desde = comandos.length;
      const codigo = await CLI.ejecutarReal(e, x => lineas.push(x), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }],
        fetch, uuid: () => crypto.randomUUID(), resumen: x => resumen.push(x) }, { perfil });
      const reg = lineas.filter(x => x.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1);
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')), 'sin credenciales en la salida');
      return { codigo, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)), lineas, resumen, comandos: comandos.slice(desde) };
    };
    // Fetch en cola: cada consulta toma la siguiente respuesta; consultas de más hacen fallar la prueba.
    const cola = (...respuestas) => { const f = async u => { assert.equal(u, ITU); const r = respuestas.shift(); if (!r) throw new Error(`consulta no esperada a ${u}`); f.consultas += 1; return r(); }; f.consultas = 0; f.restan = () => respuestas.length; return f; };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));
    const itDoc = async () => JSON.stringify(await col('destinos').findOne({ codigo_iso: 'IT' }));
    const cuenta = async () => ({ propuestas: await col('propuestas_cambio').countDocuments(), aprobaciones: await col('eventos_propuesta').countDocuments({ tipo_evento: 'aprobacion' }),
      aplicaciones: await col('eventos_propuesta').countDocuments({ tipo_evento: 'aplicacion' }), intentos: await col('intentos_aplicacion').countDocuments(),
      exitos: await col('intentos_aplicacion').countDocuments({ resultado: 'exito' }), historial: await col('historial_cambios').countDocuments() });
    // Deja una propuesta aprobada con la aplicación caída (detección OK, revalidación de H3.3 con `fallo`).
    const aprobadaCaida = async (fallo = caida) => {
      await sembrar();
      const f = cola(okHtml(IT), fallo);
      const r = await correr(conTodas, f);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.estado_propuesta, r.registro.pendiente?.tipo, f.restan()], [4, 'fuente_temporalmente_no_disponible', 'aprobada', 'reintentar', 0], r.lineas.join('\n'));
      return r.registro;
    };
    const hoy = fechaMontevideo(new Date());
    const li = await require('../services/propuestas/adaptadores/v2/embajada-italia-montevideo').leer({ fetch: async () => okHtml(IT)(), ahora: () => new Date() });

    // A. Caída → caída otra vez → recuperación → aplicación única → API.
    const r0 = await aprobadaCaida();
    const antes = await itDoc();
    const itVisaAntes = JSON.stringify(await reqApi('IT', 'visa'));
    assert.deepEqual(await cuenta(), { propuestas: 1, aprobaciones: 1, aplicaciones: 0, intentos: 1, exitos: 0, historial: 0 });
    const f1 = cola(sinRed);
    const r1 = await correr(conTodas, f1);
    assert.deepEqual([r1.codigo, r1.registro.resultado, r1.registro.propuesta_id, r1.registro.estado_propuesta, r1.registro.reintento?.admitido, r1.registro.reintento?.intento_previo_id, r1.registro.fuente?.motivo, f1.consultas],
      [4, 'fuente_temporalmente_no_disponible', r0.propuesta_id, 'aprobada', true, r0.intento_id, 'red', 1], r1.lineas.join('\n'));
    assert.equal(await itDoc(), antes, 'segunda caída: nada publicado');
    assert.deepEqual(await cuenta(), { propuestas: 1, aprobaciones: 1, aplicaciones: 0, intentos: 2, exitos: 0, historial: 0 }, 'un intento nuevo auditado, sin otra propuesta ni aprobación');
    const f2 = cola(okHtml(IT));
    const r2 = await correr(conTodas, f2);
    assert.deepEqual([r2.codigo, r2.registro.resultado, r2.registro.propuesta_id, r2.registro.estado_propuesta, r2.registro.reintento?.intento_previo_id, r2.registro.reintento?.intentos_previos,
      r2.registro.tipo_cambio, r2.registro.campos_propuestos, r2.registro.valor_aplicado, f2.consultas],
    [0, 'exito', r0.propuesta_id, 'aplicada', r1.registro.intento_id, 2, 'procedencia', ['descripcion', 'fuente'], 'si', 1], r2.lineas.join('\n'));
    assert.match(r2.resumen[0], /^\| embajada-it-pasaporte \| IT \| politica_automatica \| exito \| 0 \| .* \| REINTENTO 2 de 3 de la propuesta aprobada \(intento previo [0-9a-f-]{36}\); APLICADO: cambio de procedencia/);
    assert.deepEqual(await cuenta(), { propuestas: 1, aprobaciones: 1, aplicaciones: 1, intentos: 3, exitos: 1, historial: 1 });
    const intento = await col('intentos_aplicacion').findOne({ intento_id: r2.registro.intento_id });
    assert.deepEqual([intento.auditoria.operador, intento.revalidaciones[0].url, intento.aprobacion.evento_id], ['proceso.ciclo', ITU, r0.decision_evento_id ?? intento.aprobacion.evento_id]);
    const evAprob = await col('eventos_propuesta').findOne({ tipo_evento: 'aprobacion' });
    assert.equal(intento.aprobacion.evento_id, evAprob.evento_id, 'el reintento usa la aprobación original');
    // Revalidación real de H3.3: el intento exitoso guarda la lectura con los hechos APROBADOS.
    const aprobada = await col('propuestas_cambio').findOne({ propuesta_id: r0.propuesta_id });
    assert.deepEqual([intento.revalidaciones.length, intento.revalidaciones[0].hechos_hash], [1, aprobada.payload.fuentes[0].hechos_hash]);
    const intentoCaido = await col('intentos_aplicacion').findOne({ intento_id: r1.registro.intento_id });
    assert.deepEqual([intentoCaido.resultado, intentoCaido.lecturas_fuente.map(x => x.codigo_fallo)], ['fuente_temporalmente_no_disponible', ['red']], 'cada reintento deja su intento auditado');
    const itp = await reqApi('IT', 'validez_pasaporte');
    assert.deepEqual([itp.obligatorio, itp.fuente, itp.descripcion, String(itp.fecha_verificacion).slice(0, 10)], ['si', ITU, P.descripcionItPasaporte(li.hechos), hoy], 'API');
    assert.equal(JSON.stringify(await reqApi('IT', 'visa')), itVisaAntes, 'el otro requisito de IT no se toca');
    // Repeticiones: sin propuestas, intentos ni escrituras nuevas.
    let h = await huella();
    for (let i = 0; i < 3; i++) {
      const r = await correr(conTodas, cola(okHtml(IT)));
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.reintento], [0, 'sin_cambio', null]);
      assert.deepEqual(r.comandos.filter(c => COMANDOS_ESCRITURA.includes(c)), [], 'repetición: solo lecturas');
    }
    assert.equal(await huella(), h, 'repeticiones sin escrituras');

    // B. Autorización vencida, renovada o ausente: no se reintenta ni se escribe (modo informe).
    for (const [nombre, e, motivo, pendiente, modo] of [
      ['vencida', conVencida, 'politica_no_habilitada', 'autorizacion', 'informe'],
      ['ausente', sinPolitica, 'politica_no_habilitada', 'autorizacion', 'informe'],
      ['renovada (otra autorización)', conRenovada, 'aprobacion_fuera_de_la_autorizacion_vigente', 'revision_humana', 'politica_automatica'],
      ['distinta (otro autorizante, mismas fechas)', conOtroAutorizante, 'aprobacion_fuera_de_la_autorizacion_vigente', 'revision_humana', 'politica_automatica']
    ]) {
      await aprobadaCaida();
      h = await huella();
      const f = cola();
      const r = await correr(e, f);
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.motivo, r.registro.pendiente.tipo, r.registro.reintento.admitido, f.consultas],
        [3, modo, 'propuesta_activa_existente', motivo, pendiente, false, 0], `${nombre}\n${r.lineas.join('\n')}`);
      assert.deepEqual(r.comandos.filter(c => COMANDOS_ESCRITURA.includes(c)), [], `${nombre}: solo lecturas`);
      assert.equal(await huella(), h, `${nombre}: cero escrituras`);
    }
    // Recuperada la autorización ORIGINAL (vigente), la misma propuesta se reintenta y aplica.
    const rv = await correr(conTodas, cola(okHtml(IT)));
    assert.deepEqual([rv.codigo, rv.registro.resultado, rv.registro.reintento.admitido], [0, 'exito', true]);

    // B2. HTTP 200 con hechos DISTINTOS de los aprobados: H3.3 revalida (dos lecturas) y nunca aplica
    // el contenido anterior. Mismos hechos nuevos dos veces → obsoleta; distintos entre sí → revisión.
    const IT6 = IT.replace('de 3 meses', 'de 6 meses'), IT9 = IT.replace('de 3 meses', 'de 9 meses');
    for (const [nombre, l1, l2, resultado, estado] of [['mismos hechos nuevos', IT6, IT6, 'fuente_cambio', 'obsoleta'], ['hechos nuevos distintos entre sí', IT6, IT9, 'extraccion_ambigua', 'revision_requerida']]) {
      const prev = await aprobadaCaida();
      const antesIT = await itDoc();
      const f = cola(okHtml(l1), okHtml(l2));
      const r = await correr(conTodas, f);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.estado_propuesta, r.registro.propuesta_id, r.registro.reintento?.admitido, f.consultas], [3, resultado, estado, prev.propuesta_id, true, 2], `${nombre}\n${r.lineas.join('\n')}`);
      assert.equal(await itDoc(), antesIT, `${nombre}: el destino no cambia`);
      const c = await cuenta();
      assert.deepEqual([c.propuestas, c.aprobaciones, c.aplicaciones, c.historial, c.exitos], [1, 1, 0, 0, 0], nombre);
      const lecturas = (await col('intentos_aplicacion').findOne({ intento_id: r.registro.intento_id })).lecturas_fuente;
      const aprobadoHash = (await col('propuestas_cambio').findOne({ propuesta_id: prev.propuesta_id })).payload.fuentes[0].hechos_hash;
      assert.ok(lecturas.length === 2 && lecturas.every(x => x.tipo === 'hechos' && x.hechos_hash !== aprobadoHash), `${nombre}: dos lecturas reales de H3.3 con otros hechos`);
    }

    // B3. Límite: como máximo 3 reintentos automáticos después del intento inicial.
    assert.equal(ciclo.MAX_REINTENTOS_AUTOMATICOS, 3);
    const inicial = await aprobadaCaida();
    for (const n of [1, 2, 3]) {
      const f = cola(caida);
      const r = await correr(conTodas, f);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.propuesta_id, r.registro.reintento.numero, r.registro.reintento.agotados, r.registro.pendiente.tipo, f.consultas],
        [4, 'fuente_temporalmente_no_disponible', inicial.propuesta_id, n, n === 3, n === 3 ? 'revision_humana' : 'reintentar', 1], `reintento ${n}`);
      if (n === 3) {
        assert.equal(r.registro.pendiente.motivo, 'reintentos_agotados');
        assert.match(r.resumen[0], /REINTENTOS AGOTADOS \(3 de 3\): no se aplica sola, requiere revisión humana/);
      }
    }
    assert.deepEqual(await cuenta(), { propuestas: 1, aprobaciones: 1, aplicaciones: 0, intentos: 4, exitos: 0, historial: 0 }, 'inicial + 3 reintentos, cada uno auditado');
    // Agotados: aunque la fuente ya responda, no se consulta ni se aplica; revisión humana, exit 3.
    h = await huella();
    for (let i = 0; i < 2; i++) {
      const f = cola();
      const r = await correr(conTodas, f);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo, r.registro.pendiente.tipo, r.registro.reintento.detalle, f.consultas],
        [3, 'propuesta_activa_existente', 'reintentos_agotados', 'revision_humana', { reintentos: 3, maximo: 3 }, 0]);
      assert.match(r.resumen[0], /\| 3 \| - \| REINTENTOS AGOTADOS \(3 de 3\)/);
      assert.deepEqual(r.comandos.filter(x => COMANDOS_ESCRITURA.includes(x)), []);
    }
    assert.equal(await huella(), h, 'agotados: cero escrituras');

    // C. Fallos que no son caídas transitorias: la propuesta queda para revisión, sin consultar ni escribir.
    for (const [nombre, fallo, codigo] of [['404', status(404), 'http'], ['redirección fuera del sitio', fuera, 'redireccion_fuera_del_sitio']]) {
      await aprobadaCaida(fallo);
      h = await huella();
      const f = cola();
      const r = await correr(conTodas, f);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo, r.registro.pendiente.tipo, f.consultas], [3, 'propuesta_activa_existente', 'fallo_no_admitido', 'revision_humana', 0], nombre);
      assert.deepEqual(r.registro.reintento.detalle.codigos, [codigo], nombre);
      assert.equal(await huella(), h, `${nombre}: cero escrituras`);
    }
    // Integridad rota (payload alterado, aprobación de otro origen) o identidad distinta: sin reintento.
    for (const [nombre, alterar, motivo] of [
      ['payload alterado', p => col('propuestas_cambio').updateOne({ propuesta_id: p }, { $set: { 'payload.cambios.0.propuesto.valor': 'otra cosa' } }), 'propuesta_no_integra'],
      ['aprobación manual (no por la política)', async p => col('eventos_propuesta').updateOne({ propuesta_id: p, tipo_evento: 'aprobacion' }, { $set: { 'detalle.identidad_operador.metodo': 'panel' } }), 'aprobacion_fuera_de_la_autorizacion_vigente'],
      ['evento de aprobación de otro contenido', async p => col('eventos_propuesta').updateOne({ propuesta_id: p, tipo_evento: 'aprobacion' }, { $set: { hash_contenido_referenciado: '0'.repeat(64) } }), 'propuesta_no_integra'],
      ['requisito con otra identidad', async () => col('destinos').updateOne({ codigo_iso: 'IT', 'requisitos.tipo': 'validez_pasaporte' }, { $set: { 'requisitos.$.nombre': 'Pasaporte' } }), 'requisito_fuera_de_perfil']
    ]) {
      const reg = await aprobadaCaida();
      await alterar(reg.propuesta_id);
      h = await huella();
      const f = cola();
      const r = await correr(conTodas, f, PERFIL);
      if (nombre === 'requisito con otra identidad') {
        // El perfil ya no encuentra su requisito: el prechequeo falla antes de leer la fuente.
        assert.deepEqual([r.codigo, r.registro.resultado], [1, 'error'], nombre);
      } else {
        assert.deepEqual([r.codigo, r.registro.resultado, r.registro.reintento?.admitido, f.consultas], [3, 'propuesta_activa_existente', false, 0], `${nombre}\n${r.lineas.join('\n')}`);
        assert.equal(r.registro.motivo, motivo, nombre);
      }
      assert.equal(await huella(), h, `${nombre}: cero escrituras`);
    }

    // D. Pendiente de aprobación y revisión requerida: nunca se reintentan (ni se consulta la fuente).
    await sembrar();
    const rev = await correr(conTodas, cola(okHtml(IT), okHtml(IT.replace('no necesitan de visa', 'necesitan de visa'))));
    assert.equal(rev.registro.estado_propuesta, 'revision_requerida');
    h = await huella();
    const rrev = await correr(conTodas, cola());
    assert.deepEqual([rrev.codigo, rrev.registro.resultado, rrev.registro.estado_propuesta, rrev.registro.reintento ?? null], [3, 'propuesta_activa_existente', 'revision_requerida', null]);
    assert.equal(await huella(), h);
    const pend = await aprobadaCaida();
    await col('propuestas_cambio').updateOne({ propuesta_id: pend.propuesta_id }, { $set: { estado: 'pendiente_aprobacion' } });
    h = await huella();
    const rpend = await correr(conTodas, cola());
    assert.deepEqual([rpend.codigo, rpend.registro.resultado, rpend.registro.estado_propuesta, rpend.registro.reintento ?? null], [3, 'propuesta_activa_existente', 'pendiente_aprobacion', null]);
    assert.equal(await huella(), h);

    // E. Cancelada (decisión humana real) o rechazada con los mismos hechos: no se vuelve a proponer sola.
    const can = await aprobadaCaida();
    const pc = await col('propuestas_cambio').findOne({ propuesta_id: can.propuesta_id });
    const dec = await D.decidirPropuesta({ tipo_evento: 'cancelacion', propuesta_id: pc.propuesta_id, estado_esperado: 'aprobada', payload_hash_esperado: pc.payload_hash,
      version_coordinacion_esperada: pc.version_coordinacion, decision_aprobacion_id_esperado: pc.decision_aprobacion_id, version_contrato_esperada: '2.0', motivo: 'La operadora prefiere revisar la descripción.' },
    { ...D.crearDependenciasMongoose(conexion), uuid: () => crypto.randomUUID(), ahora: () => new Date(),
      resolverIdentidad: async () => ({ actor: { tipo: 'humano', identificador: 'operadora.panel' }, identidad_operador: { metodo: 'connection_status', usuario_atlas: 'op', db_autenticacion: 'admin' }, comando: { nombre: 'decidir-propuesta', version: '1' } }) });
    assert.equal(dec.resultado, 'decision_registrada', JSON.stringify(dec));
    h = await huella();
    const rcan = await correr(conTodas, cola(okHtml(IT)));
    assert.deepEqual([rcan.codigo, rcan.registro.resultado, rcan.registro.motivo, rcan.registro.propuesta_id, rcan.registro.estado_propuesta], [3, 'revision_humana', 'decision_humana_previa', can.propuesta_id, 'cancelada'], rcan.lineas.join('\n'));
    assert.equal(await huella(), h, 'cancelada: cero escrituras');
    await col('propuestas_cambio').updateOne({ propuesta_id: can.propuesta_id }, { $set: { estado: 'rechazada' } });
    h = await huella();
    const rrec = await correr(conTodas, cola(okHtml(IT)));
    assert.deepEqual([rrec.codigo, rrec.registro.motivo, rrec.registro.estado_propuesta], [3, 'decision_humana_previa', 'rechazada']);
    assert.equal(await huella(), h, 'rechazada: cero escrituras');
    // Hechos nuevos en la fuente (6 meses): no es la misma decisión, se propone y aplica otra.
    // IT6: misma página con 6 meses (definida arriba).
    const rnue = await correr(conTodas, cola(okHtml(IT6), okHtml(IT6)));
    assert.deepEqual([rnue.codigo, rnue.registro.resultado, (await reqApi('IT', 'validez_pasaporte')).descripcion.includes('al menos 6 meses')], [0, 'exito', true]);

    // F. Concurrencia.
    // F1. Un intento en curso (inicio sin intento terminado) bloquea el reintento de otra corrida.
    await aprobadaCaida();
    let liberar, consultada;
    const llego = new Promise(ok => { consultada = ok; });
    const pausada = async u => { assert.equal(u, ITU); consultada(); await new Promise(ok => { liberar = ok; }); return okHtml(IT)(); };
    const a = correr(conTodas, pausada);
    await llego;
    h = await huella();
    const b = await correr(conTodas, cola());
    assert.deepEqual([b.codigo, b.registro.resultado, b.registro.motivo, b.registro.pendiente.tipo], [3, 'propuesta_activa_existente', 'intento_en_curso', 'reintentar']);
    assert.equal(await huella(), h, 'la corrida bloqueada no escribe');
    liberar();
    assert.deepEqual([(await a).codigo, (await a).registro.resultado], [0, 'exito']);
    assert.deepEqual(await cuenta(), { propuestas: 1, aprobaciones: 1, aplicaciones: 1, intentos: 2, exitos: 1, historial: 1 });
    // F2. Tres corridas simultáneas: una sola aplicación, sin duplicados.
    await aprobadaCaida();
    const lenta = async u => { assert.equal(u, ITU); await new Promise(ok => setTimeout(ok, 40)); return okHtml(IT)(); };
    const simultaneas = await Promise.all([1, 2, 3].map(() => correr(conTodas, lenta)));
    const resultados = simultaneas.map(r => `${r.registro.resultado}${r.registro.motivo ? `/${r.registro.motivo}` : ''}`);
    assert.equal(resultados.filter(x => x === 'exito').length, 1, resultados.join(', '));
    assert.ok(resultados.every(x => ['exito', 'propuesta_activa_existente/intento_en_curso', 'sin_cambio', 'propuesta_no_aplicable'].includes(x)), resultados.join(', '));
    const cs = await cuenta();
    assert.deepEqual([cs.propuestas, cs.aprobaciones, cs.aplicaciones, cs.exitos, cs.historial], [1, 1, 1, 1, 1], JSON.stringify(cs));
    assert.equal((await reqApi('IT', 'validez_pasaporte')).descripcion, P.descripcionItPasaporte(li.hechos));
    // F3. Carrera directa en H3.3 (las dos pasan la guardia): el CAS de versión y el índice de éxito único
    // dejan una sola escritura; la otra cierra su intento sin escribir.
    await aprobadaCaida();
    const prep = await R.prepararEjecucionReal(R.cargarConfigCicloReal(conTodas, new Date(), { perfil: PERFIL }), {
      conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: async () => okHtml(IT)(), ahora: () => new Date(), uuid: () => crypto.randomUUID() });
    const prop = await col('propuestas_cambio').findOne({ estado: 'aprobada' });
    const ev = ciclo.evaluarReintento({ propuesta: prop, evento: await col('eventos_propuesta').findOne({ evento_id: prop.decision_aprobacion_id }),
      intentos: await col('intentos_aplicacion').find({ propuesta_id: prop.propuesta_id }).toArray(), inicios: await col('inicios_intento_aplicacion').find({ propuesta_id: prop.propuesta_id }).toArray(),
      requisito: (await col('destinos').findOne({ codigo_iso: 'IT' })).requisitos.find(r => r.tipo === 'validez_pasaporte'), objetivo: prep.objetivo, perfil: prep.perfil,
      identidadDecision: prep.contexto.identidadDecision, ahora: new Date() });
    assert.equal(ev.admitido, true, JSON.stringify(ev));
    const carrera = await Promise.all([1, 2].map(() => aplicarConRevalidacionV2(ev.entrada, prep.contexto.credencialAplicacion, prep.contexto.depsAplicacion()).then(x => x.resultado, e => `error:${e?.constructor?.name}`)));
    assert.equal(carrera.filter(x => x === 'exito').length, 1, carrera.join(', '));
    const cc = await cuenta();
    assert.deepEqual([cc.propuestas, cc.aprobaciones, cc.aplicaciones, cc.exitos, cc.historial], [1, 1, 1, 1, 1], `${carrera.join(', ')} ${JSON.stringify(cc)}`);
    assert.equal(await col('inicios_intento_aplicacion').countDocuments(), cc.intentos, 'cada inicio tiene su intento terminado');

    // G. Pura: vencimiento defensivo y estado distinto de aprobada.
    const vencida = ciclo.evaluarReintento({ ...{ propuesta: { ...prop, estado: 'aprobada' } }, evento: null, intentos: [], inicios: [], requisito: null, objetivo: prep.objetivo, perfil: prep.perfil, identidadDecision: null, ahora: new Date() });
    assert.equal(vencida.admitido, false);
    for (const estado of ['pendiente_aprobacion', 'revision_requerida', 'rechazada', 'cancelada', 'aplicada', 'obsoleta', 'conflicto']) {
      assert.equal(ciclo.evaluarReintento({ propuesta: { ...prop, estado }, evento: null, intentos: [], inicios: [], requisito: null, objetivo: prep.objetivo, perfil: prep.perfil, identidadDecision: null, ahora: new Date() }).admitido, false, estado);
    }

    // H. Regresión: los perfiles existentes siguen sin cambio sobre registros canónicos (CO, GB visa/ETA aplicados).
    await sembrar();
    const gv = await correr(conTodas, async () => okHtml(GBH)(), 'govuk-gb-visa');
    assert.deepEqual([gv.codigo, gv.registro.resultado], [0, 'exito'], gv.lineas.join('\n'));
    for (const [perfil, html] of [['checkmig-colombia', FICHA_CO], ['govuk-gb-eta', GBH], ['govuk-gb-visa', GBH]]) {
      const r = await correr(conTodas, async () => okHtml(html)(), perfil);
      assert.deepEqual([r.codigo, r.registro.resultado], [0, 'sin_cambio'], `${perfil}: ${r.lineas.join('\n')}`);
    }

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Reintento 2.0: caída → recuperación → aplicación única → API, repetición sin escrituras, autorización vencida/renovada/ausente sin escribir, fallos no transitorios e integridad rota sin reintento, pendiente/revisión/rechazada/cancelada respetadas, intento en curso, corridas simultáneas y carrera en H3.3 sin duplicados: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
