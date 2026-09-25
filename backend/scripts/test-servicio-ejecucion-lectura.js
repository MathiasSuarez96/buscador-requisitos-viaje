// Pruebas offline (sin conexión a Mongo, sin red) para
// services/propuestas/registrar-ejecucion-lectura.js. El flujo se prueba
// con dependencias falsas: la "transacción" acumula las escrituras en un
// staging que solo se consolida si el callback termina sin lanzar, así
// que un error dentro del callback se comporta como un abort real (no
// queda nada de ese intento). Cada inserción pasa igual por
// document.validate() de los modelos reales (NO validateSync(): en
// Mongoose 9.9.4 no dispara los hooks pre('validate')).
//
// Lo que estas pruebas NO cubren: el E11000 real del índice parcial y el
// abort real del servidor (requiere replica set; mongodb-memory-server
// quedó fuera por ahora).
//
// Uso: node scripts/test-servicio-ejecucion-lectura.js

const assert = require('assert');
const crypto = require('crypto');

const EjecucionLectura = require('../models/propuestas/EjecucionLectura.model.js');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');
const {
  VERSION_CONTRATO_PROPUESTA,
  TIPO_PROPUESTA,
  esFechaIsoUtcExacta,
  hashSobreCanonico
} = require('../services/propuestas/canonicalizacion-propuestas');
const {
  CATEGORIAS_QUE_GENERAN_PROPUESTA,
  ESTADOS_ACTIVOS,
  INDICE_PROPUESTA_ACTIVA,
  CLAVE_INDICE_PROPUESTA_ACTIVA,
  MAX_INTENTOS,
  ErrorEntradaInvalida,
  ErrorPrecondicionIndices,
  ErrorEjecucionDuplicada,
  esColisionPropuestaActiva,
  validarEntrada,
  construirPropuesta,
  construirEjecucion,
  verificarListadoIndices,
  registrarEjecucionLectura,
  crearDependenciasMongoose
} = require('../services/propuestas/registrar-ejecucion-lectura');

const DESTINO_ID = '000000000000000000000001';
const REQUISITO_ID = '000000000000000000000002';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTRO_RUN_ID = '44444444-4444-4444-8444-444444444444';
const PROPUESTA_ID_FIJO = '22222222-2222-4222-8222-222222222222';
const FECHA_PROPUESTA_FIJA = '2026-09-24T12:00:02.000Z';

function entradaOk(extra = {}) {
  return {
    run_id: RUN_ID,
    iniciado_en: new Date('2026-09-24T12:00:00.000Z'),
    campo: 'costo',
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-24T12:00:01.000Z' },
    evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP', fragmento_html: 'cost £20 to apply' } } },
    estado_ejecucion: 'ok',
    destino_id: DESTINO_ID,
    requisito_id: REQUISITO_ID,
    valor_previo_en_mongo: { presente: false, valor: null },
    resultado_comparacion: { categoria: 'SIN_COSTO_PREVIO_EN_MONGO', ambiguo: false },
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } },
    ...extra
  };
}

function entradaFallo(extra = {}) {
  return {
    run_id: RUN_ID,
    iniciado_en: new Date('2026-09-24T12:00:00.000Z'),
    campo: 'costo',
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: null },
    evidencia: {},
    estado_ejecucion: 'fallo',
    etapa_fallo: 'fetch_fuente',
    error_mensaje: 'Timeout de 8000ms',
    ...extra
  };
}

// Propuesta activa de OTRA corrida (la "ganadora" en las pruebas de
// concurrencia).
function propuestaDeOtraCorrida({ importe = 20, estado = 'pendiente_aprobacion' } = {}) {
  const p = construirPropuesta(
    entradaOk({
      run_id: OTRO_RUN_ID,
      valor_propuesto: { valor: `£${importe}`, valor_normalizado: { importe, moneda: 'GBP' } }
    }),
    '55555555-5555-4555-8555-555555555555',
    '2026-09-24T11:59:00.000Z'
  );
  return { ...p, estado };
}

// Todos los intentos de insertar la propuesta deben llevar exactamente el
// mismo contenido inmutable.
function assertIntentosIdenticos(intentos, etiqueta) {
  assert.ok(intentos.length >= 1, etiqueta);
  const [primero] = intentos;
  for (const [i, intento] of intentos.entries()) {
    assert.strictEqual(intento.propuesta_id, primero.propuesta_id, `[${etiqueta}] propuesta_id del intento ${i + 1}`);
    assert.strictEqual(intento.payload.fecha_propuesta, primero.payload.fecha_propuesta, `[${etiqueta}] fecha_propuesta del intento ${i + 1}`);
    assert.strictEqual(intento.payload_hash, primero.payload_hash, `[${etiqueta}] payload_hash del intento ${i + 1}`);
  }
}

function errorE11000PropuestaActiva({ keyPattern = { ...CLAVE_INDICE_PROPUESTA_ACTIVA }, indice = INDICE_PROPUESTA_ACTIVA } = {}) {
  const err = new Error(
    `E11000 duplicate key error collection: buscador_requisitos.propuestas_cambio index: ${indice} dup key: { destino_id: ObjectId('${DESTINO_ID}'), requisito_id: ObjectId('${REQUISITO_ID}'), campo: "costo" }`
  );
  err.code = 11000;
  if (keyPattern !== null) err.keyPattern = keyPattern;
  return err;
}

function errorE11000RunId(runId) {
  const err = new Error(
    `E11000 duplicate key error collection: buscador_requisitos.ejecuciones_lectura index: run_id_1 dup key: { run_id: "${runId}" }`
  );
  err.code = 11000;
  err.keyPattern = { run_id: 1 };
  return err;
}

