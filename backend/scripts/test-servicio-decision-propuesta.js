// Pruebas offline (sin conexión a Mongo, sin red) para
// services/propuestas/decidir-propuesta.js. El flujo se prueba con un
// store falso en memoria:
//  - la "transacción" acumula las escrituras en un staging que solo se
//    consolida al hacer commit; si el callback lanza, no queda nada.
//  - el CAS toma un bloqueo sobre la propuesta; otra transacción que la
//    quiera modificar recibe un WriteConflict con la etiqueta
//    TransientTransactionError y el ejecutor falso re-ejecuta el
//    callback (como withTransaction) cuando se libera el bloqueo.
//  - cada evento pasa por document.validate() del modelo real
//    (EventoPropuesta), y los índices únicos evento_id_1 y
//    uniq_evento_por_propuesta_version se imitan a mano.
//
// LÍMITES DEL FAKE (lo que estas pruebas NO cubren):
//  - El matcher solo entiende igualdad de primer nivel (sin operadores).
//    Imita a Mongo en que {campo: null} matchea null Y campo ausente
//    (prueba 5); cualquier otra semántica de Mongo (tipos BSON, casting
//    de Mongoose, arrays) no está modelada.
//  - No hay aislamiento snapshot real: el CAS lee el estado consolidado
//    actual. Un WriteConflict por snapshot viejo se modela como bloqueo o
//    como CAS sin coincidencia, que llevan al mismo resultado.
//  - El E11000 real, el abort real del servidor y el commit ambiguo real
//    (UnknownTransactionCommitResult) requieren un replica set.
//
// Uso: node scripts/test-servicio-decision-propuesta.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');
const EventoPropuesta = require('../models/propuestas/EventoPropuesta.model.js');
const {
  ESTADOS_PROPUESTA,
  TRANSICIONES,
  TIPOS_QUE_REQUIEREN_MOTIVO,
  TIPOS_EVENTO_CON_INTENTO,
  motivoTransicionInvalida
} = require('../services/propuestas/contrato-propuestas');
const { INDICES_DECISION } = require('../services/propuestas/indices-propuestas');
const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const {
  TIPOS_DECISION,
  COMANDO,
  ErrorEntradaInvalida,
  ErrorTransicionInvalida,
  ErrorInconsistencia,
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  ErrorPrecondicionIndices,
  construirEvento,
  validarResolucionIdentidad,
  identidadPorConnectionStatus,
  verificarListadoIndices,
  decidirPropuesta,
  crearDependenciasMongoose
} = require('../services/propuestas/decidir-propuesta');
const { cargarOperadoresAutorizados, resolverActor } = require('../services/propuestas/operadores-autorizados');
const { COMANDO_PANEL, cargarOperadoresPanel, resolverOperadorPanel } = require('../services/panel/operadores-panel');

// Armado por partes para que el literal nunca aparezca en el código.
const PROPUESTA_REAL_PROTEGIDA = ['054d03c8', 'e9ba', '4352', '8370', 'e4f88534f612'].join('-');

const PROPUESTA_ID = '22222222-2222-4222-8222-222222222222';
const FECHA_PROPUESTA = '2026-09-24T12:00:02.000Z';
const OCURRIDO_EN = new Date('2026-09-28T10:00:00.000Z');
const OTRO_UUID = '77777777-7777-4777-8777-777777777777';
const USUARIO = { user: 'operador-prueba', db: 'admin' };
const OPERADORES_JSON = JSON.stringify([
  { usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' },
  { usuario_atlas: 'otro-operador', db: 'admin', identificador: 'otro.operador' }
]);
const MAX_REINTENTOS_DRIVER = 10;

const clonar = (v) => structuredClone(v);

function entradaLectura() {
  return {
    run_id: '11111111-1111-4111-8111-111111111111',
    iniciado_en: new Date('2026-09-24T12:00:00.000Z'),
    campo: 'costo',
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-24T12:00:01.000Z' },
    evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP' } } },
    estado_ejecucion: 'ok',
    destino_id: '000000000000000000000001',
    requisito_id: '000000000000000000000002',
    valor_previo_en_mongo: { presente: false, valor: null },
    resultado_comparacion: { categoria: 'SIN_COSTO_PREVIO_EN_MONGO', ambiguo: false },
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } }
  };
}

// Camino válido (según TRANSICIONES) desde pendiente_aprobacion hasta
// cada estado, para fabricar propuestas con historia consistente.
const CAMINOS = {
  pendiente_aprobacion: [],
  aprobada: ['aprobacion'],
  rechazada: ['rechazo'],
  cancelada: ['aprobacion', 'cancelacion'],
  aplicada: ['aprobacion', 'aplicacion'],
  revision_requerida: ['aprobacion', 'entrada_revision'],
  obsoleta: ['aprobacion', 'obsolescencia'],
  conflicto: ['aprobacion', 'conflicto']
};

function fixture(estadoDestino) {
  const p = {
    ...construirPropuesta(entradaLectura(), PROPUESTA_ID, FECHA_PROPUESTA),
    decision_aprobacion_id: null,
    ultimo_evento_id: null,
    createdAt: new Date('2026-09-24T12:00:03.000Z'),
    updatedAt: new Date('2026-09-24T12:00:03.000Z')
  };
  const eventos = [];
  let estado = 'pendiente_aprobacion';
  CAMINOS[estadoDestino].forEach((tipo, i) => {
    const regla = TRANSICIONES[tipo];
    const actorTipo = regla.actores[0];
    const evento = {
      evento_id: `99999999-9999-4999-8999-${String(i + 1).padStart(12, '0')}`,
      propuesta_id: p.propuesta_id,
      tipo_evento: tipo,
      estado_anterior: estado,
      estado_nuevo: regla.hacia,
      hash_contenido_referenciado: p.payload_hash,
      version_coordinacion_nueva: i + 1,
      ocurrido_en: new Date(Date.UTC(2026, 8, 25, 10, i)),
      actor: { tipo: actorTipo, identificador: actorTipo === 'humano' ? 'operador.previo' : 'aplicador-prueba' }
    };
    if (TIPOS_QUE_REQUIEREN_MOTIVO.includes(tipo)) evento.motivo = 'motivo previo';
    if (TIPOS_EVENTO_CON_INTENTO.includes(tipo)) evento.intento_aplicacion_id = '88888888-8888-4888-8888-888888888888';
    eventos.push(evento);
    if (tipo === 'aprobacion') p.decision_aprobacion_id = evento.evento_id;
    estado = regla.hacia;
  });
  p.estado = estado;
  p.version_coordinacion = eventos.length;
  p.ultimo_evento_id = eventos.at(-1)?.evento_id ?? null;
  return { propuesta: p, eventos };
}

function crearStore({ propuestas = [], eventos = [] } = {}) {
  return {
    propuestas: new Map(propuestas.map((p) => [p.propuesta_id, clonar(p)])),
    eventos: eventos.map(clonar),
    bloqueos: new Map(),
    esperas: []
  };
}

function storeDe(estado) {
  const { propuesta, eventos } = fixture(estado);
  return crearStore({ propuestas: [propuesta], eventos });
}

function foto(store) {
  return clonar({ propuestas: [...store.propuestas.values()], eventos: store.eventos });
}

// Imita a Mongo SOLO en igualdad de primer nivel: {campo: null} matchea
// null o campo ausente. Cualquier operador lanza (no está modelado).
function coincideFiltro(doc, filtro) {
  for (const [campo, valor] of Object.entries(filtro)) {
    if (valor !== null && typeof valor === 'object') throw new Error(`fake: operador no soportado en ${campo}`);
    if (valor === null) {
      if (doc[campo] !== null && doc[campo] !== undefined) return false;
    } else if (doc[campo] !== valor) {
      return false;
    }
  }
  return true;
}

function aplicarUpdate(doc, update) {
  for (const op of Object.keys(update)) {
    if (op !== '$set' && op !== '$inc') throw new Error(`fake: operador de update no soportado ${op}`);
  }
  Object.assign(doc, update.$set ?? {});
  for (const [campo, delta] of Object.entries(update.$inc ?? {})) doc[campo] = (doc[campo] ?? 0) + delta;
  return doc;
}

function liberar(store, tx) {
  for (const [id, duenio] of store.bloqueos) if (duenio === tx.id) store.bloqueos.delete(id);
  if (store.bloqueos.size === 0) store.esperas.splice(0).forEach((resolver) => resolver());
}

function esperarLiberacion(store) {
  return store.bloqueos.size === 0 ? Promise.resolve() : new Promise((resolve) => store.esperas.push(resolve));
}

function aplicarCommit(store, tx) {
  for (const [id, doc] of tx.propuestas) store.propuestas.set(id, doc);
  store.eventos.push(...tx.eventos);
  tx.propuestas.clear();
  tx.eventos.length = 0;
}

