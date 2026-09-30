// Pruebas offline (sin conexión a Mongo, sin red) para
// services/propuestas/aplicar-propuesta.js y
// services/propuestas/identidad-requisito.js. Extiende el store falso del
// servicio de decisión con destinos, intentos, historial e inicios:
//  - la "transacción" acumula escrituras en un staging que solo se
//    consolida al hacer commit; si el callback lanza, no queda nada.
//  - el CAS de la propuesta y el $set del destino toman un bloqueo; otra
//    transacción que lo quiera recibe un WriteConflict con la etiqueta
//    TransientTransactionError y el ejecutor falso re-ejecuta el callback
//    (como withTransaction) cuando se libera.
//  - todo documento insertado pasa por validate() del modelo real y se
//    guarda como lo dejaría Mongoose (toObject(): _id, ObjectId casteados);
//    los destinos se validan con el modelo Destino antes y después del $set.
//  - índices únicos de INDICES_APLICACION imitados a mano, con el mismo
//    mensaje E11000 que el servidor ("collection: ... index: ...").
//  - el matcher de destinos imita a Mongo en lo que importa acá: un _id
//    string NUNCA matchea un ObjectId, {campo: null} matchea null Y
//    ausente, $exists, $type:'null', $elemMatch y $ posicional.
//
// LÍMITES DEL FAKE: sin aislamiento snapshot real (la lectura en sesión ve
// staging + consolidado); el E11000, el abort y el commit ambiguo reales
// requieren un replica set (ver la integración con Mongo efímero). Que el
// filtro con ObjectId encuentre subdocumentos con _id BSON en un servidor
// real también queda para esa integración; acá se prueba la forma exacta.
//
// Uso: node scripts/test-servicio-aplicacion-propuesta.js

const assert = require('assert');
const mongoose = require('mongoose');
const { ObjectId } = require('bson');

const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');
const EventoPropuesta = require('../models/propuestas/EventoPropuesta.model.js');
const IntentoAplicacion = require('../models/propuestas/IntentoAplicacion.model.js');
const InicioIntentoAplicacion = require('../models/propuestas/InicioIntentoAplicacion.model.js');
const HistorialCambio = require('../models/propuestas/HistorialCambio.model.js');
const Destino = require('../models/Destino.model.js');
const { canonicalizarValor } = require('../services/propuestas/canonicalizacion-propuestas');
const { VENTANA_REVALIDACION_MS } = require('../services/propuestas/contrato-propuestas');
const { INDICES_APLICACION, coleccionesDe } = require('../services/propuestas/indices-propuestas');
const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const { cargarOperadoresAutorizados } = require('../services/propuestas/operadores-autorizados');
const { clasificarIdentidadRequisito } = require('../services/propuestas/identidad-requisito');
const S = require('../services/propuestas/aplicar-propuesta');

const {
  ErrorEntradaInvalida,
  ErrorInconsistencia,
  ErrorPropuestaNoEncontrada,
  ErrorPropuestaNoSoportada,
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  ErrorPrecondicionIndices,
  ErrorSinAdaptador,
  ErrorEscrituraAbortada,
  ErrorResultadoIncierto,
  aplicarPropuesta
} = S;
const adaptadorGovUk = require('../services/propuestas/adaptadores/govuk-uk-eta');
const { REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');

// ------------------------------------------------------------------
// Constantes de prueba (ids ficticios)
// ------------------------------------------------------------------

const PROPUESTA_ID = '22222222-2222-4222-8222-222222222222';
const APROBACION_ID = '99999999-9999-4999-8999-000000000001';
const DESTINO_HEX = '0000000000000000000000a1';
const REQ_HEX = '0000000000000000000000b2';
const OTRO_REQ_HEX = '0000000000000000000000b3';
const URL_FUENTE = 'https://www.gov.uk/api/content/eta';

const T0 = new Date('2026-09-29T10:00:00.000Z'); // iniciado_en (1.ª llamada a ahora)
const T = new Date('2026-09-29T10:00:05.000Z'); // t (2.ª llamada a ahora)
const REVALIDADA_EN = new Date('2026-09-29T10:00:03.000Z');
const DESTINO_UPDATED_AT = new Date('2026-09-01T00:00:00.000Z');

const PREFIJO = '33333333-3333-4333-8333-';
const idGen = (n, prefijo = PREFIJO) => `${prefijo}${String(n).padStart(12, '0')}`;
const INTENTO = idGen(1);
const EVENTO = idGen(2);
const HISTORIAL = idGen(3);
const REVALIDACION = idGen(4);

const USUARIO = { user: 'operador-prueba', db: 'admin' };
const OPERADORES_JSON = JSON.stringify([
  { usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' },
  { usuario_atlas: 'otro-operador', db: 'admin', identificador: 'otro.operador' }
]);
const OPERADOR = { tipo: 'humano', identificador: 'operador.prueba' };
const IDENTIDAD_OPERADOR = { metodo: 'connection_status', usuario_atlas: 'operador-prueba', db_autenticacion: 'admin' };
const PROCESO = { nombre: 'aplicar-propuesta', version: '1' };
const ADAPTADOR = { nombre: 'adaptador-prueba', version: '7' };
const CONTEXTO_PROCESO = { host: 'host-prueba', pid: 4242 };
const MAX_REINTENTOS_DRIVER = 10;

const AUSENTE = { presente: false, valor: null };
const NULO = { presente: true, valor: null };
const VALOR16 = { presente: true, valor: '£16' };
const VALOR10 = { presente: true, valor: '£10' };

const RESP_VALOR = {
  tipo: 'valor',
  valor: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } },
  revalidada_en: REVALIDADA_EN,
  fuente_nombre: 'GOV.UK',
  url: URL_FUENTE,
  evidencia: { avisos: [], secciones: { overview: 20, apply: 20 } }
};
const RESP_NO_DISPONIBLE = {
  tipo: 'no_disponible',
  motivo: 'timeout',
  evidencia: { causa: 'timeout', status: null, mensaje: 'timeout simulado', timeout_ms: 10000 }
};
const RESP_AMBIGUO = {
  tipo: 'ambiguo',
  motivo: 'overview_distinto_de_apply',
  revalidada_en: REVALIDADA_EN,
  fuente_nombre: 'GOV.UK',
  url: URL_FUENTE,
  evidencia: { avisos: ['overview 20, apply 25'] }
};
const respValor = (valor, importe, extra = {}) => ({
  ...RESP_VALOR,
  valor: { valor, valor_normalizado: { importe, moneda: 'GBP' } },
  ...extra
});

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------

// structuredClone perdería la clase ObjectId: se clona a mano.
function clonar(v) {
  if (v instanceof ObjectId) return ObjectId.createFromHexString(v.toHexString());
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clonar);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)]));
  return v;
}

// Forma comparable: ObjectId → {$oid}, Date → ISO.
function plano(v) {
  if (v instanceof ObjectId) return { $oid: v.toHexString() };
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plano);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plano(x)]));
  return v;
}

// Documento leído → comparable con lo construido por el servicio.
function limpio(doc) {
  const { _id, __v, ...resto } = doc;
  return plano(S.normalizarBson(resto));
}

function recorrer(v, fn, ruta = []) {
  fn(v, ruta);
  if (v instanceof ObjectId || v instanceof Date) return;
  if (Array.isArray(v)) v.forEach((x, i) => recorrer(x, fn, [...ruta, i]));
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) recorrer(x, fn, [...ruta, k]);
}

async function assertRechaza(promesaOFn, claseOMensaje, etiqueta) {
  let err;
  try {
    await (typeof promesaOFn === 'function' ? promesaOFn() : promesaOFn);
  } catch (e) {
    err = e;
  }
  assert.ok(err, `[${etiqueta}] se esperaba un error`);
  if (typeof claseOMensaje === 'string') {
    assert.ok(String(err.message).includes(claseOMensaje), `[${etiqueta}] mensaje real: ${err.message}`);
  } else {
    assert.ok(err instanceof claseOMensaje, `[${etiqueta}] clase real: ${err.constructor.name} (${err.message})`);
  }
  return err;
}

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

function propuestaAprobada({ valorAnterior = VALOR16, valorPropuesto = '£20', importe = 20, destinoHex = DESTINO_HEX, requisitoHex = REQ_HEX } = {}) {
  const entrada = {
    run_id: '11111111-1111-4111-8111-111111111111',
    iniciado_en: new Date('2026-09-24T12:00:00.000Z'),
    campo: 'costo',
    fuente: { nombre: 'GOV.UK', url: URL_FUENTE, capturado_en: '2026-09-24T12:00:01.000Z' },
    evidencia: { extraccion: { overview: { costo_extraido: importe, moneda: 'GBP' } } },
    estado_ejecucion: 'ok',
    destino_id: destinoHex,
    requisito_id: requisitoHex,
    valor_previo_en_mongo: { ...valorAnterior },
    resultado_comparacion: { categoria: 'IMPORTE_NO_COINCIDE', ambiguo: false },
    valor_propuesto: { valor: valorPropuesto, valor_normalizado: { importe, moneda: 'GBP' } }
  };
  const p = {
    ...construirPropuesta(entrada, PROPUESTA_ID, '2026-09-24T12:00:02.000Z'),
    estado: 'aprobada',
    version_coordinacion: 1,
    decision_aprobacion_id: APROBACION_ID,
    ultimo_evento_id: APROBACION_ID,
    createdAt: new Date('2026-09-24T12:00:03.000Z'),
    updatedAt: new Date('2026-09-28T10:00:00.000Z')
  };
  const aprobacion = {
    evento_id: APROBACION_ID,
    propuesta_id: PROPUESTA_ID,
    tipo_evento: 'aprobacion',
    estado_anterior: 'pendiente_aprobacion',
    estado_nuevo: 'aprobada',
    hash_contenido_referenciado: p.payload_hash,
    version_coordinacion_nueva: 1,
    ocurrido_en: new Date('2026-09-28T10:00:00.000Z'),
    actor: { tipo: 'humano', identificador: 'operador.previo' },
    detalle: { comando: { nombre: 'decidir-propuesta', version: '1' } }
  };
  return { propuesta: p, aprobacion };
}

function requisitoEta(costo = VALOR16, extra = {}) {
  const r = {
    _id: ObjectId.createFromHexString(REQ_HEX),
    tipo: 'formulario_digital',
    nombre: 'ETA',
    obligatorio: 'si',
    descripcion: 'Autorización electrónica de viaje',
    estado: 'verificar'
  };
  if (costo.presente) r.costo = costo.valor;
  return { ...r, ...extra };
}

function destinoFixture(costo = VALOR16, { requisitos } = {}) {
  return {
    _id: ObjectId.createFromHexString(DESTINO_HEX),
    pais: 'Reino Unido',
    codigo_iso: 'GB',
    requisitos: requisitos ?? [
      { _id: ObjectId.createFromHexString(OTRO_REQ_HEX), tipo: 'visa', obligatorio: 'no', descripcion: 'No requiere visa', estado: 'verificar' },
      requisitoEta(costo)
    ],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: DESTINO_UPDATED_AT
  };
}

function crearStore({ propuestas = [], eventos = [], destinos = [], intentos = [], historial = [], inicios = [] } = {}) {
  return {
    propuestas: new Map(propuestas.map((p) => [p.propuesta_id, clonar(p)])),
    destinos: new Map(destinos.map((d) => [d._id.toHexString(), clonar(d)])),
    eventos: eventos.map(clonar),
    intentos: intentos.map(clonar),
    historial: historial.map(clonar),
    inicios: inicios.map(clonar),
    bloqueos: new Map(),
    esperas: [],
    pendientes: []
  };
}

function escenario({ valorAnterior = VALOR16, costoDestino, propuesta: extraPropuesta = {}, destino } = {}) {
  const { propuesta, aprobacion } = propuestaAprobada({ valorAnterior });
  const p = { ...propuesta, ...extraPropuesta };
  const d = destino === undefined ? destinoFixture(costoDestino ?? valorAnterior) : destino;
  const store = crearStore({ propuestas: [p], eventos: [aprobacion], destinos: d ? [d] : [] });
  return { store, propuesta: p, aprobacion };
}

function entradaDe(p, extra = {}) {
  return { propuesta_id: p.propuesta_id, payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: p.version_coordinacion, ...extra };
}

function foto(store) {
  return plano({
    propuestas: [...store.propuestas.values()],
    destinos: [...store.destinos.values()],
    eventos: store.eventos,
    intentos: store.intentos,
    historial: store.historial,
    inicios: store.inicios
  });
}

// ------------------------------------------------------------------
// Matcher y updates con semántica Mongo (subconjunto)
// ------------------------------------------------------------------

const esOperadores = (v) =>
  v !== null && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith('$'));

function igualBson(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}

function cumpleCondicion(doc, campo, cond) {
  const presente = Object.hasOwn(doc, campo) && doc[campo] !== undefined;
  if (esOperadores(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$exists') {
        if (presente !== Boolean(arg)) return false;
      } else if (op === '$type') {
        if (arg !== 'null') throw new Error(`fake: $type ${arg} no soportado`);
        if (!(presente && doc[campo] === null)) return false;
      } else if (op === '$elemMatch') {
        if (!Array.isArray(doc[campo]) || !doc[campo].some((el) => el !== null && typeof el === 'object' && cumpleFiltro(el, arg))) return false;
      } else {
        throw new Error(`fake: operador ${op} no soportado`);
      }
    }
    return true;
  }
  if (cond === null) return !presente || doc[campo] === null; // semántica de Mongo
  if (!presente) return false;
  return igualBson(doc[campo], cond);
}

function cumpleFiltro(doc, filtro) {
  return Object.entries(filtro).every(([campo, cond]) => cumpleCondicion(doc, campo, cond));
}

function aplicarUpdatePropuesta(doc, update) {
  for (const op of Object.keys(update)) if (op !== '$set' && op !== '$inc') throw new Error(`fake: operador de update ${op}`);
  Object.assign(doc, clonar(update.$set ?? {}));
  for (const [campo, delta] of Object.entries(update.$inc ?? {})) doc[campo] = (doc[campo] ?? 0) + delta;
  return doc;
}

// Solo $set con 'requisitos.$.<campo>' (posicional del $elemMatch) y campos de primer nivel.
function aplicarUpdateDestino(doc, filtro, update) {
  for (const op of Object.keys(update)) if (op !== '$set') throw new Error(`fake: operador de update de destino ${op}`);
  for (const [ruta, valor] of Object.entries(update.$set)) {
    const m = ruta.match(/^requisitos\.\$\.([a-z_]+)$/);
    if (m) {
      const em = filtro.requisitos?.$elemMatch;
      if (!em) throw new Error('fake: $ posicional sin $elemMatch en el filtro');
      const i = doc.requisitos.findIndex((el) => cumpleFiltro(el, em));
      if (i < 0) throw new Error('fake: $ posicional sin elemento');
      doc.requisitos[i][m[1]] = clonar(valor);
    } else if (!ruta.includes('.')) {
      doc[ruta] = clonar(valor);
    } else {
      throw new Error(`fake: ruta de $set no soportada ${ruta}`);
    }
  }
  return doc;
}

// ------------------------------------------------------------------
// Índices únicos y errores
// ------------------------------------------------------------------