function crearRepoFalso({ propuestasIniciales = [], ejecucionesIniciales = [], fallas = {}, repetirCallback = false } = {}) {
  const estado = {
    propuestas: [...propuestasIniciales],
    ejecuciones: [...ejecucionesIniciales],
    llamadas: [],
    intentosPropuesta: [],
    commits: 0,
    uuids: 0,
    ahoras: 0
  };

  const deps = {
    uuid: () => {
      estado.uuids++;
      return `33333333-3333-4333-8333-${String(estado.uuids).padStart(12, '0')}`;
    },
    // Avanza 1 s por llamada: si fecha_propuesta se regenerara en un
    // reintento, cambiaría y las pruebas lo detectarían.
    ahora: () => {
      estado.ahoras++;
      return new Date(Date.UTC(2026, 8, 24, 12, 0, 4 + estado.ahoras));
    },
    verificarIndices: async () => {
      estado.llamadas.push('verificarIndices');
      if (fallas.verificarIndices) throw fallas.verificarIndices;
    },
    ejecutarTransaccion: async (fn) => {
      estado.llamadas.push('ejecutarTransaccion');
      const correr = async () => {
        const session = { staging: { propuestas: [], ejecuciones: [] } };
        const resultado = await fn(session); // si lanza, el staging se descarta (= abort)
        return { resultado, session };
      };
      if (repetirCallback) {
        // Simula un TransientTransactionError después de correr el
        // callback completo: se descarta y withTransaction lo re-ejecuta.
        await correr();
      }
      const { resultado, session } = await correr();
      estado.propuestas.push(...session.staging.propuestas);
      estado.ejecuciones.push(...session.staging.ejecuciones);
      estado.commits++;
      return resultado;
    },
    buscarPropuestaActiva: async (clave) => {
      estado.llamadas.push('buscarPropuestaActiva');
      if (fallas.buscarPropuestaActiva) throw fallas.buscarPropuestaActiva;
      return (
        estado.propuestas.find(
          (p) =>
            p.destino_id === clave.destino_id &&
            p.requisito_id === clave.requisito_id &&
            p.campo === clave.campo &&
            ESTADOS_ACTIVOS.includes(p.estado)
        ) ?? null
      );
    },
    insertarPropuesta: async (doc, session) => {
      estado.llamadas.push('insertarPropuesta');
      estado.intentosPropuesta.push(doc);
      await new PropuestaCambio(doc).validate();
      const falla = fallas.insertarPropuesta && fallas.insertarPropuesta(estado);
      if (falla) throw falla;
      session.staging.propuestas.push(doc);
    },
    insertarEjecucion: async (doc, session) => {
      estado.llamadas.push(session ? 'insertarEjecucion:tx' : 'insertarEjecucion');
      await new EjecucionLectura(doc).validate();
      const falla = fallas.insertarEjecucion && fallas.insertarEjecucion(doc, session);
      if (falla) throw falla;
      const yaRegistradas = [...estado.ejecuciones, ...(session ? session.staging.ejecuciones : [])];
      if (yaRegistradas.some((e) => e.run_id === doc.run_id)) throw errorE11000RunId(doc.run_id);
      (session ? session.staging.ejecuciones : estado.ejecuciones).push(doc);
    }
  };

  return { estado, deps };
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

(async () => {
  // ============================================================
  // 1) Vector fijo: JSON canónico escrito a mano y hash calculado con
  //    crypto directo sobre ese literal (no vía hashSobreCanonico).
  // ============================================================
  {
    const propuesta = construirPropuesta(entradaOk(), PROPUESTA_ID_FIJO, FECHA_PROPUESTA_FIJA);

    const jsonCanonicoEsperado =
      '{"algoritmo_canonicalizacion":"toc-v1","algoritmo_hash":"sha256","payload":' +
      '{"campo":"costo","destino_id":"000000000000000000000001",' +
      '"fecha_propuesta":"2026-09-24T12:00:02.000Z",' +
      '"fuente":{"capturado_en":"2026-09-24T12:00:01.000Z","nombre":"GOV.UK","url":"https://www.gov.uk/api/content/eta"},' +
      '"propuesta_id":"22222222-2222-4222-8222-222222222222",' +
      '"requisito_id":"000000000000000000000002",' +
      '"run_id_origen":"11111111-1111-4111-8111-111111111111",' +
      '"tipo_propuesta":"actualizacion_campo_requisito",' +
      '"valor_anterior":{"presente":false,"valor":null},' +
      '"valor_propuesto":{"evidencia":{"extraccion":{"overview":{"costo_extraido":20,"fragmento_html":"cost £20 to apply","moneda":"GBP"}}},' +
      '"valor":"£20","valor_normalizado":{"importe":20,"moneda":"GBP"}},' +
      '"version_contrato":"1.0"}}';
    const hashEsperado = crypto.createHash('sha256').update(jsonCanonicoEsperado, 'utf8').digest('hex');

    assert.strictEqual(propuesta.payload_hash, hashEsperado);
    assert.strictEqual(propuesta.estado, 'pendiente_aprobacion');
    assert.strictEqual(propuesta.run_id_origen, RUN_ID);
    assert.strictEqual(propuesta.payload.run_id_origen, RUN_ID);
    assert.strictEqual(propuesta.payload.propuesta_id, propuesta.propuesta_id);
    assert.strictEqual(propuesta.payload.version_contrato, '1.0');
    assert.strictEqual(propuesta.payload.tipo_propuesta, 'actualizacion_campo_requisito');
    assert.strictEqual(propuesta.payload.fecha_propuesta, FECHA_PROPUESTA_FIJA);
    assert.strictEqual(propuesta.version_coordinacion, 0);

    // Los tres campos del contrato están protegidos por el hash:
    // cambiar cualquiera de ellos cambia el payload_hash.
    for (const [campo, otroValor] of [
      ['version_contrato', '1.1'],
      ['tipo_propuesta', 'otro_tipo'],
      ['fecha_propuesta', '2026-09-24T12:00:03.000Z']
    ]) {
      const alterado = { ...propuesta.payload, [campo]: otroValor };
      assert.notStrictEqual(
        hashSobreCanonico(alterado, 'toc-v1', 'sha256'),
        propuesta.payload_hash,
        `${campo} debe estar cubierto por el hash`
      );
    }

    console.log('1) vector fijo (JSON canónico + hash SHA-256 literales, con contrato): OK');
  }

  // ============================================================
  // 2) valor_anterior: ausente / nulo explícito / presente producen
  //    tres payloads y tres hashes distintos.
  // ============================================================
  {
    const propuestaId = PROPUESTA_ID_FIJO;
    const ausente = construirPropuesta(entradaOk({ valor_previo_en_mongo: { presente: false, valor: null } }), propuestaId, FECHA_PROPUESTA_FIJA);
    const nulo = construirPropuesta(entradaOk({ valor_previo_en_mongo: { presente: true, valor: null } }), propuestaId, FECHA_PROPUESTA_FIJA);
    const presente = construirPropuesta(
      entradaOk({
        valor_previo_en_mongo: { presente: true, valor: '£15' },
        resultado_comparacion: { categoria: 'IMPORTE_NO_COINCIDE', ambiguo: false }
      }),
      propuestaId,
      FECHA_PROPUESTA_FIJA
    );

    const hashes = new Set([ausente.payload_hash, nulo.payload_hash, presente.payload_hash]);
    assert.strictEqual(hashes.size, 3, 'ausente, nulo explícito y presente deben hashear distinto');
    assert.deepStrictEqual(nulo.payload.valor_anterior, { presente: true, valor: null });
    assert.deepStrictEqual(presente.payload.valor_anterior, { presente: true, valor: '£15' });

    console.log('2) valor_anterior ausente / nulo explícito / presente distinguibles: OK');
  }

  // ============================================================
  // 3) Validación de entrada: rechazos antes de tocar cualquier
  //    dependencia.
  // ============================================================
  {
    const casosInvalidos = [
      ['evidencia con undefined', entradaOk({ evidencia: { a: undefined } }), 'undefined'],
      ['run_id no UUID', entradaOk({ run_id: 'abc' }), 'run_id'],
      ['iniciado_en string', entradaOk({ iniciado_en: '2026-09-24T12:00:00.000Z' }), 'iniciado_en'],
      ['campo distinto de costo', entradaOk({ campo: 'nombre' }), 'costo'],
      ['categoría que propone con ambiguo true', entradaOk({ resultado_comparacion: { categoria: 'IMPORTE_NO_COINCIDE', ambiguo: true } }), 'ambiguo'],
      ['categoría que propone sin valor_propuesto', entradaOk({ valor_propuesto: undefined }), 'valor_propuesto'],
      ['importe no entero', entradaOk({ valor_propuesto: { valor: '£20.5', valor_normalizado: { importe: 20.5, moneda: 'GBP' } } }), 'valor_propuesto'],
      ['categoría sin propuesta con valor_propuesto', entradaOk({ resultado_comparacion: { categoria: 'COINCIDE', ambiguo: false } }), 'no genera propuesta'],
      ['presente false con valor', entradaOk({ valor_previo_en_mongo: { presente: false, valor: '£20' } }), 'presente es false'],
      ['destino_id inválido', entradaOk({ destino_id: 'xyz' }), 'ObjectId'],
      ['fallo sin etapa', entradaFallo({ etapa_fallo: undefined }), 'etapa_fallo'],
      ['propone sin capturado_en', entradaOk({ fuente: { nombre: 'GOV.UK', url: 'https://x', capturado_en: null } }), 'capturado_en']
    ];

    for (const [etiqueta, entrada, mensaje] of casosInvalidos) {
      const { estado, deps } = crearRepoFalso();
      const err = await assertRechaza(() => registrarEjecucionLectura(entrada, deps), ErrorEntradaInvalida, etiqueta);
      assert.ok(err.message.includes(mensaje), `[${etiqueta}] mensaje real: ${err.message}`);
      assert.deepStrictEqual(estado.llamadas, [], `[${etiqueta}] no debe llamar a ninguna dependencia`);
    }

    // capturado_en: solo ISO exacto de Date#toISOString.
    assert.ok(esFechaIsoUtcExacta('2026-09-24T12:00:01.000Z'));
    for (const invalida of ['2026-09-24', '2026-09-24T12:00:01Z', '2026-09-24T09:00:01.000-03:00', '2026-02-30T00:00:00.000Z', 'x', '']) {
      assert.ok(!esFechaIsoUtcExacta(invalida), `"${invalida}" no debería ser ISO válida`);
      assert.throws(() => construirPropuesta(entradaOk(), PROPUESTA_ID_FIJO, invalida), ErrorEntradaInvalida, `fecha_propuesta "${invalida}"`);
      assert.throws(
        () => validarEntrada(entradaOk({ fuente: { nombre: 'GOV.UK', url: 'https://x', capturado_en: invalida } })),
        ErrorEntradaInvalida,
        `capturado_en "${invalida}"`
      );
    }
    for (const noString of [new Date('2026-09-24T12:00:01.000Z'), 1790000000000]) {
      assert.throws(
        () => validarEntrada(entradaFallo({ fuente: { nombre: 'GOV.UK', url: 'https://x', capturado_en: noString } })),
        /capturado_en/
      );
    }
    // Donde no se propone, capturado_en puede faltar (ej. falló el fetch).
    validarEntrada(entradaFallo());
    validarEntrada(
      entradaOk({
        fuente: { nombre: 'GOV.UK', url: 'https://x', capturado_en: null },
        resultado_comparacion: { categoria: 'COINCIDE', ambiguo: false },
        valor_propuesto: undefined
      })
    );

    console.log('3) validación de entrada (incluye capturado_en ISO): OK');
  }

  // ============================================================
  // 4) Documentos construidos pasan los modelos reales; los ajustes de
  //    modelo (construccion_salida, valor_normalizado_coincide) rigen.
  // ============================================================
  {
    const propuesta = construirPropuesta(entradaOk(), PROPUESTA_ID_FIJO, FECHA_PROPUESTA_FIJA);
    const docPropuesta = new PropuestaCambio(propuesta);
    await docPropuesta.validate();
    assert.strictEqual(docPropuesta.version_coordinacion, 0);

    // version_coordinacion: default 0 si se omite; negativa o null rechazada.
    const { version_coordinacion: _omitida, ...sinVersion } = propuesta;
    const docSinVersion = new PropuestaCambio(sinVersion);
    await docSinVersion.validate();
    assert.strictEqual(docSinVersion.version_coordinacion, 0);
    await assertRechaza(
      new PropuestaCambio({ ...propuesta, version_coordinacion: -1 }).validate(),
      'version_coordinacion',
      'version_coordinacion-negativa'
    );
    await assertRechaza(
      new PropuestaCambio({ ...propuesta, version_coordinacion: null }).validate(),
      'version_coordinacion',
      'version_coordinacion-null'
    );

    // Contrato: el modelo rechaza valores distintos aunque el hash se
    // haya recalculado sobre el payload alterado (no depende del hash).
    const contratoInvalido = [
      ['version_contrato', '1.1'],
      ['version_contrato', 1],
      ['tipo_propuesta', 'actualizacion'],
      ['fecha_propuesta', '2026-09-24T12:00:02Z'],
      ['fecha_propuesta', '2026-09-24T09:00:02.000-03:00']
    ];
    for (const [campo, valor] of contratoInvalido) {
      const payload = { ...propuesta.payload, [campo]: valor };
      const doc = new PropuestaCambio({ ...propuesta, payload, payload_hash: hashSobreCanonico(payload, 'toc-v1', 'sha256') });
      await assertRechaza(doc.validate(), campo, `contrato-${campo}-${JSON.stringify(valor)}`);
    }
    const { fecha_propuesta: _f, ...payloadSinFecha } = propuesta.payload;
    await assertRechaza(
      new PropuestaCambio({
        ...propuesta,
        payload: payloadSinFecha,
        payload_hash: hashSobreCanonico(payloadSinFecha, 'toc-v1', 'sha256')
      }).validate(),
      'fecha_propuesta',
      'contrato-sin-fecha_propuesta'
    );
    assert.strictEqual(VERSION_CONTRATO_PROPUESTA, '1.0');
    assert.strictEqual(TIPO_PROPUESTA, 'actualizacion_campo_requisito');

    const finalizado = new Date('2026-09-24T12:00:05.000Z');
    const referencia = {
      propuesta_id_referenciada: propuesta.propuesta_id,
      propuesta_fue_creada_por_esta_ejecucion: true,
      valor_normalizado_coincide: true
    };
    await new EjecucionLectura(construirEjecucion(entradaOk(), referencia, finalizado)).validate();
    await new EjecucionLectura(construirEjecucion(entradaOk(), null, finalizado)).validate();
    await new EjecucionLectura(construirEjecucion(entradaFallo(), null, finalizado)).validate();
    await new EjecucionLectura(
      construirEjecucion(entradaFallo({ etapa_fallo: 'construccion_salida' }), null, finalizado)
    ).validate();

    const sinCoincide = { propuesta_id_referenciada: propuesta.propuesta_id, propuesta_fue_creada_por_esta_ejecucion: false };
    await assertRechaza(
      new EjecucionLectura(construirEjecucion(entradaOk(), sinCoincide, finalizado)).validate(),
      'valor_normalizado_coincide',
      'referencia-exige-valor_normalizado_coincide'
    );

    const etapas = EjecucionLectura.schema.path('etapa_fallo').enumValues;
    for (const etapa of ['construccion_salida', 'deteccion_propuesta_existente', 'creacion_propuesta']) {
      assert.ok(etapas.includes(etapa), `ETAPAS_FALLO debe incluir ${etapa}`);
    }

    console.log('4) documentos construidos válidos contra los modelos reales: OK');
  }

  // ============================================================
  // 5) Categorías: exactamente las del enum real; solo
  //    SIN_COSTO_PREVIO_EN_MONGO e IMPORTE_NO_COINCIDE abren transacción.
  // ============================================================
  {
    const enumCategorias = EjecucionLectura.schema.path('resultado_comparacion').schema.path('categoria').enumValues;
    assert.deepStrictEqual(
      [...enumCategorias].sort(),
      [
        'COINCIDE',
        'FORMATO_AMBIGUO_EN_MONGO',
        'IMPORTE_NO_COINCIDE',
        'MONEDA_AMBIGUA',
        'MONEDA_DISTINTA',
        'SIN_COSTO_PREVIO_EN_MONGO',
        'VALOR_INESPERADO_EN_MONGO'
      ]
    );
    for (const c of CATEGORIAS_QUE_GENERAN_PROPUESTA) assert.ok(enumCategorias.includes(c), c);

    const ambiguas = ['FORMATO_AMBIGUO_EN_MONGO', 'MONEDA_AMBIGUA', 'VALOR_INESPERADO_EN_MONGO'];
    for (const categoria of enumCategorias) {
      const genera = CATEGORIAS_QUE_GENERAN_PROPUESTA.includes(categoria);
      const extra = { resultado_comparacion: { categoria, ambiguo: ambiguas.includes(categoria) } };
      if (!genera) extra.valor_propuesto = undefined;
      if (categoria === 'IMPORTE_NO_COINCIDE') extra.valor_previo_en_mongo = { presente: true, valor: '£15' };

      const { estado, deps } = crearRepoFalso();
      const r = await registrarEjecucionLectura(entradaOk(extra), deps);

      assert.strictEqual(r.estado_ejecucion, 'ok', categoria);
      assert.strictEqual(estado.ejecuciones.length, 1, categoria);
      assert.strictEqual(estado.ejecuciones[0].resultado_comparacion.categoria, categoria);
      if (genera) {
        assert.strictEqual(r.accion, 'propuesta_creada', categoria);
        assert.strictEqual(estado.propuestas.length, 1, categoria);
      } else {
        assert.strictEqual(r.accion, 'sin_propuesta', categoria);
        assert.strictEqual(estado.propuestas.length, 0, categoria);
        assert.ok(!estado.llamadas.includes('ejecutarTransaccion'), `${categoria} no debe abrir transacción`);
        assert.strictEqual(estado.ejecuciones[0].propuesta_referencia, undefined, categoria);
      }
    }

    // Fallo del piloto: solo se registra la ejecución de fallo.
    const { estado, deps } = crearRepoFalso();
    const r = await registrarEjecucionLectura(entradaFallo(), deps);
    assert.strictEqual(r.accion, 'fallo_registrado');
    assert.deepStrictEqual(estado.llamadas, ['verificarIndices', 'insertarEjecucion']);
    assert.strictEqual(estado.ejecuciones[0].etapa_fallo, 'fetch_fuente');

    console.log('5) categorías exactas del enum y cuáles generan propuesta: OK');
  }

  // ============================================================
  // 6) Flujo normal: propuesta creada + ejecución vinculada, misma
  //    transacción.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso();
    const r = await registrarEjecucionLectura(entradaOk(), deps);

    assert.strictEqual(r.accion, 'propuesta_creada');
    assert.strictEqual(r.colisiones, 0);
    assert.strictEqual(estado.commits, 1);
    assert.strictEqual(estado.propuestas.length, 1);
    assert.strictEqual(estado.ejecuciones.length, 1);

    const [p] = estado.propuestas;
    const [e] = estado.ejecuciones;
    assert.strictEqual(p.run_id_origen, e.run_id);
    assert.strictEqual(p.estado, 'pendiente_aprobacion');
    assert.strictEqual(p.version_coordinacion, 0, 'version_coordinacion comienza en 0');
    assert.strictEqual(p.payload.version_contrato, '1.0');
    assert.strictEqual(p.payload.tipo_propuesta, 'actualizacion_campo_requisito');
    assert.ok(esFechaIsoUtcExacta(p.payload.fecha_propuesta));
    assert.strictEqual(p.payload_hash, hashSobreCanonico(p.payload, p.algoritmo_canonicalizacion, p.algoritmo_hash));
    assert.deepStrictEqual(e.propuesta_referencia, {
      propuesta_id_referenciada: p.propuesta_id,
      propuesta_fue_creada_por_esta_ejecucion: true,
      valor_normalizado_coincide: true
    });
    assert.deepStrictEqual(r.propuesta, {
      propuesta_id: p.propuesta_id,
      payload_hash: p.payload_hash,
      estado: 'pendiente_aprobacion',
      creada_por_esta_ejecucion: true,
      valor_normalizado_coincide: true
    });
    assert.deepStrictEqual(estado.llamadas, [
      'verificarIndices',
      'ejecutarTransaccion',
      'buscarPropuestaActiva',
      'insertarPropuesta',
      'insertarEjecucion:tx'
    ]);

    console.log('6) flujo normal: OK');
  }

  // ============================================================
  // 7) Propuesta activa preexistente: se vincula sin crear; la
  //    discrepancia de valor se PERSISTE en la ejecución y no se marca
  //    obsoleta.
  // ============================================================
  {
    for (const [importe, coincide] of [[20, true], [25, false]]) {
      const activa = propuestaDeOtraCorrida({ importe, estado: 'aprobada' });
      const { estado, deps } = crearRepoFalso({ propuestasIniciales: [activa] });
      const r = await registrarEjecucionLectura(entradaOk(), deps);

      assert.strictEqual(r.accion, 'vinculada_a_propuesta_activa');
      assert.ok(!estado.llamadas.includes('insertarPropuesta'));
      assert.strictEqual(estado.propuestas.length, 1);
      assert.strictEqual(estado.propuestas[0].estado, 'aprobada', 'no se toca el estado de la activa');
      assert.deepStrictEqual(estado.ejecuciones[0].propuesta_referencia, {
        propuesta_id_referenciada: activa.propuesta_id,
        propuesta_fue_creada_por_esta_ejecucion: false,
        valor_normalizado_coincide: coincide
      });
      assert.strictEqual(r.propuesta.valor_normalizado_coincide, coincide);
    }

    // Una propuesta NO activa (rechazada) no bloquea crear una nueva.
    const rechazada = propuestaDeOtraCorrida({ estado: 'rechazada' });
    const { estado, deps } = crearRepoFalso({ propuestasIniciales: [rechazada] });
    const r = await registrarEjecucionLectura(entradaOk(), deps);
    assert.strictEqual(r.accion, 'propuesta_creada');
    assert.strictEqual(estado.propuestas.length, 2);

    console.log('7) propuesta activa preexistente (coincidente y discrepante): OK');
  }

  // ============================================================
  // 8) Reconocimiento de colisión E11000: código + índice + keyPattern.
  // ============================================================
  {
    assert.ok(esColisionPropuestaActiva(errorE11000PropuestaActiva()));
    assert.ok(
      esColisionPropuestaActiva(errorE11000PropuestaActiva({ keyPattern: { campo: 1, destino_id: 1, requisito_id: 1 } })),
      'el orden de claves de keyPattern no importa'
    );
    assert.ok(!esColisionPropuestaActiva(errorE11000PropuestaActiva({ keyPattern: null })), 'sin keyPattern no es colisión');
    assert.ok(
      !esColisionPropuestaActiva(errorE11000PropuestaActiva({ keyPattern: { destino_id: 1, requisito_id: 1 } })),
      'keyPattern incompleto'
    );
    assert.ok(
      !esColisionPropuestaActiva(errorE11000PropuestaActiva({ keyPattern: { destino_id: 1, requisito_id: 1, campo: 1, estado: 1 } })),
      'keyPattern con claves extra'
    );
    assert.ok(!esColisionPropuestaActiva(errorE11000PropuestaActiva({ indice: 'otro_indice' })), 'otro índice en el mensaje');
    assert.ok(!esColisionPropuestaActiva(errorE11000RunId(RUN_ID)), 'duplicado de run_id');
    const sinCodigo = errorE11000PropuestaActiva();
    sinCodigo.code = 112;
    assert.ok(!esColisionPropuestaActiva(sinCodigo), 'código distinto de 11000');
    assert.ok(!esColisionPropuestaActiva(null));

    console.log('8) reconocimiento de colisión E11000 por código + índice + keyPattern: OK');
  }

  // ============================================================
  // 9) Colisión E11000: pierde la carrera, la transacción revierte y
  //    el reintento se vincula a la ganadora.
  // ============================================================
  {
    const ganadora = propuestaDeOtraCorrida({ importe: 20 });
    let lanzada = false;
    const { estado, deps } = crearRepoFalso({
      fallas: {
        insertarPropuesta: (st) => {
          if (lanzada) return null;
          lanzada = true;
          st.propuestas.push(ganadora); // la otra corrida hizo commit primero
          return errorE11000PropuestaActiva();
        }
      }
    });
    const r = await registrarEjecucionLectura(entradaOk(), deps);

    assert.strictEqual(r.accion, 'vinculada_a_propuesta_activa');
    assert.strictEqual(r.colisiones, 1);
    assert.strictEqual(estado.commits, 1, 'solo el segundo intento consolida');
    assert.strictEqual(estado.intentosPropuesta.length, 1, 'el segundo intento se vincula sin volver a insertar');
    assert.deepStrictEqual(estado.propuestas, [ganadora], 'no queda ninguna propuesta de esta corrida');
    assert.strictEqual(estado.ejecuciones.length, 1);
    assert.deepStrictEqual(estado.ejecuciones[0].propuesta_referencia, {
      propuesta_id_referenciada: ganadora.propuesta_id,
      propuesta_fue_creada_por_esta_ejecucion: false,
      valor_normalizado_coincide: true
    });
    assert.strictEqual(estado.ejecuciones[0].estado_ejecucion, 'ok');

    console.log('9) colisión E11000 → vinculada a la propuesta activa ganadora: OK');
  }

  // ============================================================
  // 10) La ganadora desaparece en cada intento: fallo registrado en
  //     deteccion_propuesta_existente tras MAX_INTENTOS.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso({ fallas: { insertarPropuesta: () => errorE11000PropuestaActiva() } });
    const r = await registrarEjecucionLectura(entradaOk(), deps);

    assert.strictEqual(r.estado_ejecucion, 'fallo');
    assert.strictEqual(r.etapa_fallo, 'deteccion_propuesta_existente');
    assert.strictEqual(r.colisiones, MAX_INTENTOS);
    assert.strictEqual(estado.intentosPropuesta.length, MAX_INTENTOS);
    assertIntentosIdenticos(estado.intentosPropuesta, 'reintentos-tras-E11000');
    assert.strictEqual(estado.uuids, 1, 'propuesta_id se genera una sola vez');
    assert.strictEqual(estado.propuestas.length, 0);
    assert.strictEqual(estado.ejecuciones.length, 1);
    const [e] = estado.ejecuciones;
    assert.strictEqual(e.estado_ejecucion, 'fallo');
    assert.strictEqual(e.etapa_fallo, 'deteccion_propuesta_existente');
    assert.strictEqual(e.propuesta_referencia, undefined);
    assert.strictEqual(e.resultado_comparacion.categoria, 'SIN_COSTO_PREVIO_EN_MONGO', 'conserva lo que sí se leyó');

    console.log('10) ganadora inubicable tras MAX_INTENTOS → fallo registrado: OK');
  }

  // ============================================================
  // 11) E11000 no atribuible (sin keyPattern): NO se trata como
  //     colisión; fallo en creacion_propuesta tras un solo intento.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso({
      fallas: { insertarPropuesta: () => errorE11000PropuestaActiva({ keyPattern: null }) }
    });
    const r = await registrarEjecucionLectura(entradaOk(), deps);

    assert.strictEqual(r.estado_ejecucion, 'fallo');
    assert.strictEqual(r.etapa_fallo, 'creacion_propuesta');
    assert.strictEqual(r.colisiones, 0);
    assert.strictEqual(estado.intentosPropuesta.length, 1);
    assert.strictEqual(estado.ejecuciones[0].etapa_fallo, 'creacion_propuesta');

    console.log('11) E11000 sin keyPattern del índice → fallo, no colisión: OK');
  }

  // ============================================================
  // 12) run_id duplicado: ErrorEjecucionDuplicada sin escribir nada
  //     (ni propuesta ni ejecución de fallo).
  // ============================================================
  {
    const previa = construirEjecucion(entradaFallo(), null, new Date('2026-09-24T11:00:00.000Z'));

    const conPropuesta = crearRepoFalso({ ejecucionesIniciales: [previa] });
    await assertRechaza(registrarEjecucionLectura(entradaOk(), conPropuesta.deps), ErrorEjecucionDuplicada, 'dup-run-id-con-propuesta');
    assert.strictEqual(conPropuesta.estado.propuestas.length, 0, 'la propuesta del intento revierte');
    assert.deepStrictEqual(conPropuesta.estado.ejecuciones, [previa]);
    assert.strictEqual(conPropuesta.estado.intentosPropuesta.length, 1, 'no reintenta');

    const sinPropuesta = crearRepoFalso({ ejecucionesIniciales: [previa] });
    await assertRechaza(registrarEjecucionLectura(entradaFallo(), sinPropuesta.deps), ErrorEjecucionDuplicada, 'dup-run-id-fallo');
    assert.deepStrictEqual(sinPropuesta.estado.ejecuciones, [previa]);

    console.log('12) run_id duplicado → ErrorEjecucionDuplicada sin escrituras: OK');
  }

  // ============================================================
  // 13) Errores que no son E11000: rollback + ejecución de fallo fuera
  //     de la transacción, con la etapa en la que estaba.
  // ============================================================
  {
    const creacion = crearRepoFalso({ fallas: { insertarPropuesta: () => new Error('write conflict simulado') } });
    const r1 = await registrarEjecucionLectura(entradaOk(), creacion.deps);
    assert.strictEqual(r1.etapa_fallo, 'creacion_propuesta');
    assert.strictEqual(r1.error_mensaje, 'write conflict simulado');
    assert.strictEqual(creacion.estado.propuestas.length, 0);
    assert.strictEqual(creacion.estado.ejecuciones.length, 1);
    assert.strictEqual(creacion.estado.llamadas.at(-1), 'insertarEjecucion', 'el fallo se registra sin sesión');

    // Falla la ejecución DENTRO de la transacción, después de insertar
    // la propuesta: la propuesta también revierte.
    const ejecucionTx = crearRepoFalso({
      fallas: { insertarEjecucion: (doc, session) => (session ? new Error('fallo al insertar ejecución') : null) }
    });
    const r2 = await registrarEjecucionLectura(entradaOk(), ejecucionTx.deps);
    assert.strictEqual(r2.etapa_fallo, 'creacion_propuesta');
    assert.strictEqual(ejecucionTx.estado.propuestas.length, 0, 'propuesta sin ejecución no puede quedar');
    assert.strictEqual(ejecucionTx.estado.ejecuciones[0].estado_ejecucion, 'fallo');

    const deteccion = crearRepoFalso({ fallas: { buscarPropuestaActiva: new Error('cursor timeout') } });
    const r3 = await registrarEjecucionLectura(entradaOk(), deteccion.deps);
    assert.strictEqual(r3.etapa_fallo, 'deteccion_propuesta_existente');
    assert.ok(!deteccion.estado.llamadas.includes('insertarPropuesta'));

    console.log('13) errores no E11000 → rollback + fallo registrado con su etapa: OK');
  }

  // ============================================================
  // 14) Si tampoco se puede registrar el fallo, el error lleva ambos
  //     mensajes.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso({
      fallas: {
        insertarPropuesta: () => new Error('error original'),
        insertarEjecucion: (doc, session) => (session ? null : new Error('error al registrar fallo'))
      }
    });
    const err = await assertRechaza(registrarEjecucionLectura(entradaOk(), deps), 'error original', 'doble-falla');
    assert.ok(err.message.includes('error al registrar fallo'), err.message);
    assert.strictEqual(estado.propuestas.length, 0);
    assert.strictEqual(estado.ejecuciones.length, 0);

    console.log('14) doble falla → error con ambos mensajes: OK');
  }

  // ============================================================
  // 15) Reintento de withTransaction (callback corrido dos veces):
  //     mismo propuesta_id y hash, un solo commit.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso({ repetirCallback: true });
    const r = await registrarEjecucionLectura(entradaOk(), deps);

    assert.strictEqual(r.accion, 'propuesta_creada');
    assert.strictEqual(estado.uuids, 1, 'propuesta_id se genera una sola vez, fuera del callback');
    assert.strictEqual(estado.intentosPropuesta.length, 2);
    assertIntentosIdenticos(estado.intentosPropuesta, 'reintento-transient');
    assert.ok(estado.ahoras > 1, 'ahora() avanzó entre intentos: una fecha regenerada habría cambiado');
    assert.strictEqual(estado.propuestas[0].payload.fecha_propuesta, estado.intentosPropuesta[0].payload.fecha_propuesta);
    assert.strictEqual(estado.propuestas[0].version_coordinacion, 0);
    assert.strictEqual(estado.commits, 1);
    assert.strictEqual(estado.propuestas.length, 1);
    assert.strictEqual(estado.ejecuciones.length, 1);

    // Ambos tipos de reintento combinados. En cada intento del bucle: la
    // primera corrida del callback termina bien pero se descarta
    // (transient), y la re-ejecución choca con E11000 (llamadas pares a
    // insertarPropuesta). Un E11000 no lo reintenta withTransaction: lo
    // relanza y es el bucle del servicio el que vuelve a intentar.
    let llamadasInsertar = 0;
    const mixto = crearRepoFalso({
      repetirCallback: true,
      fallas: { insertarPropuesta: () => (++llamadasInsertar % 2 === 0 ? errorE11000PropuestaActiva() : null) }
    });
    const rMixto = await registrarEjecucionLectura(entradaOk(), mixto.deps);
    assert.strictEqual(rMixto.colisiones, MAX_INTENTOS);
    assert.strictEqual(mixto.estado.intentosPropuesta.length, MAX_INTENTOS * 2);
    assertIntentosIdenticos(mixto.estado.intentosPropuesta, 'reintentos-mixtos');

    console.log('15) reintentos (transient y E11000) conservan propuesta_id, fecha_propuesta y payload_hash: OK');
  }

  // ============================================================
  // 16) Precondición de índices: si falla, no se escribe nada.
  // ============================================================
  {
    const { estado, deps } = crearRepoFalso({ fallas: { verificarIndices: new ErrorPrecondicionIndices('falta índice') } });
    await assertRechaza(registrarEjecucionLectura(entradaOk(), deps), ErrorPrecondicionIndices, 'sin-indices');
    assert.deepStrictEqual(estado.llamadas, ['verificarIndices']);

    const indicePropuestaActiva = {
      name: INDICE_PROPUESTA_ACTIVA,
      key: { destino_id: 1, requisito_id: 1, campo: 1 },
      unique: true,
      partialFilterExpression: { estado: { $in: ['pendiente_aprobacion', 'aprobada', 'revision_requerida'] } }
    };
    const idId = { name: '_id_', key: { _id: 1 } };
    const idPropuesta = { name: 'propuesta_id_1', key: { propuesta_id: 1 }, unique: true };
    const idRun = { name: 'run_id_1', key: { run_id: 1 }, unique: true };

    verificarListadoIndices([idId, indicePropuestaActiva, idPropuesta], [idId, idRun]);

    const variantesInvalidas = [
      ['sin índice parcial', [idId, idPropuesta], [idId, idRun]],
      ['parcial no único', [{ ...indicePropuestaActiva, unique: false }, idPropuesta], [idRun]],
      ['parcial sin filtro', [{ ...indicePropuestaActiva, partialFilterExpression: undefined }, idPropuesta], [idRun]],
      [
        'parcial con otros estados',
        [{ ...indicePropuestaActiva, partialFilterExpression: { estado: { $in: ['pendiente_aprobacion', 'aprobada'] } } }, idPropuesta],
        [idRun]
      ],
      ['parcial con otra clave', [{ ...indicePropuestaActiva, key: { destino_id: 1, campo: 1 } }, idPropuesta], [idRun]],
      ['sin propuesta_id único', [indicePropuestaActiva], [idRun]],
      ['sin run_id único', [indicePropuestaActiva, idPropuesta], [idId]],
      ['colecciones inexistentes', [], []]
    ];
    for (const [etiqueta, propuestas, ejecuciones] of variantesInvalidas) {
      assert.throws(() => verificarListadoIndices(propuestas, ejecuciones), ErrorPrecondicionIndices, etiqueta);
    }

    console.log('16) precondición de índices: OK');
  }

  // ============================================================
  // 17) Sincronía con lo declarado en los schemas: el listado que
  //     produciría crear exactamente los índices declarados pasa la
  //     verificación del servicio.
  // ============================================================
  {
    const comoListado = (Model) =>
      Model.schema.indexes().map(([key, opciones]) => ({
        name: opciones.name ?? Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_'),
        key,
        unique: opciones.unique === true,
        ...(opciones.partialFilterExpression && { partialFilterExpression: opciones.partialFilterExpression })
      }));

    const declaradosPropuesta = comoListado(PropuestaCambio);
    const parcial = declaradosPropuesta.find((i) => i.name === INDICE_PROPUESTA_ACTIVA);
    assert.ok(parcial, 'el índice parcial debe estar declarado en PropuestaCambio');
    assert.deepStrictEqual(parcial.partialFilterExpression, { estado: { $in: ESTADOS_ACTIVOS } });
    assert.deepStrictEqual(parcial.key, CLAVE_INDICE_PROPUESTA_ACTIVA);

    verificarListadoIndices(declaradosPropuesta, comoListado(EjecucionLectura));

    console.log('17) ESTADOS_ACTIVOS e índices del servicio sincronizados con los schemas: OK');
  }

  // ============================================================
  // 18) Dependencias REALES (crearDependenciasMongoose) sin índices:
  //     el servicio se niega antes de cualquier escritura. Sin Mongo:
  //     se reemplaza solo el listado de índices de cada colección y se
  //     espían save() y transaction() para comprobar que nunca se llaman.
  // ============================================================
  {
    const originales = {
      indicesPropuesta: PropuestaCambio.collection.indexes,
      indicesEjecucion: EjecucionLectura.collection.indexes,
      savePropuesta: PropuestaCambio.prototype.save,
      saveEjecucion: EjecucionLectura.prototype.save
    };
    const escrituras = [];
    PropuestaCambio.prototype.save = async function () {
      escrituras.push('PropuestaCambio.save');
    };
    EjecucionLectura.prototype.save = async function () {
      escrituras.push('EjecucionLectura.save');
    };
    const conexionFalsa = {
      transaction: async () => {
        escrituras.push('transaction');
      }
    };
    const namespaceNotFound = () => Object.assign(new Error('ns does not exist'), { code: 26 });
    const soloId = async () => [{ name: '_id_', key: { _id: 1 } }];

    const escenarios = [
      [
        'colecciones inexistentes (NamespaceNotFound)',
        async () => {
          throw namespaceNotFound();
        },
        async () => {
          throw namespaceNotFound();
        }
      ],
      ['colecciones solo con _id_', soloId, soloId]
    ];

    try {
      for (const [etiqueta, listarPropuestas, listarEjecuciones] of escenarios) {
        PropuestaCambio.collection.indexes = listarPropuestas;
        EjecucionLectura.collection.indexes = listarEjecuciones;
        const deps = crearDependenciasMongoose(conexionFalsa);
        for (const entrada of [entradaOk(), entradaFallo()]) {
          await assertRechaza(
            registrarEjecucionLectura(entrada, deps),
            ErrorPrecondicionIndices,
            `${etiqueta} / ${entrada.estado_ejecucion}`
          );
        }
        assert.deepStrictEqual(escrituras, [], `${etiqueta}: no debe haber ninguna escritura`);
      }
    } finally {
      PropuestaCambio.collection.indexes = originales.indicesPropuesta;
      EjecucionLectura.collection.indexes = originales.indicesEjecucion;
      PropuestaCambio.prototype.save = originales.savePropuesta;
      EjecucionLectura.prototype.save = originales.saveEjecucion;
    }

    console.log('18) dependencias reales sin índices → ErrorPrecondicionIndices, cero escrituras: OK');
  }

  console.log('\nTodas las pruebas offline del servicio pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
