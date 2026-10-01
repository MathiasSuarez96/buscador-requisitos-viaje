/**
 * Prueba de INTEGRACIÓN del servicio de aplicación
 * (services/propuestas/aplicar-propuesta.js) y del comando
 * (scripts/aplicar-propuesta.js) contra un Mongo REAL y efímero:
 * MongoMemoryReplSet 8.0.32 con autenticación, en 127.0.0.1. Valida lo que
 * los fakes offline no pueden: transacciones y su commit/rollback reales,
 * $elemMatch con ObjectId de BSON, WriteConflict y E11000 del servidor, y
 * la representación de la transacción en el oplog.
 *
 * Dos procesos:
 *  1. Lanzador (sin marca): arma un entorno SANEADO con una allowlist
 *     mínima de variables de Windows/Node (ENTORNO_PERMITIDO) más
 *     MONGOMS_VERSION, verifica que MONGODB_URI, MONGODB_URI_DECISION y
 *     OPERADORES_AUTORIZADOS_JSON no se hereden, y se relanza con
 *     --require preload-solo-loopback.js.
 *  2. Hijo (con marca): vuelve a verificar el entorno y el preload, levanta
 *     el replica set, corre las fases F0–F3 y en finally detiene el
 *     replica set y borra sus datos.
 *
 * Nunca lee .env ni process.env para conectarse: las URIs y la allowlist
 * se arman acá (contraseñas aleatorias por corrida) y se inyectan como
 * objeto. El binario de mongod tiene que estar en la caché de
 * mongodb-memory-server (~/.cache/mongodb-binaries); si falta, la descarga
 * queda bloqueada por el preload y la prueba falla.
 *
 * Uso: node scripts/test-integracion-aplicacion-propuesta.js
 * (no forma parte de las suites offline: levanta mongod).
 */

const path = require('path');
const { spawnSync } = require('child_process');

const VERSION_MONGOD = '8.0.32';
const MARCA_HIJO = 'INTEGRACION_APLICACION_HIJO';
const VARIABLES_SENSIBLES = ['MONGODB_URI', 'MONGODB_URI_DECISION', 'OPERADORES_AUTORIZADOS_JSON'];
// Mínimo para Node y mongod en Windows (y HOME/TMPDIR en otros sistemas).
const ENTORNO_PERMITIDO = [
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'LOCALAPPDATA',
  'APPDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  // libuv las agrega en Windows al crear el hijo si faltan (required_vars):
  // no se pueden quitar, así que se admiten explícitamente.
  'LOGONSERVER',
  'USERDOMAIN',
  'USERNAME'
];
const PRELOAD = path.join(__dirname, 'preload-solo-loopback.js');

const claves = (env) => Object.keys(env).map((k) => k.toUpperCase());

function entornoSaneado(origen = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(origen)) if (ENTORNO_PERMITIDO.includes(k.toUpperCase())) env[k] = v;
  env.MONGOMS_VERSION = VERSION_MONGOD;
  env[MARCA_HIJO] = '1';
  return env;
}

