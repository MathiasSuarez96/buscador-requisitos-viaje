/**
 * Prueba de punta a punta de las decisiones del panel contra un Mongo REAL
 * y efímero: MongoMemoryReplSet 8.0.32 en 127.0.0.1 (las transacciones
 * exigen replica set), app real, verificador real de Google con claves
 * propias y JWKS local, lector y decisiones por defecto (driver nativo +
 * decidirPropuesta real) e índices de INDICES_DECISION creados con
 * crear-indices-propuestas.js.
 *
 * Valida lo que los fakes no pueden: gate de índices con listIndexes real,
 * transacción CAS + evento, WriteConflict entre decisiones concurrentes,
 * reenvío idéntico sin evento nuevo, coherencia con acciones_permitidas
 * del detalle (bloque 3) y, con el monitor de comandos, que un 4xx no
 * escribe nada, que un éxito solo escribe update de propuestas_cambio e
 * insert de eventos_propuesta, y que destinos nunca se escribe.
 *
 * Nunca lee .env ni process.env para conectarse. Exige el preload
 * solo-loopback; el binario de mongod tiene que estar en la caché.
 *
 * Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-panel-decisiones-mongo.js
 */

const assert = require('assert');

if (!globalThis.__SOLO_LOOPBACK__) {
  console.error('Falta --require ./scripts/preload-solo-loopback.js. Abortando sin levantar nada.');
  process.exit(1);
}

