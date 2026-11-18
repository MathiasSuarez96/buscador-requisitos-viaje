// Corrección puntual CO / Check-Mig (scripts/corregir-requisito.js) contra Mongo efímero, con la
// API pública y la ficha simuladas. Nada toca Atlas ni la red.
// El proceso solo sale con 0 después de la última aserción (exitCode = 1 por defecto).
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId, BSON } = require('mongodb');
const C = require('./corregir-requisito');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const perfil = require('../services/propuestas/ciclo/perfil-checkmig-colombia');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');

const ESPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'correcciones', 'co-checkmig.json'), 'utf8'));
const API = fs.readFileSync(path.join(__dirname, 'fixtures', 'correcciones', 'api-co-2026-11-12.json'), 'utf8');
const FICHA = fs.readFileSync(path.join(__dirname, 'fixtures', 'checkmig', 'oficial-muestra.html'), 'utf8').replace(/\r\n/g, '\n');
const T0 = new Date('2026-11-12T04:00:00.000Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corregir-requisito-'));
let n = 0;
const nueva = () => path.join(tmp, `respaldo-${++n}.json`);
const respuestas = ({ api = API, ficha = FICHA, enlace = 200 } = {}) => async (url) => {
  if (url === ESPEC.api) return new Response(api, { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === URL_FICHA) return new Response(ficha, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (url === ESPEC.cambios.link) return new Response('<title>Página de inicio | CheckMig</title>', { status: enlace, headers: { 'content-type': 'text/html' } });
  if (url === 'https://apps.migracioncolombia.gov.co/check-mig/') return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } });
  throw new Error(`URL no simulada: ${url}`);
};

// Documento de la base a partir de la captura pública: ids como ObjectId y fecha como texto (así la guarda Atlas).
function documentoDesdeApi(texto) {
  const d = JSON.parse(texto);
  return { _id: ObjectId.createFromHexString(d._id), pais: d.pais, codigo_iso: d.codigo_iso, updatedAt: new Date(d.updatedAt),
    requisitos: d.requisitos.map(r => ({ ...r, _id: ObjectId.createFromHexString(r._id), ...(typeof r.fecha_verificacion === 'string' ? { fecha_verificacion: r.fecha_verificacion.slice(0, 10) } : {}) })) };
}
const ej = d => BSON.EJSON.stringify(d, { relaxed: false });