function lanzar() {
  const env = entornoSaneado();
  const heredadas = VARIABLES_SENSIBLES.filter((v) => claves(env).includes(v));
  if (heredadas.length > 0) throw new Error(`El entorno saneado hereda ${heredadas.join(', ')}. Abortando.`);
  console.log(`Entorno saneado del hijo (${Object.keys(env).length} variables): ${Object.keys(env).sort().join(', ')}`);
  console.log(
    `Variables sensibles en el proceso lanzador: ${VARIABLES_SENSIBLES.map((v) => `${v}=${process.env[v] !== undefined ? 'PRESENTE' : 'ausente'}`).join(', ')}`
  );
  console.log('Heredadas por el hijo: ninguna (verificado sobre el objeto de entorno del hijo).\n');
  const r = spawnSync(process.execPath, ['--require', PRELOAD, __filename], {
    env,
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    timeout: 10 * 60 * 1000
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}

if (process.env[MARCA_HIJO] !== '1') {
  if (require.main === module) lanzar();
  module.exports = { ENTORNO_PERMITIDO, VARIABLES_SENSIBLES, entornoSaneado };
  return;
}

// ======================================================================
// Hijo
// ======================================================================

// Guardas antes de cargar nada que pueda conectarse.
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('El preload preload-solo-loopback.js no está cargado. Abortando.');
{
  const presentes = claves(process.env);
  const sensibles = VARIABLES_SENSIBLES.filter((v) => presentes.includes(v));
  if (sensibles.length > 0) throw new Error(`El hijo heredó ${sensibles.join(', ')}. Abortando sin levantar nada.`);
  const extra = presentes.filter((k) => !ENTORNO_PERMITIDO.includes(k) && k !== 'MONGOMS_VERSION' && k !== MARCA_HIJO);
  if (extra.length > 0) throw new Error(`Variables fuera de la allowlist en el hijo: ${extra.join(', ')}. Abortando.`);
  if (process.env.MONGOMS_VERSION !== VERSION_MONGOD) throw new Error(`MONGOMS_VERSION debe ser ${VERSION_MONGOD}.`);
}

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { ObjectId, EJSON } = require('bson');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const { TRANSICIONES } = require('../services/propuestas/contrato-propuestas');
const { ErrorPrecondicionIndices, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { ErrorActorNoAutorizado } = require('../services/propuestas/operadores-autorizados');
const { decidirPropuesta, crearDependenciasMongoose: crearDepsDecision } = require('../services/propuestas/decidir-propuesta');
const {
  aplicarPropuesta,
  verificarIndices: verificarIndicesAplicacion,
  crearDependenciasMongoose: crearDepsAplicacion,
  ErrorEscrituraAbortada,
  ErrorInconsistencia
} = require('../services/propuestas/aplicar-propuesta');
const govuk = require('../services/propuestas/adaptadores/govuk-uk-eta');
const { REQUISITO_ID_ETA, URL_ETA, FUENTE_NOMBRE } = require('../services/propuestas/fuentes/govuk-uk-eta');
const crearIndices = require('./crear-indices-propuestas');
const comando = require('./aplicar-propuesta');

const DB = 'buscador_requisitos';
const NS = (c) => `${DB}.${c}`;
const FECHA_BASE = new Date('2026-09-01T00:00:00.000Z');
const VALOR16 = { presente: true, valor: '£16' };
const COLECCIONES = ['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'historial_cambios', 'inicios_intento_aplicacion'];

const OPERADOR = 'operador-integracion';
const OPERADORES_JSON = JSON.stringify([{ usuario_atlas: OPERADOR, db: 'admin', identificador: 'operador.integracion' }]);
const clave = () => crypto.randomBytes(18).toString('hex');
const CLAVES = { root: clave(), operador: clave(), backend: clave() };

// Todo lo impreso pasa por acá: al final se verifica que no haya secretos.
const SALIDA = [];
function salida(linea = '') {
  SALIDA.push(String(linea));
  console.log(linea);
}

// Eventos de comandos del cliente de mongoose (operador), para commits y fallos.
const EVENTOS = { commits: [], fallos: [] };

let rs = null;
let root = null;
let otroProceso = null;
const U = {}; // URIs armadas

// ----------------------------------------------------------------------
// Conexiones
// ----------------------------------------------------------------------

function armarUri(usuario, pwd, puerto, setName) {
  return `mongodb://${usuario}:${pwd}@127.0.0.1:${puerto}/${DB}?replicaSet=${setName}&authSource=admin`;
}

async function conectarOperador() {
  await mongoose.connect(U.operador, { monitorCommands: true });
  const cliente = mongoose.connection.getClient();
  const iniciados = new Map();
  cliente.on('commandStarted', (e) => {
    if (e.commandName === 'commitTransaction') iniciados.set(e.requestId, { lsid: e.command.lsid, txnNumber: e.command.txnNumber });
  });
  cliente.on('commandSucceeded', (e) => {
    if (e.commandName === 'commitTransaction' && iniciados.has(e.requestId)) EVENTOS.commits.push(iniciados.get(e.requestId));
  });
  cliente.on('commandFailed', (e) => {
    EVENTOS.fallos.push({ comando: e.commandName, code: e.failure?.code ?? null, codeName: e.failure?.codeName ?? null, labels: e.failure?.errorLabels ?? [] });
  });
}

const desconectar = () => (mongoose.connection.readyState !== 0 ? mongoose.disconnect() : null);
const col = (c) => root.db(DB).collection(c);
const snapshot = async (c, filtro) => EJSON.stringify(await col(c).find(filtro).sort({ _id: 1 }).toArray(), { relaxed: false });
const contar = async () => Object.fromEntries(await Promise.all(COLECCIONES.map(async (c) => [c, await col(c).countDocuments()])));

// ----------------------------------------------------------------------
// Siembra
// ----------------------------------------------------------------------

let paises = 0;

// Destino con 3 requisitos: el ETA objetivo (en el medio) y dos más, uno
// con el MISMO costo para probar que el $elemMatch elige por _id.
async function sembrarDestino({ costo = '£16', eta = {}, idEtaComoString = false } = {}) {
  paises++;
  const destinoId = new ObjectId();
  const otroId = new ObjectId();
  const requisitos = [
    { _id: otroId, tipo: 'visa', obligatorio: 'no', descripcion: 'No requiere visa', estado: 'verificar', costo },
    {
      _id: idEtaComoString ? REQUISITO_ID_ETA : ObjectId.createFromHexString(REQUISITO_ID_ETA),
      tipo: 'formulario_digital',
      nombre: 'UK ETA',
      obligatorio: 'si',
      descripcion: 'Autorización electrónica de viaje',
      estado: 'verificar',
      costo,
      ...eta
    },
    { _id: new ObjectId(), tipo: 'pasaporte', obligatorio: 'si', descripcion: 'Pasaporte vigente', estado: 'verificar' }
  ];
  await col('destinos').insertOne({ _id: destinoId, pais: `País integración ${paises}`, codigo_iso: `X${paises}`, requisitos, createdAt: FECHA_BASE, updatedAt: FECHA_BASE });
  return { destinoId, otroId };
}

// Propuesta real (construirPropuesta + validación del modelo) y, si se
// pide, aprobación real con el servicio decidirPropuesta como operador.
async function sembrarPropuesta(destinoId, { aprobar = true } = {}) {
  const propuestaId = crypto.randomUUID();
  const entrada = {
    run_id: crypto.randomUUID(),
    iniciado_en: new Date(),
    campo: 'costo',
    fuente: { nombre: FUENTE_NOMBRE, url: URL_ETA, capturado_en: new Date().toISOString() },
    evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP' } } },
    estado_ejecucion: 'ok',
    destino_id: destinoId.toHexString(),
    requisito_id: REQUISITO_ID_ETA,
    valor_previo_en_mongo: { ...VALOR16 },
    resultado_comparacion: { categoria: 'IMPORTE_NO_COINCIDE', ambiguo: false },
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } }
  };
  const doc = construirPropuesta(entrada, propuestaId, new Date().toISOString());
  await new PropuestaCambio(doc).save();
  if (aprobar) {
    const r = await decidirPropuesta(
      {
        tipo_evento: 'aprobacion',
        propuesta_id: propuestaId,
        estado_esperado: 'pendiente_aprobacion',
        payload_hash_esperado: doc.payload_hash,
        version_coordinacion_esperada: 0,
        decision_aprobacion_id_esperado: null
      },
      crearDepsDecision(mongoose.connection, { operadoresJson: OPERADORES_JSON })
    );
    assert.strictEqual(r.resultado, 'decision_registrada', 'aprobación real registrada');
  }
  return { propuestaId, hash: doc.payload_hash, entrada: { propuesta_id: propuestaId, payload_hash_esperado: doc.payload_hash, version_coordinacion_esperada: 1 } };
}

// ----------------------------------------------------------------------
// Adaptador inyectado: soporta/validarIdentidad reales, revalidar con una
// Promise real (sin red).
// ----------------------------------------------------------------------

const respuestaValor = (valor = '£20', importe = 20) => (t) => ({
  tipo: 'valor',
  valor: { valor, valor_normalizado: { importe, moneda: 'GBP' } },
  revalidada_en: t,
  fuente_nombre: FUENTE_NOMBRE,
  url: URL_ETA,
  evidencia: { avisos: [], origen: 'adaptador inyectado de la prueba de integración' }
});

function crearAdaptador(responder = respuestaValor(), antes = null) {
  const llamadas = { revalidar: 0 };
  const adaptador = Object.freeze({
    nombre: govuk.nombre,
    version: govuk.version,
    soporta: govuk.soporta,
    validarIdentidad: govuk.validarIdentidad,
    revalidar: async (propuesta, { ahora }) => {
      llamadas.revalidar++;
      if (antes) await antes();
      await new Promise((r) => setImmediate(r));
      return responder(ahora(), propuesta);
    }
  });
  return { adaptador, llamadas };
}

function depsServicio(adaptador, extra = {}) {
  return { ...crearDepsAplicacion(mongoose.connection, { operadoresJson: OPERADORES_JSON }), elegirAdaptador: () => adaptador, ...extra };
}

// Cuenta corridas del callback de transacción (incluye reintentos del driver).
function conContador(deps) {
  const contador = { corridas: 0 };
  const base = deps.ejecutarTransaccion;
  deps.ejecutarTransaccion = (fn) =>
    base(async (session) => {
      contador.corridas++;
      return fn(session);
    });
  return contador;
}

// ----------------------------------------------------------------------
// Oplog
// ----------------------------------------------------------------------

// Todas las entradas físicas de UNA transacción (lsid.id + txnNumber),
// ordenadas por ts, y sus operaciones lógicas reunidas (applyOps de cada
// entrada, sea una sola o una cadena partialTxn).
async function transaccionEnOplog({ lsid, txnNumber }) {
  const entradas = await root
    .db('local')
    .collection('oplog.rs')
    .find({ 'lsid.id': lsid.id, txnNumber })
    .sort({ ts: 1 })
    .toArray();
  const operaciones = entradas.flatMap((e) => (e.op === 'c' && Array.isArray(e.o?.applyOps) ? e.o.applyOps : []));
  return { entradas, operaciones };
}

// Toda escritura registrada en el oplog sobre un destino, suelta o dentro
// de una transacción. [] = el destino nunca se modificó después de sembrarse.
async function escriturasOplogDestino(destinoId) {
  return root
    .db('local')
    .collection('oplog.rs')
    .find({
      $or: [
        { ns: NS('destinos'), op: 'u', 'o2._id': destinoId },
        { 'o.applyOps': { $elemMatch: { ns: NS('destinos'), op: 'u', 'o2._id': destinoId } } }
      ]
    })
    .toArray();
}

// ----------------------------------------------------------------------
// Verificaciones comunes
// ----------------------------------------------------------------------

async function estadoPropuesta(propuestaId) {
  const p = await col('propuestas_cambio').findOne({ propuesta_id: propuestaId });
  return { estado: p.estado, version: p.version_coordinacion, ultimo_evento_id: p.ultimo_evento_id };
}

async function assertSinCambiosEnDestino(destinoId, antes, etiqueta) {
  assert.strictEqual(await snapshot('destinos', { _id: destinoId }), antes, `[${etiqueta}] destino idéntico al sembrado`);
  assert.deepStrictEqual(await escriturasOplogDestino(destinoId), [], `[${etiqueta}] ninguna escritura del destino en el oplog`);
}

async function inicioDe(propuestaId) {
  const inicios = await col('inicios_intento_aplicacion').find({ propuesta_id: propuestaId }).toArray();
  assert.strictEqual(inicios.length, 1, 'un InicioIntentoAplicacion');
  return inicios[0];
}

// ----------------------------------------------------------------------
// Comando de punta a punta (ejecutar() con dependencias reales salvo el
// adaptador, la pregunta y el adaptador del servicio)
// ----------------------------------------------------------------------

async function correrComando(config, { env, adaptador, respuesta }) {
  await desconectar(); // el comando abre su propia conexión con MONGODB_URI_DECISION
  const logs = [];
  const llamadas = { preguntar: 0 };
  const deps = {
    ...comando.crearDependenciasComando(env),
    elegirAdaptador: () => adaptador,
    preguntar: async () => {
      llamadas.preguntar++;
      return respuesta;
    },
    aplicar: (entrada, operadoresJson) =>
      aplicarPropuesta(entrada, { ...crearDepsAplicacion(mongoose.connection, { operadoresJson }), elegirAdaptador: () => adaptador })
  };
  let r = null;
  let err = null;
  try {
    r = await comando.ejecutar(config, deps, (l) => logs.push(String(l)));
  } catch (e) {
    err = e;
    logs.push(`Error: ${comando.mensajeDeError(e, env.MONGODB_URI_DECISION)}`);
  } finally {
    await desconectar();
    await conectarOperador();
  }
  for (const l of logs.join('\n').split('\n')) salida(`    │ ${l}`);
  return { r, err, logs: logs.join('\n'), llamadas };
}

// ----------------------------------------------------------------------
// Escenarios
// ----------------------------------------------------------------------

let numero = 0;
async function escenario(nombre, fn) {
  numero++;
  salida(`\n── ${nombre}`);
  const t0 = Date.now();
  const detalles = await fn();
  for (const d of detalles ?? []) salida(`   · ${d}`);
  salida(`   OK (${Date.now() - t0} ms)`);
}

async function principal() {
  const t0 = Date.now();

  // ---------------- Replica set con autenticación ----------------
  rs = await MongoMemoryReplSet.create({
    binary: { version: VERSION_MONGOD },
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
      auth: {
        enable: true,
        customRootName: 'root-integracion',
        customRootPwd: CLAVES.root,
        extraUsers: [
          { createUser: OPERADOR, pwd: CLAVES.operador, roles: [{ role: 'readWrite', db: DB }], database: 'admin' },
          { createUser: 'backend-app', pwd: CLAVES.backend, roles: [{ role: 'readWrite', db: DB }], database: 'admin' }
        ]
      }
    }
  });
  const base = new URL(rs.getUri());
  if (base.hostname !== '127.0.0.1') throw new Error(`El replica set no está en 127.0.0.1 (${base.hostname}). Abortando.`);
  const setName = base.searchParams.get('replicaSet');
  U.root = armarUri('root-integracion', CLAVES.root, base.port, setName);
  U.operador = armarUri(OPERADOR, CLAVES.operador, base.port, setName);
  U.backend = armarUri('backend-app', CLAVES.backend, base.port, setName);
  for (const u of Object.values(U)) assert.match(u, /^mongodb:\/\/[a-z-]+:[0-9a-f]{36}@127\.0\.0\.1:\d+\/buscador_requisitos\?replicaSet=\w+&authSource=admin$/);

  root = new MongoClient(U.root);
  await root.connect();
  otroProceso = new MongoClient(U.backend); // "otro proceso": otra conexión, otro usuario
  await otroProceso.connect();

  const build = await root.db('admin').command({ buildInfo: 1 });
  const hello = await root.db('admin').command({ hello: 1 });
  const opciones = await root.db('admin').command({ getCmdLineOpts: 1 });
  salida('=== MONGOD EFÍMERO ===');
  salida(`buildInfo.version: ${build.version} (gitVersion ${build.gitVersion})`);
  salida(`replica set: ${hello.setName}, primario escribible: ${hello.isWritablePrimary}, hosts: ${hello.hosts.join(', ')}`);
  salida(`bindIp: ${opciones.parsed?.net?.bindIp}, auth: ${opciones.parsed?.security?.authorization ?? '(keyFile)'}, keyFile: ${opciones.parsed?.security?.keyFile ? 'sí' : 'no'}`);
  salida(`dbPath: ${opciones.parsed?.storage?.dbPath}`);
  assert.strictEqual(build.version, VERSION_MONGOD);
  assert.ok(hello.setName && hello.isWritablePrimary);
  assert.strictEqual(opciones.parsed?.net?.bindIp, '127.0.0.1');

  const ENV_OPERADOR = { MONGODB_URI_DECISION: U.operador, MONGODB_URI: U.backend, OPERADORES_AUTORIZADOS_JSON: OPERADORES_JSON };

  await conectarOperador();
  const status = await mongoose.connection.db.command({ connectionStatus: 1 });
  salida(`connectionStatus (mongoose): ${JSON.stringify(status.authInfo.authenticatedUsers)}`);
  assert.deepStrictEqual(status.authInfo.authenticatedUsers, [{ user: OPERADOR, db: 'admin' }]);

  // ================= F0: gate sin índices =================
  const destinoE = await sembrarDestino();
  const propuestaE = await sembrarPropuesta(destinoE.destinoId, { aprobar: false });

  await escenario('F0 · gate sin índices (listIndexes real)', async () => {
    let err = null;
    try {
      await verificarIndicesAplicacion();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ErrorPrecondicionIndices, `ErrorPrecondicionIndices (recibido ${err})`);
    const antes = await contar();
    const { adaptador, llamadas } = crearAdaptador();
    const { r } = await correrComando({ modo: 'solo_lectura', propuesta_id: propuestaE.propuestaId }, { env: ENV_OPERADOR, adaptador });
    assert.strictEqual(r.gate_ok, false);
    assert.strictEqual(r.identidad_ok, true);
    assert.strictEqual(r.prevision, 'propuesta_no_aplicable');
    assert.strictEqual(llamadas.revalidar, 0, 'revalidación omitida por propuesta no aplicable');
    assert.deepStrictEqual(await contar(), antes, 'solo_lectura no escribe');
    return [`servicio: ${err.constructor.name}: ${err.message.split('\n')[0].slice(0, 160)}…`, 'comando solo_lectura: gate_ok=false, previsión propuesta_no_aplicable, 0 revalidaciones, 0 escrituras'];
  });

  // ================= F1: índices con crear-indices-propuestas =================
  await escenario('F1 · crear-indices-propuestas.js creacion_real, conjunto aplicacion (como backend-app)', async () => {
    await desconectar();
    const logs = [];
    // Dependencias reales del script salvo conectar(), que lee process.env.MONGODB_URI.
    const deps = {
      ...crearIndices.crearDependenciasMongoose(),
      conectar: async () => {
        await mongoose.connect(U.backend);
        return mongoose.connection.db.databaseName;
      }
    };
    const conPrefijo = (prefijo) => (l) => logs.push(...String(l).split('\n').map((x) => `${prefijo}: ${x}`));
    const r1 = await crearIndices.ejecutar('creacion_real', deps, conPrefijo('1ª'), 'aplicacion');
    const r2 = await crearIndices.ejecutar('creacion_real', deps, conPrefijo('2ª'), 'aplicacion');
    await desconectar();
    await conectarOperador();
    for (const l of logs.join('\n').split('\n')) salida(`    │ ${l}`);
    assert.strictEqual(r1.creados.length, INDICES_APLICACION.length, `1ª corrida crea los ${INDICES_APLICACION.length}`);
    assert.deepStrictEqual(r2.creados, [], '2ª corrida no crea nada');
    assert.ok(r2.plan.every((p) => p.estado === 'ya_existe'), '2ª corrida: todo ya_existe');
    await verificarIndicesAplicacion();
    return [`1ª corrida: ${r1.creados.length} creados; 2ª: 0 creados, ${r2.plan.length} ya_existe`, 'verificarIndices() del servicio: OK'];
  });

  // ================= F2: servicio =================
  const S1B = {}; // datos de S1 que valida S1b
  await escenario('S1 · éxito: $elemMatch con ObjectId real elige el subdocumento correcto', async () => {
    const { destinoId, otroId } = await sembrarDestino();
    const gemelo = await sembrarDestino(); // mismo _id de requisito y mismo costo, otro destino
    const gemeloAntes = await snapshot('destinos', { _id: gemelo.destinoId });
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    EVENTOS.commits.length = 0;
    const r = await aplicarPropuesta(p.entrada, depsServicio(adaptador));
    assert.strictEqual(r.resultado, 'exito');
    const commits = [...EVENTOS.commits];

    const d = await col('destinos').findOne({ _id: destinoId });
    const [otro, eta, tercero] = d.requisitos;
    assert.ok(eta._id instanceof ObjectId && eta._id.toHexString() === REQUISITO_ID_ETA, '_id del ETA sigue siendo ObjectId');
    assert.ok(otro._id instanceof ObjectId && otro._id.equals(otroId));
    assert.strictEqual(eta.costo, '£20', 'el ETA cambió');
    assert.strictEqual(otro.costo, '£16', 'el otro requisito con el mismo costo NO cambió');
    assert.strictEqual(tercero.costo, undefined);
    assert.strictEqual(await snapshot('destinos', { _id: gemelo.destinoId }), gemeloAntes, 'el destino gemelo no cambió');

    // S1b se valida con estos datos (mismo intento).
    S1B.datos = { r, commits, destinoId, propuestaId: p.propuestaId };
    return [
      `resultado ${r.resultado}, intento ${r.intento_id}, evento ${r.evento_id}`,
      `requisitos[1] (${REQUISITO_ID_ETA}, ObjectId): £16 → £20; requisitos[0] (mismo costo, otro _id): £16 intacto`,
      'destino gemelo con el mismo _id de requisito: idéntico'
    ];
  });

  await escenario('S1b · commit atómico: oplog correlacionado por lsid + txnNumber', async () => {
    const { r, commits, destinoId, propuestaId } = S1B.datos;
    assert.strictEqual(commits.length, 1, 'un solo commitTransaction exitoso en el intento');
    const { entradas, operaciones } = await transaccionEnOplog(commits[0]);
    assert.ok(entradas.length >= 1, 'la transacción está en el oplog');
    const resumen = operaciones.map((o) => `${o.op} ${o.ns}`).sort();
    assert.deepStrictEqual(resumen, [
      `i ${NS('eventos_propuesta')}`,
      `i ${NS('historial_cambios')}`,
      `i ${NS('intentos_aplicacion')}`,
      `u ${NS('destinos')}`,
      `u ${NS('propuestas_cambio')}`
    ]);
    const por = (op, c) => operaciones.find((o) => o.op === op && o.ns === NS(c));
    const propuesta = await col('propuestas_cambio').findOne({ propuesta_id: propuestaId });
    assert.ok(por('u', 'destinos').o2._id.equals(destinoId), 'update del destino correcto');
    assert.ok(por('u', 'propuestas_cambio').o2._id.equals(propuesta._id), 'update de la propuesta correcta');
    assert.strictEqual(por('i', 'historial_cambios').o.historial_id, r.historial_id);
    assert.strictEqual(por('i', 'intentos_aplicacion').o.intento_id, r.intento_id);
    assert.strictEqual(por('i', 'intentos_aplicacion').o.resultado, 'exito');
    assert.strictEqual(por('i', 'eventos_propuesta').o.evento_id, r.evento_id);
    assert.strictEqual(por('i', 'eventos_propuesta').o.tipo_evento, 'aplicacion');

    // Mismo t en las 5 escrituras.
    const t = por('i', 'historial_cambios').o.aplicado_en.getTime();
    const d = await col('destinos').findOne({ _id: destinoId });
    assert.deepStrictEqual(
      [d.updatedAt, propuesta.updatedAt, por('i', 'intentos_aplicacion').o.finalizado_en, por('i', 'eventos_propuesta').o.ocurrido_en].map((x) => x.getTime()),
      [t, t, t, t]
    );
    assert.deepStrictEqual([propuesta.estado, propuesta.version_coordinacion], ['aplicada', 2]);

    // El inicio es un insert independiente, fuera de la transacción.
    const inicio = await root.db('local').collection('oplog.rs').findOne({ ns: NS('inicios_intento_aplicacion'), op: 'i', 'o.intento_id': r.intento_id });
    assert.ok(inicio, 'el inicio está en el oplog');
    assert.ok(!(inicio.lsid && inicio.lsid.id.equals(commits[0].lsid.id) && inicio.txnNumber?.equals?.(commits[0].txnNumber)), 'el inicio no pertenece a la transacción');
    assert.ok(!operaciones.some((o) => o.ns === NS('inicios_intento_aplicacion')), 'el inicio no está entre las operaciones de la transacción');

    const fisicas = entradas.map((e) => `${e.op}${e.partialTxn ? '(partialTxn)' : ''} applyOps=${e.o?.applyOps?.length ?? 0}`);
    return [
      `lsid ${commits[0].lsid.id.toString('hex')}, txnNumber ${commits[0].txnNumber}`,
      `entradas físicas del oplog: ${entradas.length} [${fisicas.join('; ')}]`,
      `operaciones lógicas reunidas (${operaciones.length}): ${resumen.join(' | ')}`,
      `las 5 con el mismo t = ${new Date(t).toISOString()}; propuesta aplicada v2`,
      'InicioIntentoAplicacion: insert propio en el oplog, fuera de la transacción'
    ];
  });

  await escenario('C1 · WriteConflict real (otro proceso toca OTRO requisito) → reintento del driver → éxito', async () => {
    const { destinoId, otroId } = await sembrarDestino();
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    const deps = depsServicio(adaptador);
    const contador = conContador(deps);
    const leer = deps.leerDestino;
    let disparado = false;
    deps.leerDestino = async (filtro, session) => {
      const d = await leer(filtro, session);
      if (session && !disparado) {
        disparado = true;
        const u = await otroProceso
          .db(DB)
          .collection('destinos')
          .updateOne({ _id: destinoId }, { $set: { 'requisitos.$[o].descripcion': 'Cambio externo C1' } }, { arrayFilters: [{ 'o._id': otroId }] });
        assert.strictEqual(u.modifiedCount, 1, 'el otro proceso escribió');
      }
      return d;
    };
    EVENTOS.fallos.length = 0;
    const r = await aplicarPropuesta(p.entrada, deps);
    const conflictos = EVENTOS.fallos.filter((f) => f.code === 112);
    assert.strictEqual(r.resultado, 'exito');
    assert.ok(conflictos.length >= 1, 'hubo al menos un WriteConflict real (code 112)');
    assert.ok(conflictos.every((f) => f.labels.includes('TransientTransactionError')), 'etiquetado TransientTransactionError');
    assert.strictEqual(contador.corridas, 2, 'el callback corrió 2 veces (1 conflicto + 1 reintento)');
    const d = await col('destinos').findOne({ _id: destinoId });
    assert.strictEqual(d.requisitos[1].costo, '£20');
    assert.strictEqual(d.requisitos[0].descripcion, 'Cambio externo C1', 'el cambio externo se conserva');
    return [
      `fallos del servidor: ${conflictos.map((f) => `${f.comando} code=${f.code} ${f.codeName} [${f.labels.join(',')}]`).join('; ')}`,
      `corridas del callback de transacción: ${contador.corridas}`,
      'resultado exito; cambio externo en requisitos[0] conservado; ETA £20'
    ];
  });

  await escenario('C2 · WriteConflict real (otro proceso cambia el costo) → reintento → valor_actual_cambio', async () => {
    const { destinoId } = await sembrarDestino();
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    const deps = depsServicio(adaptador);
    const contador = conContador(deps);
    const leer = deps.leerDestino;
    let disparado = false;
    deps.leerDestino = async (filtro, session) => {
      const d = await leer(filtro, session);
      if (session && !disparado) {
        disparado = true;
        await otroProceso
          .db(DB)
          .collection('destinos')
          .updateOne({ _id: destinoId }, { $set: { 'requisitos.$[e].costo': '£18' } }, { arrayFilters: [{ 'e._id': ObjectId.createFromHexString(REQUISITO_ID_ETA) }] });
      }
      return d;
    };
    EVENTOS.fallos.length = 0;
    const r = await aplicarPropuesta(p.entrada, deps);
    const conflictos = EVENTOS.fallos.filter((f) => f.code === 112);
    assert.strictEqual(r.resultado, 'valor_actual_cambio');
    assert.ok(conflictos.length >= 1 && conflictos.every((f) => f.labels.includes('TransientTransactionError')));
    assert.strictEqual(contador.corridas, 3, '2 corridas de la transacción de éxito + 1 transacción corta');
    assert.deepStrictEqual(await estadoPropuesta(p.propuestaId), { estado: TRANSICIONES.conflicto.hacia, version: 2, ultimo_evento_id: r.evento_id });
    const d = await col('destinos').findOne({ _id: destinoId });
    assert.strictEqual(d.requisitos[1].costo, '£18', 'queda el valor del otro proceso');
    assert.strictEqual(await col('historial_cambios').countDocuments({ propuesta_id: p.propuestaId }), 0);
    const intento = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
    assert.deepStrictEqual(intento.valor_observado, { presente: true, valor: '£18' });
    return [
      `fallos del servidor: ${conflictos.map((f) => `${f.comando} code=${f.code} ${f.codeName}`).join('; ')}`,
      `corridas: ${contador.corridas}; resultado ${r.resultado}; propuesta ${TRANSICIONES.conflicto.hacia} v2; valor_observado £18; sin historial`
    ];
  });

  await escenario('C3 · carrera real: dos aplicaciones concurrentes de la misma propuesta', async () => {
    const { destinoId } = await sembrarDestino();
    const p = await sembrarPropuesta(destinoId);
    // Barrera: ambas pasan la etapa 0 (propuesta aprobada) antes de que alguna escriba.
    let llegados = 0;
    let soltar;
    const juntos = new Promise((r) => {
      soltar = r;
    });
    const barrera = async () => {
      if (++llegados === 2) soltar();
      await juntos;
    };
    const a = crearAdaptador(respuestaValor(), barrera);
    const b = crearAdaptador(respuestaValor(), barrera);
    EVENTOS.fallos.length = 0;
    const res = await Promise.allSettled([aplicarPropuesta(p.entrada, depsServicio(a.adaptador)), aplicarPropuesta(p.entrada, depsServicio(b.adaptador))]);
    assert.ok(res.every((x) => x.status === 'fulfilled'), `ambas terminan sin lanzar: ${res.map((x) => x.reason?.message).join(' | ')}`);
    const resultados = res.map((x) => x.value);
    const ganador = resultados.find((x) => x.resultado === 'exito');
    const perdedor = resultados.find((x) => x.resultado !== 'exito');
    assert.ok(ganador && perdedor, 'una gana y otra pierde');
    assert.strictEqual(perdedor.resultado, 'propuesta_no_aplicable');
    assert.strictEqual(perdedor.etapa_fallo, 'escritura_aplicacion', 'pierde en el CAS de la transacción, no en la etapa 0');
    assert.strictEqual(await col('historial_cambios').countDocuments({ propuesta_id: p.propuestaId }), 1);
    assert.strictEqual(await col('intentos_aplicacion').countDocuments({ propuesta_id: p.propuestaId, resultado: 'exito' }), 1);
    assert.strictEqual(await col('inicios_intento_aplicacion').countDocuments({ propuesta_id: p.propuestaId }), 2);
    assert.strictEqual(await col('eventos_propuesta').countDocuments({ propuesta_id: p.propuestaId }), 2, 'aprobación + aplicación');
    assert.deepStrictEqual(await estadoPropuesta(p.propuestaId), { estado: 'aplicada', version: 2, ultimo_evento_id: ganador.evento_id });
    const conflictos = EVENTOS.fallos.filter((f) => f.code === 112);
    return [
      `ganador exito (intento ${ganador.intento_id}); perdedor propuesta_no_aplicable en ${perdedor.etapa_fallo}`,
      `WriteConflict reales durante la carrera: ${conflictos.length}${conflictos.length === 0 ? ' (el perdedor encontró el CAS ya confirmado: matchedCount 0)' : ''}`,
      '1 historial, 1 intento exito, 2 inicios, 2 eventos (aprobación + aplicación); propuesta aplicada v2'
    ];
  });

  await escenario('A1 · abort real: error después del $set, historial e intento → rollback completo', async () => {
    const { destinoId } = await sembrarDestino();
    const antes = await snapshot('destinos', { _id: destinoId });
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    const inyectado = new Error('fallo inyectado al insertar el evento (conexión mongodb://usuario:clave-inyectada@host.example/x)');
    const deps = depsServicio(adaptador, {
      insertarEvento: async () => {
        throw inyectado;
      }
    });
    let err = null;
    try {
      await aplicarPropuesta(p.entrada, deps);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ErrorEscrituraAbortada, `ErrorEscrituraAbortada (recibido ${err})`);
    assert.strictEqual(err.cause, inyectado, 'cause = error original');
    await assertSinCambiosEnDestino(destinoId, antes, 'A1');
    assert.deepStrictEqual(await estadoPropuesta(p.propuestaId), { estado: 'aprobada', version: 1, ultimo_evento_id: (await col('propuestas_cambio').findOne({ propuesta_id: p.propuestaId })).decision_aprobacion_id });
    assert.strictEqual(await col('historial_cambios').countDocuments({ propuesta_id: p.propuestaId }), 0);
    assert.strictEqual(await col('eventos_propuesta').countDocuments({ propuesta_id: p.propuestaId }), 1, 'solo la aprobación');
    const intentos = await col('intentos_aplicacion').find({ propuesta_id: p.propuestaId }).toArray();
    assert.deepStrictEqual(intentos.map((i) => i.resultado), ['escritura_abortada']);
    assert.strictEqual(intentos[0].intento_id, err.intento_id);
    assert.ok(!intentos[0].error_mensaje.includes('clave-inyectada') && intentos[0].error_mensaje.includes('<uri-mongodb-redactada>'), 'error_mensaje saneado');
    return [
      `${err.constructor.name} (intento ${err.intento_id}, etapa ${err.etapa_fallo})`,
      'destino idéntico y sin escrituras en el oplog; propuesta aprobada v1; 0 historial; solo el evento de aprobación',
      `intento registrado: escritura_abortada; error_mensaje persistido: "${intentos[0].error_mensaje.slice(0, 120)}…"`
    ];
  });

  await escenario('A2 · E11000 real dentro de la transacción (historial_cambios.propuesta_id_1)', async () => {
    const { destinoId } = await sembrarDestino();
    const antes = await snapshot('destinos', { _id: destinoId });
    const p = await sembrarPropuesta(destinoId);
    await col('historial_cambios').insertOne({ historial_id: crypto.randomUUID(), propuesta_id: p.propuestaId, intento_aplicacion_id: crypto.randomUUID(), sembrado_por: 'A2' });
    const { adaptador } = crearAdaptador();
    let err = null;
    try {
      await aplicarPropuesta(p.entrada, depsServicio(adaptador));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ErrorInconsistencia, `ErrorInconsistencia (recibido ${err})`);
    assert.match(err.message, /E11000/);
    assert.match(err.message, /propuesta_id_1/);
    await assertSinCambiosEnDestino(destinoId, antes, 'A2');
    assert.deepStrictEqual((await estadoPropuesta(p.propuestaId)).estado, 'aprobada');
    assert.strictEqual((await estadoPropuesta(p.propuestaId)).version, 1);
    const inicio = await inicioDe(p.propuestaId);
    assert.strictEqual(await col('intentos_aplicacion').countDocuments({ intento_id: inicio.intento_id }), 0, 'el intento de la transacción se revirtió');
    assert.strictEqual(await col('historial_cambios').countDocuments({ propuesta_id: p.propuestaId }), 1, 'solo el sembrado');
    return [`${err.constructor.name}: ${err.message.slice(0, 200)}…`, 'destino, CAS de la propuesta e intento revertidos; queda el inicio para auditoría'];
  });

  await escenario('A3 · abort semántico: identidad del requisito cambió → CAS revertido + transacción corta', async () => {
    const { destinoId } = await sembrarDestino({ eta: { nombre: 'Otro nombre' } });
    const antes = await snapshot('destinos', { _id: destinoId });
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    const deps = depsServicio(adaptador);
    const contador = conContador(deps);
    const r = await aplicarPropuesta(p.entrada, deps);
    assert.strictEqual(r.resultado, 'identidad_requisito_cambio');
    assert.strictEqual(contador.corridas, 2, 'transacción de éxito abortada + transacción corta');
    // Si el CAS de la 1ª no se hubiera revertido, la 2ª (que exige v1) no habría encontrado la propuesta.
    assert.deepStrictEqual(await estadoPropuesta(p.propuestaId), { estado: TRANSICIONES.conflicto.hacia, version: 2, ultimo_evento_id: r.evento_id });
    await assertSinCambiosEnDestino(destinoId, antes, 'A3');
    const intento = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
    assert.strictEqual(intento.identidad_esperada_no_coincide.categoria, 'identidad_semantica_no_coincide');
    return [`resultado ${r.resultado}; corridas ${contador.corridas}; propuesta ${TRANSICIONES.conflicto.hacia} v2 (no v3: el CAS abortado se revirtió)`, 'destino sin escrituras'];
  });

  await escenario('T1 · control de tipo: requisito con _id STRING → el $elemMatch con ObjectId no matchea', async () => {
    const { destinoId } = await sembrarDestino({ idEtaComoString: true });
    const antes = await snapshot('destinos', { _id: destinoId });
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador();
    let err = null;
    try {
      await aplicarPropuesta(p.entrada, depsServicio(adaptador));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ErrorInconsistencia, `ErrorInconsistencia (recibido ${err})`);
    assert.match(err.message, /matchedCount=0/);
    await assertSinCambiosEnDestino(destinoId, antes, 'T1');
    assert.strictEqual((await estadoPropuesta(p.propuestaId)).version, 1);
    const i = await col('intentos_aplicacion').findOne({ intento_id: err.intento_id });
    assert.strictEqual(i.resultado, 'escritura_abortada');
    const d = await col('destinos').findOne({ _id: destinoId });
    assert.strictEqual(typeof d.requisitos[1]._id, 'string');
    return [
      `${err.constructor.name}: ${err.message.slice(0, 180)}…`,
      'la identidad (String(_id)) coincide, pero el driver nativo no convierte tipos: el filtro con ObjectId no encuentra el _id string',
      'rollback: destino y propuesta intactos; intento escritura_abortada registrado'
    ];
  });

  // ================= F3: comando de punta a punta =================
  const destinoCmd = await sembrarDestino();
  const pCmd = await sembrarPropuesta(destinoCmd.destinoId);
  const adaptadorCmd = crearAdaptador();

  await escenario('E1 · comando solo_lectura contra la base efímera', async () => {
    const antes = await contar();
    const destinoAntes = await snapshot('destinos', { _id: destinoCmd.destinoId });
    const { r, logs } = await correrComando({ modo: 'solo_lectura', propuesta_id: pCmd.propuestaId }, { env: ENV_OPERADOR, adaptador: adaptadorCmd.adaptador });
    assert.deepStrictEqual(r, { modo: 'solo_lectura', escrito: false, gate_ok: true, identidad_ok: true, prevision: 'exito' });
    assert.ok(logs.includes('Operador: operador.integracion'));
    assert.ok(logs.includes(`"_id": "ObjectId(\\"${destinoCmd.destinoId.toHexString()}\\")"`));
    assert.ok(logs.includes('Gate de índices (INDICES_APLICACION): OK'));
    assert.deepStrictEqual(await contar(), antes, 'no escribió en ninguna colección');
    assert.strictEqual(await snapshot('destinos', { _id: destinoCmd.destinoId }), destinoAntes);
    assert.strictEqual(adaptadorCmd.llamadas.revalidar, 1);
    return ['previsión exito; identidad por connectionStatus real; gate OK con listIndexes real; 0 escrituras'];
  });

  await escenario('E2 · comando aplicacion_real (misma propuesta)', async () => {
    const { r, llamadas } = await correrComando(
      { modo: 'aplicacion_real', propuesta_id: pCmd.propuestaId },
      { env: ENV_OPERADOR, adaptador: adaptadorCmd.adaptador, respuesta: pCmd.hash.slice(0, 12) }
    );
    assert.strictEqual(r.aplicado, true);
    assert.strictEqual(comando.codigoSalida(r), 0);
    assert.strictEqual(llamadas.preguntar, 1);
    assert.strictEqual(adaptadorCmd.llamadas.revalidar, 3, 'E1 vista + E2 vista + E2 servicio');
    const d = await col('destinos').findOne({ _id: destinoCmd.destinoId });
    assert.strictEqual(d.requisitos[1].costo, '£20');
    assert.deepStrictEqual(await estadoPropuesta(pCmd.propuestaId), { estado: 'aplicada', version: 2, ultimo_evento_id: r.resultado.evento_id });
    for (const c of ['historial_cambios', 'intentos_aplicacion']) assert.strictEqual(await col(c).countDocuments({ propuesta_id: pCmd.propuestaId }), 1, c);
    return ['resultado exito; codigoSalida 0; GOV.UK (inyectado) consultado 2 veces en esta corrida: vista + servicio', 'destino £20, propuesta aplicada v2, 1 historial, 1 intento'];
  });

  await escenario('E3 · comando aplicacion_real con cambio de fuente previsto → lo registra el servicio', async () => {
    const { destinoId } = await sembrarDestino();
    const antes = await snapshot('destinos', { _id: destinoId });
    const p = await sembrarPropuesta(destinoId);
    const { adaptador } = crearAdaptador(respuestaValor('£25', 25));
    const { r, logs, llamadas } = await correrComando({ modo: 'aplicacion_real', propuesta_id: p.propuestaId }, { env: ENV_OPERADOR, adaptador, respuesta: p.hash.slice(0, 12) });
    assert.strictEqual(r.prevision, 'fuente_cambio');
    assert.ok(logs.includes('ATENCIÓN: la vista prevé fuente_cambio'));
    assert.strictEqual(llamadas.preguntar, 1);
    assert.strictEqual(r.resultado.resultado, 'fuente_cambio');
    assert.strictEqual(comando.codigoSalida(r), 1);
    assert.deepStrictEqual((await estadoPropuesta(p.propuestaId)).estado, TRANSICIONES.obsolescencia.hacia);
    await assertSinCambiosEnDestino(destinoId, antes, 'E3');
    return [`previsión fuente_cambio → confirmado → servicio: fuente_cambio; propuesta ${TRANSICIONES.obsolescencia.hacia}; codigoSalida 1; destino intacto`];
  });

  await escenario('E4 · comando con la credencial de backend-app (fuera de la allowlist)', async () => {
    const { destinoId } = await sembrarDestino();
    const p = await sembrarPropuesta(destinoId);
    const antes = await contar();
    const { adaptador } = crearAdaptador();
    const env = { MONGODB_URI_DECISION: U.backend, MONGODB_URI: U.operador, OPERADORES_AUTORIZADOS_JSON: OPERADORES_JSON };
    const { err, llamadas } = await correrComando({ modo: 'aplicacion_real', propuesta_id: p.propuestaId }, { env, adaptador, respuesta: p.hash.slice(0, 12) });
    assert.ok(err instanceof ErrorActorNoAutorizado, `ErrorActorNoAutorizado (recibido ${err})`);
    assert.strictEqual(llamadas.preguntar, 0);
    assert.deepStrictEqual(await contar(), antes, 'no escribió nada');
    return [`${err.constructor.name}: ${err.message}`, 'abortó antes de pedir confirmación; 0 escrituras'];
  });

  await escenario('E5 · saneo: ninguna salida contiene contraseñas ni URIs de esta corrida', async () => {
    const texto = SALIDA.join('\n');
    for (const secreto of [...Object.values(CLAVES), ...Object.values(U)]) assert.ok(!texto.includes(secreto), 'secreto en la salida');
    assert.ok(!/mongodb(\+srv)?:\/\/[^\s]*:[^\s]*@/.test(texto), 'URI con credenciales en la salida');
    return [`${SALIDA.length} líneas revisadas: 0 contraseñas, 0 URIs con credenciales`];
  });

  salida(`\n${numero} escenarios OK en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function limpiar() {
  const pids = rs ? rs.servers.map((s) => s.instanceInfo?.instance?.mongodProcess?.pid).filter(Boolean) : [];
  const rutas = rs ? rs.servers.map((s) => s.instanceInfo?.dbPath).filter(Boolean) : [];
  const pasos = [];
  const intentar = async (nombre, fn) => {
    try {
      await fn();
      pasos.push(`${nombre}: ok`);
    } catch (e) {
      pasos.push(`${nombre}: FALLÓ (${e.message})`);
    }
  };
  await intentar('mongoose.disconnect', desconectar);
  await intentar('cliente root', () => root?.close());
  await intentar('cliente otro proceso', () => otroProceso?.close());
  await intentar('rs.stop({ doCleanup: true })', () => rs?.stop({ doCleanup: true, force: true }));
  const vivos = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const quedan = rutas.filter((r) => fs.existsSync(r));
  salida('\n=== LIMPIEZA (finally) ===');
  for (const p of pasos) salida(`  ${p}`);
  salida(`  estado del replica set: ${rs?.state ?? '(no se creó)'}`);
  salida(`  procesos mongod (${pids.join(', ') || '-'}): ${vivos.length === 0 ? 'terminados' : `VIVOS ${vivos.join(', ')}`}`);
  salida(`  directorios de datos (${rutas.length}): ${quedan.length === 0 ? 'borrados' : `QUEDAN ${quedan.join(', ')}`}`);
  return vivos.length === 0 && quedan.length === 0 && pasos.every((p) => p.endsWith(': ok'));
}

function informarLoopback() {
  const e = globalThis.__SOLO_LOOPBACK__;
  const destinos = [...e.destinos];
  salida('\n=== RED ===');
  salida(`  conexiones permitidas: ${e.permitidos}, todas a: ${[...new Set(destinos.map((d) => d.replace(/:\d+$/, '')))].join(', ')}`);
  salida(`  destinos: ${destinos.join(', ')}`);
  salida(`  bloqueados: ${e.bloqueados.length}${e.bloqueados.length ? ` [${[...new Set(e.bloqueados)].join(', ')}]` : ''}`);
  return e.bloqueados.length === 0 && destinos.every((d) => d.startsWith('127.0.0.1:') || d.startsWith('::1:'));
}

(async () => {
  let ok = false;
  try {
    salida('Hijo: preload solo-loopback cargado; MONGODB_URI, MONGODB_URI_DECISION y OPERADORES_AUTORIZADOS_JSON ausentes; entorno dentro de la allowlist.\n');
    await principal();
    ok = true;
  } catch (err) {
    salida(`\nFALLÓ: ${comando.mensajeDeError(err, U.operador)}`);
    if (err?.stack) salida(err.stack.split('\n').slice(1, 6).join('\n'));
  } finally {
    const limpio = await limpiar();
    const soloLoopback = informarLoopback();
    if (!limpio || !soloLoopback) ok = false;
    salida(`\n${ok ? 'PRUEBA DE INTEGRACIÓN OK' : 'PRUEBA DE INTEGRACIÓN FALLIDA'}`);
    process.exitCode = ok ? 0 : 1;
  }
})();