const mongoose = require('../config/mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { crearApp } = require('../app');
const crearIndices = require('./crear-indices-propuestas');
const { crearVerificadorGoogle } = require('../services/panel/verificar-token-google');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');
const { pedir } = require('./lib/http-prueba');
const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');

const VERSION_MONGOD = '8.0.32';
const DB = 'buscador_requisitos';
const ITERACIONES = 20;
const OPERADORES = [
  { proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] },
  { proveedor: 'google', sub: '4000', email: 'segundo@example.com', identificador: 'segundo.operador', permisos: ['ver', 'decidir'] },
  { proveedor: 'google', sub: '3000', email: 'solo-ver@example.com', identificador: 'solo.ver', permisos: ['ver'] }
];
const ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, OPERADORES_PANEL_JSON: JSON.stringify(OPERADORES), PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app' };
const COMANDOS_ESCRITURA = ['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'dropIndexes', 'renameCollection', 'collMod', 'bulkWrite', 'aggregate', 'mapReduce'];
const PROHIBIDOS = ['fragmento_html', '<', '>', 'usuario_atlas', '"sub"', '"email"', '@example.com', 'mongodb://', 'eyJ', '"payload"', 'identidad_operador'];

let rs;
let semilla;
let servidorHttp;

// ------------------------------------------------------------------
// Siembra: cada propuesta con su propio destino (el índice único de
// propuesta activa es por destino + requisito + campo).
// ------------------------------------------------------------------

const requisito = (extra = {}) => ({ _id: ObjectId.createFromHexString(REQUISITO_ID_ETA), tipo: 'formulario_digital', nombre: 'UK ETA', obligatorio: 'si', estado: 'confirmado', ...extra });
const VARIANTES = {
  valida: { requisitos: [requisito()] },
  valorCambiado: { requisitos: [requisito({ costo: '£16' })] },
  ausenteVsNull: { requisitos: [requisito({ costo: null })] },
  identidadCambiada: { requisitos: [requisito({ nombre: 'UK ETA (nuevo)' })] },
  requisitoInexistente: { requisitos: [requisito({ _id: new ObjectId() })] },
  destinoInexistente: null,
  hashAlterado: { requisitos: [requisito()], alterarHash: true },
  hashInvalido: { requisitos: [requisito()], hashInvalido: true },
  versionInvalida: { requisitos: [requisito()], extra: { version_coordinacion: 1.5 } },
  decisionPrevia: { requisitos: [requisito()], extra: { decision_aprobacion_id: '4db810fc-d491-4166-82d1-8b88fe9b088d' } }
};

let secuencia = 0;
const MANIPULADAS = [];
async function sembrar(variante = 'valida') {
  secuencia++;
  const v = VARIANTES[variante];
  const destinoId = new ObjectId();
  if (v) await semilla.db(DB).collection('destinos').insertOne({ _id: destinoId, pais: `País ${secuencia}`, codigo_iso: `X${secuencia}`, requisitos: v.requisitos });
  const propuestaId = `00000000-0000-4000-8000-${String(secuencia).padStart(12, '0')}`;
  const payload = {
    version_contrato: '1.0',
    tipo_propuesta: 'actualizacion_campo_requisito',
    fecha_propuesta: '2026-09-27T16:24:32.532Z',
    destino_id: destinoId.toHexString(),
    requisito_id: REQUISITO_ID_ETA,
    campo: 'costo',
    run_id_origen: 'bfcf5b8e-bda9-4cc7-b3c3-ef28fb897835',
    propuesta_id: propuestaId,
    valor_anterior: { presente: false, valor: null },
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' }, evidencia: { extraccion: { apply: { costo_extraido: 20, fragmento_html: '<p>£20</p>', moneda: 'GBP' } } } },
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-27T16:24:31.692Z' }
  };
  const hash = hashSobreCanonico(payload, 'toc-v1', 'sha256');
  if (v?.alterarHash) payload.valor_propuesto.valor = '£2';
  const doc = {
    propuesta_id: propuestaId,
    destino_id: destinoId,
    requisito_id: ObjectId.createFromHexString(REQUISITO_ID_ETA),
    campo: 'costo',
    algoritmo_canonicalizacion: 'toc-v1',
    algoritmo_hash: 'sha256',
    payload,
    payload_hash: v?.hashInvalido ? 'no-es-un-hash' : hash,
    run_id_origen: payload.run_id_origen,
    estado: 'pendiente_aprobacion',
    version_coordinacion: 0,
    decision_aprobacion_id: null,
    ultimo_evento_id: null,
    createdAt: new Date('2026-09-27T16:24:32.600Z'),
    updatedAt: new Date('2026-09-27T16:24:32.600Z'),
    __v: 0,
    ...(v?.extra ?? {})
  };
  await semilla.db(DB).collection('propuestas_cambio').insertOne(doc);
  return doc;
}

const leerPropuesta = (id) => semilla.db(DB).collection('propuestas_cambio').findOne({ propuesta_id: id });
const eventosDe = (id) => semilla.db(DB).collection('eventos_propuesta').find({ propuesta_id: id }).sort({ version_coordinacion_nueva: 1 }).toArray();
const cuerpoDe = (p, extra = {}) => ({ estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: p.version_coordinacion, ...extra });

(async () => {
  const t0 = Date.now();
  rs = await MongoMemoryReplSet.create({ binary: { version: VERSION_MONGOD }, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: DB } });
  const uri = rs.getUri(DB);
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'replica set efímero en 127.0.0.1');
  semilla = new MongoClient(uri);
  await semilla.connect();
  const hello = await semilla.db('admin').command({ hello: 1 });
  assert.ok(hello.setName && hello.isWritablePrimary, 'replica set con primario');

  await mongoose.connect(uri, { monitorCommands: true });
  const COMANDOS = [];
  mongoose.connection.getClient().on('commandStarted', (e) => COMANDOS.push({ nombre: e.commandName, coleccion: e.command[e.commandName] }));
  const escrituras = () => COMANDOS.filter((c) => COMANDOS_ESCRITURA.includes(c.nombre)).map((c) => `${c.nombre}:${c.coleccion}`);

  const emisor = await crearEmisorPrueba();
  const verificador = crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: emisor.localJWKSet });
  const REGISTROS = [];
  const app = crearApp({ panel: { env: ENV, verificador, registrar: (e) => REGISTROS.push(e) } });
  servidorHttp = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidorHttp.once('listening', r));
  const puerto = servidorHttp.address().port;
  const TOKENS = {};
  for (const o of OPERADORES) TOKENS[o.sub] = await emisor.firmar({ sub: o.sub, email: o.email });

  const RESPUESTAS = [];
  const llamar = async (metodo, ruta, cuerpo, sub = '1000') => {
    const headers = { Authorization: `Bearer ${TOKENS[sub]}` };
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const r = await pedir(puerto, metodo, ruta, headers, cuerpo === undefined ? null : JSON.stringify(cuerpo));
    RESPUESTAS.push({ ruta, status: r.status, body: r.body });
    return { ...r, json: r.body ? JSON.parse(r.body) : null };
  };
  const decidir = (p, tipo, cuerpo, sub) => llamar('POST', `/api/panel/propuestas/${p.propuesta_id}/${tipo}`, cuerpo, sub);
  const detalle = (p, sub) => llamar('GET', `/api/panel/propuestas/${p.propuesta_id}`, undefined, sub);
  const codigo = (r) => r.json?.error?.codigo ?? null;

  try {
    // ============================================================
    // 0) Gate de índices real: sin INDICES_DECISION → 503, 0 escrituras
    // ============================================================
    {
      const p = await sembrar();
      COMANDOS.length = 0;
      const r = await decidir(p, 'aprobacion', cuerpoDe(p));
      assert.deepStrictEqual([r.status, codigo(r)], [503, 'no_disponible'], r.body);
      assert.deepStrictEqual(escrituras(), [], 'sin índices no escribe');
      assert.ok(COMANDOS.some((c) => c.nombre === 'listIndexes'), 'el gate consultó listIndexes');
      assert.deepStrictEqual(REGISTROS.at(-1).motivo, 'indices');
      assert.strictEqual((await leerPropuesta(p.propuesta_id)).version_coordinacion, 0);
      // Índices de decisión con el script versionado.
      const logs = [];
      const deps = { ...crearIndices.crearDependenciasMongoose(), conectar: async () => mongoose.connection.db.databaseName };
      await crearIndices.ejecutar('creacion_real', deps, (l) => logs.push(l), 'decision');
      const r2 = await decidir(p, 'aprobacion', cuerpoDe(p));
      assert.strictEqual(r2.status, 200, r2.body);
      console.log('0) sin índices de decisión: 503 no_disponible (listIndexes real), 0 escrituras; tras crear INDICES_DECISION la misma aprobación → 200: OK');
    }

    // ============================================================
    // 1) Aprobación y rechazo exitosos: transacción real
    // ============================================================
    {
      const p = await sembrar();
      COMANDOS.length = 0;
      const r = await decidir(p, 'aprobacion', cuerpoDe(p));
      assert.strictEqual(r.status, 200, r.body);
      assert.deepStrictEqual(escrituras().sort(), ['insert:eventos_propuesta', 'update:propuestas_cambio'], 'éxito: solo el CAS y el evento');
      assert.ok(COMANDOS.some((c) => c.nombre === 'commitTransaction'), 'en una transacción');
      const d = r.json.decision;
      const guardada = await leerPropuesta(p.propuesta_id);
      assert.deepStrictEqual(
        [guardada.estado, guardada.version_coordinacion, guardada.decision_aprobacion_id, guardada.ultimo_evento_id, guardada.updatedAt.toISOString()],
        ['aprobada', 1, d.evento_id, d.evento_id, d.ocurrido_en]
      );
      const [ev] = await eventosDe(p.propuesta_id);
      assert.deepStrictEqual(ev.actor, { tipo: 'humano', identificador: 'operador.panel' });
      assert.deepStrictEqual(ev.detalle, { identidad_operador: { metodo: 'oidc_google', sub: '1000', email: 'operador@example.com' }, comando: { nombre: 'panel-propuestas', version: '1' } });
      assert.deepStrictEqual(d, {
        tipo_evento: 'aprobacion',
        propuesta_id: p.propuesta_id,
        evento_id: ev.evento_id,
        estado_anterior: 'pendiente_aprobacion',
        estado_nuevo: 'aprobada',
        version_coordinacion_nueva: 1,
        ocurrido_en: ev.ocurrido_en.toISOString(),
        actor: { tipo: 'humano', identificador: 'operador.panel' },
        ya_registrada: false
      });

      const q = await sembrar();
      const rr = await decidir(q, 'rechazo', cuerpoDe(q, { motivo: '  Fuente desactualizada\n' }), '4000');
      assert.strictEqual(rr.status, 200, rr.body);
      const [evr] = await eventosDe(q.propuesta_id);
      assert.deepStrictEqual([evr.tipo_evento, evr.motivo, evr.actor.identificador, evr.detalle.identidad_operador.sub], ['rechazo', 'Fuente desactualizada', 'segundo.operador', '4000']);
      const gq = await leerPropuesta(q.propuesta_id);
      assert.deepStrictEqual([gq.estado, gq.version_coordinacion, gq.decision_aprobacion_id], ['rechazada', 1, null]);
      console.log('1) aprobación y rechazo: 200; escrituras = update propuestas_cambio + insert eventos_propuesta en una transacción; evento con panel-propuestas, oidc_google, sub y email; motivo recortado: OK');
    }

    // ============================================================
    // 2) 404, 409, 422 y reenvío: cero escrituras
    // ============================================================
    {
      const sinEscribir = async (etiqueta, fn) => {
        COMANDOS.length = 0;
        const r = await fn();
        assert.deepStrictEqual(escrituras(), [], `${etiqueta}: 0 escrituras`);
        return r;
      };
      const r404 = await sinEscribir('404', () => decidir({ propuesta_id: '11111111-1111-4111-8111-111111111111' }, 'aprobacion', cuerpoDe({ payload_hash: 'a'.repeat(64), version_coordinacion: 0 })));
      assert.deepStrictEqual([r404.status, codigo(r404)], [404, 'no_encontrado']);

      const p = await sembrar();
      const r409 = await sinEscribir('409', () => decidir(p, 'aprobacion', cuerpoDe(p, { version_coordinacion_esperada: 1 })));
      assert.deepStrictEqual([r409.status, codigo(r409)], [409, 'propuesta_cambio']);
      assert.deepStrictEqual(r409.json.error.actual, { estado: 'pendiente_aprobacion', version_coordinacion: 0, payload_hash: p.payload_hash, ultimo_evento: null });

      const casos422 = [
        ['hashAlterado', ['hash_no_coincide']],
        ['valorCambiado', ['valor_actual_cambio']],
        ['ausenteVsNull', ['valor_actual_cambio']],
        ['identidadCambiada', ['requisito_no_coincide']],
        ['requisitoInexistente', ['requisito_no_coincide', 'valor_actual_cambio']],
        ['destinoInexistente', ['requisito_no_coincide', 'valor_actual_cambio']]
      ];
      for (const [variante, motivos] of casos422) {
        const q = await sembrar(variante);
        const r = await sinEscribir(`422 ${variante}`, () => decidir(q, 'aprobacion', cuerpoDe(q)));
        assert.deepStrictEqual([r.status, codigo(r), r.json.error.motivos], [422, 'propuesta_no_decidible', motivos], `${variante}: ${r.body}`);
        assert.strictEqual((await leerPropuesta(q.propuesta_id)).version_coordinacion, 0);
      }

      // Reenvío idéntico: 200 ya_registrada, sin evento nuevo.
      const a = await sembrar();
      const primero = await decidir(a, 'aprobacion', cuerpoDe(a));
      assert.strictEqual(primero.status, 200);
      const reenvio = await sinEscribir('reenvío', () => decidir(a, 'aprobacion', cuerpoDe(a)));
      assert.deepStrictEqual([reenvio.status, reenvio.json.decision?.ya_registrada, reenvio.json.decision?.evento_id], [200, true, primero.json.decision.evento_id], reenvio.body);
      assert.strictEqual((await eventosDe(a.propuesta_id)).length, 1, 'sin evento nuevo');
      // El mismo reenvío de otro operador, o pidiendo la otra decisión → 409.
      const otro = await sinEscribir('reenvío de otro operador', () => decidir(a, 'aprobacion', cuerpoDe(a), '4000'));
      assert.deepStrictEqual([otro.status, codigo(otro)], [409, 'propuesta_cambio']);
      assert.deepStrictEqual(otro.json.error.actual.ultimo_evento, { tipo_evento: 'aprobacion', ocurrido_en: primero.json.decision.ocurrido_en });
      const distinta = await sinEscribir('otra decisión', () => decidir(a, 'rechazo', cuerpoDe(a, { motivo: 'm' })));
      assert.deepStrictEqual([distinta.status, codigo(distinta)], [409, 'propuesta_cambio']);
      console.log(`2) 404; 409 por versión vieja; ${casos422.length} casos 422 con BSON real (hash, valor, ausente ≠ null, identidad, requisito y destino inexistentes); reenvío idéntico → 200 ya_registrada sin evento nuevo; reenvío de otro operador u otra decisión → 409; todos con 0 escrituras: OK`);
    }

    // ============================================================
    // 3) Coherencia con el detalle del bloque 3: cada acción que el GET
    //    ofrece pasa en el POST, y cada acción bloqueada se rechaza con los
    //    mismos motivos (misma evaluarIntegridad)
    // ============================================================
    {
      let n = 0;
      const sinEscrituras = async (fn, etiqueta) => {
        COMANDOS.length = 0;
        const r = await fn();
        assert.deepStrictEqual(escrituras(), [], `${etiqueta}: 0 escrituras`);
        return r;
      };
      for (const variante of Object.keys(VARIANTES)) {
        const p = await sembrar(variante);
        const soloVer = (await detalle(p, '3000')).json;
        assert.deepStrictEqual(soloVer.acciones_permitidas, [], `${variante}: sin "decidir" → []`);
        assert.ok(soloVer.acciones_bloqueadas.aprobar.includes('sin_permiso_decidir') && soloVer.acciones_bloqueadas.rechazar.includes('sin_permiso_decidir'), `${variante}: sin permiso en ambas`);
        const d = (await detalle(p, '1000')).json;
        const esperado = { valida: ['aprobar', 'rechazar'], hashInvalido: [], versionInvalida: [], decisionPrevia: [] }[variante] ?? ['rechazar'];
        assert.deepStrictEqual(d.acciones_permitidas, esperado, `${variante}: acciones`);
        for (const a of ['aprobar', 'rechazar']) {
          assert.strictEqual(d.acciones_permitidas.includes(a), d.acciones_bloqueadas[a].length === 0, `${variante}: ${a} permitida ⇔ sin motivos`);
        }

        if (variante === 'hashInvalido') {
          // Ninguna acción: con el hash almacenado no hay body válido (400) y
          // con cualquier hash válido la coordinación no coincide (409).
          assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: ['payload_hash_invalido'], rechazar: ['payload_hash_invalido'] });
          for (const [tipo, extra] of [['aprobacion', {}], ['rechazo', { motivo: 'm' }]]) {
            const r400 = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, extra)), `${tipo} con el hash almacenado`);
            assert.deepStrictEqual([r400.status, codigo(r400)], [400, 'solicitud_invalida'], r400.body);
            const r409 = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, { ...extra, payload_hash_esperado: 'a'.repeat(64) })), `${tipo} con otro hash`);
            assert.deepStrictEqual([r409.status, codigo(r409)], [409, 'propuesta_cambio'], r409.body);
          }
          assert.strictEqual((await leerPropuesta(p.propuesta_id)).version_coordinacion, 0);
          n++;
          continue;
        }

        if (variante === 'versionInvalida') {
          // Ninguna acción. POST actual: con 1.5 el body es 400; con un entero, 409.
          assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: ['version_coordinacion_invalida'], rechazar: ['version_coordinacion_invalida'] });
          for (const [tipo, extra] of [['aprobacion', {}], ['rechazo', { motivo: 'm' }]]) {
            const r400 = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, extra)), `${tipo} con la versión almacenada 1.5`);
            assert.deepStrictEqual([r400.status, codigo(r400)], [400, 'solicitud_invalida'], r400.body);
            for (const v of [1, 2]) {
              const r409 = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, { ...extra, version_coordinacion_esperada: v })), `${tipo} con versión ${v}`);
              assert.deepStrictEqual([r409.status, codigo(r409), r409.json.error.actual], [409, 'propuesta_cambio', { estado: 'pendiente_aprobacion', version_coordinacion: null, payload_hash: p.payload_hash, ultimo_evento: null }], r409.body);
            }
          }
          assert.strictEqual((await leerPropuesta(p.propuesta_id)).version_coordinacion, 1.5);
          assert.strictEqual((await eventosDe(p.propuesta_id)).length, 0);
          n++;
          continue;
        }

        if (variante === 'decisionPrevia') {
          // Ninguna acción. POST: con lo visto vigente → 422
          // [decision_previa_existente]; con otra versión u otro hash → 409.
          assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: ['decision_previa_existente'], rechazar: ['decision_previa_existente'] });
          for (const [tipo, extra] of [['aprobacion', {}], ['rechazo', { motivo: 'm' }]]) {
            const r = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, extra)), `${tipo} con decisión previa`);
            assert.deepStrictEqual([r.status, codigo(r), r.json.error.motivos], [422, 'propuesta_no_decidible', d.acciones_bloqueadas.aprobar], r.body);
            const r409 = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, { ...extra, version_coordinacion_esperada: 1 })), `${tipo} con otra versión y decisión previa`);
            assert.deepStrictEqual([r409.status, codigo(r409)], [409, 'propuesta_cambio'], r409.body);
            const r409h = await sinEscrituras(() => decidir(p, tipo, cuerpoDe(p, { ...extra, payload_hash_esperado: 'b'.repeat(64) })), `${tipo} con otro hash y decisión previa`);
            assert.deepStrictEqual([r409h.status, codigo(r409h)], [409, 'propuesta_cambio'], r409h.body);
          }
          const g = await leerPropuesta(p.propuesta_id);
          assert.deepStrictEqual([g.estado, g.version_coordinacion, g.decision_aprobacion_id], ['pendiente_aprobacion', 0, '4db810fc-d491-4166-82d1-8b88fe9b088d']);
          assert.strictEqual((await eventosDe(p.propuesta_id)).length, 0);
          n++;
          continue;
        }

        if (d.acciones_permitidas.includes('aprobar')) {
          const ap = await decidir(p, 'aprobacion', cuerpoDe(p));
          assert.strictEqual(ap.status, 200, `${variante}: el detalle ofrece aprobar y el POST pasa`);
        } else {
          const ap = await sinEscrituras(() => decidir(p, 'aprobacion', cuerpoDe(p)), `${variante}: aprobación bloqueada`);
          assert.deepStrictEqual([ap.status, ap.json.error.motivos], [422, d.acciones_bloqueadas.aprobar], `${variante}: 422 con los mismos motivos que acciones_bloqueadas.aprobar`);
          assert.ok(d.acciones_permitidas.includes('rechazar'));
          const re = await decidir(p, 'rechazo', cuerpoDe(p, { motivo: 'No verificable' }));
          assert.strictEqual(re.status, 200, `${variante}: el detalle ofrece rechazar y el POST pasa (${re.body})`);
        }
        const despues = (await detalle(p, '1000')).json;
        assert.deepStrictEqual(
          [despues.acciones_permitidas, despues.acciones_bloqueadas.rechazar],
          [[], ['estado_no_permite_decision']],
          `${variante}: decidida → []`
        );
        assert.ok(despues.acciones_bloqueadas.aprobar.includes('estado_no_permite_decision'));
        assert.strictEqual(despues.eventos.at(-1).origen, 'panel-propuestas');
        assert.strictEqual(despues.eventos.at(-1).metodo_identidad, 'oidc_google');
        n++;
      }
      console.log(`3) coherencia GET↔POST en ${n} variantes: íntegra → [aprobar, rechazar] y aprobación 200; con problemas → [rechazar], aprobación 422 con acciones_bloqueadas.aprobar exacto y rechazo 200; payload_hash inválido → [], POST 400 con ese hash y 409 con otro; versión 1.5 → [], POST 400 con 1.5 y 409 con 1/2; decisión previa → [], POST 422 con lo visto y 409 con otra versión u otro hash; todos con 0 escrituras; sin "decidir" → []; decidida → []: OK`);
    }

    // ============================================================
    // 3b) La aprobación gana (secuencial): el rechazo posterior es 409
    // ============================================================
    {
      const p = await sembrar();
      const ap = await decidir(p, 'aprobacion', cuerpoDe(p));
      assert.strictEqual(ap.status, 200, ap.body);
      for (const [sub, etiqueta] of [
        ['1000', 'mismo operador'],
        ['4000', 'otro operador']
      ]) {
        COMANDOS.length = 0;
        const re = await decidir(p, 'rechazo', cuerpoDe(p, { motivo: 'Llegó tarde' }), sub);
        assert.deepStrictEqual([re.status, codigo(re)], [409, 'propuesta_cambio'], `${etiqueta}: ${re.body}`);
        assert.deepStrictEqual(re.json.error.actual, {
          estado: 'aprobada',
          version_coordinacion: 1,
          payload_hash: p.payload_hash,
          ultimo_evento: { tipo_evento: 'aprobacion', ocurrido_en: ap.json.decision.ocurrido_en }
        });
        assert.deepStrictEqual(escrituras(), [], `${etiqueta}: 0 escrituras`);
      }
      const evs = await eventosDe(p.propuesta_id);
      assert.deepStrictEqual(evs.map((e) => e.tipo_evento), ['aprobacion']);
      const g = await leerPropuesta(p.propuesta_id);
      assert.deepStrictEqual([g.estado, g.version_coordinacion, g.decision_aprobacion_id], ['aprobada', 1, ap.json.decision.evento_id]);
      console.log('3b) aprobación primero: 200; rechazo posterior del mismo operador y de otro → 409 con actual { aprobada, v1, último evento aprobacion }, 0 escrituras; un solo evento: OK');
    }

    // ============================================================
    // 3c) Pendiente con decisión previa y un último evento que parece un
    //     reenvío: nunca 200 ya_registrada
    // ============================================================
    {
      // Aprobación real del mismo operador; después alguien devuelve la
      // propuesta a pendiente dejando decision_aprobacion_id y el evento.
      const p = await sembrar();
      MANIPULADAS.push(p.propuesta_id);
      const ap = await decidir(p, 'aprobacion', cuerpoDe(p));
      assert.strictEqual(ap.status, 200, ap.body);
      await semilla.db(DB).collection('propuestas_cambio').updateOne({ propuesta_id: p.propuesta_id }, { $set: { estado: 'pendiente_aprobacion' } });
      const actual = await leerPropuesta(p.propuesta_id);
      assert.deepStrictEqual([actual.estado, actual.version_coordinacion, actual.decision_aprobacion_id, actual.ultimo_evento_id], ['pendiente_aprobacion', 1, ap.json.decision.evento_id, ap.json.decision.evento_id]);
      const casos = [
        ['body original (v0)', cuerpoDe(p), 409, 'propuesta_cambio'],
        ['body con lo visto ahora (v1)', cuerpoDe(actual), 422, 'propuesta_no_decidible']
      ];
      for (const [etiqueta, cuerpo, status, cod] of casos) {
        COMANDOS.length = 0;
        const r = await decidir(p, 'aprobacion', cuerpo);
        assert.deepStrictEqual([r.status, codigo(r)], [status, cod], `${etiqueta}: ${r.body}`);
        assert.ok(!r.json.decision, `${etiqueta}: nunca 200 ya_registrada`);
        assert.deepStrictEqual(escrituras(), [], `${etiqueta}: 0 escrituras`);
      }
      assert.strictEqual((await eventosDe(p.propuesta_id)).length, 1, 'sin evento nuevo');
      console.log('3c) pendiente con decisión previa y último evento propio del panel: body original → 409, body con lo visto → 422 [decision_previa_existente]; nunca 200 ya_registrada; 0 escrituras: OK');
    }

    // ============================================================
    // 4) Concurrencia (Promise.all), ITERACIONES de cada caso
    // ============================================================
    {
      const resumen = { dosOperadores: {}, aprobarYRechazar: {}, dobleClic: {} };
      const contar = (obj, clave) => (obj[clave] = (obj[clave] ?? 0) + 1);
      for (let i = 0; i < ITERACIONES; i++) {
        // a) dos operadores aprueban a la vez
        {
          const p = await sembrar();
          const rs2 = await Promise.all([decidir(p, 'aprobacion', cuerpoDe(p), '1000'), decidir(p, 'aprobacion', cuerpoDe(p), '4000')]);
          const st = rs2.map((r) => r.status).sort();
          assert.deepStrictEqual(st, [200, 409], `dos operadores: ${rs2.map((r) => r.body).join(' | ')}`);
          assert.strictEqual(rs2.find((r) => r.status === 200).json.decision.ya_registrada, false);
          assert.strictEqual((await eventosDe(p.propuesta_id)).length, 1);
          assert.strictEqual((await leerPropuesta(p.propuesta_id)).version_coordinacion, 1);
          contar(resumen.dosOperadores, st.join('+'));
        }
        // b) el mismo operador aprueba y rechaza a la vez
        {
          const p = await sembrar();
          const rs2 = await Promise.all([decidir(p, 'aprobacion', cuerpoDe(p)), decidir(p, 'rechazo', cuerpoDe(p, { motivo: 'm' }))]);
          assert.deepStrictEqual(rs2.map((r) => r.status).sort(), [200, 409], `aprobar+rechazar: ${rs2.map((r) => r.body).join(' | ')}`);
          const ganadora = rs2.find((r) => r.status === 200).json.decision.tipo_evento;
          const evs = await eventosDe(p.propuesta_id);
          assert.deepStrictEqual(evs.map((e) => e.tipo_evento), [ganadora]);
          contar(resumen.aprobarYRechazar, ganadora);
        }
        // c) doble clic del mismo operador
        {
          const p = await sembrar();
          const rs2 = await Promise.all([decidir(p, 'aprobacion', cuerpoDe(p)), decidir(p, 'aprobacion', cuerpoDe(p))]);
          assert.deepStrictEqual(rs2.map((r) => r.status), [200, 200], `doble clic: ${rs2.map((r) => r.body).join(' | ')}`);
          assert.deepStrictEqual(rs2.map((r) => r.json.decision.ya_registrada).sort(), [false, true]);
          assert.strictEqual(rs2[0].json.decision.evento_id, rs2[1].json.decision.evento_id, 'mismo evento');
          assert.strictEqual((await eventosDe(p.propuesta_id)).length, 1);
          const deteccion = REGISTROS.filter((e) => e.evento === 'panel_decision' && e.propuesta_id === p.propuesta_id && e.ya_registrada).map((e) => e.reenvio_detectado_en);
          contar(resumen.dobleClic, deteccion.join());
        }
      }
      const errores5xx = RESPUESTAS.filter((r) => r.status >= 500 && r.status !== 503);
      assert.deepStrictEqual(errores5xx, [], 'ninguna carrera termina en 500');
      console.log(`4) concurrencia ×${ITERACIONES}: dos operadores → siempre 200+409, 1 evento, versión 1 ${JSON.stringify(resumen.dosOperadores)}; aprobar+rechazar → 200+409 con un solo evento ${JSON.stringify(resumen.aprobarYRechazar)}; doble clic → 200 nuevo + 200 ya_registrada, 1 evento ${JSON.stringify(resumen.dobleClic)}; 0 respuestas 500: OK`);
    }

    // ============================================================
    // 5) Destinos nunca se escriben; respuestas y registros sin datos privados
    // ============================================================
    {
      assert.ok(!COMANDOS.some((c) => COMANDOS_ESCRITURA.includes(c.nombre) && c.coleccion === 'destinos'), 'destinos nunca se escribe');
      for (const r of RESPUESTAS) for (const x of PROHIBIDOS) assert.ok(!r.body.includes(x), `${r.ruta} (${r.status}) contiene ${JSON.stringify(x)}`);
      for (const e of REGISTROS) assert.ok(!/eyJ|mongodb:\/\/|@example\.com|"sub"/.test(JSON.stringify(e)), `registro sin identidad privada: ${JSON.stringify(e).slice(0, 200)}`);
      // Excluye la propuesta de 3c, devuelta a pendiente a mano a propósito.
      const total = await semilla.db(DB).collection('eventos_propuesta').countDocuments({ propuesta_id: { $nin: MANIPULADAS } });
      const decididas = await semilla.db(DB).collection('propuestas_cambio').countDocuments({ estado: { $ne: 'pendiente_aprobacion' }, propuesta_id: { $nin: MANIPULADAS } });
      assert.strictEqual(total, decididas, 'un evento por propuesta decidida (historia lineal)');
      const statuses = [...new Set(RESPUESTAS.map((r) => r.status))].sort();
      console.log(`5) destinos: 0 escrituras; ${RESPUESTAS.length} respuestas (${statuses.join(', ')}) sin identidad, payload, HTML ni tokens; ${REGISTROS.length} registros saneados; ${total} eventos = ${decididas} propuestas decididas: OK`);
    }

    console.log(`\nPRUEBA DECISIONES DEL PANEL + MONGO (replica set) OK (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    const pasos = [];
    await new Promise((r) => servidorHttp.close(r)).then(() => pasos.push('http: cerrado'));
    await mongoose.disconnect().then(() => pasos.push('mongoose.disconnect: ok'));
    await semilla.close().then(() => pasos.push('cliente semilla: ok'));
    await rs.stop({ doCleanup: true, force: true }).then(() => pasos.push('replica set: detenido y datos borrados (doCleanup)'));
    console.log(`LIMPIEZA: ${pasos.join('; ')}`);
  }
})().catch(async (err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
  try {
    await mongoose.disconnect();
    await semilla?.close();
    await rs?.stop({ doCleanup: true, force: true });
  } catch {
    // limpieza best-effort
  }
});