function errorTransitorio() {
  const err = new Error('WriteConflict (simulado)');
  err.code = 112;
  err.errorLabels = ['TransientTransactionError'];
  return err;
}

function errorE11000Evento(indice) {
  const keyPattern = indice === 'evento_id_1' ? { evento_id: 1 } : { propuesta_id: 1, version_coordinacion_nueva: 1 };
  const err = new Error(`E11000 duplicate key error collection: buscador_requisitos.eventos_propuesta index: ${indice} dup key`);
  err.code = 11000;
  err.keyPattern = keyPattern;
  return err;
}

const listado = (coleccion) => [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  ...INDICES_DECISION.filter((s) => s.coleccion === coleccion).map((s) => ({
    v: 2,
    key: s.clave,
    name: s.nombre,
    unique: true,
    ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {})
  }))
];
const INDICES_PROPUESTAS_OK = listado('propuestas_cambio');
const INDICES_EVENTOS_OK = listado('eventos_propuesta');

function crearEntorno(store, opciones = {}) {
  const {
    usuarios = [USUARIO],
    indicesPropuestas = INDICES_PROPUESTAS_OK,
    indicesEventos = INDICES_EVENTOS_OK,
    prefijoUuid = '33333333-3333-4333-8333-',
    uuidFijo = null,
    fallas = {}
  } = opciones;
  // Sin default de desestructuración: un `undefined` explícito tiene que
  // llegar tal cual (variable de entorno ausente).
  const operadoresJson = 'operadoresJson' in opciones ? opciones.operadoresJson : OPERADORES_JSON;
  const llamadas = {
    uuid: 0,
    ahora: 0,
    operadores: 0,
    usuarios: 0,
    verificarIndices: 0,
    validarEvento: 0,
    transacciones: 0,
    callbacks: 0,
    cas: 0,
    insertarEvento: 0,
    relecturas: 0
  };

  const deps = {
    uuid: () => {
      llamadas.uuid++;
      return uuidFijo ?? `${prefijoUuid}${String(llamadas.uuid).padStart(12, '0')}`;
    },
    // Avanza 1 s por llamada: si ocurrido_en se regenerara, se notaría.
    ahora: () => {
      llamadas.ahora++;
      return new Date(OCURRIDO_EN.getTime() + (llamadas.ahora - 1) * 1000);
    },
    operadoresAutorizados: () => {
      llamadas.operadores++;
      return cargarOperadoresAutorizados(operadoresJson);
    },
    usuariosAutenticados: async () => {
      llamadas.usuarios++;
      return usuarios;
    },
    verificarIndices: async () => {
      llamadas.verificarIndices++;
      verificarListadoIndices(indicesPropuestas, indicesEventos);
    },
    validarEvento: async (doc) => {
      llamadas.validarEvento++;
      await new EventoPropuesta(doc).validate();
    },
    ejecutarTransaccion: async (fn) => {
      llamadas.transacciones++;
      for (let intento = 1; ; intento++) {
        const tx = { id: Symbol('tx'), propuestas: new Map(), eventos: [] };
        llamadas.callbacks++;
        try {
          if (fallas.antesDelCallback && intento === 1) fallas.antesDelCallback(store);
          await fn(tx);
          if (fallas.transitorioAlCommit && intento === 1) throw errorTransitorio();
          if (fallas.commit === 'sin_aplicar') throw new Error('commit fallido (simulado, sin aplicar)');
          aplicarCommit(store, tx);
          liberar(store, tx);
          if (fallas.trasCommit) fallas.trasCommit(store);
          if (fallas.commit === 'aplicado_con_error') throw new Error('UnknownTransactionCommitResult (simulado, sí se aplicó)');
          return;
        } catch (err) {
          liberar(store, tx);
          if (err.errorLabels?.includes('TransientTransactionError') && intento < MAX_REINTENTOS_DRIVER) {
            await esperarLiberacion(store);
            continue;
          }
          throw err;
        }
      }
    },
    actualizarPropuestaCas: async (filtro, update, tx) => {
      llamadas.cas++;
      const id = filtro.propuesta_id;
      const actual = tx.propuestas.get(id) ?? store.propuestas.get(id);
      if (!actual || !coincideFiltro(actual, filtro)) return { matchedCount: 0, modifiedCount: 0 };
      const duenio = store.bloqueos.get(id);
      if (duenio && duenio !== tx.id) {
        if (fallas.alConflicto) fallas.alConflicto();
        throw errorTransitorio();
      }
      store.bloqueos.set(id, tx.id);
      if (fallas.modifiedCountCero) return { matchedCount: 1, modifiedCount: 0 };
      tx.propuestas.set(id, aplicarUpdate(clonar(actual), update));
      if (fallas.pausaTrasCas) await fallas.pausaTrasCas;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    insertarEvento: async (doc, tx) => {
      llamadas.insertarEvento++;
      await new EventoPropuesta(doc).validate();
      const falla = fallas.insertarEvento && fallas.insertarEvento(store, tx, doc);
      if (falla) throw falla;
      const todos = [...store.eventos, ...tx.eventos];
      if (todos.some((e) => e.evento_id === doc.evento_id)) throw errorE11000Evento('evento_id_1');
      if (todos.some((e) => e.propuesta_id === doc.propuesta_id && e.version_coordinacion_nueva === doc.version_coordinacion_nueva)) {
        throw errorE11000Evento('uniq_evento_por_propuesta_version');
      }
      tx.eventos.push(clonar(doc));
    },
    leerPropuesta: async (id) => {
      llamadas.relecturas++;
      if (fallas.relectura) throw fallas.relectura;
      return clonar(store.propuestas.get(id)) ?? null;
    },
    leerEvento: async (id) => {
      if (fallas.relectura) throw fallas.relectura;
      return clonar(store.eventos.find((e) => e.evento_id === id)) ?? null;
    }
  };
  return { deps, llamadas };
}

function entradaDesde(p, tipo, extra = {}) {
  const entrada = {
    tipo_evento: tipo,
    propuesta_id: p.propuesta_id,
    estado_esperado: p.estado,
    payload_hash_esperado: p.payload_hash,
    version_coordinacion_esperada: p.version_coordinacion,
    decision_aprobacion_id_esperado: p.decision_aprobacion_id ?? null
  };
  if (TIPOS_QUE_REQUIEREN_MOTIVO.includes(tipo)) entrada.motivo = 'motivo de prueba';
  return { ...entrada, ...extra };
}

// Escrito a mano (no vía construirEvento) para no validar el servicio
// contra sí mismo.
function eventoEsperado(entrada, eventoId, ocurridoEn = OCURRIDO_EN) {
  const detalle = {
    identidad_operador: { metodo: 'connection_status', usuario_atlas: 'operador-prueba', db_autenticacion: 'admin' },
    comando: { nombre: 'decidir-propuesta', version: '1' }
  };
  if (entrada.tipo_evento === 'cancelacion') detalle.decision_aprobacion_id_cancelada = entrada.decision_aprobacion_id_esperado;
  const e = {
    evento_id: eventoId,
    propuesta_id: entrada.propuesta_id,
    tipo_evento: entrada.tipo_evento,
    estado_anterior: entrada.estado_esperado,
    estado_nuevo: TRANSICIONES[entrada.tipo_evento].hacia,
    hash_contenido_referenciado: entrada.payload_hash_esperado,
    version_coordinacion_nueva: entrada.version_coordinacion_esperada + 1,
    ocurrido_en: ocurridoEn,
    actor: { tipo: 'humano', identificador: 'operador.prueba' },
    detalle
  };
  if (entrada.motivo !== undefined) e.motivo = entrada.motivo.trim();
  return e;
}

// Historia lineal y cache de estado coherente para cada propuesta.
function verificarInvariantes(store, etiqueta) {
  const ids = store.eventos.map((e) => e.evento_id);
  assert.strictEqual(new Set(ids).size, ids.length, `[${etiqueta}] evento_id repetido`);
  for (const p of store.propuestas.values()) {
    const evs = store.eventos
      .filter((e) => e.propuesta_id === p.propuesta_id)
      .sort((a, b) => a.version_coordinacion_nueva - b.version_coordinacion_nueva);
    assert.strictEqual(evs.length, p.version_coordinacion, `[${etiqueta}] #eventos === version_coordinacion`);
    evs.forEach((e, i) => {
      assert.strictEqual(e.version_coordinacion_nueva, i + 1, `[${etiqueta}] versiones 1..n sin huecos`);
      assert.strictEqual(e.estado_anterior, i === 0 ? 'pendiente_aprobacion' : evs[i - 1].estado_nuevo, `[${etiqueta}] cadena de estados`);
      assert.strictEqual(e.hash_contenido_referenciado, p.payload_hash, `[${etiqueta}] hash del evento`);
    });
    assert.strictEqual(p.ultimo_evento_id ?? null, evs.at(-1)?.evento_id ?? null, `[${etiqueta}] ultimo_evento_id`);
    assert.strictEqual(p.estado, evs.at(-1)?.estado_nuevo ?? 'pendiente_aprobacion', `[${etiqueta}] estado cacheado`);
    if (p.decision_aprobacion_id != null) {
      assert.ok(
        evs.some((e) => e.evento_id === p.decision_aprobacion_id && e.tipo_evento === 'aprobacion'),
        `[${etiqueta}] decision_aprobacion_id apunta a una aprobación`
      );
    } else {
      assert.ok(!evs.some((e) => e.tipo_evento === 'aprobacion'), `[${etiqueta}] aprobación sin decision_aprobacion_id`);
    }
  }
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

const CASOS_PERMITIDOS = TIPOS_DECISION.flatMap((tipo) => TRANSICIONES[tipo].desde.map((estado) => ({ tipo, estado })));

function hashAlterado(h) {
  return h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
}

(async () => {
  // ============================================================
  // 1) Contrato y fixtures
  // ============================================================
  {
    assert.deepStrictEqual(TIPOS_DECISION, ['aprobacion', 'rechazo', 'cancelacion']);
    assert.deepStrictEqual(CASOS_PERMITIDOS, [
      { tipo: 'aprobacion', estado: 'pendiente_aprobacion' },
      { tipo: 'rechazo', estado: 'pendiente_aprobacion' },
      { tipo: 'cancelacion', estado: 'aprobada' },
      { tipo: 'cancelacion', estado: 'revision_requerida' }
    ]);
    assert.deepStrictEqual(Object.keys(CAMINOS).sort(), [...ESTADOS_PROPUESTA].sort());
    for (const estado of ESTADOS_PROPUESTA) {
      const { propuesta, eventos } = fixture(estado);
      assert.notStrictEqual(propuesta.propuesta_id, PROPUESTA_REAL_PROTEGIDA);
      await new PropuestaCambio(propuesta).validate();
      for (const e of eventos) {
        assert.strictEqual(motivoTransicionInvalida(e.tipo_evento, e.estado_anterior, e.estado_nuevo, e.actor.tipo), null);
        await new EventoPropuesta(e).validate();
      }
      verificarInvariantes(crearStore({ propuestas: [propuesta], eventos }), `fixture ${estado}`);
    }
    console.log('1) TIPOS_DECISION derivado del contrato; fixtures válidas para los 8 estados: OK');
  }

  // ============================================================
  // 2) Matriz completa operación × estado (3 × 8), vista = documento
  // ============================================================
  {
    let permitidos = 0;
    for (const tipo of TIPOS_DECISION) {
      for (const estado of ESTADOS_PROPUESTA) {
        const etiqueta = `${tipo} desde ${estado}`;
        const store = storeDe(estado);
        const antes = foto(store);
        const [p] = antes.propuestas;
        const { deps, llamadas } = crearEntorno(store);
        const entrada = entradaDesde(p, tipo);

        if (!TRANSICIONES[tipo].desde.includes(estado)) {
          await assertRechaza(decidirPropuesta(entrada, deps), ErrorTransicionInvalida, etiqueta);
          assert.deepStrictEqual(foto(store), antes, `[${etiqueta}] sin cambios`);
          assert.deepStrictEqual(
            [llamadas.operadores, llamadas.usuarios, llamadas.verificarIndices, llamadas.uuid, llamadas.transacciones],
            [0, 0, 0, 0, 0],
            `[${etiqueta}] se rechaza antes de todo I/O`
          );
          continue;
        }

        permitidos++;
        const r = await decidirPropuesta(entrada, deps);
        const eventoId = '33333333-3333-4333-8333-000000000001';
        const hacia = TRANSICIONES[tipo].hacia;
        assert.deepStrictEqual(r, {
          resultado: 'decision_registrada',
          tipo_evento: tipo,
          propuesta_id: PROPUESTA_ID,
          evento_id: eventoId,
          estado_anterior: estado,
          estado_nuevo: hacia,
          version_coordinacion_nueva: p.version_coordinacion + 1,
          ocurrido_en: OCURRIDO_EN,
          actor: { tipo: 'humano', identificador: 'operador.prueba' },
          confirmada_por_relectura: false,
          causa_relectura: null
        });
        const despues = store.propuestas.get(PROPUESTA_ID);
        const decisionEsperada = tipo === 'aprobacion' ? eventoId : p.decision_aprobacion_id;
        assert.deepStrictEqual(despues, {
          ...p,
          estado: hacia,
          version_coordinacion: p.version_coordinacion + 1,
          ultimo_evento_id: eventoId,
          decision_aprobacion_id: decisionEsperada,
          updatedAt: OCURRIDO_EN
        });
        assert.strictEqual(store.eventos.length, antes.eventos.length + 1);
        assert.deepStrictEqual(store.eventos.at(-1), eventoEsperado(entrada, eventoId));
        assert.deepStrictEqual([llamadas.uuid, llamadas.ahora, llamadas.transacciones, llamadas.callbacks], [1, 1, 1, 1]);
        verificarInvariantes(store, etiqueta);
      }
    }
    assert.strictEqual(permitidos, 4);
    console.log('2) matriz 3×8: 4 transiciones registradas con evento exacto, 20 rechazadas antes de todo I/O: OK');
  }

  // ============================================================
  // 3) Vista válida pero el documento está en otro estado → CAS falla
  // ============================================================
  {
    let casos = 0;
    for (const { tipo, estado: estadoVisto } of CASOS_PERMITIDOS) {
      const vista = fixture(estadoVisto).propuesta;
      for (const estadoReal of ESTADOS_PROPUESTA.filter((e) => e !== estadoVisto)) {
        const etiqueta = `${tipo}: visto ${estadoVisto}, real ${estadoReal}`;
        const store = storeDe(estadoReal);
        const antes = foto(store);
        const { deps, llamadas } = crearEntorno(store);
        const r = await decidirPropuesta(entradaDesde(vista, tipo), deps);
        const real = antes.propuestas[0];
        assert.strictEqual(r.resultado, 'cas_no_coincide', etiqueta);
        assert.strictEqual(r.escrito, false, etiqueta);
        assert.deepStrictEqual(r.actual, {
          estado: real.estado,
          payload_hash: real.payload_hash,
          version_coordinacion: real.version_coordinacion,
          decision_aprobacion_id: real.decision_aprobacion_id,
          ultimo_evento_id: real.ultimo_evento_id
        });
        assert.deepStrictEqual(foto(store), antes, `[${etiqueta}] sin cambios`);
        assert.deepStrictEqual([llamadas.transacciones, llamadas.callbacks, llamadas.insertarEvento], [1, 1, 0], `[${etiqueta}] sin reintento`);
        casos++;
      }
    }
    assert.strictEqual(casos, 28);
    console.log('3) 28 combinaciones vista válida / documento en otro estado → cas_no_coincide, cero escrituras, sin reintento: OK');
  }

  // ============================================================
  // 4) CAS con hash, versión o decisión distintos a los vistos
  // ============================================================
  {
    for (const { tipo, estado } of CASOS_PERMITIDOS) {
      const base = fixture(estado).propuesta;
      const variantes = [
        ['hash con un carácter distinto', { payload_hash_esperado: hashAlterado(base.payload_hash) }],
        ['versión +1', { version_coordinacion_esperada: base.version_coordinacion + 1 }]
      ];
      if (base.version_coordinacion > 0) variantes.push(['versión -1', { version_coordinacion_esperada: base.version_coordinacion - 1 }]);
      if (tipo === 'cancelacion') variantes.push(['decision_aprobacion_id distinto', { decision_aprobacion_id_esperado: OTRO_UUID }]);

      for (const [nombre, extra] of variantes) {
        const etiqueta = `${tipo} desde ${estado}: ${nombre}`;
        const store = storeDe(estado);
        const antes = foto(store);
        const { deps, llamadas } = crearEntorno(store);
        const r = await decidirPropuesta(entradaDesde(base, tipo, extra), deps);
        assert.strictEqual(r.resultado, 'cas_no_coincide', etiqueta);
        assert.deepStrictEqual(foto(store), antes, `[${etiqueta}] sin cambios`);
        assert.deepStrictEqual([llamadas.transacciones, llamadas.callbacks, llamadas.insertarEvento, llamadas.uuid], [1, 1, 0, 1], etiqueta);
      }

      if (tipo !== 'cancelacion') {
        // Documento pendiente con decision_aprobacion_id ya puesto (inconsistente).
        const store = crearStore({ propuestas: [{ ...base, decision_aprobacion_id: OTRO_UUID }] });
        const antes = foto(store);
        const { deps } = crearEntorno(store);
        const r = await decidirPropuesta(entradaDesde(base, tipo), deps);
        assert.strictEqual(r.resultado, 'cas_no_coincide', `${tipo}: documento con decisión no nula`);
        assert.deepStrictEqual(foto(store), antes);
      }

      const vacio = crearStore();
      const { deps } = crearEntorno(vacio);
      const r = await decidirPropuesta(entradaDesde(base, tipo), deps);
      assert.strictEqual(r.resultado, 'cas_no_coincide');
      assert.strictEqual(r.actual, null, `${tipo}: propuesta inexistente → actual null`);
      assert.strictEqual(vacio.eventos.length, 0);
    }
    console.log('4) hash/versión/decisión distintos y propuesta inexistente → cas_no_coincide, cero escrituras: OK');
  }

  // ============================================================
  // 5) El matcher falso imita a Mongo: {campo: null} matchea ausente
  // ============================================================
  {
    assert.strictEqual(coincideFiltro({}, { decision_aprobacion_id: null }), true);
    assert.strictEqual(coincideFiltro({ decision_aprobacion_id: null }, { decision_aprobacion_id: null }), true);
    assert.strictEqual(coincideFiltro({ decision_aprobacion_id: undefined }, { decision_aprobacion_id: null }), true);
    assert.strictEqual(coincideFiltro({ decision_aprobacion_id: OTRO_UUID }, { decision_aprobacion_id: null }), false);
    assert.throws(() => coincideFiltro({}, { estado: { $in: ['aprobada'] } }), /no soportado/);

    const p = fixture('pendiente_aprobacion').propuesta;
    delete p.decision_aprobacion_id;
    const store = crearStore({ propuestas: [p] });
    const { deps } = crearEntorno(store);
    const r = await decidirPropuesta(entradaDesde(p, 'aprobacion'), deps);
    assert.strictEqual(r.resultado, 'decision_registrada');
    assert.strictEqual(store.propuestas.get(PROPUESTA_ID).decision_aprobacion_id, r.evento_id);
    verificarInvariantes(store, 'aprobación con campo ausente');
    console.log('5) {decision_aprobacion_id: null} matchea el campo ausente (igual que Mongo) y la aprobación procede: OK');
  }

  // ============================================================
  // 6) Dos decisiones simultáneas sobre la misma propuesta: una sola gana
  // ============================================================
  {
    for (const [tipoA, tipoB] of [
      ['aprobacion', 'aprobacion'],
      ['rechazo', 'aprobacion'],
      ['aprobacion', 'rechazo']
    ]) {
      const etiqueta = `${tipoA} ∥ ${tipoB}`;
      const store = storeDe('pendiente_aprobacion');
      const [p] = foto(store).propuestas;
      let soltarA;
      const pausa = new Promise((resolve) => (soltarA = resolve));
      const a = crearEntorno(store, { fallas: { pausaTrasCas: pausa } });
      const b = crearEntorno(store, { prefijoUuid: '44444444-4444-4444-8444-', fallas: { alConflicto: () => soltarA() } });

      const [ra, rb] = await Promise.all([
        decidirPropuesta(entradaDesde(p, tipoA), a.deps),
        decidirPropuesta(entradaDesde(p, tipoB), b.deps)
      ]);
      assert.strictEqual(ra.resultado, 'decision_registrada', etiqueta);
      assert.strictEqual(rb.resultado, 'cas_no_coincide', etiqueta);
      assert.strictEqual(rb.actual.version_coordinacion, 1);
      assert.strictEqual(rb.actual.ultimo_evento_id, ra.evento_id);
      assert.strictEqual(b.llamadas.callbacks, 2, `[${etiqueta}] B: WriteConflict + re-ejecución`);
      assert.strictEqual(b.llamadas.uuid, 1, `[${etiqueta}] B no regenera evento_id`);
      assert.strictEqual(store.eventos.length, 1);
      assert.strictEqual(store.eventos[0].evento_id, ra.evento_id);
      verificarInvariantes(store, etiqueta);
    }

    // Cinco a la vez, con intercalado natural.
    const store = storeDe('pendiente_aprobacion');
    const [p] = foto(store).propuestas;
    const tipos = ['aprobacion', 'rechazo', 'aprobacion', 'rechazo', 'aprobacion'];
    const resultados = await Promise.all(
      tipos.map((tipo, i) =>
        decidirPropuesta(entradaDesde(p, tipo), crearEntorno(store, { prefijoUuid: `5555555${i}-5555-4555-8555-` }).deps)
      )
    );
    assert.strictEqual(resultados.filter((r) => r.resultado === 'decision_registrada').length, 1);
    assert.strictEqual(resultados.filter((r) => r.resultado === 'cas_no_coincide').length, 4);
    assert.strictEqual(store.eventos.length, 1);
    verificarInvariantes(store, '5 simultáneas');
    console.log('6) decisiones simultáneas (2 con WriteConflict forzado y 5 intercaladas): una sola gana, un solo evento: OK');
  }

  // ============================================================
  // 7) evento_id y ocurrido_en se generan una sola vez
  // ============================================================
  {
    const store = storeDe('aprobada');
    const [p] = foto(store).propuestas;
    const { deps, llamadas } = crearEntorno(store, { fallas: { transitorioAlCommit: true } });
    const r = await decidirPropuesta(entradaDesde(p, 'cancelacion'), deps);
    assert.strictEqual(r.resultado, 'decision_registrada');
    assert.deepStrictEqual([llamadas.callbacks, llamadas.uuid, llamadas.ahora], [2, 1, 1]);
    assert.strictEqual(store.eventos.at(-1).evento_id, '33333333-3333-4333-8333-000000000001');
    assert.deepStrictEqual(store.eventos.at(-1).ocurrido_en, OCURRIDO_EN);
    verificarInvariantes(store, 'reintento transitorio');
    console.log('7) TransientTransactionError: callback re-ejecutado con el mismo evento_id y ocurrido_en: OK');
  }

  // ============================================================
  // 8) Rollback: nunca queda propuesta movida sin evento, ni evento suelto
  // ============================================================
  {
    for (const { tipo, estado } of CASOS_PERMITIDOS) {
      const escenarios = [
        ['error de red al insertar el evento', { insertarEvento: () => new Error('red caída (simulado)') }, 'red caída'],
        ['error de validación al insertar', { insertarEvento: () => new Error('ValidationError (simulado)') }, 'ValidationError'],
        ['commit fallido sin aplicar', { commit: 'sin_aplicar' }, 'commit fallido'],
        ['modifiedCount 0', { modifiedCountCero: true }, ErrorInconsistencia]
      ];
      for (const [nombre, fallas, esperado] of escenarios) {
        const etiqueta = `${tipo} desde ${estado}: ${nombre}`;
        const store = storeDe(estado);
        const antes = foto(store);
        const { deps, llamadas } = crearEntorno(store, { fallas });
        await assertRechaza(decidirPropuesta(entradaDesde(antes.propuestas[0], tipo), deps), esperado, etiqueta);
        assert.deepStrictEqual(foto(store), antes, `[${etiqueta}] propuesta y eventos intactos`);
        assert.strictEqual(store.bloqueos.size, 0, `[${etiqueta}] sin bloqueos colgados`);
        assert.strictEqual(llamadas.transacciones, 1, `[${etiqueta}] sin reintento`);
        verificarInvariantes(store, etiqueta);
      }
    }

    // Relectura también fallida: el error lo dice explícitamente.
    const store = storeDe('pendiente_aprobacion');
    const antes = foto(store);
    const { deps } = crearEntorno(store, { fallas: { commit: 'sin_aplicar', relectura: new Error('relectura caída') } });
    await assertRechaza(decidirPropuesta(entradaDesde(antes.propuestas[0], 'aprobacion'), deps), 'INCIERTO', 'relectura fallida');
    assert.deepStrictEqual(foto(store), antes);
    console.log('8) rollback (insert, validación, commit, modifiedCount 0): propuesta y eventos intactos, sin reintento: OK');
  }

  // ============================================================
  // 9) E11000 en eventos: escritura directa por fuera del servicio
  // ============================================================
  {
    // uniq_evento_por_propuesta_version: alguien insertó a mano un evento v+1.
    {
      const { propuesta, eventos } = fixture('pendiente_aprobacion');
      const intruso = { ...eventoEsperado(entradaDesde(propuesta, 'rechazo'), OTRO_UUID), actor: { tipo: 'humano', identificador: 'intruso' } };
      const store = crearStore({ propuestas: [propuesta], eventos: [...eventos, intruso] });
      const antes = foto(store);
      const { deps, llamadas } = crearEntorno(store);
      const err = await assertRechaza(decidirPropuesta(entradaDesde(propuesta, 'aprobacion'), deps), ErrorInconsistencia, 'versión ocupada');
      assert.ok(err.message.includes('uniq_evento_por_propuesta_version'));
      assert.deepStrictEqual(foto(store), antes);
      assert.strictEqual(llamadas.transacciones, 1);
    }
    // evento_id_1: el evento_id generado ya existe (con otro contenido).
    {
      const { propuesta, eventos } = fixture('aprobada');
      const store = crearStore({ propuestas: [propuesta], eventos });
      const antes = foto(store);
      const { deps } = crearEntorno(store, { uuidFijo: eventos[0].evento_id });
      const err = await assertRechaza(decidirPropuesta(entradaDesde(propuesta, 'cancelacion'), deps), ErrorInconsistencia, 'evento_id repetido');
      assert.ok(err.message.includes('evento_id_1'));
      assert.deepStrictEqual(foto(store), antes);
    }
    console.log('9) E11000 de uniq_evento_por_propuesta_version / evento_id_1 sin decisión confirmada → ErrorInconsistencia, sin cambios: OK');
  }

  // ============================================================
  // 10) Confirmación idempotente por relectura
  // ============================================================
  {
    // a) Commit aplicado pero informado como error (commit ambiguo).
    for (const { tipo, estado } of CASOS_PERMITIDOS) {
      const store = storeDe(estado);
      const { deps } = crearEntorno(store, { fallas: { commit: 'aplicado_con_error' } });
      const r = await decidirPropuesta(entradaDesde(foto(store).propuestas[0], tipo), deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.strictEqual(r.confirmada_por_relectura, true);
      assert.strictEqual(r.causa_relectura, 'error_transaccion');
      verificarInvariantes(store, `commit ambiguo ${tipo}`);
    }

    // b) E11000 con la decisión ya persistida exactamente → ya confirmada.
    const persistirYDuplicar = (indice) => (store, tx, doc) => {
      for (const [id, d] of tx.propuestas) store.propuestas.set(id, d);
      store.eventos.push(clonar(doc));
      tx.propuestas.clear();
      return errorE11000Evento(indice);
    };
    for (const indice of ['evento_id_1', 'uniq_evento_por_propuesta_version']) {
      const store = storeDe('pendiente_aprobacion');
      const { deps } = crearEntorno(store, { fallas: { insertarEvento: persistirYDuplicar(indice) } });
      const r = await decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'rechazo'), deps);
      assert.strictEqual(r.resultado, 'decision_registrada', indice);
      assert.strictEqual(r.causa_relectura, 'duplicado_evento');
      assert.strictEqual(store.eventos.length, 1);
      verificarInvariantes(store, `E11000 confirmado ${indice}`);
    }

    // c) E11000 con la decisión persistida pero algo difiere → inconsistencia.
    const mutaciones = [
      ['actor distinto', (s) => (s.eventos.at(-1).actor.identificador = 'otro.operador')],
      ['motivo distinto', (s) => (s.eventos.at(-1).motivo = 'otro motivo')],
      ['hash del evento distinto', (s) => (s.eventos.at(-1).hash_contenido_referenciado = hashAlterado(s.eventos.at(-1).hash_contenido_referenciado))],
      ['estado_nuevo del evento distinto', (s) => (s.eventos.at(-1).estado_nuevo = 'aprobada')],
      ['tipo del evento distinto', (s) => (s.eventos.at(-1).tipo_evento = 'aprobacion')],
      ['ocurrido_en distinto', (s) => (s.eventos.at(-1).ocurrido_en = new Date(0))],
      ['versión de la propuesta distinta', (s) => (s.propuestas.get(PROPUESTA_ID).version_coordinacion = 7)],
      ['estado de la propuesta distinto', (s) => (s.propuestas.get(PROPUESTA_ID).estado = 'pendiente_aprobacion')],
      ['ultimo_evento_id distinto', (s) => (s.propuestas.get(PROPUESTA_ID).ultimo_evento_id = OTRO_UUID)],
      ['evento ausente', (s) => s.eventos.pop()]
    ];
    for (const [nombre, mutar] of mutaciones) {
      const store = storeDe('pendiente_aprobacion');
      const { deps } = crearEntorno(store, {
        fallas: {
          insertarEvento: (s, tx, doc) => {
            const err = persistirYDuplicar('uniq_evento_por_propuesta_version')(s, tx, doc);
            mutar(s);
            return err;
          }
        }
      });
      await assertRechaza(decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'rechazo'), deps), ErrorInconsistencia, `E11000 + ${nombre}`);
    }

    // d) Commit ambiguo con rastro parcial (evento alterado tras el commit).
    {
      const store = storeDe('pendiente_aprobacion');
      const { deps } = crearEntorno(store, {
        fallas: { commit: 'aplicado_con_error', trasCommit: (s) => (s.eventos.at(-1).actor.identificador = 'otro.operador') }
      });
      await assertRechaza(decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'aprobacion'), deps), ErrorInconsistencia, 'commit ambiguo parcial');
    }

    // e) CAS sin coincidencia porque ESTA misma decisión ya estaba aplicada.
    {
      const store = storeDe('aprobada');
      const [p] = foto(store).propuestas;
      const entrada = entradaDesde(p, 'cancelacion');
      const resolucion = { ...resolverActor([USUARIO], cargarOperadoresAutorizados(OPERADORES_JSON)), comando: COMANDO };
      const evento = construirEvento(entrada, '33333333-3333-4333-8333-000000000001', OCURRIDO_EN, resolucion);
      const { deps } = crearEntorno(store, {
        fallas: {
          antesDelCallback: (s) => {
            Object.assign(s.propuestas.get(PROPUESTA_ID), {
              estado: 'cancelada',
              version_coordinacion: 2,
              ultimo_evento_id: evento.evento_id,
              updatedAt: OCURRIDO_EN
            });
            s.eventos.push(clonar(evento));
          }
        }
      });
      const r = await decidirPropuesta(entrada, deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.strictEqual(r.causa_relectura, 'cas_no_coincide');
      verificarInvariantes(store, 'cas propio');
    }

    // f) Solo difiere propuesta.updatedAt o solo difiere evento.detalle:
    //    ErrorInconsistencia por los tres caminos de relectura, y la
    //    diferencia informada es EXACTAMENTE ese campo (nada más cambió).
    const soloUnCampo = [
      ['propuesta.updatedAt', 'updatedAt distinto de ocurrido_en', (s) => (s.propuestas.get(PROPUESTA_ID).updatedAt = new Date(OCURRIDO_EN.getTime() + 1))],
      ['propuesta.updatedAt', 'updatedAt ausente', (s) => delete s.propuestas.get(PROPUESTA_ID).updatedAt],
      ['evento.detalle', 'detalle.identidad_operador.usuario_atlas distinto', (s) => (s.eventos.at(-1).detalle.identidad_operador.usuario_atlas = 'otro-operador')],
      ['evento.detalle', 'detalle.identidad_operador.metodo distinto', (s) => (s.eventos.at(-1).detalle.identidad_operador.metodo = 'otro_metodo')],
      ['evento.detalle', 'detalle.comando.version distinta', (s) => (s.eventos.at(-1).detalle.comando.version = '2')],
      ['evento.detalle', 'detalle con clave extra', (s) => (s.eventos.at(-1).detalle.extra = true)],
      ['evento.detalle', 'detalle sin comando', (s) => delete s.eventos.at(-1).detalle.comando],
      ['evento.detalle', 'detalle ausente', (s) => delete s.eventos.at(-1).detalle]
    ];
    const assertSoloDifiere = (err, campo, etiqueta) => {
      const nombres = [...err.message.matchAll(/(propuesta|evento)\.[a-zA-Z_]+(?==)/g)].map((m) => m[0]);
      assert.deepStrictEqual(nombres, [campo], `[${etiqueta}] diferencias informadas: ${err.message}`);
    };
    for (const [campo, nombre, mutar] of soloUnCampo) {
      // E11000 con la decisión persistida.
      {
        const store = storeDe('pendiente_aprobacion');
        const { deps } = crearEntorno(store, {
          fallas: {
            insertarEvento: (s, tx, doc) => {
              const err = persistirYDuplicar('evento_id_1')(s, tx, doc);
              mutar(s);
              return err;
            }
          }
        });
        const err = await assertRechaza(decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'rechazo'), deps), ErrorInconsistencia, `E11000 + ${nombre}`);
        assertSoloDifiere(err, campo, `E11000 + ${nombre}`);
      }
      // Commit ambiguo (aplicado, informado como error).
      {
        const store = storeDe('pendiente_aprobacion');
        const { deps } = crearEntorno(store, { fallas: { commit: 'aplicado_con_error', trasCommit: mutar } });
        const err = await assertRechaza(decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'aprobacion'), deps), ErrorInconsistencia, `commit ambiguo + ${nombre}`);
        assertSoloDifiere(err, campo, `commit ambiguo + ${nombre}`);
      }
      // CAS sin coincidencia con esta decisión ya escrita.
      {
        const store = storeDe('aprobada');
        const entrada = entradaDesde(foto(store).propuestas[0], 'cancelacion');
        const resolucion = { ...resolverActor([USUARIO], cargarOperadoresAutorizados(OPERADORES_JSON)), comando: COMANDO };
        const evento = construirEvento(entrada, '33333333-3333-4333-8333-000000000001', OCURRIDO_EN, resolucion);
        const { deps } = crearEntorno(store, {
          fallas: {
            antesDelCallback: (s) => {
              Object.assign(s.propuestas.get(PROPUESTA_ID), {
                estado: 'cancelada',
                version_coordinacion: 2,
                ultimo_evento_id: evento.evento_id,
                updatedAt: OCURRIDO_EN
              });
              s.eventos.push(clonar(evento));
              mutar(s);
            }
          }
        });
        const err = await assertRechaza(decidirPropuesta(entrada, deps), ErrorInconsistencia, `CAS propio + ${nombre}`);
        assertSoloDifiere(err, campo, `CAS propio + ${nombre}`);
      }
    }

    // g) El detalle se compara canonicalizado: el mismo contenido con otro
    //    orden de claves (como puede devolverlo Mongo) sigue confirmando.
    {
      const store = storeDe('pendiente_aprobacion');
      const reordenar = (s) => {
        const ev = s.eventos.at(-1);
        const { identidad_operador: io, comando } = ev.detalle;
        ev.detalle = {
          comando: { version: comando.version, nombre: comando.nombre },
          identidad_operador: { db_autenticacion: io.db_autenticacion, usuario_atlas: io.usuario_atlas, metodo: io.metodo }
        };
      };
      const { deps } = crearEntorno(store, { fallas: { commit: 'aplicado_con_error', trasCommit: reordenar } });
      const r = await decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'aprobacion'), deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.strictEqual(r.causa_relectura, 'error_transaccion');
      assert.deepStrictEqual(foto(store).eventos.at(-1).detalle.identidad_operador, {
        db_autenticacion: 'admin',
        usuario_atlas: 'operador-prueba',
        metodo: 'connection_status'
      }, 'usuario_atlas se conserva en detalle.identidad_operador');
    }
    console.log('10) relectura idempotente: confirma solo con propuesta (incl. updatedAt) y evento (incl. detalle canónico) exactos; cualquier diferencia → ErrorInconsistencia: OK');
  }

  // ============================================================
  // 11) Rechazos de actor: antes del gate y de toda transacción
  // ============================================================
  {
    const store = storeDe('pendiente_aprobacion');
    const antes = foto(store);
    const [p] = antes.propuestas;
    const casos = [
      ['sin usuarios autenticados', []],
      ['dos usuarios autenticados', [USUARIO, { user: 'otro-operador', db: 'admin' }]],
      ['usuario fuera de la lista', [{ user: 'backend-app', db: 'admin' }]],
      ['usuario correcto, otra db', [{ user: 'operador-prueba', db: 'buscador_requisitos' }]],
      ['user vacío', [{ user: '', db: 'admin' }]],
      ['authenticatedUsers no es array', null]
    ];
    for (const [nombre, usuarios] of casos) {
      const { deps, llamadas } = crearEntorno(store, { usuarios });
      await assertRechaza(decidirPropuesta(entradaDesde(p, 'aprobacion'), deps), ErrorActorNoAutorizado, nombre);
      assert.deepStrictEqual([llamadas.verificarIndices, llamadas.uuid, llamadas.transacciones], [0, 0, 0], nombre);
    }
    for (const [nombre, extra] of [
      ['actor en la entrada', { actor: { tipo: 'humano', identificador: 'operador.prueba' } }],
      ['identidad_declarada en la entrada', { identidad_declarada: 'operador.prueba' }]
    ]) {
      const { deps, llamadas } = crearEntorno(store);
      await assertRechaza(decidirPropuesta(entradaDesde(p, 'aprobacion', extra), deps), ErrorEntradaInvalida, nombre);
      assert.deepStrictEqual([llamadas.operadores, llamadas.usuarios, llamadas.transacciones], [0, 0, 0], nombre);
    }
    assert.deepStrictEqual(foto(store), antes);
    console.log('11) actor rechazado (0/2 usuarios, fuera de lista, otra db, actor en la entrada): sin gate ni transacción: OK');
  }

  // ============================================================
  // 12) Configuración de operadores inválida: aborta antes de todo
  // ============================================================
  {
    const store = storeDe('pendiente_aprobacion');
    const [p] = foto(store).propuestas;
    const marcador = 'marcador-que-no-debe-filtrarse';
    const op = (extra = {}) => ({ usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba', ...extra });
    const casos = [
      ['ausente', undefined],
      ['vacía', ''],
      ['solo espacios', '   '],
      ['JSON inválido', `[{"usuario_atlas": "${marcador}"`],
      ['no es array', JSON.stringify(op())],
      ['lista vacía', '[]'],
      ['entrada no objeto', JSON.stringify(['operador-prueba'])],
      ['falta una clave', JSON.stringify([{ usuario_atlas: marcador, db: 'admin' }])],
      ['clave extra', JSON.stringify([op({ password: marcador })])],
      ['valor con espacios al borde', JSON.stringify([op({ identificador: ' operador.prueba' })])],
      ['valor no string', JSON.stringify([op({ db: 1 })])],
      ['usuario + db duplicados', JSON.stringify([op(), op({ identificador: 'otro' })])],
      ['identificador duplicado', JSON.stringify([op(), op({ usuario_atlas: 'otro-usuario' })])]
    ];
    for (const [nombre, operadoresJson] of casos) {
      const { deps, llamadas } = crearEntorno(store, { operadoresJson });
      const err = await assertRechaza(decidirPropuesta(entradaDesde(p, 'aprobacion'), deps), ErrorConfiguracionOperadores, nombre);
      assert.ok(!err.message.includes(marcador), `[${nombre}] el mensaje no repite el contenido`);
      assert.deepStrictEqual([llamadas.usuarios, llamadas.verificarIndices, llamadas.transacciones], [0, 0, 0], nombre);
    }
    console.log('12) 13 OPERADORES_AUTORIZADOS_JSON inválidos → ErrorConfiguracionOperadores antes de identidad, gate y transacción: OK');
  }

  // ============================================================
  // 13) Gate de índices (INDICES_DECISION)
  // ============================================================
  {
    const store = storeDe('pendiente_aprobacion');
    const [p] = foto(store).propuestas;
    const sin = (lista, nombre) => lista.filter((i) => i.name !== nombre);
    const cambiar = (lista, nombre, cambios) => lista.map((i) => (i.name === nombre ? { ...i, ...cambios } : i));
    const casos = [
      ['falta evento_id_1', INDICES_PROPUESTAS_OK, sin(INDICES_EVENTOS_OK, 'evento_id_1')],
      ['falta uniq_evento_por_propuesta_version', INDICES_PROPUESTAS_OK, sin(INDICES_EVENTOS_OK, 'uniq_evento_por_propuesta_version')],
      ['uniq_evento_por_propuesta_version no único', INDICES_PROPUESTAS_OK, cambiar(INDICES_EVENTOS_OK, 'uniq_evento_por_propuesta_version', { unique: false })],
      [
        'uniq_evento_por_propuesta_version con claves en otro orden',
        INDICES_PROPUESTAS_OK,
        cambiar(INDICES_EVENTOS_OK, 'uniq_evento_por_propuesta_version', { key: { version_coordinacion_nueva: 1, propuesta_id: 1 } })
      ],
      ['eventos_propuesta inexistente', INDICES_PROPUESTAS_OK, []],
      [
        'propuesta activa con otro filtro parcial',
        cambiar(INDICES_PROPUESTAS_OK, 'uniq_propuesta_activa_por_destino_requisito_campo', {
          partialFilterExpression: { estado: { $in: ['pendiente_aprobacion'] } }
        }),
        INDICES_EVENTOS_OK
      ],
      ['falta propuesta_id_1', sin(INDICES_PROPUESTAS_OK, 'propuesta_id_1'), INDICES_EVENTOS_OK]
    ];
    for (const [nombre, indicesPropuestas, indicesEventos] of casos) {
      const { deps, llamadas } = crearEntorno(store, { indicesPropuestas, indicesEventos });
      await assertRechaza(decidirPropuesta(entradaDesde(p, 'aprobacion'), deps), ErrorPrecondicionIndices, nombre);
      assert.deepStrictEqual([llamadas.uuid, llamadas.transacciones], [0, 0], nombre);
    }
    console.log('13) gate de índices: 7 formas inválidas → ErrorPrecondicionIndices sin transacción: OK');
  }

  // ============================================================
  // 14) Entrada inválida
  // ============================================================
  {
    const store = storeDe('aprobada');
    const aprobada = foto(store).propuestas[0];
    const pendiente = fixture('pendiente_aprobacion').propuesta;
    const casos = [
      ['rechazo sin motivo', entradaDesde(pendiente, 'rechazo', { motivo: undefined }), ErrorEntradaInvalida],
      ['cancelacion con motivo en blanco', entradaDesde(aprobada, 'cancelacion', { motivo: '   ' }), ErrorEntradaInvalida],
      ['aprobacion con motivo vacío', entradaDesde(pendiente, 'aprobacion', { motivo: '' }), ErrorEntradaInvalida],
      ['tipo aplicacion (actor sistema)', entradaDesde(aprobada, 'aplicacion'), ErrorEntradaInvalida],
      ['tipo conflicto (actor sistema)', entradaDesde(aprobada, 'conflicto', { motivo: 'x' }), ErrorEntradaInvalida],
      ['hash en mayúsculas', entradaDesde(pendiente, 'aprobacion', { payload_hash_esperado: pendiente.payload_hash.toUpperCase() }), ErrorEntradaInvalida],
      ['hash corto', entradaDesde(pendiente, 'aprobacion', { payload_hash_esperado: pendiente.payload_hash.slice(0, 12) }), ErrorEntradaInvalida],
      ['versión negativa', entradaDesde(pendiente, 'aprobacion', { version_coordinacion_esperada: -1 }), ErrorEntradaInvalida],
      ['versión no entera', entradaDesde(pendiente, 'aprobacion', { version_coordinacion_esperada: 0.5 }), ErrorEntradaInvalida],
      ['versión como string', entradaDesde(pendiente, 'aprobacion', { version_coordinacion_esperada: '0' }), ErrorEntradaInvalida],
      ['propuesta_id no UUID', entradaDesde(pendiente, 'aprobacion', { propuesta_id: 'abc' }), ErrorEntradaInvalida],
      ['estado desconocido', entradaDesde(pendiente, 'aprobacion', { estado_esperado: 'borrador' }), ErrorEntradaInvalida],
      ['aprobacion con decisión no nula', entradaDesde(pendiente, 'aprobacion', { decision_aprobacion_id_esperado: OTRO_UUID }), ErrorEntradaInvalida],
      ['cancelacion con decisión no UUID', entradaDesde(aprobada, 'cancelacion', { decision_aprobacion_id_esperado: 'x' }), ErrorEntradaInvalida],
      ['cancelacion desde aprobada con decisión null', entradaDesde(aprobada, 'cancelacion', { decision_aprobacion_id_esperado: null }), ErrorInconsistencia]
    ];
    const sinDecision = entradaDesde(pendiente, 'aprobacion');
    delete sinDecision.decision_aprobacion_id_esperado;
    casos.push(['falta decision_aprobacion_id_esperado', sinDecision, ErrorEntradaInvalida]);

    for (const [nombre, entrada, clase] of casos) {
      if (entrada.motivo === undefined) delete entrada.motivo;
      const { deps, llamadas } = crearEntorno(store);
      await assertRechaza(decidirPropuesta(entrada, deps), clase, nombre);
      assert.deepStrictEqual([llamadas.operadores, llamadas.transacciones], [0, 0], nombre);
    }

    // El motivo se guarda sin espacios al borde (y la relectura compara ese valor).
    const s = storeDe('pendiente_aprobacion');
    const { deps } = crearEntorno(s);
    await decidirPropuesta(entradaDesde(foto(s).propuestas[0], 'aprobacion', { motivo: '  verificado en GOV.UK  ' }), deps);
    assert.strictEqual(s.eventos.at(-1).motivo, 'verificado en GOV.UK');
    console.log('14) 16 entradas inválidas rechazadas antes de todo I/O; motivo normalizado con trim: OK');
  }

  // ============================================================
  // 15) Dependencias reales (Mongoose) con stubs, sin conexión
  // ============================================================
  {
    const originales = {
      indicesPropuesta: PropuestaCambio.collection.indexes,
      indicesEvento: EventoPropuesta.collection.indexes,
      updateOne: PropuestaCambio.updateOne,
      saveEvento: EventoPropuesta.prototype.save
    };
    const capturas = { transaccion: null, update: null, eventos: [] };
    const conexionFalsa = {
      db: { command: async (cmd) => (cmd.connectionStatus === 1 ? { authInfo: { authenticatedUsers: [USUARIO] } } : null) },
      transaction: async (fn, opciones) => {
        capturas.transaccion = opciones;
        await fn('SESION_FALSA');
      }
    };
    try {
      PropuestaCambio.collection.indexes = async () => INDICES_PROPUESTAS_OK;
      EventoPropuesta.collection.indexes = async () => {
        const err = new Error('ns does not exist');
        err.code = 26;
        throw err;
      };
      const p = fixture('pendiente_aprobacion').propuesta;
      const deps = crearDependenciasMongoose(conexionFalsa, { operadoresJson: OPERADORES_JSON });
      await assertRechaza(decidirPropuesta(entradaDesde(p, 'aprobacion'), deps), ErrorPrecondicionIndices, 'colección de eventos inexistente');
      assert.strictEqual(capturas.transaccion, null);

      EventoPropuesta.collection.indexes = async () => INDICES_EVENTOS_OK;
      PropuestaCambio.updateOne = async (filtro, update, opciones) => {
        capturas.update = { filtro, update, opciones };
        return { matchedCount: 1, modifiedCount: 1 };
      };
      EventoPropuesta.prototype.save = async function (opciones) {
        capturas.eventos.push({ doc: this.toObject(), opciones });
      };
      const r = await decidirPropuesta(entradaDesde(p, 'aprobacion'), deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.deepStrictEqual(capturas.transaccion, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      assert.deepStrictEqual(capturas.update.filtro, {
        propuesta_id: PROPUESTA_ID,
        estado: 'pendiente_aprobacion',
        payload_hash: p.payload_hash,
        version_coordinacion: 0,
        decision_aprobacion_id: null
      });
      assert.deepStrictEqual(capturas.update.update.$inc, { version_coordinacion: 1 });
      assert.strictEqual(capturas.update.update.$set.decision_aprobacion_id, r.evento_id);
      assert.deepStrictEqual(capturas.update.opciones, { session: 'SESION_FALSA', timestamps: false, strict: 'throw', runValidators: true });
      assert.strictEqual(capturas.eventos.length, 1);
      assert.deepStrictEqual(capturas.eventos[0].opciones, { session: 'SESION_FALSA' });
      assert.strictEqual(capturas.eventos[0].doc.evento_id, r.evento_id);
      assert.deepStrictEqual(capturas.eventos[0].doc.detalle.comando, COMANDO);
    } finally {
      PropuestaCambio.collection.indexes = originales.indicesPropuesta;
      EventoPropuesta.collection.indexes = originales.indicesEvento;
      PropuestaCambio.updateOne = originales.updateOne;
      EventoPropuesta.prototype.save = originales.saveEvento;
    }
    console.log('15) dependencias reales con stubs: gate, connectionStatus, opciones de transacción/updateOne/save correctas: OK');
  }

  // ============================================================
  // 17) Identidad inyectada (panel): resolverIdentidad reemplaza a
  //     connectionStatus, se valida antes del gate y queda en el evento
  // ============================================================
  {
    const IDENTIDAD_PANEL = {
      actor: { tipo: 'humano', identificador: 'operador.panel' },
      identidad_operador: { metodo: 'oidc_google', sub: '1234567890', email: 'operador@example.com' },
      comando: { nombre: 'panel-propuestas', version: '1' }
    };
    const conIdentidad = (store, resolver, opciones) => {
      const entorno = crearEntorno(store, opciones);
      entorno.llamadas.resolver = 0;
      entorno.deps.resolverIdentidad = async () => {
        entorno.llamadas.resolver++;
        return typeof resolver === 'function' ? resolver() : resolver;
      };
      return entorno;
    };

    // a) Decisión registrada con la identidad inyectada; connectionStatus no se consulta.
    {
      const store = storeDe('pendiente_aprobacion');
      const [p] = foto(store).propuestas;
      const { deps, llamadas } = conIdentidad(store, IDENTIDAD_PANEL, { operadoresJson: undefined, usuarios: [] });
      const r = await decidirPropuesta(entradaDesde(p, 'aprobacion'), deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.deepStrictEqual([llamadas.resolver, llamadas.operadores, llamadas.usuarios], [1, 0, 0], 'no usa connectionStatus ni la allowlist de la CLI');
      const ev = foto(store).eventos.at(-1);
      assert.deepStrictEqual(ev.actor, IDENTIDAD_PANEL.actor);
      assert.deepStrictEqual(ev.detalle, { identidad_operador: IDENTIDAD_PANEL.identidad_operador, comando: IDENTIDAD_PANEL.comando });
      assert.deepStrictEqual(r.actor, IDENTIDAD_PANEL.actor);
    }

    // b) Rechazo con motivo, misma identidad.
    {
      const store = storeDe('pendiente_aprobacion');
      const [p] = foto(store).propuestas;
      const { deps } = conIdentidad(store, IDENTIDAD_PANEL);
      const r = await decidirPropuesta(entradaDesde(p, 'rechazo'), deps);
      assert.strictEqual(r.resultado, 'decision_registrada');
      assert.strictEqual(foto(store).eventos.at(-1).detalle.comando.nombre, 'panel-propuestas');
    }

    // c) Formas inválidas → TypeError antes del gate y de toda transacción.
    const invalidas = [
      ['null', null],
      ['actor sistema', { ...IDENTIDAD_PANEL, actor: { tipo: 'sistema', identificador: 'x' } }],
      ['actor con clave extra', { ...IDENTIDAD_PANEL, actor: { ...IDENTIDAD_PANEL.actor, rol: 'admin' } }],
      ['identificador vacío', { ...IDENTIDAD_PANEL, actor: { tipo: 'humano', identificador: ' ' } }],
      ['sin metodo', { ...IDENTIDAD_PANEL, identidad_operador: { sub: '1' } }],
      ['identidad con valor no string', { ...IDENTIDAD_PANEL, identidad_operador: { metodo: 'oidc_google', sub: 1 } }],
      ['sin comando', { actor: IDENTIDAD_PANEL.actor, identidad_operador: IDENTIDAD_PANEL.identidad_operador }],
      ['comando con clave extra', { ...IDENTIDAD_PANEL, comando: { ...IDENTIDAD_PANEL.comando, x: 'y' } }]
    ];
    for (const [nombre, resolucion] of invalidas) {
      const store = storeDe('pendiente_aprobacion');
      const antes = foto(store);
      const { deps, llamadas } = conIdentidad(store, resolucion);
      await assertRechaza(decidirPropuesta(entradaDesde(antes.propuestas[0], 'aprobacion'), deps), TypeError, nombre);
      assert.deepStrictEqual([llamadas.verificarIndices, llamadas.uuid, llamadas.transacciones], [0, 0, 0], nombre);
      assert.deepStrictEqual(foto(store), antes, nombre);
    }

    // d) resolverIdentidad que lanza (p. ej. operador no autorizado) → nada se escribe.
    {
      const store = storeDe('pendiente_aprobacion');
      const antes = foto(store);
      const { deps, llamadas } = conIdentidad(store, () => {
        throw new ErrorActorNoAutorizado('Operador no autorizado: prueba');
      });
      await assertRechaza(decidirPropuesta(entradaDesde(antes.propuestas[0], 'aprobacion'), deps), ErrorActorNoAutorizado, 'resolver lanza');
      assert.deepStrictEqual([llamadas.verificarIndices, llamadas.transacciones], [0, 0]);
      assert.deepStrictEqual(foto(store), antes);
    }

    // e) La entrada nunca puede traer identidad, aunque haya resolverIdentidad.
    for (const extra of [{ actor: IDENTIDAD_PANEL.actor }, { identidad_operador: IDENTIDAD_PANEL.identidad_operador }, { comando: IDENTIDAD_PANEL.comando }]) {
      const store = storeDe('pendiente_aprobacion');
      const { deps, llamadas } = conIdentidad(store, IDENTIDAD_PANEL);
      await assertRechaza(decidirPropuesta(entradaDesde(foto(store).propuestas[0], 'aprobacion', extra), deps), ErrorEntradaInvalida, Object.keys(extra)[0]);
      assert.strictEqual(llamadas.resolver, 0, 'la entrada se valida antes de resolver la identidad');
    }

    // f) La identidad devuelta queda congelada (no se puede alterar después de validarla).
    {
      const v = validarResolucionIdentidad(IDENTIDAD_PANEL);
      assert.ok(Object.isFrozen(v) && Object.isFrozen(v.actor) && Object.isFrozen(v.identidad_operador) && Object.isFrozen(v.comando));
      assert.notStrictEqual(v.actor, IDENTIDAD_PANEL.actor, 'copia, no la referencia recibida');
    }

    // g) Sin resolverIdentidad, la CLI sigue igual (connectionStatus + COMANDO de la CLI).
    {
      const store = storeDe('pendiente_aprobacion');
      const r = await identidadPorConnectionStatus(crearEntorno(store).deps);
      assert.deepStrictEqual(r.comando, COMANDO);
      assert.strictEqual(r.identidad_operador.metodo, 'connection_status');
    }
    // h) Integración real: la salida EXACTA de resolverOperadorPanel() (la que
    //    será req.operador en el panel) como resolverIdentidad.
    {
      const operadores = cargarOperadoresPanel(
        JSON.stringify([{ proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] }])
      );
      const identidadVerificada = Object.freeze({ proveedor: 'google', iss: 'https://accounts.google.com', sub: '1000', email: 'operador@example.com', email_verificado: true });
      const operador = resolverOperadorPanel(identidadVerificada, operadores);
      assert.ok(operador && Object.isFrozen(operador) && Object.isFrozen(operador.comando));
      for (const tipo of ['aprobacion', 'rechazo']) {
        const store = storeDe('pendiente_aprobacion');
        const { deps, llamadas } = crearEntorno(store, { operadoresJson: undefined, usuarios: [] });
        deps.resolverIdentidad = () => operador; // tal cual, sin adaptar
        const r = await decidirPropuesta(entradaDesde(foto(store).propuestas[0], tipo), deps);
        assert.strictEqual(r.resultado, 'decision_registrada', tipo);
        assert.deepStrictEqual([llamadas.operadores, llamadas.usuarios], [0, 0], `${tipo}: sin connectionStatus`);
        const ev = foto(store).eventos.at(-1);
        assert.deepStrictEqual(ev.detalle.comando, { nombre: 'panel-propuestas', version: '1' }, `${tipo}: comando del panel`);
        assert.deepStrictEqual(ev.detalle.comando, { ...COMANDO_PANEL });
        assert.notStrictEqual(ev.detalle.comando.nombre, COMANDO.nombre, `${tipo}: nunca decidir-propuesta`);
        assert.deepStrictEqual(ev.actor, { tipo: 'humano', identificador: 'operador.panel' });
        assert.deepStrictEqual(ev.detalle.identidad_operador, { metodo: 'oidc_google', sub: '1000', email: 'operador@example.com' });
        assert.ok(!('permisos' in ev.detalle) && !('identificador' in ev.detalle), `${tipo}: solo actor/identidad/comando llegan al evento`);
      }
      assert.ok(Object.isFrozen(COMANDO_PANEL), 'COMANDO_PANEL congelado');
    }

    // i) construirEvento exige comando: nunca hay un origen por defecto.
    {
      const p = fixture('pendiente_aprobacion').propuesta;
      const sinComando = resolverActor([USUARIO], cargarOperadoresAutorizados(OPERADORES_JSON));
      assert.throws(() => construirEvento(entradaDesde(p, 'aprobacion'), '33333333-3333-4333-8333-000000000001', OCURRIDO_EN, sinComando), TypeError);
      assert.throws(() => construirEvento(entradaDesde(p, 'aprobacion'), '33333333-3333-4333-8333-000000000001', OCURRIDO_EN, { ...sinComando, comando: { nombre: 'x' } }), TypeError);
      const ev = construirEvento(entradaDesde(p, 'aprobacion'), '33333333-3333-4333-8333-000000000001', OCURRIDO_EN, {
        ...sinComando,
        comando: { nombre: 'panel-propuestas', version: '1', extra: 'x' }
      });
      assert.deepStrictEqual(ev.detalle.comando, { nombre: 'panel-propuestas', version: '1' }, 'solo nombre/version, sin fallback ni claves extra');
    }
    console.log(`17) identidad inyectada: registra actor/identidad/comando del panel sin connectionStatus; ${invalidas.length} formas inválidas, resolver que lanza y identidad en la entrada → sin escrituras; salida real de resolverOperadorPanel() → evento con panel-propuestas; construirEvento sin comando → TypeError: OK`);
  }

  // ============================================================
  // 16) La propuesta real no aparece en ningún archivo nuevo
  // ============================================================
  {
    const archivos = [
      '../services/propuestas/decidir-propuesta.js',
      '../services/propuestas/operadores-autorizados.js',
      './decidir-propuesta.js',
      './test-decidir-propuesta.js',
      './test-servicio-decision-propuesta.js'
    ];
    for (const archivo of archivos) {
      const texto = fs.readFileSync(path.join(__dirname, archivo), 'utf8');
      assert.ok(!texto.includes(PROPUESTA_REAL_PROTEGIDA), `${archivo} no debe mencionar la propuesta real`);
    }
    console.log('16) la propuesta real no aparece en el servicio, el comando ni las pruebas: OK');
  }

  console.log('\nTodas las pruebas offline del servicio de decisión pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