(async () => {
  let rs, client;
  try {
    // ---- 1. Plan: preparación, contenido, hashes y validación ----
    const plan = await C.prepararPlan(ESPEC, { fetch: respuestas(), ahora: () => T0 });
    assert.deepEqual(plan.campos_cambiados, ['descripcion', 'fecha_verificacion', 'fuente', 'link', 'obligatorio']);
    assert.deepEqual([plan.antes.obligatorio, plan.antes.fecha_verificacion, plan.antes.link], ['si', '2026-08-18', 'https://apps.migracioncolombia.gov.co/check-mig/']);
    assert.deepEqual({ obligatorio: plan.despues.obligatorio, descripcion: plan.despues.descripcion, fuente: plan.despues.fuente, link: plan.despues.link }, ESPEC.cambios);
    assert.deepEqual([plan.fecha_verificacion.renovada, plan.despues.fecha_verificacion, plan.despues.estado], [true, '2026-11-12', 'confirmado']);
    assert.deepEqual([plan.evidencia.enlace_nuevo.http_status, plan.evidencia.enlace_anterior.http_status, plan.evidencia.ficha.hechos.obligatoriedad], [200, 404, 'no_obligatorio']);
    assert.equal(C.hashPlan(plan), plan.hash);
    const ahora = () => new Date(T0.getTime() + 60_000);
    C.validarPlan(plan, { modo: 'correccion', confirmo: plan.hash, ahora });
    assert.throws(() => C.validarPlan(plan, { modo: 'correccion', confirmo: plan.hash_reversion, ahora }), /--confirmo/);
    assert.throws(() => C.validarPlan({ ...plan, despues: { ...plan.despues, obligatorio: 'si' } }, { modo: 'correccion', confirmo: plan.hash, ahora }), /alterado/);
    assert.throws(() => C.validarPlan(plan, { modo: 'correccion', confirmo: plan.hash, ahora: () => new Date(T0.getTime() + 73 * 3600_000) }), /venció/);
    C.validarPlan(plan, { modo: 'reversion', confirmo: plan.hash_reversion, ahora: () => new Date(T0.getTime() + 30 * 86_400_000) }); // la reversión no vence
    // Sin evidencia suficiente no hay plan: ficha ambigua, enlace caído o registro que cambió de forma.
    await assert.rejects(C.prepararPlan(ESPEC, { fetch: respuestas({ ficha: fs.readFileSync(path.join(__dirname, 'fixtures', 'checkmig', 'ambigua.html'), 'utf8') }), ahora: () => T0 }), /sin hechos confirmados/);
    await assert.rejects(C.prepararPlan(ESPEC, { fetch: respuestas({ enlace: 404 }), ahora: () => T0 }), /enlace nuevo/);
    const dosCheckmig = JSON.parse(API); dosCheckmig.requisitos.push({ ...dosCheckmig.requisitos[1], _id: '6aaddd0e9f54309f9d827280' });
    await assert.rejects(C.prepararPlan(ESPEC, { fetch: respuestas({ api: JSON.stringify(dosCheckmig) }), ahora: () => T0 }), /no es único/);
    // El plan versionado en el repo es íntegro y describe el mismo cambio.
    const versionado = JSON.parse(fs.readFileSync(path.join(__dirname, 'correcciones', 'co-checkmig.plan.json'), 'utf8'));
    assert.deepEqual([C.hashPlan(versionado) === versionado.hash, C.hashReversion(versionado) === versionado.hash_reversion], [true, true], 'plan versionado íntegro');
    assert.deepEqual([versionado.antes, versionado.campos_cambiados], [plan.antes, plan.campos_cambiados]);

    // ---- 2. Mongo efímero: solo cambia el requisito objetivo ----
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    const uri = rs.getUri();
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    client = await new MongoClient(uri, { monitorCommands: true, retryWrites: false }).connect();
    const col = client.db(plan.base_datos).collection('destinos');
    const otro = { _id: new ObjectId(), pais: 'Tailandia', codigo_iso: 'TH', updatedAt: new Date('2026-10-22T00:30:34.700Z'),
      requisitos: [{ _id: new ObjectId(), tipo: 'visa', obligatorio: 'si', descripcion: 'Visa', estado: 'verificar', fecha_verificacion: '2026-10-21' }] };
    const sembrar = async () => { await col.deleteMany({}); await col.insertMany([documentoDesdeApi(API), structuredClone(otro)]); };
    const deps = extra => ({ client, ahora: () => new Date(T0.getTime() + 120_000), respaldo: nueva(), omitirOperador: true, ...extra });
    const destinoId = ObjectId.createFromHexString(plan.destino._id), reqId = ObjectId.createFromHexString(plan.requisito._id);
    const leer = () => col.findOne({ _id: destinoId });

    await sembrar();
    const antes = await leer(), otroAntes = ej(await col.findOne({ codigo_iso: 'TH' }));
    const d1 = deps();
    const r1 = await C.aplicarPlan(plan, 'correccion', d1);
    assert.deepEqual([r1.resultado, r1.matched, r1.modified], ['aplicada', 1, 1]);
    assert.deepEqual(r1.campos.sort(), ['descripcion', 'fecha_verificacion', 'fuente', 'link', 'obligatorio']);
    assert.ok(r1.comandos.every(c => ['connectionStatus', 'find', 'update', 'endSessions'].includes(c)), `comandos: ${r1.comandos}`);
    const despues = await leer();
    const objetivo = despues.requisitos.find(x => x._id.equals(reqId));
    const { _id, ...camposObjetivo } = objetivo;
    assert.deepEqual(camposObjetivo, plan.despues, 'el requisito quedó exactamente como el plan');
    assert.equal(typeof objetivo.fecha_verificacion, 'string', 'la fecha sigue siendo texto');
    assert.deepEqual(despues.requisitos.filter(x => !x._id.equals(reqId)).map(ej), antes.requisitos.filter(x => !x._id.equals(reqId)).map(ej), 'los otros requisitos no cambian');
    assert.deepEqual([despues.pais, despues.codigo_iso, despues.requisitos.length], [antes.pais, antes.codigo_iso, antes.requisitos.length]);
    assert.notEqual(despues.updatedAt.getTime(), antes.updatedAt.getTime());
    assert.equal(ej(await col.findOne({ codigo_iso: 'TH' })), otroAntes, 'otro destino intacto');
    const respaldo = JSON.parse(fs.readFileSync(d1.respaldo, 'utf8'));
    assert.equal(ej(BSON.EJSON.deserialize(respaldo.destino, { relaxed: false })), ej(antes), 'el respaldo es el documento anterior completo');

    // Segunda aplicación: el estado ya no es el anterior → no escribe ni crea respaldo.
    const d2 = deps();
    await assert.rejects(C.aplicarPlan(plan, 'correccion', d2), e => e instanceof C.ErrorEstadoDistinto && e.diferencias.some(x => x.campo === 'obligatorio'));
    assert.equal(ej(await leer()), ej(despues));
    assert.equal(fs.existsSync(d2.respaldo), false);

    // ---- 3. Reversión con su propia precondición ----
    const d3 = deps();
    const r3 = await C.aplicarPlan(plan, 'reversion', d3);
    assert.equal(r3.resultado, 'aplicada');
    const revertido = (await leer()).requisitos.find(x => x._id.equals(reqId));
    assert.equal(ej(revertido), ej(antes.requisitos.find(x => x._id.equals(reqId))), 'la reversión restaura exactamente el requisito anterior');
    await assert.rejects(C.aplicarPlan(plan, 'reversion', deps()), C.ErrorEstadoDistinto, 'revertir dos veces: el estado ya es el anterior');
    // Si alguien tocó el requisito corregido, la reversión no escribe.
    await sembrar(); await C.aplicarPlan(plan, 'correccion', deps());
    await col.updateOne({ _id: destinoId, 'requisitos._id': reqId }, { $set: { 'requisitos.$.descripcion': 'Editado por otra persona.' } });
    const tocado = ej(await leer());
    await assert.rejects(C.aplicarPlan(plan, 'reversion', deps()), e => e instanceof C.ErrorEstadoDistinto && e.diferencias.some(x => x.campo === 'descripcion'));
    assert.equal(ej(await leer()), tocado);

    // ---- 4. Registro modificado entre la lectura y la escritura: el CAS lo rechaza ----
    await sembrar();
    const intermedio = { estado: null };
    await assert.rejects(C.aplicarPlan(plan, 'correccion', deps({ antesDeEscribir: async () => {
      await col.updateOne({ _id: destinoId, 'requisitos._id': reqId }, { $set: { 'requisitos.$.obligatorio': 'verificar' } });
      intermedio.estado = ej(await leer());
    } })), e => e instanceof C.ErrorEstadoDistinto && /cambio concurrente/.test(e.message));
    assert.equal(ej(await leer()), intermedio.estado, 'nada escrito por la corrección');
    // Regresión (Codex, 17/11): el filtro atómico compara el requisito completo (claves, valores y
    // tipos), no solo los campos del plan. Cada mutación ocurre entre la lectura y el update; en la
    // corrección y en la reversión el update no debe coincidir ni escribir.
    const mutaciones = modo => {
      const desde = modo === 'correccion' ? plan.antes : plan.despues;
      return [
        ['clave agregada (recomendado: "si")', { $set: { 'requisitos.$.recomendado': 'si' } }],
        ['clave quitada (descripcion)', { $unset: { 'requisitos.$.descripcion': '' } }],
        ['tipo: obligatorio como arreglo con el mismo texto', { $set: { 'requisitos.$.obligatorio': [desde.obligatorio] } }],
        ['tipo: fecha_verificacion como Date', { $set: { 'requisitos.$.fecha_verificacion': new Date(`${desde.fecha_verificacion}T00:00:00.000Z`) } }],
        ['valor: estado distinto', { $set: { 'requisitos.$.estado': 'verificar' } }]
      ];
    };
    for (const modo of ['correccion', 'reversion']) {
      for (const [caso, mutacion] of mutaciones(modo)) {
        await sembrar();
        if (modo === 'reversion') await C.aplicarPlan(plan, 'correccion', deps());
        const previo = ej(await leer());
        const estado = { intermedio: null };
        const d = deps({ antesDeEscribir: async () => {
          const u = await col.updateOne({ _id: destinoId, 'requisitos._id': reqId }, mutacion);
          assert.equal(u.modifiedCount, 1, `${modo} / ${caso}: la mutación se aplicó`);
          estado.intermedio = ej(await leer());
          assert.notEqual(estado.intermedio, previo);
        } });
        await assert.rejects(C.aplicarPlan(plan, modo, d), e => e instanceof C.ErrorEstadoDistinto && /cambio concurrente/.test(e.message), `${modo} / ${caso}: debe abortar`);
        assert.equal(ej(await leer()), estado.intermedio, `${modo} / ${caso}: nada escrito`);
      }
    }
    // Un segundo requisito con el mismo _id tampoco se acepta.
    await sembrar();
    await col.updateOne({ _id: destinoId }, { $push: { requisitos: { ...antes.requisitos.find(x => x._id.equals(reqId)) } } });
    await assert.rejects(C.aplicarPlan(plan, 'correccion', deps()), /hay 2/);

    // Operador: con la verificación activa, una conexión sin el usuario del plan no escribe.
    await sembrar();
    await assert.rejects(C.aplicarPlan(plan, 'correccion', deps({ omitirOperador: false })), /no es la del operador mathias-operador/);
    assert.equal((await leer()).requisitos.find(x => x._id.equals(reqId)).obligatorio, 'si');

    // ---- 5. El registro corregido da sin_cambio en el ciclo (--simular) ----
    const lectura = await perfil.adaptador.leer({ fetch: async () => new Response(FICHA, { status: 200, headers: { 'content-type': 'text/html' } }), ahora: () => T0 });
    const cl = ciclo.clasificar(plan.despues, lectura, perfil, { hoy: '2026-11-12' });
    assert.deepEqual([cl.accion, cl.observaciones], ['sin_cambio', []], JSON.stringify(cl));
    assert.equal(cl.fecha_verificacion.dias_desde_verificacion, 0);
    const registro = path.join(tmp, 'registro-corregido.json');
    fs.writeFileSync(registro, JSON.stringify({ destino: { pais: 'Colombia', codigo_iso: 'CO' }, requisito: plan.despues }));
    const sim = spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), path.join(__dirname, 'ciclo-checkmig-v2.js'),
      '--simular', '--registro', registro, '--html', path.join(__dirname, 'fixtures', 'checkmig', 'oficial-muestra.html')], { encoding: 'utf8', timeout: 60000 });
    assert.equal(sim.status, 0, sim.stdout + sim.stderr);
    assert.match(sim.stdout, /ACCIÓN: sin_cambio/);

    // ---- 6. Verificación vía API pública (simulada) ----
    const apiCorregida = JSON.parse(API);
    Object.assign(apiCorregida.requisitos.find(x => x._id === plan.requisito._id), { ...plan.despues, fecha_verificacion: '2026-11-12T00:00:00.000Z' });
    const fetchApi = async () => new Response(JSON.stringify(apiCorregida), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal((await C.verificarApi(plan, 'despues', { fetch: fetchApi })).ok, true);
    assert.equal((await C.verificarApi(plan, 'antes', { fetch: fetchApi })).ok, false);
    assert.equal((await C.verificarApi(plan, 'antes', { fetch: async () => new Response(API, { status: 200 }) })).ok, true);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Corrección CO / Check-Mig: plan y evidencia, solo cambia el objetivo, CAS ante cambio concurrente, reversión con precondición, operador, sin_cambio en --simular y verificación por API: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (client) await client.close().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