function errorE11000(coleccion, indice, keyPattern) {
  const err = new Error(`E11000 duplicate key error collection: buscador_requisitos.${coleccion} index: ${indice} dup key`);
  err.code = 11000;
  err.keyPattern = keyPattern;
  return err;
}

const UNICOS = {
  eventos_propuesta: [
    ['evento_id_1', { evento_id: 1 }, (a, b) => a.evento_id === b.evento_id],
    [
      'uniq_evento_por_propuesta_version',
      { propuesta_id: 1, version_coordinacion_nueva: 1 },
      (a, b) => a.propuesta_id === b.propuesta_id && a.version_coordinacion_nueva === b.version_coordinacion_nueva
    ]
  ],
  intentos_aplicacion: [
    ['intento_id_1', { intento_id: 1 }, (a, b) => a.intento_id === b.intento_id],
    ['uniq_intento_exitoso_por_propuesta', { propuesta_id: 1 }, (a, b) => a.resultado === 'exito' && b.resultado === 'exito' && a.propuesta_id === b.propuesta_id]
  ],
  historial_cambios: [
    ['historial_id_1', { historial_id: 1 }, (a, b) => a.historial_id === b.historial_id],
    ['propuesta_id_1', { propuesta_id: 1 }, (a, b) => a.propuesta_id === b.propuesta_id],
    ['intento_aplicacion_id_1', { intento_aplicacion_id: 1 }, (a, b) => a.intento_aplicacion_id === b.intento_aplicacion_id]
  ],
  inicios_intento_aplicacion: [['intento_id_1', { intento_id: 1 }, (a, b) => a.intento_id === b.intento_id]]
};

function verificarUnicos(coleccion, existentes, doc) {
  for (const [nombre, clave, choca] of UNICOS[coleccion]) {
    if (existentes.some((e) => choca(e, doc))) throw errorE11000(coleccion, nombre, clave);
  }
}

function errorTransitorio() {
  const err = new Error('WriteConflict (simulado)');
  err.code = 112;
  err.errorLabels = ['TransientTransactionError'];
  return err;
}

const listadoIndices = (coleccion, excluir = []) => [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  ...INDICES_APLICACION.filter((s) => s.coleccion === coleccion && !excluir.includes(s.nombre)).map((s) => ({
    v: 2,
    key: s.clave,
    name: s.nombre,
    unique: true,
    ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {})
  }))
];
const COLECCIONES_APLICACION = coleccionesDe(INDICES_APLICACION);
const listadosOk = () => Object.fromEntries(COLECCIONES_APLICACION.map((c) => [c, listadoIndices(c)]));

// ------------------------------------------------------------------
// Entorno (deps falsas)
// ------------------------------------------------------------------

const MODELOS = {
  eventos_propuesta: EventoPropuesta,
  intentos_aplicacion: IntentoAplicacion,
  historial_cambios: HistorialCambio,
  inicios_intento_aplicacion: InicioIntentoAplicacion
};

// Valida con el modelo real y devuelve lo que Mongoose persistiría.
async function comoPersistido(coleccion, doc) {
  const d = new MODELOS[coleccion](clonar(doc));
  await d.validate();
  return clonar(d.toObject({ virtuals: false }));
}

function crearAdaptador(entorno, respuesta) {
  return Object.freeze({
    nombre: ADAPTADOR.nombre,
    version: ADAPTADOR.version,
    soporta: () => true,
    validarIdentidad: (req) =>
      req.tipo === 'formulario_digital' && req.nombre === 'ETA'
        ? { ok: true }
        : {
            ok: false,
            categoria: 'identidad_semantica_no_coincide',
            detalle: { esperado: { tipo: 'formulario_digital', nombre: 'ETA' }, encontrado: { tipo: req.tipo ?? null, nombre: req.nombre ?? null } }
          },
    revalidar: async (propuesta, opciones) => {
      entorno.llamadas.revalidar++;
      entorno.orden.push('revalidar');
      // Nunca con una transacción abierta de este intento.
      if (entorno.txAbiertas !== 0) {
        entorno.llamadas.revalidarConTxAbierta++;
        throw new Error('revalidar() llamado con una transacción abierta');
      }
      assert.strictEqual(typeof opciones.ahora, 'function');
      if (entorno.barreraRevalidar) await entorno.barreraRevalidar();
      return clonar(typeof respuesta === 'function' ? respuesta() : respuesta);
    }
  });
}

