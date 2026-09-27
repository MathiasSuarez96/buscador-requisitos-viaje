// Pruebas offline (sin conexión a Mongo, sin red) para
// scripts/crear-indices-propuestas.js y el gate verificarListadoIndices()
// del servicio. En cada escenario se comprueba la EQUIVALENCIA: el plan
// del creador da 'ya_existe' para los tres índices si y solo si el gate
// del servicio acepta el listado.
//
// Atlas se simula con un repositorio en memoria que imita la forma de
// listIndexes() ({v: 2, key, name, unique, partialFilterExpression?}) y
// los rechazos de createIndex() ante nombre o clave ya usados.
//
// Lo que estas pruebas NO cubren: la forma exacta que devuelve el
// listIndexes() real de Atlas (se valida con el modo prechequeo_atlas).
//
// Uso: node scripts/test-crear-indices-propuestas.js

const assert = require('assert');
const mongoose = require('mongoose');
const {
  ESTADOS_ACTIVOS,
  INDICE_PROPUESTA_ACTIVA,
  ErrorPrecondicionIndices,
  verificarListadoIndices
} = require('../services/propuestas/registrar-ejecucion-lectura');
const {
  planificar,
  hayConflictos,
  ejecutar,
  crearDependenciasMongoose
} = require('./crear-indices-propuestas');

const idId = { v: 2, key: { _id: 1 }, name: '_id_' };
const idRun = { v: 2, key: { run_id: 1 }, name: 'run_id_1', unique: true };
const idPropuesta = { v: 2, key: { propuesta_id: 1 }, name: 'propuesta_id_1', unique: true };
const idActiva = {
  v: 2,
  key: { destino_id: 1, requisito_id: 1, campo: 1 },
  name: INDICE_PROPUESTA_ACTIVA,
  unique: true,
  partialFilterExpression: { estado: { $in: ['pendiente_aprobacion', 'aprobada', 'revision_requerida'] } }
};

const completos = () => ({
  propuestas_cambio: [idId, idPropuesta, idActiva],
  ejecuciones_lectura: [idId, idRun]
});

const clonar = (x) => JSON.parse(JSON.stringify(x));
const silencio = () => {};

// Comprueba los estados esperados por nombre de índice Y la equivalencia
// con el gate del servicio.
function assertPlanYGate(listados, esperados, etiqueta) {
  const plan = planificar(listados);
  const estados = Object.fromEntries(plan.map((p) => [p.spec.nombre, p.estado]));
  assert.deepStrictEqual(estados, esperados, `[${etiqueta}] estados`);

  const todosExisten = plan.every((p) => p.estado === 'ya_existe');
  let gateAcepta = true;
  try {
    verificarListadoIndices(listados.propuestas_cambio ?? [], listados.ejecuciones_lectura ?? []);
  } catch (err) {
    assert.ok(err instanceof ErrorPrecondicionIndices, `[${etiqueta}] clase real: ${err.constructor.name}`);
    gateAcepta = false;
  }
  assert.strictEqual(gateAcepta, todosExisten, `[${etiqueta}] el gate y el creador deben coincidir`);
  return plan;
}

const estados = (run, propuesta, activa) => ({
  run_id_1: run,
  propuesta_id_1: propuesta,
  [INDICE_PROPUESTA_ACTIVA]: activa
});

function crearAtlasFalso({ dbName = 'buscador_requisitos', listados = {}, fallarCrear = {} } = {}) {
  const colecciones = clonar(listados);
  const llamadas = [];
  const deps = {
    conectar: async () => {
      llamadas.push('conectar');
      return dbName;
    },
    listarIndices: async (coleccion) => {
      llamadas.push(`listar:${coleccion}`);
      if (!colecciones[coleccion]) throw Object.assign(new Error('ns does not exist'), { code: 26 });
      return clonar(colecciones[coleccion]);
    },
    crearIndice: async (coleccion, clave, opciones) => {
      llamadas.push(`crear:${coleccion}.${opciones.name}`);
      if (fallarCrear[opciones.name]) throw fallarCrear[opciones.name];
      const nuevo = { v: 2, key: clonar(clave), name: opciones.name, unique: opciones.unique };
      if (opciones.partialFilterExpression) nuevo.partialFilterExpression = clonar(opciones.partialFilterExpression);
      const indices = (colecciones[coleccion] ??= [clonar(idId)]);
      const mismoNombre = indices.find((i) => i.name === nuevo.name);
      if (mismoNombre) {
        if (JSON.stringify(mismoNombre) === JSON.stringify(nuevo)) return nuevo.name; // idéntico: no-op, como Mongo
        throw Object.assign(new Error(`Index with name: ${nuevo.name} already exists with different options`), { code: 86 });
      }
      if (indices.some((i) => JSON.stringify(i.key) === JSON.stringify(nuevo.key))) {
        throw Object.assign(new Error('Index already exists with a different name'), { code: 85 });
      }
      indices.push(nuevo);
      return nuevo.name;
    }
  };
  return { deps, llamadas, colecciones };
}

