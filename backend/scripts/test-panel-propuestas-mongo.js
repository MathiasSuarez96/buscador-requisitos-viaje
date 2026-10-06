/**
 * Prueba de punta a punta de GET /api/panel/propuestas y
 * GET /api/panel/propuestas/:propuesta_id contra un Mongo REAL y efímero
 * (MongoMemoryServer 8.0.32 en 127.0.0.1): app real, verificador real de
 * Google con claves propias y JWKS local, y el lector por defecto (driver
 * nativo de la conexión de Mongoose). Valida lo que los fakes no pueden:
 * BSON real (ObjectId, campo ausente frente a null), orden y cursor del
 * servidor, proyecciones y CERO escrituras (monitor de comandos + volcado
 * completo antes/después).
 *
 * Nunca lee .env ni process.env para conectarse: la URI la da el servidor
 * efímero. Exige el preload solo-loopback; el binario de mongod tiene que
 * estar en la caché de mongodb-memory-server.
 *
 * Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-panel-propuestas-mongo.js
 */

const assert = require('assert');

if (!globalThis.__SOLO_LOOPBACK__) {
  console.error('Falta --require ./scripts/preload-solo-loopback.js. Abortando sin levantar nada.');
  process.exit(1);
}

const mongoose = require('../config/mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { crearApp } = require('../app');
const { crearVerificadorGoogle } = require('../services/panel/verificar-token-google');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');
const { pedir } = require('./lib/http-prueba');
const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');

const VERSION_MONGOD = '8.0.32';
const DB = 'buscador_requisitos';
const ORIGEN = 'https://toctoc-requisitos.vercel.app';
const OPERADORES = [
  { proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] },
  { proveedor: 'google', sub: '2000', email: 'solo-decidir@example.com', identificador: 'solo.decidir', permisos: ['decidir'] },
  { proveedor: 'google', sub: '3000', email: 'solo-ver@example.com', identificador: 'solo.ver', permisos: ['ver'] }
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMANDOS_ESCRITURA = ['insert', 'update', 'delete', 'findAndModify', 'create', 'createIndexes', 'drop', 'dropDatabase', 'dropIndexes', 'renameCollection', 'collMod', 'bulkWrite', 'aggregate', 'mapReduce'];
const FRAGMENTO = '<p>It costs £20 to apply online or through the UK <abbr';
const PROHIBIDOS = ['fragmento_html', '<', '>', 'usuario_atlas', 'mathias-operador', 'otro-operador@example.com', 'solo-ver@example.com', '"sub"', '"email"', 'mongodb://', 'mongodb+srv', 'eyJ', '"payload"', 'detalle_interno'];

// ------------------------------------------------------------------
// Datos sembrados (con el driver nativo, antes de monitorear)
// ------------------------------------------------------------------

const oid = (hex) => ObjectId.createFromHexString(hex);
const D = {
  gb: '6a87828da8282a4aa6ddfbda', // UK ETA sin costo (campo ausente)
  gbNull: '6a87828da8282a4aa6ddfbdb', // UK ETA con costo: null
  gbOtroNombre: '6a87828da8282a4aa6ddfbdc', // mismo _id de requisito, otro nombre
  gbConCosto: '6a87828da8282a4aa6ddfbdd', // UK ETA con costo: '£16'
  inexistente: '6a87828da8282a4aa6ddfbff'
};
const requisito = (extra = {}) => ({
  _id: oid(REQUISITO_ID_ETA),
  tipo: 'formulario_digital',
  nombre: 'UK ETA',
  obligatorio: 'si',
  descripcion: 'Autorización electrónica de viaje obligatoria, se tramita antes de embarcar.',
  fuente: 'https://www.iatatravelcentre.com/',
  link: 'https://www.gov.uk/eta',
  fecha_verificacion: new Date('2026-08-20T00:00:00Z'),
  estado: 'confirmado',
  ...extra
});
const destinos = [
  { _id: oid(D.gb), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [requisito()] },
  { _id: oid(D.gbNull), pais: 'Reino Unido (null)', codigo_iso: 'G1', requisitos: [requisito({ costo: null })] },
  { _id: oid(D.gbOtroNombre), pais: 'Reino Unido (otro)', codigo_iso: 'G2', requisitos: [requisito({ nombre: 'UK ETA (nuevo)' })] },
  { _id: oid(D.gbConCosto), pais: 'Reino Unido (costo)', codigo_iso: 'G3', requisitos: [requisito({ costo: '£16' })] }
];

let secuencia = 0;
function propuesta(nombre, { destino = D.gb, requisitoHex = REQUISITO_ID_ETA, valorAnterior = { presente: false, valor: null }, estado = 'pendiente_aprobacion', alterarHash = false, extra = {} } = {}) {
  secuencia++;
  const propuestaId = `00000000-0000-4000-8000-${String(secuencia).padStart(12, '0')}`;
  const payload = {
    version_contrato: '1.0',
    tipo_propuesta: 'actualizacion_campo_requisito',
    fecha_propuesta: '2026-09-27T16:24:32.532Z',
    destino_id: destino,
    requisito_id: requisitoHex,
    campo: 'costo',
    run_id_origen: 'bfcf5b8e-bda9-4cc7-b3c3-ef28fb897835',
    propuesta_id: propuestaId,
    valor_anterior: valorAnterior,
    valor_propuesto: {
      valor: '£20',
      valor_normalizado: { importe: 20, moneda: 'GBP' },
      evidencia: {
        comparacion_govuk: { coincide_entre_secciones: true, costo_extraido_consistente: 20, moneda: 'GBP' },
        extraccion: {
          apply: { costo_extraido: 20, fragmento_html: FRAGMENTO, moneda: 'GBP' },
          overview: { costo_extraido: 20, fragmento_html: '<abbr title="Electronic travel authorisation">ETA</abbr> costs £20.', moneda: 'GBP' }
        },
        fuente_govuk: { first_published_at: '2025-05-28T11:00:06+01:00', public_updated_at: '2025-05-28T11:00:06+01:00', updated_at: '2026-09-18T15:20:42+01:00', url: 'https://www.gov.uk/api/content/eta' },
        detalle_interno: { nota: 'no debe salir' }
      }
    },
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-27T16:24:31.692Z' }
  };
  const hash = hashSobreCanonico(payload, 'toc-v1', 'sha256');
  if (alterarHash) payload.valor_propuesto.valor = '£2'; // contenido alterado después de hashear
  return {
    nombre,
    doc: {
      _id: new ObjectId(),
      propuesta_id: propuestaId,
      destino_id: oid(destino),
      requisito_id: oid(requisitoHex),
      campo: 'costo',
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hash,
      run_id_origen: payload.run_id_origen,
      estado,
      version_coordinacion: 0,
      decision_aprobacion_id: null,
      ultimo_evento_id: null,
      createdAt: new Date(Date.UTC(2026, 8, 27, 16, 24, secuencia)),
      updatedAt: new Date(Date.UTC(2026, 8, 27, 16, 24, secuencia)),
      __v: 0,
      ...extra
    }
  };
}

const P = {
  valida: propuesta('valida'),
  hashAlterado: propuesta('hash alterado', { alterarHash: true }),
  requisitoInexistente: propuesta('requisito inexistente', { requisitoHex: '6aaddd0e9f54309f9d8272ff' }),
  destinoInexistente: propuesta('destino inexistente', { destino: D.inexistente }),
  identidadCambiada: propuesta('identidad cambiada', { destino: D.gbOtroNombre }),
  valorCambiado: propuesta('valor cambiado', { destino: D.gbConCosto }),
  ausenteVsNull: propuesta('ausente en propuesta, null en destino', { destino: D.gbNull }),
  nullVsNull: propuesta('null en propuesta y en destino', { destino: D.gbNull, valorAnterior: { presente: true, valor: null } }),
  hashInvalido: propuesta('payload_hash no hex', { extra: { payload_hash: 'no-es-un-hash' } }),
  versionInvalida: propuesta('version_coordinacion 1.5 (double)', { extra: { version_coordinacion: 1.5 } }),
  decisionPrevia: propuesta('pendiente con decision_aprobacion_id', { extra: { decision_aprobacion_id: '4db810fc-d491-4166-82d1-8b88fe9b088d' } }),
  aprobada: propuesta('aprobada', { estado: 'aprobada', extra: { version_coordinacion: 1 } }),
  rechazada: propuesta('rechazada', { estado: 'rechazada', extra: { version_coordinacion: 1 } }),
  aplicada: propuesta('aplicada', { estado: 'aplicada', extra: { version_coordinacion: 2 } })
};
const relleno = Array.from({ length: 5 }, (_, i) => propuesta(`relleno ${i}`));
const EVENTO_APROBACION = '4db810fc-d491-4166-82d1-8b88fe9b088d';
P.aprobada.doc.decision_aprobacion_id = EVENTO_APROBACION;
P.aprobada.doc.ultimo_evento_id = EVENTO_APROBACION;

const eventoDe = (p, extra) => ({
  _id: new ObjectId(),
  evento_id: EVENTO_APROBACION,
  propuesta_id: p.doc.propuesta_id,
  tipo_evento: 'aprobacion',
  estado_anterior: 'pendiente_aprobacion',
  estado_nuevo: 'aprobada',
  hash_contenido_referenciado: p.doc.payload_hash,
  version_coordinacion_nueva: 1,
  ocurrido_en: new Date('2026-09-28T21:28:36.695Z'),
  actor: { tipo: 'humano', identificador: 'mathias' },
  detalle: {
    identidad_operador: { metodo: 'connection_status', usuario_atlas: 'mathias-operador', db_autenticacion: 'admin' },
    comando: { nombre: 'decidir-propuesta', version: '1' }
  },
  __v: 0,
  ...extra
});
// Insertados fuera de orden: el servidor los tiene que devolver por versión.
const eventos = [
  eventoDe(P.aplicada, {
    evento_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tipo_evento: 'aplicacion',
    estado_anterior: 'aprobada',
    estado_nuevo: 'aplicada',
    version_coordinacion_nueva: 2,
    ocurrido_en: new Date('2026-10-01T00:24:59Z'),
    actor: { tipo: 'sistema', identificador: 'aplicar-propuesta' },
    intento_aplicacion_id: '492959d5-0000-4000-8000-000000000000',
    detalle: { proceso_aplicador: { nombre: 'aplicar-propuesta' }, identidad_operador: { metodo: 'oidc_google', sub: '9999', email: 'otro-operador@example.com' }, comando: { nombre: 'aplicar-propuesta', version: '1' } }
  }),
  eventoDe(P.aplicada, { evento_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  eventoDe(P.aprobada)
];

// ------------------------------------------------------------------

let servidorMongo;
let semilla;
let servidorHttp;

async function volcado() {
  const db = semilla.db(DB);
  const salida = {};
  for (const c of (await db.listCollections().toArray()).map((x) => x.name).sort()) {
    salida[c] = {
      docs: await db.collection(c).find({}).sort({ _id: 1 }).toArray(),
      indices: await db.collection(c).listIndexes().toArray()
    };
  }
  return JSON.stringify(salida);
}

(async () => {
  const t0 = Date.now();
  servidorMongo = await MongoMemoryServer.create({ binary: { version: VERSION_MONGOD }, instance: { ip: '127.0.0.1', dbName: DB } });
  const uri = servidorMongo.getUri(DB);
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'Mongo efímero en 127.0.0.1');

  semilla = new MongoClient(uri);
  await semilla.connect();
  const db = semilla.db(DB);
  await db.collection('destinos').insertMany(destinos);
  await db.collection('propuestas_cambio').insertMany([...Object.values(P), ...relleno].map((p) => p.doc));
  await db.collection('eventos_propuesta').insertMany(eventos);
  const antes = await volcado();

  const emisor = await crearEmisorPrueba();
  const verificador = crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: emisor.localJWKSet });
  const envPanel = { GOOGLE_CLIENT_ID: CLIENT_ID, OPERADORES_PANEL_JSON: JSON.stringify(OPERADORES), PANEL_ORIGENES_PERMITIDOS: ORIGEN };

  // 0) Sin conexión de Mongoose: el lector por defecto responde 503
  //    no_disponible y lo registra como ERROR (indisponibilidad real).
  {
    const registros = [];
    const sinMongo = crearApp({ panel: { env: envPanel, verificador, registrar: (e) => registros.push(e) } });
    const srv = sinMongo.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const auth = { Authorization: `Bearer ${await emisor.firmar()}` };
    for (const ruta of ['/api/panel/propuestas', '/api/panel/propuestas/11111111-1111-4111-8111-111111111111']) {
      const r = await pedir(srv.address().port, 'GET', ruta, auth);
      assert.strictEqual(r.status, 503, ruta);
      assert.strictEqual(JSON.parse(r.body).error.codigo, 'no_disponible');
      assert.strictEqual(r.headers['cache-control'], 'no-store');
    }
    const sesion = await pedir(srv.address().port, 'GET', '/api/panel/sesion', auth);
    assert.strictEqual(sesion.status, 200, '/sesion funciona sin Mongo');
    await new Promise((r) => srv.close(r));
    assert.deepStrictEqual(
      registros.map((e) => [e.nivel, e.status, e.codigo, e.motivo]),
      [
        ['error', 503, 'no_disponible', 'sin_conexion_mongo'],
        ['error', 503, 'no_disponible', 'sin_conexion_mongo']
      ]
    );
    console.log('0) sin conexión a Mongo: /propuestas y detalle → 503 no_disponible registrado como error; /sesion sigue respondiendo 200: OK');
  }

  // Conexión de la app (mongoose) con monitor de comandos.
  await mongoose.connect(uri, { monitorCommands: true });
  const COMANDOS = [];
  mongoose.connection.getClient().on('commandStarted', (e) => COMANDOS.push({ nombre: e.commandName, coleccion: e.command[e.commandName] }));
  COMANDOS.length = 0;

  const REGISTROS = [];
  const app = crearApp({
    panel: {
      env: envPanel,
      verificador,
      registrar: (e) => REGISTROS.push(e)
    }
  });
  servidorHttp = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidorHttp.once('listening', r));
  const puerto = servidorHttp.address().port;

  const RESPUESTAS = [];
  const llamar = async (ruta, sub = '1000', extra = {}) => {
    const headers = { ...extra };
    if (sub) headers.Authorization = `Bearer ${await emisor.firmar({ sub, email: OPERADORES.find((o) => o.sub === sub)?.email ?? 'x@example.com' })}`;
    const r = await pedir(puerto, 'GET', ruta, headers);
    RESPUESTAS.push({ ruta, status: r.status, headers: r.headers, body: r.body });
    assert.strictEqual(r.headers['cache-control'], 'no-store', `${ruta}: no-store`);
    assert.strictEqual(r.headers.pragma, 'no-cache', `${ruta}: pragma`);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff', `${ruta}: nosniff`);
    assert.match(r.headers['x-request-id'], UUID, `${ruta}: x-request-id`);
    return { ...r, json: r.body ? JSON.parse(r.body) : null };
  };
  const error = (r, status, codigo, etiqueta) => {
    assert.strictEqual(r.status, status, `[${etiqueta}] status (${r.body})`);
    assert.deepStrictEqual(r.json, { error: { codigo, mensaje: r.json.error.mensaje, request_id: r.headers['x-request-id'] } }, `[${etiqueta}] forma`);
    assert.strictEqual(r.json.error.codigo, codigo, etiqueta);
  };
  const detalle = (p, sub) => llamar(`/api/panel/propuestas/${p.doc.propuesta_id}`, sub);
  const lecturasDe = () => COMANDOS.filter((c) => !['hello', 'isMaster', 'ping', 'endSessions'].includes(c.nombre));

  try {
    // ============================================================
    // 1) Autenticación, autorización y /sesion sin consultar propuestas
    // ============================================================
    {
      error(await llamar('/api/panel/propuestas', null), 401, 'no_autenticado', 'sin token');
      error(await llamar('/api/panel/propuestas', '9999'), 403, 'no_autorizado', 'fuera de la lista');
      error(await llamar('/api/panel/propuestas', '2000'), 403, 'sin_permiso', 'sin permiso ver');
      error(await llamar(`/api/panel/propuestas/${P.valida.doc.propuesta_id}`, '2000'), 403, 'sin_permiso', 'detalle sin permiso ver');
      error(await llamar(`/api/panel/propuestas/${P.valida.doc.propuesta_id}`, null), 401, 'no_autenticado', 'detalle sin token');
      const s = await llamar('/api/panel/sesion', '1000');
      assert.strictEqual(s.status, 200);
      assert.deepStrictEqual(lecturasDe(), [], 'ni los rechazos ni /sesion consultan Mongo');
      // CORS restringido: origen permitido recibe ACAO; uno ajeno, no.
      const permitido = await llamar('/api/panel/propuestas', '1000', { Origin: ORIGEN });
      assert.strictEqual(permitido.headers['access-control-allow-origin'], ORIGEN);
      const ajeno = await llamar('/api/panel/propuestas', '1000', { Origin: 'https://otro.example.com' });
      assert.ok(!('access-control-allow-origin' in ajeno.headers), 'origen ajeno sin ACAO');
      console.log('1) 401 sin token, 403 fuera de la lista y sin "ver" (listado y detalle); /sesion y rechazos: 0 comandos a Mongo; CORS solo para el origen exacto: OK');
    }

    // ============================================================
    // 2) Listado: filtro por defecto, estados, límite, cursor, orden
    // ============================================================
    {
      const pendientes = [...Object.values(P), ...relleno].filter((p) => p.doc.estado === 'pendiente_aprobacion');
      const esperado = pendientes.map((p) => p.doc).sort((a, b) => (a._id.toHexString() < b._id.toHexString() ? 1 : -1)).map((d) => d.propuesta_id);

      const todo = await llamar('/api/panel/propuestas?limite=50');
      assert.strictEqual(todo.status, 200);
      assert.deepStrictEqual(Object.keys(todo.json), ['propuestas', 'filtro', 'limite', 'siguiente_cursor']);
      assert.deepStrictEqual(todo.json.filtro, { estados: ['pendiente_aprobacion'] });
      assert.deepStrictEqual(todo.json.propuestas.map((x) => x.propuesta_id), esperado, 'por defecto solo pendientes, _id desc');
      assert.strictEqual(todo.json.siguiente_cursor, null);
      for (const x of todo.json.propuestas) assert.ok(!('acciones_permitidas' in x), 'el listado no calcula acciones');

      const vistos = [];
      let cursor = null;
      let paginas = 0;
      do {
        const r = await llamar(`/api/panel/propuestas?limite=4${cursor ? `&cursor=${cursor}` : ''}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.json.propuestas.length <= 4 && r.json.limite === 4);
        vistos.push(...r.json.propuestas.map((x) => x.propuesta_id));
        cursor = r.json.siguiente_cursor;
        paginas++;
      } while (cursor);
      assert.deepStrictEqual(vistos, esperado, 'paginación: todas, sin repetidos ni faltantes, mismo orden');
      assert.strictEqual(paginas, Math.ceil(esperado.length / 4));

      const varios = await llamar('/api/panel/propuestas?estado=aplicada,rechazada,aprobada');
      assert.deepStrictEqual(varios.json.filtro.estados, ['aprobada', 'rechazada', 'aplicada']);
      assert.deepStrictEqual(varios.json.propuestas.map((x) => x.estado).sort(), ['aplicada', 'aprobada', 'rechazada']);

      const primera = await llamar('/api/panel/propuestas?limite=1');
      for (const [q, etiqueta] of [
        ['estado=borrada', 'estado desconocido'],
        ['estado=aprobada,aprobada', 'estado repetido'],
        ['estado=aprobada&estado=rechazada', 'parámetro repetido'],
        ['limite=0', 'límite 0'],
        ['limite=51', 'límite 51'],
        ['limite=abc', 'límite no numérico'],
        ['cursor=xyz!', 'cursor malformado'],
        [`cursor=${primera.json.siguiente_cursor}&estado=aprobada`, 'cursor de otro filtro'],
        ['orden=asc', 'parámetro no admitido'],
        ['estado[$ne]=x', 'operador en la query']
      ]) {
        error(await llamar(`/api/panel/propuestas?${q}`), 400, 'solicitud_invalida', etiqueta);
      }

      // Forma exacta de un ítem.
      const item = todo.json.propuestas.find((x) => x.propuesta_id === P.valida.doc.propuesta_id);
      assert.deepStrictEqual(item, {
        propuesta_id: P.valida.doc.propuesta_id,
        estado: 'pendiente_aprobacion',
        campo: 'costo',
        destino_id: D.gb,
        requisito_id: REQUISITO_ID_ETA,
        valor_anterior: { presente: false, valor: null },
        valor_propuesto: { valor: '£20', importe: 20, moneda: 'GBP' },
        fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-27T16:24:31.692Z' },
        version_coordinacion: 0,
        creada_en: P.valida.doc.createdAt.toISOString(),
        actualizada_en: P.valida.doc.updatedAt.toISOString(),
        alertas: []
      });
      assert.deepStrictEqual(todo.json.propuestas.find((x) => x.propuesta_id === P.hashAlterado.doc.propuesta_id).alertas, ['hash_no_coincide']);
      const finds = lecturasDe().filter((c) => c.nombre === 'find');
      assert.ok(finds.length > 0 && finds.every((c) => c.coleccion === 'propuestas_cambio'), 'el listado solo lee propuestas_cambio');
      console.log(`2) listado: pendientes por defecto en orden _id desc; ${paginas} páginas de 4 sin repetidos ni faltantes; 3 estados; 10 consultas inválidas → 400; forma exacta del ítem; alerta de hash; solo lee propuestas_cambio: OK`);
    }

    // ============================================================
    // 3) Detalle: forma exacta de una propuesta válida y acciones
    // ============================================================
    {
      const r = await detalle(P.valida, '1000');
      assert.strictEqual(r.status, 200);
      const d = r.json;
      assert.deepStrictEqual(Object.keys(d), ['propuesta', 'integridad', 'requisito_actual', 'eventos', 'eventos_truncados', 'acciones_permitidas', 'acciones_bloqueadas']);
      assert.deepStrictEqual(d.integridad, { hash_coincide: true, hash_recalculado: P.valida.doc.payload_hash, consistente: true, problemas: [] });
      assert.deepStrictEqual(d.requisito_actual, {
        estado: 'coincide',
        destino: { destino_id: D.gb, pais: 'Reino Unido', codigo_iso: 'GB' },
        requisito: { requisito_id: REQUISITO_ID_ETA, tipo: 'formulario_digital', nombre: 'UK ETA' },
        valor_actual: { presente: false, valor: null },
        valor: 'coincide'
      });
      assert.deepStrictEqual(d.propuesta.evidencia, {
        fuente: 'GOV.UK',
        url: 'https://www.gov.uk/api/content/eta',
        capturado_en: '2026-09-27T16:24:31.692Z',
        fuente_actualizada_en: '2025-05-28T11:00:06+01:00',
        valor_extraido: '£20',
        importe: 20,
        moneda: 'GBP',
        secciones: [
          { seccion: 'apply', costo_extraido: 20, moneda: 'GBP' },
          { seccion: 'overview', costo_extraido: 20, moneda: 'GBP' }
        ],
        coincide_entre_secciones: true,
        avisos: []
      });
      assert.deepStrictEqual(d.acciones_permitidas, ['aprobar', 'rechazar']);
      assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: [], rechazar: [] });
      assert.deepStrictEqual(d.eventos, []);
      const soloVer = await detalle(P.valida, '3000');
      assert.deepStrictEqual([soloVer.json.acciones_permitidas, soloVer.json.acciones_bloqueadas], [[], { aprobar: ['sin_permiso_decidir'], rechazar: ['sin_permiso_decidir'] }]);
      console.log('3) detalle válido: forma exacta, hash recalculado, requisito y valor coinciden → [aprobar, rechazar]; operador sin "decidir" → []: OK');
    }

    // ============================================================
    // 4) Hash, requisito, identidad, valor; ausente frente a null
    // ============================================================
    {
      const casos = [
        [P.hashAlterado, 'coincide', 'coincide', ['hash_no_coincide']],
        [P.requisitoInexistente, 'requisito_id_no_encontrado', null, ['requisito_no_coincide', 'valor_actual_cambio']],
        [P.destinoInexistente, 'destino_no_encontrado', null, ['requisito_no_coincide', 'valor_actual_cambio']],
        [P.identidadCambiada, 'identidad_semantica_no_coincide', 'coincide', ['requisito_no_coincide']],
        [P.valorCambiado, 'coincide', 'cambio', ['valor_actual_cambio']],
        [P.ausenteVsNull, 'coincide', 'cambio', ['valor_actual_cambio']],
        [P.nullVsNull, 'coincide', 'coincide', []],
        [P.hashInvalido, 'coincide', 'coincide', ['payload_hash_invalido'], ['payload_hash_invalido']],
        [P.versionInvalida, 'coincide', 'coincide', ['version_coordinacion_invalida'], ['version_coordinacion_invalida']],
        [P.decisionPrevia, 'coincide', 'coincide', ['decision_previa_existente'], ['decision_previa_existente']]
      ];
      for (const [p, estado, valor, motivos, rechazo = []] of casos) {
        const d = (await detalle(p, '1000')).json;
        assert.strictEqual(d.requisito_actual.estado, estado, `${p.nombre}: estado`);
        assert.strictEqual(d.requisito_actual.valor, valor, `${p.nombre}: valor`);
        assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: motivos, rechazar: rechazo }, `${p.nombre}: bloqueadas`);
        // Íntegra → aprobar y rechazar; con problemas → solo rechazar; hash inválido → ninguna.
        const esperadas = ['aprobar', 'rechazar'].filter((a) => ({ aprobar: motivos, rechazar: rechazo })[a].length === 0);
        assert.deepStrictEqual(d.acciones_permitidas, esperadas, `${p.nombre}: acciones`);
        // Sin permiso "decidir" → [], con el motivo en cada acción.
        const soloVer = (await detalle(p, '3000')).json;
        assert.deepStrictEqual(
          [soloVer.acciones_permitidas, soloVer.acciones_bloqueadas],
          [[], { aprobar: [...motivos, 'sin_permiso_decidir'], rechazar: [...rechazo, 'sin_permiso_decidir'] }],
          `${p.nombre}: solo ver`
        );
      }
      assert.strictEqual((await detalle(P.hashInvalido, '1000')).json.propuesta.payload_hash, null, 'hash inválido no se expone');
      const h = (await detalle(P.hashAlterado, '1000')).json.integridad;
      assert.strictEqual(h.hash_coincide, false);
      assert.notStrictEqual(h.hash_recalculado, P.hashAlterado.doc.payload_hash);
      assert.deepStrictEqual((await detalle(P.ausenteVsNull, '1000')).json.requisito_actual.valor_actual, { presente: true, valor: null }, 'null explícito en el destino');
      assert.deepStrictEqual((await detalle(P.valida, '1000')).json.requisito_actual.valor_actual, { presente: false, valor: null }, 'campo ausente en el destino');
      console.log(`4) ${casos.length} casos con BSON real: hash alterado, requisito/destino inexistente, identidad cambiada, valor cambiado, ausente ≠ null → [rechazar]; null = null → [aprobar, rechazar]; payload_hash no hex, versión 1.5 y decisión previa en pendiente → [] (ambas con su motivo); los mismos sin "decidir" → []: OK`);
    }

    // ============================================================
    // 5) Estado no decidible, eventos ordenados y sin identidad privada
    // ============================================================
    {
      const ap = (await detalle(P.aprobada, '1000')).json;
      assert.deepStrictEqual([ap.acciones_permitidas, ap.acciones_bloqueadas], [[], { aprobar: ['estado_no_permite_decision'], rechazar: ['estado_no_permite_decision'] }]);
      assert.strictEqual(ap.propuesta.decision_aprobacion_id, EVENTO_APROBACION);
      assert.deepStrictEqual(ap.eventos, [
        {
          evento_id: EVENTO_APROBACION,
          tipo_evento: 'aprobacion',
          estado_anterior: 'pendiente_aprobacion',
          estado_nuevo: 'aprobada',
          ocurrido_en: '2026-09-28T21:28:36.695Z',
          version_coordinacion_nueva: 1,
          hash_contenido_referenciado: P.aprobada.doc.payload_hash,
          actor: { tipo: 'humano', identificador: 'mathias' },
          origen: 'decidir-propuesta',
          metodo_identidad: 'connection_status',
          motivo: null,
          intento_aplicacion_id: null
        }
      ]);
      const apl = (await detalle(P.aplicada, '1000')).json;
      assert.deepStrictEqual(apl.eventos.map((e) => [e.version_coordinacion_nueva, e.tipo_evento, e.origen]), [
        [1, 'aprobacion', 'decidir-propuesta'],
        [2, 'aplicacion', 'aplicar-propuesta']
      ], 'eventos ordenados por versión aunque se insertaron al revés');
      assert.strictEqual(apl.eventos[1].metodo_identidad, 'oidc_google');
      console.log('5) aprobada/aplicada → [] (estado_no_permite_decision); eventos ordenados por versión con forma exacta; identidad_operador nunca expuesta: OK');
    }

    // ============================================================
    // 6) 400 y 404 del detalle
    // ============================================================
    {
      error(await llamar('/api/panel/propuestas/no-es-uuid'), 400, 'solicitud_invalida', 'id no UUID');
      error(await llamar('/api/panel/propuestas/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'), 400, 'solicitud_invalida', 'UUID en mayúsculas');
      error(await llamar(`/api/panel/propuestas/${P.valida.doc.propuesta_id}?x=1`), 400, 'solicitud_invalida', 'query en el detalle');
      error(await llamar('/api/panel/propuestas/11111111-1111-4111-8111-111111111111'), 404, 'no_encontrado', 'inexistente');
      error(await llamar('/api/panel/propuestas/a/b'), 404, 'no_encontrado', 'ruta inexistente');
      console.log('6) detalle: id inválido, mayúsculas o query → 400; inexistente y subruta → 404: OK');
    }

    // ============================================================
    // 7) Ninguna respuesta con HTML ni datos privados
    // ============================================================
    {
      // /sesion devuelve a propósito la identidad PROPIA verificada; el resto se revisa entero.
      const dePropuestas = RESPUESTAS.filter((r) => r.ruta.startsWith('/api/panel/propuestas'));
      for (const r of dePropuestas) {
        for (const p of PROHIBIDOS) assert.ok(!r.body.includes(p), `${r.ruta} (${r.status}) contiene ${JSON.stringify(p)}`);
      }
      for (const e of REGISTROS) assert.ok(!/eyJ|mongodb:\/\//.test(JSON.stringify(e)), 'registros sin tokens ni URIs');
      console.log(`7) ${dePropuestas.length} respuestas de /propuestas (200, 400, 401, 403, 404): sin fragmento_html, "<", ">", payload, usuario_atlas, sub, email, URIs ni tokens; ${REGISTROS.length} registros saneados: OK`);
    }

    // ============================================================
    // 8) Cero escrituras
    // ============================================================
    {
      const nombres = [...new Set(COMANDOS.map((c) => c.nombre))].sort();
      const escrituras = COMANDOS.filter((c) => COMANDOS_ESCRITURA.includes(c.nombre));
      assert.deepStrictEqual(escrituras, [], 'ningún comando de escritura');
      assert.ok(nombres.every((n) => ['find', 'getMore', 'killCursors', 'hello', 'isMaster', 'ping', 'endSessions'].includes(n)), `comandos: ${nombres.join(', ')}`);
      const colecciones = [...new Set(COMANDOS.filter((c) => c.nombre === 'find').map((c) => c.coleccion))].sort();
      assert.deepStrictEqual(colecciones, ['destinos', 'eventos_propuesta', 'propuestas_cambio']);
      assert.strictEqual(await volcado(), antes, 'volcado completo (documentos e índices) idéntico');
      console.log(`8) ${COMANDOS.length} comandos de la app (${nombres.join(', ')}) sobre ${colecciones.join(', ')}: 0 escrituras; volcado de documentos e índices idéntico: OK`);
    }

    console.log(`\nPRUEBA PANEL PROPUESTAS + MONGO OK (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } finally {
    const pasos = [];
    await new Promise((r) => servidorHttp.close(r)).then(() => pasos.push('http: cerrado'));
    await mongoose.disconnect().then(() => pasos.push('mongoose.disconnect: ok'));
    await semilla.close().then(() => pasos.push('cliente semilla: ok'));
    await servidorMongo.stop({ doCleanup: true, force: true }).then(() => pasos.push('mongod: detenido y datos borrados (doCleanup)'));
    console.log(`LIMPIEZA: ${pasos.join('; ')}`);
  }
})().catch(async (err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
  try {
    await mongoose.disconnect();
    await semilla?.close();
    await servidorMongo?.stop({ doCleanup: true, force: true });
  } catch {
    // limpieza best-effort
  }
});