function crearEntorno(store, opciones = {}) {
  const {
    usuarios = [USUARIO],
    listados = listadosOk(),
    prefijo = PREFIJO,
    reloj = null,
    respuesta = RESP_VALOR,
    sinAdaptador = false,
    fallas = {}
  } = opciones;
  const operadoresJson = 'operadoresJson' in opciones ? opciones.operadoresJson : OPERADORES_JSON;
  const llamadas = {
    uuid: 0,
    ahora: 0,
    operadores: 0,
    usuarios: 0,
    verificarIndices: 0,
    leerPropuesta: 0,
    leerEvento: 0,
    elegirAdaptador: 0,
    revalidar: 0,
    revalidarConTxAbierta: 0,
    insertarInicio: 0,
    insertarIntentoIndependiente: 0,
    transacciones: 0,
    callbacks: 0,
    validaciones: 0
  };
  const entorno = { llamadas, orden: [], txAbiertas: 0, capturas: { escriturasTx: [], filtrosDestino: [], updatesDestino: [], casPropuesta: [] } };
  entorno.barreraRevalidar = opciones.barreraRevalidar ?? null;
  const adaptador = opciones.adaptador ?? crearAdaptador(entorno, respuesta);
  let numTx = 0;

  const fueraDeTx = (op) => {
    if (entorno.txAbiertas !== 0) throw new Error(`${op} llamado con una transacción abierta`);
  };
  const enTx = (op, tx) => {
    if (!tx || !tx.id) throw new Error(`${op} sin sesión de transacción`);
  };
  const aplicarCommit = (tx) => {
    for (const [id, doc] of tx.propuestas) store.propuestas.set(id, doc);
    for (const [id, doc] of tx.destinos) store.destinos.set(id, doc);
    store.eventos.push(...tx.eventos);
    store.intentos.push(...tx.intentos);
    store.historial.push(...tx.historial);
  };
  const liberar = (tx) => {
    for (const [id, duenio] of store.bloqueos) if (duenio === tx.id) store.bloqueos.delete(id);
    if (store.bloqueos.size === 0) store.esperas.splice(0).forEach((r) => r());
  };
  const esperarLiberacion = () => (store.bloqueos.size === 0 ? Promise.resolve() : new Promise((r) => store.esperas.push(r)));
  const bloquear = (clave, tx) => {
    const duenio = store.bloqueos.get(clave);
    if (duenio && duenio !== tx.id) {
      if (fallas.alConflicto) fallas.alConflicto();
      throw errorTransitorio();
    }
    store.bloqueos.set(clave, tx.id);
  };
  const vaciarPendientes = () => {
    for (const tx of store.pendientes.splice(0)) aplicarCommit(tx);
  };
  const fallaRelectura = () => {
    if (fallas.relectura) throw fallas.relectura;
  };
  const buscarDestino = (filtro, tx) => {
    const candidatos = new Map(store.destinos);
    if (tx) for (const [id, d] of tx.destinos) candidatos.set(id, d);
    const encontrados = [...candidatos.values()].filter((d) => cumpleFiltro(d, filtro));
    return encontrados[0] ?? null;
  };
  const insertarEnTx = async (coleccion, lista, doc, tx, hook) => {
    enTx(coleccion, tx);
    entorno.capturas.escriturasTx.push(`insertar:${coleccion}`);
    const persistido = await comoPersistido(coleccion, doc);
    const falla = hook && hook(store, tx, doc);
    if (falla) throw falla;
    verificarUnicos(coleccion, [...store[lista], ...tx[lista]], doc);
    tx[lista].push(persistido);
  };

  const deps = {
    uuid: () => {
      llamadas.uuid++;
      entorno.orden.push('uuid');
      return idGen(llamadas.uuid, prefijo);
    },
    ahora: () => {
      llamadas.ahora++;
      entorno.orden.push('ahora');
      if (reloj && reloj[llamadas.ahora - 1]) return new Date(reloj[llamadas.ahora - 1].getTime());
      if (llamadas.ahora === 1) return new Date(T0.getTime());
      return new Date(T.getTime() + (llamadas.ahora - 2) * 1000);
    },
    contextoProceso: () => ({ ...CONTEXTO_PROCESO }),
    operadoresAutorizados: () => {
      llamadas.operadores++;
      entorno.orden.push('operadores');
      return cargarOperadoresAutorizados(operadoresJson);
    },
    usuariosAutenticados: async () => {
      llamadas.usuarios++;
      entorno.orden.push('usuarios');
      return usuarios;
    },
    verificarIndices: async () => {
      llamadas.verificarIndices++;
      entorno.orden.push('verificarIndices');
      S.verificarListadoIndices(listados);
    },
    elegirAdaptador: () => {
      llamadas.elegirAdaptador++;
      entorno.orden.push('elegirAdaptador');
      if (sinAdaptador) throw new ErrorSinAdaptador('Ningún adaptador (simulado).');
      return adaptador;
    },
    leerPropuesta: async (id) => {
      llamadas.leerPropuesta++;
      entorno.orden.push('leerPropuesta');
      if (llamadas.leerPropuesta > 1) fallaRelectura();
      return clonar(store.propuestas.get(id)) ?? null;
    },
    leerEvento: async (id) => {
      llamadas.leerEvento++;
      entorno.orden.push('leerEvento');
      return clonar(store.eventos.find((e) => e.evento_id === id)) ?? null;
    },
    leerIntento: async (id) => {
      fallaRelectura();
      return clonar(store.intentos.find((i) => i.intento_id === id)) ?? null;
    },
    leerHistorial: async (id) => {
      fallaRelectura();
      return clonar(store.historial.find((h) => h.historial_id === id)) ?? null;
    },
    leerDestino: async (filtro, tx) => {
      entorno.orden.push(tx ? 'leerDestino:tx' : 'leerDestino');
      entorno.capturas.filtrosDestino.push(filtro);
      if (tx) {
        enTx('leerDestino', tx);
        entorno.capturas.escriturasTx.push('leer:destinos');
      } else {
        fallaRelectura();
      }
      return clonar(buscarDestino(filtro, tx));
    },
    validarInicio: async (doc) => {
      llamadas.validaciones++;
      await new InicioIntentoAplicacion(doc).validate();
    },
    validarIntento: async (doc) => {
      llamadas.validaciones++;
      await new IntentoAplicacion(doc).validate();
    },
    validarHistorial: async (doc) => {
      llamadas.validaciones++;
      await new HistorialCambio(doc).validate();
    },
    validarEvento: async (doc) => {
      llamadas.validaciones++;
      await new EventoPropuesta(doc).validate();
    },
    insertarInicio: async (doc) => {
      fueraDeTx('insertarInicio');
      llamadas.insertarInicio++;
      entorno.orden.push('insertarInicio');
      const persistido = await comoPersistido('inicios_intento_aplicacion', doc);
      verificarUnicos('inicios_intento_aplicacion', store.inicios, doc);
      store.inicios.push(persistido);
    },
    insertarIntentoIndependiente: async (doc) => {
      fueraDeTx('insertarIntentoIndependiente');
      llamadas.insertarIntentoIndependiente++;
      entorno.orden.push('insertarIntentoIndependiente');
      vaciarPendientes(); // un commit "diferido" se vuelve visible acá
      const fallaInsert = fallas.insertarIntentoIndependiente && fallas.insertarIntentoIndependiente(doc);
      if (fallaInsert) throw fallaInsert;
      const persistido = await comoPersistido('intentos_aplicacion', doc);
      verificarUnicos('intentos_aplicacion', store.intentos, doc);
      store.intentos.push(persistido);
    },
    ejecutarTransaccion: async (fn) => {
      llamadas.transacciones++;
      numTx++;
      const esta = numTx;
      entorno.orden.push(`transaccion:${esta}`);
      const commit = fallas.commit && (fallas.commit.tx ?? 1) === esta ? fallas.commit.modo : null;
      for (let intento = 1; ; intento++) {
        const tx = { id: Symbol('tx'), propuestas: new Map(), destinos: new Map(), eventos: [], intentos: [], historial: [] };
        llamadas.callbacks++;
        // Abierta desde el inicio del callback hasta el commit/abort.
        entorno.txAbiertas++;
        let reintentar = false;
        try {
          if (fallas.antesDelCallback && intento === 1) fallas.antesDelCallback(store, esta);
          await fn(tx);
          if (fallas.transitorioAlCommit && intento === 1 && (fallas.transitorioAlCommit.tx ?? 1) === esta) throw errorTransitorio();
          if (commit === 'sin_aplicar') throw new Error('commit fallido (simulado, sin aplicar)');
          if (commit === 'lanzar') throw fallas.commit.error;
          if (commit === 'diferido') {
            store.pendientes.push(tx);
            throw new Error('UnknownTransactionCommitResult (simulado, se aplica más tarde)');
          }
          aplicarCommit(tx);
          liberar(tx);
          if (fallas.trasCommit) fallas.trasCommit(store, esta);
          if (commit === 'aplicado_con_error') throw new Error('UnknownTransactionCommitResult (simulado, sí se aplicó)');
          return;
        } catch (err) {
          liberar(tx);
          if (!(err.errorLabels?.includes('TransientTransactionError') && intento < MAX_REINTENTOS_DRIVER)) throw err;
          reintentar = true;
        } finally {
          entorno.txAbiertas--;
        }
        if (reintentar) await esperarLiberacion();
      }
    },
    actualizarPropuestaCas: async (filtro, update, tx) => {
      enTx('actualizarPropuestaCas', tx);
      entorno.capturas.escriturasTx.push('cas:propuestas_cambio');
      entorno.capturas.casPropuesta.push({ filtro, update });
      const id = filtro.propuesta_id;
      const actual = tx.propuestas.get(id) ?? store.propuestas.get(id);
      if (!actual || !cumpleFiltro(actual, filtro)) return { matchedCount: 0, modifiedCount: 0 };
      bloquear(`p:${id}`, tx);
      if (fallas.casModifiedCero) return { matchedCount: 1, modifiedCount: 0 };
      const nuevo = aplicarUpdatePropuesta(clonar(actual), update);
      await new PropuestaCambio(clonar(nuevo)).validate();
      tx.propuestas.set(id, nuevo);
      if (fallas.pausaTrasCas) await fallas.pausaTrasCas;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    actualizarDestino: async (filtro, update, tx) => {
      enTx('actualizarDestino', tx);
      entorno.capturas.escriturasTx.push('actualizar:destinos');
      entorno.capturas.updatesDestino.push({ filtro, update });
      if (fallas.destinoSinCoincidencia) return { matchedCount: 0, modifiedCount: 0 };
      const actual = buscarDestino(filtro, tx);
      if (!actual) return { matchedCount: 0, modifiedCount: 0 };
      const hex = actual._id.toHexString();
      bloquear(`d:${hex}`, tx);
      const nuevo = aplicarUpdateDestino(clonar(actual), filtro, update);
      await new Destino(clonar(nuevo)).validate();
      tx.destinos.set(hex, nuevo);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    insertarHistorial: (doc, tx) => insertarEnTx('historial_cambios', 'historial', doc, tx, fallas.insertarHistorial),
    insertarIntento: (doc, tx) => insertarEnTx('intentos_aplicacion', 'intentos', doc, tx, fallas.insertarIntento),
    insertarEvento: (doc, tx) => insertarEnTx('eventos_propuesta', 'eventos', doc, tx, fallas.insertarEvento)
  };
  return { deps, llamadas, entorno, adaptador };
}

// ------------------------------------------------------------------
// Esperados escritos a mano (no vía los constructores del servicio)
// ------------------------------------------------------------------

function revalidacionEsperada(coincide, resp = RESP_VALOR) {
  return {
    revalidacion_id: REVALIDACION,
    revalidada_en: resp.revalidada_en,
    fuente_nombre: 'GOV.UK',
    url: URL_FUENTE,
    valor_revalidado: { valor: resp.valor.valor, valor_normalizado: resp.valor.valor_normalizado },
    coincide_con_propuesta: coincide
  };
}

function intentoEsperado(p, campos) {
  return {
    intento_id: INTENTO,
    propuesta_id: PROPUESTA_ID,
    operador: OPERADOR,
    proceso_aplicador: PROCESO,
    adaptador: ADAPTADOR,
    hash_contenido_referenciado: p.payload_hash,
    version_coordinacion_esperada: 1,
    decision_aprobacion_id: APROBACION_ID,
    iniciado_en: T0,
    ...campos
  };
}

function eventoEsperado(p, tipo, estadoNuevo, resultado, motivo) {
  const e = {
    evento_id: EVENTO,
    propuesta_id: PROPUESTA_ID,
    tipo_evento: tipo,
    estado_anterior: 'aprobada',
    estado_nuevo: estadoNuevo,
    hash_contenido_referenciado: p.payload_hash,
    version_coordinacion_nueva: 2,
    ocurrido_en: T,
    actor: { tipo: 'sistema', identificador: 'aplicar-propuesta' },
    detalle: { resultado, operador: OPERADOR, identidad_operador: IDENTIDAD_OPERADOR, proceso_aplicador: PROCESO, adaptador: ADAPTADOR },
    intento_aplicacion_id: INTENTO
  };
  if (motivo !== undefined) e.motivo = motivo;
  return e;
}

const inicioEsperado = (p) => ({
  intento_id: INTENTO,
  propuesta_id: PROPUESTA_ID,
  hash_contenido_referenciado: p.payload_hash,
  version_coordinacion_esperada: 1,
  operador: OPERADOR,
  proceso_aplicador: PROCESO,
  adaptador: ADAPTADOR,
  iniciado_en: T0,
  proceso: CONTEXTO_PROCESO
});

const ventanaEsperada = (revalidadaEn = REVALIDADA_EN, t = T) => ({
  revalidada_en: revalidadaEn,
  t,
  edad_ms: t.getTime() - revalidadaEn.getTime(),
  ventana_ms: VENTANA_REVALIDACION_MS
});

function resultadoEsperado(campos) {
  return {
    propuesta_id: PROPUESTA_ID,
    intento_id: INTENTO,
    etapa_fallo: null,
    resultado_no_registrado: null,
    estado_propuesta_nuevo: null,
    evento_id: null,
    historial_id: null,
    mensaje: null,
    confirmado_por_relectura: false,
    causa_relectura: null,
    ...campos
  };
}

// Invariantes que valen después de cualquier corrida.
function verificarInvariantes(store, etiqueta) {
  const unicos = (lista, clave, nombre) => {
    const ids = lista.map((d) => d[clave]);
    assert.strictEqual(new Set(ids).size, ids.length, `[${etiqueta}] ${nombre} repetido`);
  };
  unicos(store.eventos, 'evento_id', 'evento_id');
  unicos(store.intentos, 'intento_id', 'intento_id');
  unicos(store.inicios, 'intento_id', 'inicio.intento_id');
  unicos(store.historial, 'propuesta_id', 'historial.propuesta_id');
  // Todo intento terminado tiene su inicio.
  for (const i of store.intentos) {
    assert.ok(store.inicios.some((x) => x.intento_id === i.intento_id), `[${etiqueta}] intento ${i.intento_id} sin inicio`);
  }
  for (const p of store.propuestas.values()) {
    const evs = store.eventos
      .filter((e) => e.propuesta_id === p.propuesta_id)
      .sort((a, b) => a.version_coordinacion_nueva - b.version_coordinacion_nueva);
    assert.strictEqual(evs.length, p.version_coordinacion, `[${etiqueta}] #eventos === version_coordinacion`);
    evs.forEach((e, i) => {
      assert.strictEqual(e.version_coordinacion_nueva, i + 1, `[${etiqueta}] versiones sin huecos`);
      assert.strictEqual(e.estado_anterior, i === 0 ? 'pendiente_aprobacion' : evs[i - 1].estado_nuevo, `[${etiqueta}] cadena de estados`);
    });
    assert.strictEqual(p.ultimo_evento_id ?? null, evs.at(-1)?.evento_id ?? null, `[${etiqueta}] ultimo_evento_id`);
    assert.strictEqual(p.estado, evs.at(-1)?.estado_nuevo ?? 'pendiente_aprobacion', `[${etiqueta}] estado cacheado`);
    // Aplicada ⇔ un historial ⇔ un intento exito.
    const historiales = store.historial.filter((h) => h.propuesta_id === p.propuesta_id);
    const exitos = store.intentos.filter((i) => i.propuesta_id === p.propuesta_id && i.resultado === 'exito');
    assert.strictEqual(historiales.length, p.estado === 'aplicada' ? 1 : 0, `[${etiqueta}] historial ⇔ aplicada`);
    assert.strictEqual(exitos.length, historiales.length, `[${etiqueta}] intento exito ⇔ historial`);
    if (historiales.length === 1) {
      assert.strictEqual(historiales[0].intento_aplicacion_id, exitos[0].intento_id, `[${etiqueta}] historial → intento`);
      assert.strictEqual(exitos[0].historial_id, historiales[0].historial_id, `[${etiqueta}] intento → historial`);
    }
  }
}

function inicioUnico(store, intentoId, { terminados = 1 } = {}) {
  assert.strictEqual(store.inicios.filter((i) => i.intento_id === intentoId).length, 1, `un solo inicio para ${intentoId}`);
  assert.strictEqual(store.intentos.filter((i) => i.intento_id === intentoId).length, terminados, `intentos terminados para ${intentoId}`);
}

const soloIntento = (store) => {
  assert.strictEqual(store.intentos.length, 1);
  return limpio(store.intentos[0]);
};

// El destino solo cambió en requisitos[ETA].costo y updatedAt.
function diffDestino(antes, despues) {
  const cambios = [];
  const recorrerDiff = (a, b, ruta) => {
    const pa = JSON.stringify(plano(a));
    const pb = JSON.stringify(plano(b));
    if (pa === pb) return;
    const objetos = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !(a instanceof Date) && !(a instanceof ObjectId);
    if (!objetos) {
      cambios.push(ruta.join('.'));
      return;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) recorrerDiff(a[k], b[k], [...ruta, k]);
  };
  recorrerDiff(antes, despues, []);
  return cambios;
}

const CASOS_PRECONDICION = [
  ['ausente', AUSENTE],
  ['null explícito', NULO],
  ['valor "£16"', VALOR16]
];
const ESTADOS_DESTINO = [
  ['ausente', AUSENTE],
  ['null', NULO],
  ['"£16"', VALOR16],
  ['"£10"', VALOR10]
];

// ==================================================================

(async () => {
  // ============================================================
  // 1) IDs nativos: string hex de 24 → BSON ObjectId, en una sola función
  // ============================================================
  {
    assert.strictEqual(ObjectId, mongoose.mongo.ObjectId, 'bson.ObjectId es la clase que usa el driver de Mongoose');
    const oid = S.aObjectId(REQ_HEX, 'x');
    assert.ok(oid instanceof ObjectId && oid instanceof mongoose.mongo.ObjectId);
    assert.strictEqual(oid._bsontype, 'ObjectId');
    assert.strictEqual(oid.toHexString(), REQ_HEX);

    for (const [nombre, valor] of [
      ['mayúsculas', REQ_HEX.toUpperCase()],
      ['23 hex', REQ_HEX.slice(1)],
      ['25 hex', `${REQ_HEX}0`],
      ['12 bytes (ObjectId lo aceptaría)', 'abcdefghijkl'],
      ['no hex', 'zz00000000000000000000b2'],
      ['número', 12],
      ['null', null],
      ['undefined', undefined],
      ['ObjectId ya construido', ObjectId.createFromHexString(REQ_HEX)]
    ]) {
      assert.throws(() => S.aObjectId(valor, 'campo'), ErrorInconsistencia, `aObjectId rechaza ${nombre}`);
    }
    assert.throws(() => S.aObjectId('0000000000000000000000B2', 'campo'), ErrorInconsistencia, 'rechaza hex en mayúsculas');

    const { propuesta } = propuestaAprobada();
    const ids = S.convertirIdsDestino(propuesta);
    assert.ok(ids.destino_id instanceof ObjectId && ids.requisito_id instanceof ObjectId);
    assert.strictEqual(ids.destino_id.toHexString(), DESTINO_HEX);
    assert.strictEqual(ids.requisito_id.toHexString(), REQ_HEX);
    assert.deepStrictEqual([ids.destino_hex, ids.requisito_hex], [DESTINO_HEX, REQ_HEX]);
    // Campos externos como los devuelve .lean() (ObjectId) → mismo resultado.
    const lean = { ...propuesta, destino_id: ObjectId.createFromHexString(DESTINO_HEX), requisito_id: ObjectId.createFromHexString(REQ_HEX) };
    assert.deepStrictEqual(plano(S.convertirIdsDestino(lean)), plano(ids));
    assert.throws(() => S.convertirIdsDestino({ ...propuesta, requisito_id: OTRO_REQ_HEX }), ErrorInconsistencia, 'externo ≠ payload');
    assert.throws(
      () => S.convertirIdsDestino({ ...propuesta, destino_id: 'X', payload: { ...propuesta.payload, destino_id: 'X' } }),
      ErrorInconsistencia,
      'payload.destino_id inválido'
    );

    // Filtros: ObjectId reales, ningún id como string, nunca {costo: null}.
    const filtrosLectura = S.filtroLecturaDestino(ids);
    assert.ok(filtrosLectura._id instanceof ObjectId);
    const esperadosCondicion = [{ costo: { $exists: false } }, { costo: { $type: 'null' } }, { costo: '£16' }];
    CASOS_PRECONDICION.forEach(([nombre, va], i) => {
      const f = S.filtroDestino(ids, 'costo', va);
      assert.ok(f._id instanceof ObjectId, `[${nombre}] _id es ObjectId`);
      assert.ok(f.requisitos.$elemMatch._id instanceof ObjectId, `[${nombre}] requisitos.$elemMatch._id es ObjectId`);
      assert.strictEqual(typeof f._id, 'object');
      assert.deepStrictEqual(Object.keys(f).sort(), ['_id', 'requisitos']);
      assert.deepStrictEqual(Object.keys(f.requisitos), ['$elemMatch']);
      const { _id, ...condicion } = f.requisitos.$elemMatch;
      assert.deepStrictEqual(condicion, esperadosCondicion[i], `[${nombre}] condición exacta`);
      recorrer(f, (v, ruta) => {
        assert.ok(!(typeof v === 'string' && (v === DESTINO_HEX || v === REQ_HEX)), `[${nombre}] id como string en ${ruta.join('.')}`);
        if (ruta.at(-1) === 'costo') assert.notStrictEqual(v, null, `[${nombre}] nunca {costo: null}`);
      });
    });

    assert.throws(() => S.condicionValor('costo', { presente: false, valor: '£1' }), TypeError);
    assert.throws(() => S.condicionValor('costo', { presente: true, valor: 16 }), TypeError);
    assert.throws(() => S.condicionValor('costo', { presente: true }), TypeError);
    assert.throws(() => S.condicionValor('nombre', VALOR16), TypeError);
    assert.deepStrictEqual(S.updateDestino('costo', '£20', T), { $set: { 'requisitos.$.costo': '£20', updatedAt: T } });
    assert.throws(() => S.updateDestino('costo', '', T), TypeError);
    assert.throws(() => S.updateDestino('costo', 20, T), TypeError);
    assert.throws(() => S.updateDestino('nombre', '£20', T), TypeError);
    console.log('1) aObjectId/convertirIdsDestino: solo hex de 24; filtros con ObjectId reales, sin ids string ni {costo: null}: OK');
  }

  // ============================================================
  // 2) Semántica del $elemMatch contra el matcher con reglas de Mongo
  // ============================================================
  {
    const ids = S.convertirIdsDestino(propuestaAprobada().propuesta);
    const tabla = [];
    for (const [nombreEsperado, va] of CASOS_PRECONDICION) {
      for (const [nombreActual, actual] of ESTADOS_DESTINO) {
        const matchea = cumpleFiltro(destinoFixture(actual), S.filtroDestino(ids, 'costo', va));
        tabla.push(`${nombreEsperado}×${nombreActual}=${matchea ? 1 : 0}`);
        const debe = actual.presente === va.presente && actual.valor === va.valor;
        assert.strictEqual(matchea, debe, `esperado ${nombreEsperado} vs actual ${nombreActual}`);
      }
    }
    // Control: la forma prohibida {costo: null} matchearía ausente Y null.
    const prohibido = { _id: ids.destino_id, requisitos: { $elemMatch: { _id: ids.requisito_id, costo: null } } };
    assert.strictEqual(cumpleFiltro(destinoFixture(AUSENTE), prohibido), true);
    assert.strictEqual(cumpleFiltro(destinoFixture(NULO), prohibido), true);
    // Control: los mismos filtros con ids string no encuentran nada.
    const conStrings = { _id: DESTINO_HEX, requisitos: { $elemMatch: { _id: REQ_HEX, costo: '£16' } } };
    assert.strictEqual(cumpleFiltro(destinoFixture(VALOR16), conStrings), false);
    assert.strictEqual(cumpleFiltro(destinoFixture(VALOR16), { _id: DESTINO_HEX }), false);
    assert.strictEqual(cumpleFiltro(destinoFixture(VALOR16), S.filtroLecturaDestino(ids)), true);
    // El $ posicional toca exactamente el elemento del $elemMatch.
    const d = destinoFixture(VALOR16);
    const nuevo = aplicarUpdateDestino(clonar(d), S.filtroDestino(ids, 'costo', VALOR16), S.updateDestino('costo', '£20', T));
    assert.deepStrictEqual(diffDestino(d, nuevo).sort(), ['requisitos.1.costo', 'updatedAt']);
    await new Destino(nuevo).validate();
    console.log(`2) $elemMatch: 3 tipos × 4 estados (${tabla.filter((x) => x.endsWith('=1')).length} coincidencias exactas, solo la diagonal); {costo:null} y ids string demostrados incorrectos: OK`);
  }

  // ============================================================
  // 3) clasificarIdentidadRequisito (pura)
  // ============================================================
  {
    const adaptador = crearAdaptador({ llamadas: {}, orden: [], txAbiertas: 0 }, RESP_VALOR);
    const v = adaptador.validarIdentidad;
    const ok = clasificarIdentidadRequisito(destinoFixture(), REQ_HEX, v);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.requisito._id.toHexString(), REQ_HEX);
    // _id guardado como string también se reconoce (comparación por String()).
    const conString = destinoFixture(VALOR16, { requisitos: [{ ...requisitoEta(), _id: REQ_HEX }] });
    assert.strictEqual(clasificarIdentidadRequisito(conString, REQ_HEX, v).ok, true);

    const casos = [
      ['destino_no_encontrado', null, { requisito_id: REQ_HEX }],
      [
        'requisito_id_no_encontrado',
        destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { _id: ObjectId.createFromHexString(OTRO_REQ_HEX) })] }),
        { destino_id: DESTINO_HEX, requisito_id: REQ_HEX, cantidad: 0 }
      ],
      [
        'requisito_id_duplicado',
        destinoFixture(VALOR16, { requisitos: [requisitoEta(), requisitoEta()] }),
        { destino_id: DESTINO_HEX, requisito_id: REQ_HEX, cantidad: 2 }
      ],
      [
        'identidad_semantica_no_coincide',
        destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { nombre: 'Otro' })] }),
        {
          destino_id: DESTINO_HEX,
          requisito_id: REQ_HEX,
          adaptador: { esperado: { tipo: 'formulario_digital', nombre: 'ETA' }, encontrado: { tipo: 'formulario_digital', nombre: 'Otro' } }
        }
      ]
    ];
    for (const [categoria, destino, detalle] of casos) {
      const antes = plano(destino);
      const r = clasificarIdentidadRequisito(destino, REQ_HEX, v);
      assert.deepStrictEqual(r, { ok: false, categoria, detalle }, categoria);
      canonicalizarValor(r.detalle);
      assert.deepStrictEqual(plano(destino), antes, `[${categoria}] no modifica el destino`);
    }
    assert.throws(() => clasificarIdentidadRequisito(destinoFixture(), REQ_HEX, () => ({ ok: 'si' })), TypeError);
    assert.throws(() => clasificarIdentidadRequisito(destinoFixture(), REQ_HEX, () => ({ ok: false, categoria: 'requisito_id_duplicado' })), TypeError);
    assert.throws(() => clasificarIdentidadRequisito(destinoFixture(), ObjectId.createFromHexString(REQ_HEX), v), TypeError);
    assert.throws(() => clasificarIdentidadRequisito(destinoFixture(), REQ_HEX, null), TypeError);
    console.log('3) identidad: 4 categorías con detalle canonicalizable, sin mutar el destino; contrato del adaptador exigido: OK');
  }

  // ============================================================
  // 4) Funciones puras de etapa 0/1, ventana e índices
  // ============================================================
  {
    const { propuesta, aprobacion } = propuestaAprobada();
    const e = entradaDe(propuesta);
    assert.deepStrictEqual(S.verificarPrecondicionesPropuesta(e, propuesta, aprobacion), []);

    // Ventana: bordes exactos.
    const t = T;
    const casos = [
      [VENTANA_REVALIDACION_MS, true],
      [VENTANA_REVALIDACION_MS + 1, false],
      [0, true],
      [-1, false],
      [1, true]
    ];
    for (const [edad, vigente] of casos) {
      const r = S.revalidacionVigente(new Date(t.getTime() - edad), t);
      assert.deepStrictEqual(r, { vigente, edad_ms: edad, ventana_ms: VENTANA_REVALIDACION_MS }, `edad ${edad}`);
    }
    assert.strictEqual(VENTANA_REVALIDACION_MS, 15 * 60 * 1000);

    // Clasificación de la revalidación.
    assert.deepStrictEqual(S.clasificarRevalidacion(propuesta, RESP_NO_DISPONIBLE, REVALIDACION), {
      resultado: 'fuente_temporalmente_no_disponible',
      motivo: 'timeout',
      revalidacion: null
    });
    assert.deepStrictEqual(S.clasificarRevalidacion(propuesta, RESP_AMBIGUO, REVALIDACION), {
      resultado: 'extraccion_ambigua',
      motivo: 'overview_distinto_de_apply',
      revalidacion: null
    });
    const cont = S.clasificarRevalidacion(propuesta, RESP_VALOR, REVALIDACION);
    assert.strictEqual(cont.resultado, 'continuar');
    assert.deepStrictEqual(cont.revalidacion, revalidacionEsperada(true));
    for (const [nombre, r] of [
      ['importe distinto', respValor('£25', 25)],
      ['mismo importe, texto distinto', respValor('GBP 20', 20)],
      ['moneda distinta', { ...RESP_VALOR, valor: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'EUR' } } }]
    ]) {
      const c = S.clasificarRevalidacion(propuesta, r, REVALIDACION);
      assert.strictEqual(c.resultado, 'fuente_cambio', nombre);
      assert.strictEqual(c.revalidacion.coincide_con_propuesta, false, nombre);
    }
    for (const [nombre, r] of [
      ['null', null],
      ['tipo desconocido', { ...RESP_VALOR, tipo: 'otro' }],
      ['valor sin revalidada_en', { ...RESP_VALOR, revalidada_en: '2026-09-29' }],
      ['ambiguo sin url', { ...RESP_AMBIGUO, url: undefined }],
      ['valor sin valor', { ...RESP_VALOR, valor: null }],
      ['con undefined', { ...RESP_NO_DISPONIBLE, evidencia: { x: undefined } }]
    ]) {
      assert.throws(() => S.clasificarRevalidacion(propuesta, r, REVALIDACION), TypeError, nombre);
    }

    // observarValor / mismoValorConPresencia.
    assert.deepStrictEqual(S.observarValor(requisitoEta(AUSENTE), 'costo'), AUSENTE);
    assert.deepStrictEqual(S.observarValor(requisitoEta(NULO), 'costo'), NULO);
    assert.deepStrictEqual(S.observarValor(requisitoEta(VALOR16), 'costo'), VALOR16);
    assert.strictEqual(S.mismoValorConPresencia(AUSENTE, NULO), false);
    assert.strictEqual(S.mismoValorConPresencia(NULO, NULO), true);

    // indiceDuplicado.
    assert.deepStrictEqual(S.indiceDuplicado(errorE11000('intentos_aplicacion', 'intento_id_1', { intento_id: 1 })), {
      coleccion: 'intentos_aplicacion',
      indice: 'intento_id_1'
    });
    assert.deepStrictEqual(S.indiceDuplicado(errorE11000('historial_cambios', 'propuesta_id_1', { propuesta_id: 1 })), {
      coleccion: 'historial_cambios',
      indice: 'propuesta_id_1'
    });
    assert.strictEqual(S.indiceDuplicado(new Error('otro')), null);

    // Gate de índices: los 10 de INDICES_APLICACION en 5 colecciones.
    assert.deepStrictEqual(COLECCIONES_APLICACION.sort(), [
      'eventos_propuesta',
      'historial_cambios',
      'inicios_intento_aplicacion',
      'intentos_aplicacion',
      'propuestas_cambio'
    ]);
    S.verificarListadoIndices(listadosOk());
    for (const spec of INDICES_APLICACION) {
      const l = listadosOk();
      l[spec.coleccion] = listadoIndices(spec.coleccion, [spec.nombre]);
      assert.throws(() => S.verificarListadoIndices(l), ErrorPrecondicionIndices, `falta ${spec.coleccion}.${spec.nombre}`);
    }
    console.log('4) ventana [0, 15 min] con bordes exactos, tabla de revalidación, observarValor, E11000 y gate de 10 índices: OK');
  }

  // ============================================================
  // 5) Orden: entrada, allowlist, actor y gate antes de todo I/O
  // ============================================================
  {
    const { store, propuesta } = escenario();
    const antes = foto(store);
    const e = entradaDe(propuesta);
    const invalidas = [
      ['no objeto', null],
      ['actor en la entrada', { ...e, actor: OPERADOR }],
      ['propuesta_id no UUID', { ...e, propuesta_id: 'x' }],
      ['hash en mayúsculas', { ...e, payload_hash_esperado: e.payload_hash_esperado.toUpperCase() }],
      ['versión negativa', { ...e, version_coordinacion_esperada: -1 }],
      ['versión no entera', { ...e, version_coordinacion_esperada: 1.5 }],
      ['falta versión', { propuesta_id: e.propuesta_id, payload_hash_esperado: e.payload_hash_esperado }]
    ];
    for (const [nombre, entrada] of invalidas) {
      const { deps, llamadas } = crearEntorno(store);
      await assertRechaza(aplicarPropuesta(entrada, deps), ErrorEntradaInvalida, nombre);
      assert.deepStrictEqual([llamadas.operadores, llamadas.usuarios, llamadas.verificarIndices, llamadas.uuid, llamadas.leerPropuesta], [0, 0, 0, 0, 0], nombre);
    }

    {
      const { deps, llamadas } = crearEntorno(store, { operadoresJson: '[' });
      await assertRechaza(aplicarPropuesta(e, deps), ErrorConfiguracionOperadores, 'allowlist inválida');
      assert.deepStrictEqual([llamadas.usuarios, llamadas.verificarIndices, llamadas.uuid, llamadas.leerPropuesta], [0, 0, 0, 0]);
    }
    {
      const { deps, llamadas } = crearEntorno(store, { usuarios: [{ user: 'intruso', db: 'admin' }] });
      await assertRechaza(aplicarPropuesta(e, deps), ErrorActorNoAutorizado, 'actor no autorizado');
      assert.deepStrictEqual([llamadas.verificarIndices, llamadas.uuid, llamadas.leerPropuesta], [0, 0, 0]);
    }
    for (const coleccion of COLECCIONES_APLICACION) {
      const listados = { ...listadosOk(), [coleccion]: [{ v: 2, key: { _id: 1 }, name: '_id_' }] };
      const { deps, llamadas } = crearEntorno(store, { listados });
      await assertRechaza(aplicarPropuesta(e, deps), ErrorPrecondicionIndices, `gate sin índices de ${coleccion}`);
      assert.deepStrictEqual(
        [llamadas.uuid, llamadas.ahora, llamadas.leerPropuesta, llamadas.insertarInicio, llamadas.revalidar, llamadas.transacciones],
        [0, 0, 0, 0, 0, 0],
        coleccion
      );
    }
    assert.deepStrictEqual(foto(store), antes, 'nada escrito');

    // Orden completo del camino de éxito.
    const { deps, entorno } = crearEntorno(store);
    await aplicarPropuesta(e, deps);
    assert.deepStrictEqual(entorno.orden, [
      'operadores',
      'usuarios',
      'verificarIndices',
      'uuid',
      'uuid',
      'uuid',
      'uuid',
      'ahora',
      'leerPropuesta',
      'elegirAdaptador',
      'leerEvento',
      'insertarInicio',
      'revalidar',
      'ahora',
      'transaccion:1',
      'leerDestino:tx'
    ]);
    console.log('5) entrada, allowlist, actor y gate (5 colecciones) cortan antes de uuid/ahora/lecturas; orden completo verificado: OK');
  }

  // ============================================================
  // 6) Etapa 0 sin persistencia: propuesta inexistente, ids inválidos, sin adaptador, campo
  // ============================================================
  {
    const casos = [
      ['propuesta inexistente', () => crearStore(), ErrorPropuestaNoEncontrada, {}],
      [
        'payload.destino_id no es hex de 24',
        () => {
          const { propuesta, aprobacion } = propuestaAprobada({ destinoHex: 'no-es-un-objectid' });
          return crearStore({ propuestas: [propuesta], eventos: [aprobacion], destinos: [destinoFixture()] });
        },
        ErrorInconsistencia,
        {}
      ],
      ['sin adaptador único', () => escenario().store, ErrorSinAdaptador, { sinAdaptador: true }],
      [
        'campo no aplicable',
        () => {
          const { propuesta, aprobacion } = propuestaAprobada();
          return crearStore({ propuestas: [{ ...propuesta, campo: 'nombre' }], eventos: [aprobacion], destinos: [destinoFixture()] });
        },
        ErrorPropuestaNoSoportada,
        {}
      ]
    ];
    for (const [nombre, fabricar, clase, opciones] of casos) {
      const store = fabricar();
      const antes = foto(store);
      const { deps, llamadas } = crearEntorno(store, opciones);
      await assertRechaza(aplicarPropuesta(entradaDe(propuestaAprobada().propuesta), deps), clase, nombre);
      assert.deepStrictEqual(foto(store), antes, `[${nombre}] nada persistido`);
      assert.deepStrictEqual([llamadas.insertarInicio, llamadas.revalidar, llamadas.transacciones], [0, 0, 0], nombre);
    }
    console.log('6) propuesta inexistente / ids inválidos / sin adaptador / campo no aplicable: se lanza sin persistir nada: OK');
  }

  // ============================================================
  // 7) Etapa 0: las cuatro fallas → inicio + propuesta_no_aplicable, sin HTTP
  // ============================================================
  {
    const hashOtro = (h) => h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
    const casos = [
      {
        nombre: 'estado pendiente_aprobacion',
        preparar: () => {
          const { propuesta } = propuestaAprobada();
          const p = { ...propuesta, estado: 'pendiente_aprobacion', version_coordinacion: 0, decision_aprobacion_id: null, ultimo_evento_id: null };
          return { store: crearStore({ propuestas: [p], destinos: [destinoFixture()] }), p, entrada: entradaDe(p) };
        },
        codigos: ['estado_no_aprobada', 'aprobacion_invalida'],
        decision: null
      },
      {
        nombre: 'versión distinta a la vista',
        preparar: () => {
          const { store, propuesta } = escenario();
          return { store, p: propuesta, entrada: entradaDe(propuesta, { version_coordinacion_esperada: 2 }) };
        },
        codigos: ['version_no_coincide']
      },
      {
        nombre: 'hash distinto al visto',
        preparar: () => {
          const { store, propuesta } = escenario();
          return { store, p: propuesta, entrada: entradaDe(propuesta, { payload_hash_esperado: hashOtro(propuesta.payload_hash) }) };
        },
        codigos: ['hash_no_coincide']
      },
      {
        nombre: 'payload alterado con el hash original',
        preparar: () => {
          const { propuesta, aprobacion } = propuestaAprobada();
          const p = { ...propuesta, payload: { ...propuesta.payload, valor_propuesto: { ...propuesta.payload.valor_propuesto, valor: '£99' } } };
          return { store: crearStore({ propuestas: [p], eventos: [aprobacion], destinos: [destinoFixture()] }), p, entrada: entradaDe(p) };
        },
        codigos: ['hash_no_coincide']
      },
      {
        nombre: 'evento de aprobación inexistente',
        preparar: () => {
          const { propuesta } = propuestaAprobada();
          return { store: crearStore({ propuestas: [propuesta], destinos: [destinoFixture()] }), p: propuesta, entrada: entradaDe(propuesta) };
        },
        codigos: ['aprobacion_invalida']
      },
      {
        nombre: 'aprobación sobre otro hash',
        preparar: () => {
          const { propuesta, aprobacion } = propuestaAprobada();
          const a = { ...aprobacion, hash_contenido_referenciado: hashOtro(propuesta.payload_hash) };
          return { store: crearStore({ propuestas: [propuesta], eventos: [a], destinos: [destinoFixture()] }), p: propuesta, entrada: entradaDe(propuesta) };
        },
        codigos: ['aprobacion_invalida']
      },
      {
        nombre: 'aprobación hecha por un sistema',
        preparar: () => {
          const { propuesta, aprobacion } = propuestaAprobada();
          const a = { ...aprobacion, actor: { tipo: 'sistema', identificador: 'x' } };
          return { store: crearStore({ propuestas: [propuesta], eventos: [a], destinos: [destinoFixture()] }), p: propuesta, entrada: entradaDe(propuesta) };
        },
        codigos: ['aprobacion_invalida']
      }
    ];
    for (const caso of casos) {
      const { store, p, entrada } = caso.preparar();
      const antes = foto(store);
      const { deps, llamadas } = crearEntorno(store);
      const r = await aplicarPropuesta(entrada, deps);
      assert.strictEqual(r.resultado, 'propuesta_no_aplicable', caso.nombre);
      assert.strictEqual(r.etapa_fallo, 'precondiciones_propuesta', caso.nombre);
      assert.deepStrictEqual([llamadas.revalidar, llamadas.transacciones], [0, 0], `[${caso.nombre}] sin HTTP ni transacción`);
      inicioUnico(store, INTENTO);
      const i = soloIntento(store);
      assert.deepStrictEqual(
        i.evidencia_fresca.precondiciones.map((f) => f.codigo),
        caso.codigos,
        caso.nombre
      );
      assert.strictEqual(i.decision_aprobacion_id, caso.decision === undefined ? APROBACION_ID : caso.decision, caso.nombre);
      assert.strictEqual(i.hash_contenido_referenciado, p.payload_hash);
      assert.strictEqual(i.version_coordinacion_esperada, entrada.version_coordinacion_esperada);
      assert.strictEqual(i.finalizado_en, T.toISOString());
      for (const campo of ['revalidacion', 'precondicion', 'valor_observado', 'historial_id']) assert.ok(!(campo in i), `[${caso.nombre}] sin ${campo}`);
      assert.deepStrictEqual(limpio(store.inicios[0]), plano({ ...inicioEsperado(p), version_coordinacion_esperada: entrada.version_coordinacion_esperada }));
      const despues = foto(store);
      assert.deepStrictEqual(
        { ...despues, intentos: [], inicios: [] },
        { ...antes, intentos: [], inicios: [] },
        `[${caso.nombre}] propuesta, destino, eventos e historial intactos`
      );
    }
    console.log(`7) etapa 0: estado, versión, hash (visto y recalculado) y aprobación (${casos.length} casos) → inicio + propuesta_no_aplicable, sin revalidar: OK`);
  }

  // ============================================================
  // 8) Etapa 1: no_disponible, ambiguo, fuente_cambio; respuesta fuera de contrato
  // ============================================================
  {
    // no_disponible: insert independiente, sin transacción ni cambio de estado.
    {
      const { store, propuesta } = escenario();
      const antes = foto(store);
      const { deps, llamadas } = crearEntorno(store, { respuesta: RESP_NO_DISPONIBLE });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      const mensaje = 'La fuente no está disponible (timeout); se puede reintentar.';
      assert.deepStrictEqual(
        r,
        resultadoEsperado({ resultado: 'fuente_temporalmente_no_disponible', etapa_fallo: 'revalidacion_externa', mensaje })
      );
      assert.strictEqual(llamadas.transacciones, 0);
      inicioUnico(store, INTENTO);
      assert.deepStrictEqual(
        soloIntento(store),
        plano(
          intentoEsperado(propuesta, {
            finalizado_en: T,
            resultado: 'fuente_temporalmente_no_disponible',
            etapa_fallo: 'revalidacion_externa',
            error_mensaje: mensaje,
            evidencia_fresca: { revalidacion_externa: RESP_NO_DISPONIBLE }
          })
        )
      );
      assert.deepStrictEqual({ ...foto(store), intentos: [], inicios: [] }, { ...antes, intentos: [], inicios: [] });
    }

    // ambiguo: transacción corta → revision_requerida, sin revalidacion.
    {
      const { store, propuesta } = escenario();
      const destinoAntes = foto(store).destinos;
      const { deps, llamadas, entorno } = crearEntorno(store, { respuesta: RESP_AMBIGUO });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      const motivo = 'La fuente respondió sin un valor inequívoco (overview_distinto_de_apply); requiere revisión humana.';
      assert.deepStrictEqual(
        r,
        resultadoEsperado({
          resultado: 'extraccion_ambigua',
          etapa_fallo: 'revalidacion_externa',
          estado_propuesta_nuevo: 'revision_requerida',
          evento_id: EVENTO,
          mensaje: motivo
        })
      );
      assert.deepStrictEqual([llamadas.transacciones, llamadas.callbacks], [1, 1]);
      assert.deepStrictEqual(entorno.capturas.escriturasTx, ['cas:propuestas_cambio', 'insertar:intentos_aplicacion', 'insertar:eventos_propuesta']);
      assert.deepStrictEqual(
        soloIntento(store),
        plano(
          intentoEsperado(propuesta, {
            finalizado_en: T,
            resultado: 'extraccion_ambigua',
            etapa_fallo: 'revalidacion_externa',
            error_mensaje: motivo,
            evidencia_fresca: { revalidacion_externa: RESP_AMBIGUO }
          })
        )
      );
      assert.deepStrictEqual(limpio(store.eventos[1]), plano(eventoEsperado(propuesta, 'entrada_revision', 'revision_requerida', 'extraccion_ambigua', motivo)));
      const p = store.propuestas.get(PROPUESTA_ID);
      assert.deepStrictEqual([p.estado, p.version_coordinacion, p.ultimo_evento_id, p.decision_aprobacion_id], ['revision_requerida', 2, EVENTO, APROBACION_ID]);
      assert.strictEqual(p.updatedAt.getTime(), T.getTime());
      assert.deepStrictEqual(foto(store).destinos, destinoAntes, 'destino intacto');
      assert.strictEqual(store.historial.length, 0);
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'ambiguo');
    }

    // fuente_cambio: transacción corta → obsoleta, con revalidacion.coincide false.
    for (const [nombre, resp] of [
      ['importe distinto', respValor('£25', 25)],
      ['mismo importe, texto distinto', respValor('GBP 20', 20)]
    ]) {
      const { store, propuesta } = escenario();
      const destinoAntes = foto(store).destinos;
      const { deps } = crearEntorno(store, { respuesta: resp });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      const motivo = `La fuente ahora informa ${JSON.stringify(resp.valor.valor)} y la propuesta proponía "£20".`;
      assert.deepStrictEqual(
        r,
        resultadoEsperado({ resultado: 'fuente_cambio', etapa_fallo: 'revalidacion_externa', estado_propuesta_nuevo: 'obsoleta', evento_id: EVENTO, mensaje: motivo }),
        nombre
      );
      assert.deepStrictEqual(
        soloIntento(store),
        plano(
          intentoEsperado(propuesta, {
            finalizado_en: T,
            resultado: 'fuente_cambio',
            etapa_fallo: 'revalidacion_externa',
            error_mensaje: motivo,
            evidencia_fresca: { revalidacion_externa: resp },
            revalidacion: revalidacionEsperada(false, resp)
          })
        ),
        nombre
      );
      assert.deepStrictEqual(limpio(store.eventos[1]), plano(eventoEsperado(propuesta, 'obsolescencia', 'obsoleta', 'fuente_cambio', motivo)));
      assert.deepStrictEqual(foto(store).destinos, destinoAntes, `[${nombre}] destino intacto`);
      verificarInvariantes(store, `fuente_cambio ${nombre}`);
    }

    // Respuesta fuera de contrato (bug del adaptador): inicio huérfano, sin intento.
    {
      const { store, propuesta } = escenario();
      const { deps, llamadas } = crearEntorno(store, { respuesta: { tipo: 'desconocido' } });
      await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), TypeError, 'respuesta fuera de contrato');
      inicioUnico(store, INTENTO, { terminados: 0 });
      assert.strictEqual(llamadas.transacciones, 0);
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
    }
    console.log('8) etapa 1: no_disponible (independiente), ambiguo → revision_requerida, fuente_cambio → obsoleta; bug del adaptador deja inicio huérfano: OK');
  }

  // ============================================================
  // 9) Ventana de 15 minutos exacta, antes de escribir en destinos
  // ============================================================
  {
    const casos = [
      ['exactamente 15 min', VENTANA_REVALIDACION_MS, 'exito'],
      ['15 min + 1 ms', VENTANA_REVALIDACION_MS + 1, 'revalidacion_vencida'],
      ['revalidada en t', 0, 'exito'],
      ['revalidada 1 ms después de t', -1, 'revalidacion_vencida']
    ];
    for (const [nombre, edad, esperado] of casos) {
      const iniciado = new Date(T.getTime() - VENTANA_REVALIDACION_MS - 60000);
      const revalidadaEn = new Date(T.getTime() - edad);
      const resp = { ...RESP_VALOR, revalidada_en: revalidadaEn };
      const { store, propuesta } = escenario();
      const destinoAntes = foto(store).destinos;
      const { deps, llamadas } = crearEntorno(store, { respuesta: resp, reloj: [iniciado, T] });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(r.resultado, esperado, nombre);
      inicioUnico(store, INTENTO);
      if (esperado === 'revalidacion_vencida') {
        const mensaje = `La revalidación tiene ${edad} ms respecto de t (ventana [0, ${VENTANA_REVALIDACION_MS}]); no se escribe.`;
        assert.deepStrictEqual(r, resultadoEsperado({ resultado: 'revalidacion_vencida', etapa_fallo: 'escritura_aplicacion', mensaje }), nombre);
        assert.strictEqual(llamadas.transacciones, 0, `[${nombre}] sin transacción`);
        assert.deepStrictEqual(
          soloIntento(store),
          plano(
            intentoEsperado(propuesta, {
              iniciado_en: iniciado,
              finalizado_en: T,
              resultado: 'revalidacion_vencida',
              etapa_fallo: 'escritura_aplicacion',
              error_mensaje: mensaje,
              evidencia_fresca: { revalidacion_externa: resp, ventana: ventanaEsperada(revalidadaEn) },
              revalidacion: revalidacionEsperada(true, resp)
            })
          ),
          nombre
        );
        assert.deepStrictEqual(foto(store).destinos, destinoAntes, `[${nombre}] destino intacto`);
        assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
      } else {
        assert.strictEqual(store.destinos.get(DESTINO_HEX).requisitos[1].costo, '£20', nombre);
      }
      verificarInvariantes(store, `ventana ${nombre}`);
    }
    console.log('9) ventana: 15:00.000 aplica, 15:00.001 vencida, 0 aplica, −1 ms vencida; vencida no abre transacción ni toca destinos: OK');
  }

  // ============================================================
  // 10) Identidad: las 4 categorías → conflicto (transacción corta)
  // ============================================================
  {
    const casos = [
      ['destino_no_encontrado', null],
      ['requisito_id_no_encontrado', destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { _id: ObjectId.createFromHexString(OTRO_REQ_HEX) })] })],
      ['requisito_id_duplicado', destinoFixture(VALOR16, { requisitos: [requisitoEta(), requisitoEta()] })],
      ['identidad_semantica_no_coincide', destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { tipo: 'visa' })] })]
    ];
    for (const [categoria, destino] of casos) {
      const { store, propuesta } = escenario({ destino });
      const antes = foto(store);
      const { deps, llamadas, entorno, adaptador } = crearEntorno(store);
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      const motivo = `La identidad del requisito ya no coincide (${categoria}); no se escribe en destinos.`;
      const { detalle } = clasificarIdentidadRequisito(destino, REQ_HEX, adaptador.validarIdentidad);
      assert.deepStrictEqual(
        r,
        resultadoEsperado({
          resultado: 'identidad_requisito_cambio',
          etapa_fallo: 'escritura_aplicacion',
          estado_propuesta_nuevo: 'conflicto',
          evento_id: EVENTO,
          mensaje: motivo
        }),
        categoria
      );
      assert.deepStrictEqual([llamadas.transacciones, llamadas.callbacks], [2, 2], `[${categoria}] escritura abortada + transacción corta`);
      assert.ok(!entorno.capturas.escriturasTx.includes('actualizar:destinos'), `[${categoria}] no llega al $set`);
      const i = soloIntento(store);
      assert.deepStrictEqual(i.identidad_esperada_no_coincide, plano({ categoria, detalle }));
      assert.deepStrictEqual(i.revalidacion, plano(revalidacionEsperada(true)));
      assert.ok(!('valor_observado' in i) && !('historial_id' in i));
      assert.deepStrictEqual(i.evidencia_fresca.identidad, i.identidad_esperada_no_coincide);
      assert.deepStrictEqual(limpio(store.eventos[1]), plano(eventoEsperado(propuesta, 'conflicto', 'conflicto', 'identidad_requisito_cambio', motivo)));
      assert.deepStrictEqual(foto(store).destinos, antes.destinos, `[${categoria}] destino intacto`);
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'conflicto');
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, categoria);
    }
    console.log('10) identidad: destino/_id ausente/_id duplicado/semántica → identidad_requisito_cambio + conflicto, sin tocar destinos: OK');
  }

  // ============================================================
  // 11) Precondición: 3 tipos × 4 estados del destino
  // ============================================================
  {
    let exitos = 0;
    let conflictos = 0;
    for (const [nombreEsperado, va] of CASOS_PRECONDICION) {
      for (const [nombreActual, actual] of ESTADOS_DESTINO) {
        const etiqueta = `esperado ${nombreEsperado}, actual ${nombreActual}`;
        const { store, propuesta } = escenario({ valorAnterior: va, costoDestino: actual });
        const antes = foto(store);
        const { deps } = crearEntorno(store);
        const r = await aplicarPropuesta(entradaDe(propuesta), deps);
        const coincide = actual.presente === va.presente && actual.valor === va.valor;
        if (coincide) {
          exitos++;
          assert.strictEqual(r.resultado, 'exito', etiqueta);
          const despues = store.destinos.get(DESTINO_HEX);
          assert.deepStrictEqual(diffDestino(antes.destinos[0], plano(despues)).sort(), ['requisitos.1.costo', 'updatedAt'], etiqueta);
          assert.strictEqual(despues.requisitos[1].costo, '£20');
          const h = limpio(store.historial[0]);
          assert.deepStrictEqual(h.valor_anterior, va, etiqueta);
        } else {
          conflictos++;
          const motivo = `El valor actual de costo (${JSON.stringify(actual)}) ya no es el valor_anterior de la propuesta (${JSON.stringify(va)}).`;
          assert.deepStrictEqual(
            r,
            resultadoEsperado({
              resultado: 'valor_actual_cambio',
              etapa_fallo: 'escritura_aplicacion',
              estado_propuesta_nuevo: 'conflicto',
              evento_id: EVENTO,
              mensaje: motivo
            }),
            etiqueta
          );
          const i = soloIntento(store);
          assert.deepStrictEqual(i.valor_observado, actual, `[${etiqueta}] valor_observado exacto`);
          assert.deepStrictEqual(i.precondicion, va, `[${etiqueta}] precondicion = valor_anterior`);
          assert.deepStrictEqual(i.evidencia_fresca.valor_observado, actual);
          assert.deepStrictEqual(foto(store).destinos, antes.destinos, `[${etiqueta}] destino intacto`);
          assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'conflicto');
          assert.deepStrictEqual(limpio(store.eventos[1]), plano(eventoEsperado(propuesta, 'conflicto', 'conflicto', 'valor_actual_cambio', motivo)));
        }
        inicioUnico(store, INTENTO);
        verificarInvariantes(store, etiqueta);
      }
    }
    assert.deepStrictEqual([exitos, conflictos], [3, 9]);
    console.log('11) precondición: 3 éxitos (diagonal) y 9 valor_actual_cambio con valor_observado exacto (ausente ≠ null ≠ valor): OK');
  }

  // ============================================================
  // 12) Éxito: las 5 escrituras exactas; en destinos solo costo + updatedAt
  // ============================================================
  {
    const { store, propuesta, aprobacion } = escenario();
    const antes = foto(store);
    const { deps, llamadas, entorno } = crearEntorno(store);
    const r = await aplicarPropuesta(entradaDe(propuesta), deps);
    assert.deepStrictEqual(
      r,
      resultadoEsperado({ resultado: 'exito', estado_propuesta_nuevo: 'aplicada', evento_id: EVENTO, historial_id: HISTORIAL })
    );
    assert.deepStrictEqual(entorno.capturas.escriturasTx, [
      'cas:propuestas_cambio',
      'leer:destinos',
      'actualizar:destinos',
      'insertar:historial_cambios',
      'insertar:intentos_aplicacion',
      'insertar:eventos_propuesta'
    ]);
    assert.deepStrictEqual(
      [llamadas.uuid, llamadas.ahora, llamadas.transacciones, llamadas.callbacks, llamadas.insertarInicio, llamadas.insertarIntentoIndependiente, llamadas.revalidar],
      [4, 2, 1, 1, 1, 0, 1]
    );

    // CAS exacto.
    assert.deepStrictEqual(entorno.capturas.casPropuesta, [
      {
        filtro: {
          propuesta_id: PROPUESTA_ID,
          estado: 'aprobada',
          payload_hash: propuesta.payload_hash,
          version_coordinacion: 1,
          decision_aprobacion_id: APROBACION_ID,
          ultimo_evento_id: APROBACION_ID
        },
        update: { $set: { estado: 'aplicada', ultimo_evento_id: EVENTO, updatedAt: T }, $inc: { version_coordinacion: 1 } }
      }
    ]);
    // Filtros y update del destino: ObjectId reales.
    const [lectura] = entorno.capturas.filtrosDestino;
    assert.ok(lectura._id instanceof ObjectId && lectura._id.toHexString() === DESTINO_HEX);
    const [{ filtro, update }] = entorno.capturas.updatesDestino;
    assert.ok(filtro._id instanceof ObjectId && filtro.requisitos.$elemMatch._id instanceof ObjectId);
    assert.deepStrictEqual(plano(filtro), { _id: { $oid: DESTINO_HEX }, requisitos: { $elemMatch: { _id: { $oid: REQ_HEX }, costo: '£16' } } });
    assert.deepStrictEqual(update, { $set: { 'requisitos.$.costo': '£20', updatedAt: T } });

    // Documentos exactos.
    const pDespues = store.propuestas.get(PROPUESTA_ID);
    assert.deepStrictEqual(
      plano(pDespues),
      plano({ ...propuesta, estado: 'aplicada', version_coordinacion: 2, ultimo_evento_id: EVENTO, updatedAt: T })
    );
    await new PropuestaCambio(clonar(pDespues)).validate();
    assert.deepStrictEqual(store.historial.map(limpio), [
      plano({
        historial_id: HISTORIAL,
        destino_id: DESTINO_HEX,
        requisito_id: REQ_HEX,
        campo: 'costo',
        valor_anterior: VALOR16,
        valor_nuevo: { presente: true, valor: '£20' },
        aplicado_en: T,
        propuesta_id: PROPUESTA_ID,
        decision_aprobacion_id: APROBACION_ID,
        intento_aplicacion_id: INTENTO,
        revalidacion_id: REVALIDACION
      })
    ]);
    // Como lo persiste Mongoose: destino_id/requisito_id del historial casteados a ObjectId.
    assert.ok(store.historial[0].destino_id instanceof ObjectId);
    assert.deepStrictEqual(
      soloIntento(store),
      plano(
        intentoEsperado(propuesta, {
          finalizado_en: T,
          resultado: 'exito',
          evidencia_fresca: { revalidacion_externa: RESP_VALOR, ventana: ventanaEsperada() },
          revalidacion: revalidacionEsperada(true),
          precondicion: VALOR16,
          historial_id: HISTORIAL
        })
      )
    );
    assert.deepStrictEqual(store.eventos.map(limpio), [plano(aprobacion), plano(eventoEsperado(propuesta, 'aplicacion', 'aplicada', 'exito'))]);
    assert.deepStrictEqual(store.inicios.map(limpio), [plano(inicioEsperado(propuesta))]);

    // Destino: solo requisitos[ETA].costo y updatedAt = t; el otro requisito intacto.
    const dDespues = store.destinos.get(DESTINO_HEX);
    assert.deepStrictEqual(diffDestino(antes.destinos[0], plano(dDespues)).sort(), ['requisitos.1.costo', 'updatedAt']);
    assert.strictEqual(dDespues.updatedAt.getTime(), T.getTime());
    assert.ok(dDespues.requisitos[1]._id instanceof ObjectId, 'el _id del subdocumento sigue siendo ObjectId');
    await new Destino(clonar(dDespues)).validate();
    inicioUnico(store, INTENTO);
    verificarInvariantes(store, 'éxito');
    console.log('12) éxito: CAS + lectura + $set + historial + intento + evento exactos; destino solo costo/updatedAt = t: OK');
  }

  // ============================================================
  // 13) Doble aplicación
  // ============================================================
  {
    const { store, propuesta } = escenario();
    await aplicarPropuesta(entradaDe(propuesta), crearEntorno(store).deps);
    const destinoTrasPrimera = foto(store).destinos;
    for (const [nombre, entrada, codigos] of [
      ['misma vista', entradaDe(propuesta), ['estado_no_aprobada', 'version_no_coincide', 'aprobacion_invalida']],
      ['vista actualizada', entradaDe(propuesta, { version_coordinacion_esperada: 2 }), ['estado_no_aprobada', 'aprobacion_invalida']]
    ]) {
      const { deps, llamadas } = crearEntorno(store, { prefijo: nombre === 'misma vista' ? '44444444-4444-4444-8444-' : '55555555-5555-4555-8555-' });
      const r = await aplicarPropuesta(entrada, deps);
      assert.strictEqual(r.resultado, 'propuesta_no_aplicable', nombre);
      assert.strictEqual(r.etapa_fallo, 'precondiciones_propuesta', nombre);
      assert.deepStrictEqual([llamadas.revalidar, llamadas.transacciones], [0, 0], nombre);
      const i = limpio(store.intentos.find((x) => x.intento_id === r.intento_id));
      assert.deepStrictEqual(i.evidencia_fresca.precondiciones.map((f) => f.codigo), codigos, nombre);
      inicioUnico(store, r.intento_id);
    }
    assert.deepStrictEqual(foto(store).destinos, destinoTrasPrimera);
    assert.strictEqual(store.historial.length, 1);
    verificarInvariantes(store, 'doble aplicación');
    console.log('13) doble aplicación: la segunda termina en etapa 0 (estado aplicada), sin revalidar ni tocar destinos: OK');
  }

  // ============================================================
  // 14) Reintentos y concurrencia con el mismo t
  // ============================================================
  {
    // WriteConflict al commit: se re-ejecuta el callback con los mismos ids y t.
    {
      const { store, propuesta } = escenario();
      const { deps, llamadas, entorno } = crearEntorno(store, { fallas: { transitorioAlCommit: { tx: 1 } } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(r.resultado, 'exito');
      assert.deepStrictEqual([llamadas.transacciones, llamadas.callbacks, llamadas.ahora, llamadas.uuid], [1, 2, 2, 4]);
      assert.strictEqual(entorno.capturas.casPropuesta.length, 2);
      assert.deepStrictEqual(plano(entorno.capturas.casPropuesta[0]), plano(entorno.capturas.casPropuesta[1]), 'mismo filtro y update (mismo t)');
      assert.deepStrictEqual(plano(entorno.capturas.updatesDestino[0]), plano(entorno.capturas.updatesDestino[1]));
      assert.strictEqual(store.destinos.get(DESTINO_HEX).updatedAt.getTime(), T.getTime());
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).updatedAt.getTime(), T.getTime());
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'reintento transitorio');
    }

    // Dos aplicaciones concurrentes de la misma propuesta.
    {
      const { store, propuesta } = escenario();
      let liberarConflicto;
      const pausaTrasCas = new Promise((r) => {
        liberarConflicto = r;
      });
      let llegados = 0;
      let abrir;
      const barrera = new Promise((r) => {
        abrir = r;
      });
      const barreraRevalidar = async () => {
        llegados++;
        if (llegados === 2) abrir();
        await barrera;
      };
      const fallas = { pausaTrasCas, alConflicto: () => liberarConflicto() };
      const A = crearEntorno(store, { prefijo: '66666666-6666-4666-8666-', fallas, barreraRevalidar });
      const B = crearEntorno(store, { prefijo: '77777777-7777-4777-8777-', fallas, barreraRevalidar });
      const [ra, rb] = await Promise.all([aplicarPropuesta(entradaDe(propuesta), A.deps), aplicarPropuesta(entradaDe(propuesta), B.deps)]);
      const resultados = [ra.resultado, rb.resultado].sort();
      assert.deepStrictEqual(resultados, ['exito', 'propuesta_no_aplicable']);
      const perdedor = ra.resultado === 'exito' ? { r: rb, e: B } : { r: ra, e: A };
      assert.strictEqual(perdedor.r.etapa_fallo, 'escritura_aplicacion');
      assert.deepStrictEqual([perdedor.e.llamadas.transacciones, perdedor.e.llamadas.callbacks], [1, 2], 'el perdedor reintenta una vez');
      assert.strictEqual(perdedor.e.llamadas.ahora, 3, 'iniciado_en + t + finalizado (t no se regenera en el reintento)');
      assert.deepStrictEqual(plano(perdedor.e.entorno.capturas.casPropuesta[0]), plano(perdedor.e.entorno.capturas.casPropuesta[1]), 'mismo t en el reintento');
      const ip = limpio(store.intentos.find((i) => i.intento_id === perdedor.r.intento_id));
      assert.strictEqual(ip.evidencia_fresca.propuesta_actual.estado, 'aplicada');
      assert.strictEqual(ip.evidencia_fresca.ventana.t, T.toISOString());
      assert.ok(ip.revalidacion);
      assert.strictEqual(store.historial.length, 1);
      assert.strictEqual(store.destinos.get(DESTINO_HEX).requisitos[1].costo, '£20');
      assert.strictEqual(A.llamadas.revalidarConTxAbierta + B.llamadas.revalidarConTxAbierta, 0);
      inicioUnico(store, ra.intento_id);
      inicioUnico(store, rb.intento_id);
      verificarInvariantes(store, 'concurrencia');
    }
    console.log('14) reintento por WriteConflict con los mismos ids y t; dos aplicaciones concurrentes → 1 éxito + 1 no_aplicable: OK');
  }

  // ============================================================
  // 15) Abort, commit ambiguo, E11000, relectura
  // ============================================================
  {
    // a) Commit fallido sin aplicar → escritura_abortada registrada y relanzada con la causa.
    {
      const { store, propuesta } = escenario();
      const antes = foto(store);
      const { deps, llamadas } = crearEntorno(store, { fallas: { commit: { modo: 'sin_aplicar' } } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'commit sin aplicar');
      const mensaje = 'La transacción falló y no quedó nada escrito: commit fallido (simulado, sin aplicar)';
      assert.strictEqual(err.cause.message, 'commit fallido (simulado, sin aplicar)');
      assert.deepStrictEqual(
        [err.intento_id, err.propuesta_id, err.resultado, err.etapa_fallo, err.resultado_no_registrado],
        [INTENTO, PROPUESTA_ID, 'escritura_abortada', 'escritura_aplicacion', null]
      );
      assert.deepStrictEqual(
        soloIntento(store),
        plano(
          intentoEsperado(propuesta, {
            finalizado_en: new Date(T.getTime() + 1000),
            resultado: 'escritura_abortada',
            etapa_fallo: 'escritura_aplicacion',
            error_mensaje: mensaje,
            evidencia_fresca: { revalidacion_externa: RESP_VALOR, ventana: ventanaEsperada(), error: mensaje },
            revalidacion: revalidacionEsperada(true),
            precondicion: VALOR16
          })
        )
      );
      assert.strictEqual(llamadas.insertarIntentoIndependiente, 1);
      assert.deepStrictEqual({ ...foto(store), intentos: [], inicios: [] }, { ...antes, intentos: [], inicios: [] }, 'nada de la transacción');
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'abort');
    }

    // b) Commit ambiguo que sí se aplicó → exito confirmado por relectura.
    {
      const { store, propuesta } = escenario();
      const { deps, llamadas } = crearEntorno(store, { fallas: { commit: { modo: 'aplicado_con_error' } } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual(
        r,
        resultadoEsperado({
          resultado: 'exito',
          estado_propuesta_nuevo: 'aplicada',
          evento_id: EVENTO,
          historial_id: HISTORIAL,
          confirmado_por_relectura: true,
          causa_relectura: 'error_transaccion'
        })
      );
      assert.strictEqual(llamadas.insertarIntentoIndependiente, 0);
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'commit ambiguo');
    }

    // c) Commit que se vuelve visible después de la relectura: el insert de
    //    escritura_abortada choca con intento_id_1 → se relee y se informa exito.
    {
      const { store, propuesta } = escenario();
      const { deps, llamadas } = crearEntorno(store, { fallas: { commit: { modo: 'diferido' } } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(r.resultado, 'exito');
      assert.deepStrictEqual([r.confirmado_por_relectura, r.causa_relectura], [true, 'duplicado_intento_id']);
      assert.strictEqual(llamadas.insertarIntentoIndependiente, 1);
      assert.strictEqual(store.intentos.length, 1);
      assert.strictEqual(store.intentos[0].resultado, 'exito', 'el exito no se sobrescribe');
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'commit diferido');
    }

    // d) E11000 del historial por una escritura externa → ErrorInconsistencia, sin registrar nada más.
    {
      const { store, propuesta } = escenario();
      store.historial.push({
        historial_id: '88888888-8888-4888-8888-888888888888',
        propuesta_id: PROPUESTA_ID,
        intento_aplicacion_id: '88888888-8888-4888-8888-000000000000'
      });
      const { deps } = crearEntorno(store);
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorInconsistencia, 'E11000 historial');
      assert.ok(err.message.includes('historial_cambios index: propuesta_id_1'), err.message);
      inicioUnico(store, INTENTO, { terminados: 0 });
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
      assert.strictEqual(store.destinos.get(DESTINO_HEX).requisitos[1].costo, '£16');
    }

    // e) E11000 del evento (versión tomada por fuera) → ErrorInconsistencia.
    {
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, {
        fallas: { insertarEvento: () => errorE11000('eventos_propuesta', 'uniq_evento_por_propuesta_version', { propuesta_id: 1, version_coordinacion_nueva: 1 }) }
      });
      await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorInconsistencia, 'E11000 evento');
      inicioUnico(store, INTENTO, { terminados: 0 });
    }

    // f) Falla también la relectura → ErrorResultadoIncierto, sin registrar nada más.
    {
      const { store, propuesta } = escenario();
      const errRelectura = new Error('red caída');
      const { deps } = crearEntorno(store, { fallas: { commit: { modo: 'sin_aplicar' }, relectura: errRelectura } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorResultadoIncierto, 'relectura fallida');
      assert.ok(err.message.includes('INCIERTO') && err.message.includes(INTENTO) && err.message.includes(PROPUESTA_ID));
      assert.strictEqual(err.cause.message, 'commit fallido (simulado, sin aplicar)');
      assert.strictEqual(err.error_relectura, errRelectura);
      inicioUnico(store, INTENTO, { terminados: 0 });
    }

    // g) $elemMatch sin coincidencia tras lectura consistente → ErrorInconsistencia + escritura_abortada.
    // h) CAS con modifiedCount 0 → ErrorInconsistencia + escritura_abortada.
    for (const [nombre, fallas, causa] of [
      ['$set sin coincidencia', { destinoSinCoincidencia: true }, 'no encontró nada (matchedCount=0)'],
      ['CAS modifiedCount 0', { casModifiedCero: true }, 'El CAS encontró la propuesta pero modifiedCount=0']
    ]) {
      const { store, propuesta } = escenario();
      const destinoAntes = foto(store).destinos;
      const { deps } = crearEntorno(store, { fallas });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorInconsistencia, nombre);
      assert.ok(err.message.includes(causa), err.message);
      assert.ok(err.message.includes('registrado como escritura_abortada'), err.message);
      const i = soloIntento(store);
      assert.deepStrictEqual([i.resultado, i.etapa_fallo], ['escritura_abortada', 'escritura_aplicacion'], nombre);
      assert.ok(i.error_mensaje.startsWith('Inconsistencia: '));
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
      assert.deepStrictEqual(foto(store).destinos, destinoAntes);
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, nombre);
    }

    // i) Falla el commit de la transacción corta → escritura_abortada / transicion_por_fallo
    //    con resultado_no_registrado y la misma evidencia que el resultado semántico.
    {
      const destino = destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { nombre: 'Otro' })] });
      const { store, propuesta } = escenario({ destino });
      const { deps, llamadas } = crearEntorno(store, { fallas: { commit: { modo: 'sin_aplicar', tx: 2 } } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'commit de la transacción corta');
      assert.deepStrictEqual(
        [err.resultado, err.etapa_fallo, err.resultado_no_registrado, err.intento_id],
        ['escritura_abortada', 'transicion_por_fallo', 'identidad_requisito_cambio', INTENTO]
      );
      assert.strictEqual(err.cause.message, 'commit fallido (simulado, sin aplicar)');
      assert.strictEqual(llamadas.transacciones, 2);
      const i = soloIntento(store);
      assert.strictEqual(i.identidad_esperada_no_coincide.categoria, 'identidad_semantica_no_coincide');
      assert.ok(i.revalidacion);
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
      assert.strictEqual(store.eventos.length, 1);
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'abort transición');
    }
    // Igual para valor_actual_cambio: conserva precondicion y valor_observado.
    {
      const { store, propuesta } = escenario({ costoDestino: VALOR10 });
      const { deps } = crearEntorno(store, { fallas: { commit: { modo: 'sin_aplicar', tx: 2 } } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'commit corto valor');
      assert.deepStrictEqual([err.resultado, err.resultado_no_registrado], ['escritura_abortada', 'valor_actual_cambio']);
      const i = soloIntento(store);
      assert.deepStrictEqual([i.precondicion, i.valor_observado], [VALOR16, VALOR10]);
    }

    // j) CAS sin coincidencia en la transacción corta (la propuesta se canceló
    //    mientras tanto) → escritura_abortada / transicion_por_fallo.
    {
      const { store, propuesta } = escenario();
      const cancelar = (s) => {
        const p = s.propuestas.get(PROPUESTA_ID);
        s.propuestas.set(PROPUESTA_ID, { ...p, estado: 'cancelada', version_coordinacion: 2, ultimo_evento_id: '12121212-1212-4212-8212-121212121212' });
      };
      const { deps } = crearEntorno(store, { respuesta: respValor('£25', 25), fallas: { antesDelCallback: cancelar } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual(
        [r.resultado, r.etapa_fallo, r.resultado_no_registrado],
        ['escritura_abortada', 'transicion_por_fallo', 'fuente_cambio']
      );
      const i = soloIntento(store);
      assert.strictEqual(i.revalidacion.coincide_con_propuesta, false);
      assert.ok(i.error_mensaje.includes('"cancelada"'));
      inicioUnico(store, INTENTO);
    }
    // extraccion_ambigua con CAS sin coincidencia: combinación válida sin revalidacion.
    {
      const { store, propuesta } = escenario();
      const cancelar = (s) => s.propuestas.set(PROPUESTA_ID, { ...s.propuestas.get(PROPUESTA_ID), estado: 'cancelada' });
      const { deps } = crearEntorno(store, { respuesta: RESP_AMBIGUO, fallas: { antesDelCallback: cancelar } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual([r.resultado, r.resultado_no_registrado], ['escritura_abortada', 'extraccion_ambigua']);
      assert.ok(!('revalidacion' in soloIntento(store)));
    }

    // k) Commit ambiguo en la transacción corta → confirmado por relectura.
    {
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, { respuesta: RESP_AMBIGUO, fallas: { commit: { modo: 'aplicado_con_error' } } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual(
        [r.resultado, r.estado_propuesta_nuevo, r.confirmado_por_relectura, r.causa_relectura],
        ['extraccion_ambigua', 'revision_requerida', true, 'error_transaccion']
      );
      verificarInvariantes(store, 'commit ambiguo transición');
    }

    // l) Rastro parcial (el commit se aplicó pero falta el evento) → ErrorInconsistencia.
    {
      const { store, propuesta } = escenario();
      const borrarEvento = (s) => {
        s.eventos = s.eventos.filter((e) => e.evento_id !== EVENTO);
      };
      const { deps } = crearEntorno(store, { fallas: { commit: { modo: 'aplicado_con_error' }, trasCommit: borrarEvento } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorInconsistencia, 'rastro parcial');
      assert.ok(err.message.includes('rastro parcial'), err.message);
    }
    console.log('15) abort → escritura_abortada; commit ambiguo/diferido → confirmado; E11000 e inconsistencias → ErrorInconsistencia; transición fallida → transicion_por_fallo: OK');
  }

  // ============================================================
  // 16) revalidar nunca con una transacción abierta (control del fake)
  // ============================================================
  {
    const { store } = escenario();
    const { deps, entorno, adaptador } = crearEntorno(store);
    const { propuesta } = propuestaAprobada();
    await assertRechaza(
      deps.ejecutarTransaccion(async () => adaptador.revalidar(propuesta, { ahora: deps.ahora })),
      'transacción abierta',
      'el fake detecta revalidar dentro de una transacción'
    );
    assert.strictEqual(entorno.llamadas.revalidarConTxAbierta, 1);
    assert.strictEqual(entorno.txAbiertas, 0);
    await assertRechaza(
      deps.ejecutarTransaccion(async () => deps.insertarIntentoIndependiente({})),
      'transacción abierta',
      'el fake detecta un insert independiente dentro de una transacción'
    );
    console.log('16) el fake detecta revalidar/insert independiente con transacción abierta (y ninguna prueba anterior lo disparó): OK');
  }

  // ============================================================
  // 17) Dependencias reales con stubs (sin conexión)
  // ============================================================
  {
    const modelos = [PropuestaCambio, EventoPropuesta, IntentoAplicacion, HistorialCambio, InicioIntentoAplicacion];
    const originales = {
      indexes: modelos.map((m) => m.collection.indexes),
      findOne: Destino.collection.findOne,
      updateOne: Destino.collection.updateOne,
      saveInicio: InicioIntentoAplicacion.prototype.save,
      saveIntento: IntentoAplicacion.prototype.save
    };
    try {
      const capturas = {};
      const conexion = {
        transaction: async (fn, opciones) => {
          capturas.transaccion = opciones;
          return fn('sesion');
        },
        db: { command: async () => ({ authInfo: { authenticatedUsers: [USUARIO] } }) }
      };
      const deps = S.crearDependenciasMongoose(conexion, { operadoresJson: OPERADORES_JSON });

      let excluir = null;
      modelos.forEach((m) => {
        m.collection.indexes = async () => listadoIndices(m.collection.collectionName, excluir ? [excluir] : []);
      });
      await deps.verificarIndices();
      excluir = 'uniq_intento_exitoso_por_propuesta';
      await assertRechaza(deps.verificarIndices(), ErrorPrecondicionIndices, 'gate real sin índice');

      Destino.collection.findOne = async (filtro, opciones) => {
        capturas.findOne = { filtro, opciones };
        return null;
      };
      Destino.collection.updateOne = async (filtro, update, opciones) => {
        capturas.updateOne = { filtro, update, opciones };
        return { matchedCount: 1, modifiedCount: 1 };
      };
      const ids = S.convertirIdsDestino(propuestaAprobada().propuesta);
      const filtro = S.filtroDestino(ids, 'costo', VALOR16);
      const update = S.updateDestino('costo', '£20', T);
      await deps.leerDestino(S.filtroLecturaDestino(ids), 'sesion');
      await deps.leerDestino(S.filtroLecturaDestino(ids), null);
      await deps.actualizarDestino(filtro, update, 'sesion');
      assert.strictEqual(capturas.updateOne.filtro, filtro, 'el filtro llega al driver sin transformar (misma referencia)');
      assert.ok(capturas.updateOne.filtro.requisitos.$elemMatch._id instanceof ObjectId);
      assert.deepStrictEqual(capturas.updateOne.opciones, { session: 'sesion' });
      assert.ok(capturas.findOne.filtro._id instanceof ObjectId);
      assert.deepStrictEqual(capturas.findOne.opciones, {});

      await deps.ejecutarTransaccion(async () => {});
      assert.deepStrictEqual(capturas.transaccion, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });

      InicioIntentoAplicacion.prototype.save = async function (opciones) {
        capturas.saveInicio = opciones;
      };
      IntentoAplicacion.prototype.save = async function (opciones) {
        capturas.saveIntento = opciones;
      };
      await deps.insertarInicio({});
      await deps.insertarIntentoIndependiente({});
      assert.deepStrictEqual(capturas.saveInicio, { writeConcern: { w: 'majority' } });
      assert.deepStrictEqual(capturas.saveIntento, { writeConcern: { w: 'majority' } });
      await deps.insertarIntento({}, 'sesion');
      assert.deepStrictEqual(capturas.saveIntento, { session: 'sesion' });
      assert.deepStrictEqual(await deps.usuariosAutenticados(), [USUARIO]);
      assert.deepStrictEqual(Object.keys(deps.contextoProceso()).sort(), ['host', 'pid']);
    } finally {
      modelos.forEach((m, i) => {
        m.collection.indexes = originales.indexes[i];
      });
      Destino.collection.findOne = originales.findOne;
      Destino.collection.updateOne = originales.updateOne;
      InicioIntentoAplicacion.prototype.save = originales.saveInicio;
      IntentoAplicacion.prototype.save = originales.saveIntento;
    }
    console.log('17) dependencias reales con stubs: gate de 5 colecciones, driver nativo con ObjectId sin casting, opciones de transacción y writeConcern: OK');
  }

  // ============================================================
  // 18) Errores inesperados: se registra escritura_abortada y se relanzan
  //     con cause e intento_id; nada persistido lleva URI ni credenciales
  // ============================================================
  {
    const SECRETOS = ['usuario-secreto', 'Cl4veS3creta', 'cluster-secreto', 'mongodb+srv://', 'mongodb://', 'pw-secreto', 'hunter2'];
    const MENSAJE_CON_SECRETOS =
      'conexión cerrada: mongodb+srv://usuario-secreto:Cl4veS3creta@cluster-secreto.abcd.mongodb.net/buscador?retryWrites=true ' +
      'vía https://proxy-user:pw-secreto@proxy.local:8080/x password=hunter2';
    const errorConSecretos = () => {
      const e = new Error(MENSAJE_CON_SECRETOS);
      e.code = 6; // HostUnreachable: no es E11000 ni transitorio
      return e;
    };
    const sinSecretos = (texto, etiqueta) => {
      for (const s of SECRETOS) assert.ok(!texto.includes(s), `[${etiqueta}] contiene "${s}": ${texto}`);
    };
    const persistidoSinSecretos = (store, etiqueta) =>
      sinSecretos(JSON.stringify(plano({ i: store.intentos, n: store.inicios, e: store.eventos, h: store.historial, p: [...store.propuestas.values()] })), etiqueta);

    // sanearMensaje (pura).
    assert.strictEqual(
      S.sanearMensaje(MENSAJE_CON_SECRETOS),
      'conexión cerrada: <uri-mongodb-redactada> vía https://<credenciales-redactadas>@proxy.local:8080/x password=<redactado>'
    );
    assert.strictEqual(S.sanearMensaje('mongodb://u:p@h1:27017,h2:27017/x?authSource=admin'), '<uri-mongodb-redactada>');
    assert.strictEqual(S.sanearMensaje('ver https://www.gov.uk/api/content/eta'), 'ver https://www.gov.uk/api/content/eta', 'URL pública intacta');
    assert.strictEqual(S.sanearMensaje('pwd: "a b" token=x; apiKey=y'), 'pwd: <redactado> token=<redactado>; apiKey=<redactado>');
    assert.strictEqual(S.sanearMensaje('x'.repeat(5000)).length, 2001);

    // a) Error de driver dentro de la transacción de éxito (al insertar el historial).
    {
      const { store, propuesta } = escenario();
      const destinoAntes = foto(store).destinos;
      const original = errorConSecretos();
      const { deps } = crearEntorno(store, { fallas: { insertarHistorial: () => original } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'error en historial');
      assert.strictEqual(err.cause, original, 'se conserva la causa (mismo objeto)');
      assert.strictEqual(err.cause.message, MENSAJE_CON_SECRETOS, 'la causa no se modifica');
      assert.deepStrictEqual([err.intento_id, err.etapa_fallo, err.resultado_no_registrado], [INTENTO, 'escritura_aplicacion', null]);
      sinSecretos(err.message, 'mensaje relanzado');
      const i = soloIntento(store);
      assert.deepStrictEqual([i.intento_id, i.resultado, i.etapa_fallo], [INTENTO, 'escritura_abortada', 'escritura_aplicacion'], 'intento registrado');
      assert.ok(i.error_mensaje.includes('<uri-mongodb-redactada>'));
      persistidoSinSecretos(store, 'error en historial');
      assert.deepStrictEqual(foto(store).destinos, destinoAntes);
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
      inicioUnico(store, INTENTO);
      verificarInvariantes(store, 'error en historial');
    }

    // b) Error al hacer commit de la transacción corta (valor_actual_cambio).
    {
      const { store, propuesta } = escenario({ costoDestino: VALOR10 });
      const original = errorConSecretos();
      const { deps } = crearEntorno(store, { fallas: { commit: { modo: 'lanzar', tx: 2, error: original } } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'error en commit corto');
      assert.strictEqual(err.cause, original);
      assert.deepStrictEqual([err.etapa_fallo, err.resultado_no_registrado], ['transicion_por_fallo', 'valor_actual_cambio']);
      const i = soloIntento(store);
      assert.deepStrictEqual([i.resultado, i.resultado_no_registrado, i.valor_observado], ['escritura_abortada', 'valor_actual_cambio', VALOR10]);
      persistidoSinSecretos(store, 'error en commit corto');
      sinSecretos(err.message, 'mensaje relanzado corto');
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
    }

    // c) Bug dentro de la transacción (el adaptador rompe el contrato de validarIdentidad).
    {
      const { store, propuesta } = escenario();
      const entornoAux = { llamadas: { revalidar: 0, revalidarConTxAbierta: 0 }, orden: [], txAbiertas: 0 };
      const base = crearAdaptador(entornoAux, RESP_VALOR);
      const roto = Object.freeze({ ...base, validarIdentidad: () => ({ ok: 'quizás' }) });
      const { deps } = crearEntorno(store, { adaptador: roto });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorEscrituraAbortada, 'bug del adaptador');
      assert.ok(err.cause instanceof TypeError, 'la causa es el TypeError original');
      assert.strictEqual(err.intento_id, INTENTO);
      assert.strictEqual(soloIntento(store).resultado, 'escritura_abortada');
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
    }

    // d) Falla también el registro de escritura_abortada: la causa original no se pierde.
    {
      const { store, propuesta } = escenario();
      const original = errorConSecretos();
      const errRegistro = new Error('sin conexión al registrar');
      const { deps } = crearEntorno(store, {
        fallas: { insertarHistorial: () => original, insertarIntentoIndependiente: () => errRegistro }
      });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorResultadoIncierto, 'registro fallido');
      assert.ok(!(err instanceof ErrorEscrituraAbortada), 'no afirma que quedó registrado');
      assert.strictEqual(err.propuesta_id, PROPUESTA_ID);
      sinSecretos(err.message, 'mensaje de registro fallido');
      assert.strictEqual(err.cause, original);
      assert.strictEqual(err.error_registro, errRegistro);
      assert.strictEqual(err.intento_id, INTENTO);
      inicioUnico(store, INTENTO, { terminados: 0 });
    }

    // e) ErrorInconsistencia mantiene su criterio: misma clase, no se envuelve, con intento_id.
    {
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, { fallas: { destinoSinCoincidencia: true } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorInconsistencia, 'inconsistencia');
      assert.ok(!(err instanceof ErrorEscrituraAbortada));
      assert.strictEqual(err.intento_id, INTENTO);
      assert.strictEqual(soloIntento(store).resultado, 'escritura_abortada');
    }

    // f) Un commit ambiguo que SÍ se aplicó no es un error: se devuelve exito.
    {
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, { fallas: { commit: { modo: 'aplicado_con_error' } } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual([r.resultado, r.causa_relectura], ['exito', 'error_transaccion']);
    }
    console.log('18) errores inesperados: escritura_abortada registrada, relanzada con cause e intento_id; registro fallido no pierde la causa; nada persistido con URI/credenciales: OK');
  }

  // ============================================================
  // 19) Los resultados operativos se DEVUELVEN (no se lanzan)
  // ============================================================
  {
    const cancelarEnTx = (s, numTx) => {
      if (numTx === 1) s.propuestas.set(PROPUESTA_ID, { ...s.propuestas.get(PROPUESTA_ID), estado: 'cancelada' });
    };
    const casos = [
      ['fuente no disponible', {}, { respuesta: RESP_NO_DISPONIBLE }, 'fuente_temporalmente_no_disponible', 'revalidacion_externa'],
      ['extracción ambigua', {}, { respuesta: RESP_AMBIGUO }, 'extraccion_ambigua', 'revalidacion_externa'],
      ['cambio de fuente', {}, { respuesta: respValor('£25', 25) }, 'fuente_cambio', 'revalidacion_externa'],
      ['conflicto de valor', { costoDestino: VALOR10 }, {}, 'valor_actual_cambio', 'escritura_aplicacion'],
      [
        'identidad distinta',
        { destino: destinoFixture(VALOR16, { requisitos: [requisitoEta(VALOR16, { nombre: 'Otro' })] }) },
        {},
        'identidad_requisito_cambio',
        'escritura_aplicacion'
      ],
      ['propuesta no aplicable (etapa 0)', {}, { entrada: { version_coordinacion_esperada: 5 } }, 'propuesta_no_aplicable', 'precondiciones_propuesta'],
      ['propuesta no aplicable (cambió antes de escribir)', {}, { fallas: { antesDelCallback: cancelarEnTx } }, 'propuesta_no_aplicable', 'escritura_aplicacion'],
      [
        'revalidación vencida',
        {},
        { respuesta: { ...RESP_VALOR, revalidada_en: new Date(T.getTime() - VENTANA_REVALIDACION_MS - 1) }, reloj: [new Date(T.getTime() - VENTANA_REVALIDACION_MS - 60000), T] },
        'revalidacion_vencida',
        'escritura_aplicacion'
      ],
      ['éxito', {}, {}, 'exito', null]
    ];
    for (const [nombre, esc, opciones, resultado, etapa] of casos) {
      const { store, propuesta } = escenario(esc);
      const { entrada: extra, ...opcionesEntorno } = opciones;
      const { deps } = crearEntorno(store, opcionesEntorno);
      let r;
      try {
        r = await aplicarPropuesta(entradaDe(propuesta, extra ?? {}), deps);
      } catch (err) {
        assert.fail(`[${nombre}] se lanzó en vez de devolverse: ${err.constructor.name}: ${err.message}`);
      }
      assert.deepStrictEqual([r.resultado, r.etapa_fallo], [resultado, etapa], nombre);
      assert.strictEqual(r.intento_id, INTENTO, nombre);
      assert.strictEqual(soloIntento(store).resultado, resultado, `[${nombre}] registrado`);
      inicioUnico(store, INTENTO);
    }
    console.log(`19) resultados operativos (${casos.length - 1} + éxito) se devuelven normalmente, cada uno registrado: OK`);
  }

  // ============================================================
  // 20) Saneo centralizado: error de fetch con URI, usuario, contraseña y
  //     proxy; evidencia normal y HTML oficial intactos; relectura fallida
  //     → ErrorResultadoIncierto sin tocar el error original
  // ============================================================
  {
    const SECRETOS = ['usuario-fetch', 'Contr4senaFetch', 'proxy-user', 'ProxyPass99', 'mongodb+srv://', 'cluster-fetch', 'clave-db'];
    const MENSAJE_FETCH =
      'fetch failed: connect ECONNREFUSED vía proxy http://proxy-user:ProxyPass99@proxy.corp:3128 ' +
      'hacia https://usuario-fetch:Contr4senaFetch@www.gov.uk/api/content/eta; cache mongodb+srv://app:clave-db@cluster-fetch.mongodb.net/x password=Contr4senaFetch';
    const sinSecretos = (texto, etiqueta) => {
      for (const s of SECRETOS) assert.ok(!texto.includes(s), `[${etiqueta}] contiene "${s}": ${texto}`);
    };
    const persistido = (store) => JSON.stringify(plano({ i: store.intentos, n: store.inicios, e: store.eventos, h: store.historial, p: [...store.propuestas.values()] }));
    // HTML oficial con texto que el saneador SÍ cambiaría si se le aplicara.
    const FRAGMENTO_HTML = '<p>The ETA costs £20.</p><a href="https://www.gov.uk/eta?token=abc123">Apply</a>';
    const AVISOS = ['overview y apply leídos; token=abc123 aparece en un enlace oficial'];

    // sanearTextosError (pura): solo claves de error, a cualquier profundidad.
    assert.deepStrictEqual(S.CLAVES_TEXTO_ERROR, ['error', 'mensaje', 'error_extraccion', 'motivo']);
    const evidencia = {
      causa: 'red',
      mensaje: MENSAJE_FETCH,
      anidado: { error_extraccion: MENSAJE_FETCH, fragmento_html: FRAGMENTO_HTML, lista: [{ error: MENSAJE_FETCH }] },
      avisos: AVISOS,
      fecha: T,
      cero: 0
    };
    const saneada = S.sanearTextosError(evidencia);
    sinSecretos(JSON.stringify(saneada), 'sanearTextosError');
    assert.strictEqual(saneada.anidado.fragmento_html, FRAGMENTO_HTML);
    assert.deepStrictEqual(saneada.avisos, AVISOS);
    assert.ok(saneada.fecha instanceof Date && saneada.fecha.getTime() === T.getTime());
    assert.strictEqual(saneada.cero, 0);
    assert.strictEqual(evidencia.mensaje, MENSAJE_FETCH, 'no muta la entrada');
    assert.deepStrictEqual(S.sanearTextosError(RESP_VALOR), RESP_VALOR, 'evidencia normal sin errores: idéntica');

    // a) Adaptador GOV.UK REAL con un fetch que falla con URI, usuario, contraseña y proxy.
    {
      const { propuesta, aprobacion } = propuestaAprobada({ requisitoHex: REQUISITO_ID_ETA });
      const store = crearStore({ propuestas: [propuesta], eventos: [aprobacion], destinos: [destinoFixture()] });
      let llamadasFetch = 0;
      const fetchImpl = async () => {
        llamadasFetch++;
        throw new TypeError(MENSAJE_FETCH);
      };
      const real = Object.freeze({ ...adaptadorGovUk, revalidar: (p, o) => adaptadorGovUk.revalidar(p, { ...o, fetchImpl }) });
      const { deps } = crearEntorno(store, { adaptador: real });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(llamadasFetch, 1, 'el fetch inyectado se usó (sin red real)');
      assert.deepStrictEqual([r.resultado, r.etapa_fallo], ['fuente_temporalmente_no_disponible', 'revalidacion_externa']);
      sinSecretos(r.mensaje, 'mensaje público');
      sinSecretos(persistido(store), 'persistido (fetch real)');
      const i = soloIntento(store);
      const ev = i.evidencia_fresca.revalidacion_externa.evidencia;
      assert.deepStrictEqual([ev.causa, ev.status, ev.timeout_ms], ['red', null, 8000], 'el resto de la evidencia queda igual');
      assert.ok(ev.mensaje.includes('<credenciales-redactadas>@proxy.corp:3128') && ev.mensaje.includes('<uri-mongodb-redactada>'), ev.mensaje);
      assert.ok(ev.mensaje.includes('www.gov.uk/api/content/eta'), 'la URL pública se conserva');
      assert.deepStrictEqual(i.adaptador, { nombre: 'govuk-uk-eta', version: '1' });
    }

    // b) Ambiguo con mensajes de error del adaptador + HTML oficial: transición, HTML y avisos intactos.
    {
      const resp = {
        tipo: 'ambiguo',
        motivo: `estructura_inesperada (${MENSAJE_FETCH})`,
        revalidada_en: REVALIDADA_EN,
        fuente_nombre: 'GOV.UK',
        url: URL_FUENTE,
        evidencia: {
          error_extraccion: MENSAJE_FETCH,
          mensaje: MENSAJE_FETCH,
          extraccion: { overview: { costo_extraido: 20, fragmento_html: FRAGMENTO_HTML }, apply: { costo_extraido: 25, fragmento_html: FRAGMENTO_HTML } },
          avisos: AVISOS
        }
      };
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, { respuesta: resp });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(r.resultado, 'extraccion_ambigua');
      sinSecretos(r.mensaje, 'mensaje público ambiguo');
      sinSecretos(persistido(store), 'persistido ambiguo');
      const ev = soloIntento(store).evidencia_fresca.revalidacion_externa.evidencia;
      assert.deepStrictEqual(ev.extraccion, resp.evidencia.extraccion, 'HTML oficial intacto');
      assert.deepStrictEqual(ev.avisos, AVISOS, 'avisos intactos');
      assert.ok(limpio(store.eventos[1]).motivo.includes('<uri-mongodb-redactada>'), 'motivo del evento saneado');
    }

    // c) Éxito con evidencia normal (HTML oficial incluido): persistida idéntica.
    {
      const resp = { ...RESP_VALOR, evidencia: { extraccion: { overview: { costo_extraido: 20, fragmento_html: FRAGMENTO_HTML } }, avisos: AVISOS } };
      const { store, propuesta } = escenario();
      const { deps } = crearEntorno(store, { respuesta: resp });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.strictEqual(r.resultado, 'exito');
      assert.deepStrictEqual(soloIntento(store).evidencia_fresca.revalidacion_externa, plano(resp), 'evidencia normal idéntica');
    }

    // d) Falla la escritura y también la relectura, ambas con secretos → ErrorResultadoIncierto.
    for (const [nombre, fallasBase, duplicado] of [
      ['error de commit', (original) => ({ commit: { modo: 'lanzar', error: original } }), false],
      ['E11000', (original) => ({ insertarHistorial: () => original }), true]
    ]) {
      const { store, propuesta } = escenario();
      const original = duplicado ? errorE11000('historial_cambios', 'propuesta_id_1', { propuesta_id: 1 }) : new Error(MENSAJE_FETCH);
      if (duplicado) original.message += ` ${MENSAJE_FETCH}`;
      const mensajeOriginal = original.message;
      const clavesOriginales = Object.keys(original).sort();
      const errRelectura = new Error(`relectura: ${MENSAJE_FETCH}`);
      const { deps } = crearEntorno(store, { fallas: { ...fallasBase(original), relectura: errRelectura } });
      const err = await assertRechaza(aplicarPropuesta(entradaDe(propuesta), deps), ErrorResultadoIncierto, nombre);
      assert.ok(!(err instanceof ErrorInconsistencia) && !(err instanceof ErrorEscrituraAbortada), `[${nombre}] tipado como incierto`);
      assert.strictEqual(err.cause, original, `[${nombre}] cause es el error original`);
      assert.strictEqual(original.message, mensajeOriginal, `[${nombre}] el error original no se modifica`);
      assert.deepStrictEqual(Object.keys(original).sort(), clavesOriginales, `[${nombre}] sin propiedades nuevas en el original`);
      assert.deepStrictEqual([err.intento_id, err.propuesta_id, err.error_relectura, err.duplicado], [INTENTO, PROPUESTA_ID, errRelectura, duplicado]);
      sinSecretos(err.message, `[${nombre}] mensaje público`);
      assert.ok(!err.message.includes('registrada como escritura_abortada'), `[${nombre}] no afirma registro`);
      assert.ok(err.message.includes('No se puede afirmar si quedó registrado'), err.message);
      inicioUnico(store, INTENTO, { terminados: 0 });
      sinSecretos(persistido(store), `[${nombre}] persistido`);
      assert.strictEqual(store.propuestas.get(PROPUESTA_ID).estado, 'aprobada');
    }

    // e) El CAS fallido de la transacción corta sigue siendo un resultado operativo devuelto.
    {
      const { store, propuesta } = escenario();
      const cancelar = (s) => s.propuestas.set(PROPUESTA_ID, { ...s.propuestas.get(PROPUESTA_ID), estado: 'cancelada' });
      const { deps } = crearEntorno(store, { respuesta: respValor('£25', 25), fallas: { antesDelCallback: cancelar } });
      const r = await aplicarPropuesta(entradaDe(propuesta), deps);
      assert.deepStrictEqual([r.resultado, r.etapa_fallo, r.resultado_no_registrado], ['escritura_abortada', 'transicion_por_fallo', 'fuente_cambio']);
    }
    console.log('20) saneo centralizado: fetch real con URI/usuario/contraseña/proxy saneado en todo lo persistido y en el mensaje público; HTML y evidencia normal intactos; relectura fallida → ErrorResultadoIncierto con cause intacta: OK');
  }

  console.log('\nTodas las pruebas offline del servicio de aplicación pasaron (sin conexión a Mongo, sin red).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