const creaciones = (llamadas) => llamadas.filter((l) => l.startsWith('crear:'));

async function assertRechaza(fn, mensaje, etiqueta) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `[${etiqueta}] se esperaba un error`);
  assert.ok(String(err.message).includes(mensaje), `[${etiqueta}] mensaje real: ${err.message}`);
  return err;
}

(async () => {
  // ============================================================
  // 1) Los tres índices ausentes.
  // ============================================================
  {
    assertPlanYGate({}, estados('crear', 'crear', 'crear'), 'colecciones inexistentes');
    assertPlanYGate(
      { propuestas_cambio: [idId], ejecuciones_lectura: [idId] },
      estados('crear', 'crear', 'crear'),
      'solo _id_'
    );

    const { deps, llamadas, colecciones } = crearAtlasFalso();
    const { creados } = await ejecutar('creacion_real', deps, silencio);
    assert.deepStrictEqual(creados, [
      'ejecuciones_lectura.run_id_1',
      'propuestas_cambio.propuesta_id_1',
      `propuestas_cambio.${INDICE_PROPUESTA_ACTIVA}`
    ]);
    assert.strictEqual(llamadas[0], 'conectar');
    assertPlanYGate(colecciones, estados('ya_existe', 'ya_existe', 'ya_existe'), 'después de crear');
    assert.deepStrictEqual(
      colecciones.propuestas_cambio.find((i) => i.name === INDICE_PROPUESTA_ACTIVA).partialFilterExpression,
      { estado: { $in: ESTADOS_ACTIVOS } }
    );

    console.log('1) tres índices ausentes → se crean los tres y el gate los acepta: OK');
  }

  // ============================================================
  // 2) Los tres ya existentes con forma exacta.
  // ============================================================
  {
    assertPlanYGate(completos(), estados('ya_existe', 'ya_existe', 'ya_existe'), 'completos');

    const { deps, llamadas } = crearAtlasFalso({ listados: completos() });
    const { creados } = await ejecutar('creacion_real', deps, silencio);
    assert.deepStrictEqual(creados, []);
    assert.deepStrictEqual(creaciones(llamadas), []);

    console.log('2) tres índices ya existentes exactos → ya_existe, ninguna creación: OK');
  }

  // ============================================================
  // 3-7) Conflictos. En creación real, ninguno crea NADA, aunque otros
  //      índices sí falten.
  // ============================================================
  const conflictos = [
    // 3) mismo nombre, opciones distintas
    ['propuesta_id_1 no único', { propuestas_cambio: [idId, { ...idPropuesta, unique: false }] }, estados('crear', 'conflicto', 'crear')],
    ['run_id_1 con otra clave', { ejecuciones_lectura: [idId, { ...idRun, key: { run_id: -1 } }] }, estados('conflicto', 'crear', 'crear')],
    ['índice activo no único', { propuestas_cambio: [idId, { ...idActiva, unique: false }] }, estados('crear', 'crear', 'conflicto')],
    [
      'índice activo con clave en otro orden',
      { propuestas_cambio: [idId, { ...idActiva, key: { requisito_id: 1, destino_id: 1, campo: 1 } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'propuesta_id_1 con collation',
      { propuestas_cambio: [idId, { ...idPropuesta, collation: { locale: 'es', strength: 2 } }] },
      estados('crear', 'conflicto', 'crear')
    ],
    // 4) misma clave, otro nombre
    [
      'propuesta_id con otro nombre',
      { propuestas_cambio: [idId, { ...idPropuesta, name: 'propuesta_id_unico' }] },
      estados('crear', 'conflicto', 'crear')
    ],
    [
      'propuesta_id exacto + duplicado con otro nombre',
      { propuestas_cambio: [idId, idPropuesta, idActiva, { ...idPropuesta, name: 'propuesta_id_unico' }], ejecuciones_lectura: [idId, idRun] },
      estados('ya_existe', 'conflicto', 'ya_existe')
    ],
    [
      'run_id no único con otro nombre',
      { ejecuciones_lectura: [idId, { v: 2, key: { run_id: 1 }, name: 'run_id_busqueda' }] },
      estados('conflicto', 'crear', 'crear')
    ],
    // 5) índice simple con sparse
    ['propuesta_id_1 sparse', { propuestas_cambio: [idId, { ...idPropuesta, sparse: true }] }, estados('crear', 'conflicto', 'crear')],
    ['run_id_1 sparse', { ejecuciones_lectura: [idId, { ...idRun, sparse: true }] }, estados('conflicto', 'crear', 'crear')],
    ['run_id_1 sparse: false explícito', { ejecuciones_lectura: [idId, { ...idRun, sparse: false }] }, estados('conflicto', 'crear', 'crear')],
    // 6) índice simple con filtro parcial
    [
      'propuesta_id_1 parcial',
      { propuestas_cambio: [idId, { ...idPropuesta, partialFilterExpression: { propuesta_id: { $exists: true } } }] },
      estados('crear', 'conflicto', 'crear')
    ],
    [
      'run_id_1 parcial',
      { ejecuciones_lectura: [idId, { ...idRun, partialFilterExpression: { run_id: { $type: 'string' } } }] },
      estados('conflicto', 'crear', 'crear')
    ],
    // 7) filtro o estados distintos en el índice activo
    [
      'activo sin filtro',
      { propuestas_cambio: [idId, (({ partialFilterExpression, ...resto }) => resto)(idActiva)] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'activo con menos estados',
      { propuestas_cambio: [idId, { ...idActiva, partialFilterExpression: { estado: { $in: ['pendiente_aprobacion', 'aprobada'] } } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'activo con un estado de más',
      { propuestas_cambio: [idId, { ...idActiva, partialFilterExpression: { estado: { $in: [...ESTADOS_ACTIVOS, 'rechazada'] } } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'activo con estados en otro orden',
      { propuestas_cambio: [idId, { ...idActiva, partialFilterExpression: { estado: { $in: ['aprobada', 'pendiente_aprobacion', 'revision_requerida'] } } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'activo filtrando otro campo',
      { propuestas_cambio: [idId, { ...idActiva, partialFilterExpression: { status: { $in: ESTADOS_ACTIVOS } } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    [
      'activo con operador distinto',
      { propuestas_cambio: [idId, { ...idActiva, partialFilterExpression: { estado: { $eq: 'pendiente_aprobacion' } } }] },
      estados('crear', 'crear', 'conflicto')
    ],
    ['activo sparse', { propuestas_cambio: [idId, { ...idActiva, sparse: true }] }, estados('crear', 'crear', 'conflicto')]
  ];

  for (const [etiqueta, listados, esperados] of conflictos) {
    const plan = assertPlanYGate(listados, esperados, etiqueta);
    assert.ok(hayConflictos(plan), `[${etiqueta}] debe haber conflicto`);

    const pre = crearAtlasFalso({ listados });
    const resultado = await ejecutar('prechequeo_atlas', pre.deps, silencio);
    assert.ok(hayConflictos(resultado.plan), `[${etiqueta}] prechequeo debe reportar el conflicto`);
    assert.deepStrictEqual(creaciones(pre.llamadas), [], `[${etiqueta}] prechequeo no crea`);

    const real = crearAtlasFalso({ listados });
    await assertRechaza(() => ejecutar('creacion_real', real.deps, silencio), 'No se creó ningún índice', etiqueta);
    assert.deepStrictEqual(creaciones(real.llamadas), [], `[${etiqueta}] creación real no crea nada`);
    assert.deepStrictEqual(real.colecciones, listados, `[${etiqueta}] Atlas sin cambios`);
  }
  console.log(`3-7) ${conflictos.length} conflictos (nombre, clave, sparse, parcial, filtro/estados) → gate y creador rechazan, nada se crea: OK`);

  // ============================================================
  // 8) Segunda ejecución idempotente.
  // ============================================================
  {
    const { deps, llamadas, colecciones } = crearAtlasFalso({ listados: { propuestas_cambio: [idId, idPropuesta] } });

    const primera = await ejecutar('creacion_real', deps, silencio);
    assert.deepStrictEqual(primera.creados, ['ejecuciones_lectura.run_id_1', `propuestas_cambio.${INDICE_PROPUESTA_ACTIVA}`]);
    const despuesPrimera = clonar(colecciones);

    const segunda = await ejecutar('creacion_real', deps, silencio);
    assert.deepStrictEqual(segunda.creados, []);
    assert.deepStrictEqual(segunda.plan.map((p) => p.estado), ['ya_existe', 'ya_existe', 'ya_existe']);
    assert.deepStrictEqual(colecciones, despuesPrimera, 'la segunda corrida no cambia nada');
    assert.strictEqual(creaciones(llamadas).length, 2, 'solo la primera corrida crea');

    console.log('8) segunda ejecución idempotente: OK');
  }

  // ============================================================
  // 9) Planificación local: ninguna llamada a Mongo, ni con deps falsas
  //    ni con las dependencias reales (mongoose.connect espiado).
  // ============================================================
  {
    const llamadas = [];
    const prohibido = (nombre) => async () => {
      llamadas.push(nombre);
      throw new Error(`${nombre} no debe llamarse en planificación local`);
    };
    const lineas = [];
    const resultado = await ejecutar(
      'planificacion_local',
      { conectar: prohibido('conectar'), listarIndices: prohibido('listarIndices'), crearIndice: prohibido('crearIndice') },
      (l) => lineas.push(l)
    );
    assert.deepStrictEqual(llamadas, []);
    assert.strictEqual(resultado.plan, null);
    const createIndexImpresos = lineas.filter((l) => l.startsWith('db.'));
    assert.strictEqual(createIndexImpresos.length, 3);
    assert.ok(createIndexImpresos.some((l) => l.includes('"partialFilterExpression":{"estado":{"$in":["pendiente_aprobacion","aprobada","revision_requerida"]}}')));

    const connectOriginal = mongoose.connect;
    let connectLlamado = false;
    mongoose.connect = async () => {
      connectLlamado = true;
      throw new Error('mongoose.connect no debe llamarse');
    };
    try {
      await ejecutar('planificacion_local', crearDependenciasMongoose(), silencio);
    } finally {
      mongoose.connect = connectOriginal;
    }
    assert.strictEqual(connectLlamado, false, 'mongoose.connect no se llamó');
    assert.strictEqual(mongoose.connection.readyState, 0);

    console.log('9) planificación local sin mongoose.connect ni listIndexes: OK');
  }

  // ============================================================
  // 10) Guardas adicionales: base equivocada, prechequeo sin conflictos,
  //     falla a mitad de la creación, modo desconocido.
  // ============================================================
  {
    for (const modo of ['prechequeo_atlas', 'creacion_real']) {
      const { deps, llamadas } = crearAtlasFalso({ dbName: 'test' });
      await assertRechaza(() => ejecutar(modo, deps, silencio), 'Base de datos inesperada', `db equivocada / ${modo}`);
      assert.deepStrictEqual(llamadas, ['conectar'], `${modo}: no lista ni crea con la base equivocada`);
    }

    const pre = crearAtlasFalso();
    const { plan } = await ejecutar('prechequeo_atlas', pre.deps, silencio);
    assert.deepStrictEqual(plan.map((p) => p.estado), ['crear', 'crear', 'crear']);
    assert.deepStrictEqual(creaciones(pre.llamadas), [], 'prechequeo sin conflictos tampoco crea');

    const e11000 = Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    const conFalla = crearAtlasFalso({ fallarCrear: { propuesta_id_1: e11000 } });
    const err = await assertRechaza(() => ejecutar('creacion_real', conFalla.deps, silencio), 'E11000', 'falla a mitad');
    assert.ok(err.message.includes('creados en esta corrida antes de fallar: ejecuciones_lectura.run_id_1'), err.message);
    assert.strictEqual(err.code, 11000);

    await assertRechaza(() => ejecutar('crear', crearAtlasFalso().deps, silencio), 'Modo desconocido', 'modo desconocido');

    console.log('10) base equivocada, prechequeo limpio, falla a mitad y modo desconocido: OK');
  }

  console.log('\nTodas las pruebas offline de crear-indices-propuestas pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
