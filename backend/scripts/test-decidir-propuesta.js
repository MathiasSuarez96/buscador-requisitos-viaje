// Pruebas offline (sin conexión a Mongo, sin red) para
// scripts/decidir-propuesta.js. Todas las dependencias son falsas: el
// comando nunca conecta ni escribe; `decidir` solo registra con qué
// entrada se lo llamó. El flujo transaccional del servicio se prueba en
// scripts/test-servicio-decision-propuesta.js.
//
// Uso: node scripts/test-decidir-propuesta.js

const assert = require('assert');

const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const { ErrorConfiguracionOperadores, ErrorActorNoAutorizado } = require('../services/propuestas/operadores-autorizados');
const { ErrorPrecondicionIndices } = require('../services/propuestas/indices-propuestas');
const { ocultarUri, construirEntradaDesdeVista, ejecutar, crearDependenciasComando } = require('./decidir-propuesta');

const PROPUESTA_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '99999999-9999-4999-8999-000000000001';
const SECRETO = 'secreto-falso-9f3';
const URI_FALSA = `mongodb+srv://operador-prueba:${SECRETO}@cluster-falso.example.net/buscador_requisitos?retryWrites=true`;
const URI_BACKEND = 'mongodb+srv://backend-app:otra-clave@cluster-falso.example.net/buscador_requisitos';
const USUARIO = { user: 'operador-prueba', db: 'admin' };
const OPERADORES_JSON = JSON.stringify([{ usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' }]);

function propuestaEn(estado) {
  const p = construirPropuesta(
    {
      run_id: '11111111-1111-4111-8111-111111111111',
      campo: 'costo',
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-24T12:00:01.000Z' },
      evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP' } } },
      destino_id: '000000000000000000000001',
      requisito_id: '000000000000000000000002',
      valor_previo_en_mongo: { presente: true, valor: '£16' },
      valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } }
    },
    PROPUESTA_ID,
    '2026-09-24T12:00:02.000Z'
  );
  const aprobada = estado !== 'pendiente_aprobacion';
  return {
    ...p,
    estado,
    version_coordinacion: aprobada ? 1 : 0,
    decision_aprobacion_id: aprobada ? DECISION_ID : null,
    ultimo_evento_id: aprobada ? DECISION_ID : null
  };
}

// Todas las líneas que el comando imprimió en cualquier prueba: al final
// se verifica que ninguna contenga la URI ni la contraseña.
const TODOS_LOS_LOGS = [];

function crearEntorno(opciones = {}) {
  const {
    uriBackend = URI_BACKEND,
    dbName = 'buscador_requisitos',
    usuarios = [USUARIO],
    errorIndices = null,
    errorConectar = null,
    respuesta,
    resultadoDecision = { resultado: 'decision_registrada' }
  } = opciones;
  // Sin default de desestructuración: un `undefined`/`null` explícito
  // tiene que llegar tal cual (variable ausente, propuesta inexistente).
  const tomar = (clave, porDefecto) => (clave in opciones ? opciones[clave] : porDefecto);
  const uri = tomar('uri', URI_FALSA);
  const operadoresJson = tomar('operadoresJson', OPERADORES_JSON);
  const propuesta = tomar('propuesta', propuestaEn('pendiente_aprobacion'));
  const llamadas = { conectar: [], usuarios: 0, leer: 0, indices: 0, preguntar: 0, decidir: [] };
  const logs = [];
  const deps = {
    uriDecision: () => uri,
    uriBackend: () => uriBackend,
    operadoresJson: () => operadoresJson,
    conectar: async (u) => {
      llamadas.conectar.push(u);
      if (errorConectar) throw errorConectar;
      return dbName;
    },
    usuariosAutenticados: async () => {
      llamadas.usuarios++;
      return usuarios;
    },
    verificarIndices: async () => {
      llamadas.indices++;
      if (errorIndices) throw errorIndices;
    },
    leerPropuesta: async (id) => {
      llamadas.leer++;
      return propuesta && propuesta.propuesta_id === id ? structuredClone(propuesta) : null;
    },
    preguntar: async () => {
      llamadas.preguntar++;
      return respuesta ?? propuesta.payload_hash.slice(0, 12);
    },
    decidir: async (entrada, json) => {
      llamadas.decidir.push({ entrada, json });
      return resultadoDecision;
    }
  };
  const log = (linea) => {
    logs.push(String(linea));
    TODOS_LOS_LOGS.push(String(linea));
  };
  return { deps, llamadas, logs, log };
}

const config = (extra = {}) => ({ modo: 'solo_lectura', operacion: 'aprobacion', propuesta_id: PROPUESTA_ID, motivo: '', ...extra });

async function assertRechaza(promesa, claseOMensaje, etiqueta) {
  let err;
  try {
    await promesa;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `[${etiqueta}] se esperaba un error`);
  TODOS_LOS_LOGS.push(String(err.message));
  if (typeof claseOMensaje === 'string') {
    assert.ok(String(err.message).includes(claseOMensaje), `[${etiqueta}] mensaje real: ${err.message}`);
  } else {
    assert.ok(err instanceof claseOMensaje, `[${etiqueta}] clase real: ${err.constructor.name} (${err.message})`);
  }
  return err;
}

(async () => {
  // ============================================================
  // 1) ocultarUri
  // ============================================================
  {
    const uriCodificada = 'mongodb://op:p%40ss%2Fword@host.example/db';
    const casos = [
      [`fallo al conectar a ${URI_FALSA}: timeout`, URI_FALSA],
      [`auth failed for password ${SECRETO}`, URI_FALSA],
      ['otra uri mongodb://alguien:clave@otro.example/x suelta', URI_FALSA],
      ['clave decodificada p@ss/word y cruda p%40ss%2Fword', uriCodificada]
    ];
    for (const [texto, uri] of casos) {
      const limpio = ocultarUri(texto, uri);
      for (const prohibido of [URI_FALSA, SECRETO, 'mongodb://', 'mongodb+srv://', 'p@ss/word', 'p%40ss%2Fword', 'clave@']) {
        assert.ok(!limpio.includes(prohibido), `"${limpio}" contiene ${prohibido}`);
      }
    }
    assert.strictEqual(ocultarUri('sin nada sensible', undefined), 'sin nada sensible');
    console.log('1) ocultarUri: URI completa, contraseña cruda/decodificada y URIs sueltas ocultas: OK');
  }

  // ============================================================
  // 2) Aborta ANTES de conectar
  // ============================================================
  {
    const operador = { usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' };
    const casos = [
      ['modo desconocido', config({ modo: 'escritura' }), {}, 'Modo desconocido'],
      ['operación vacía', config({ operacion: '' }), {}, 'OPERACION'],
      ['operación de sistema', config({ operacion: 'aplicacion' }), {}, 'OPERACION'],
      ['PROPUESTA_ID vacío', config({ propuesta_id: '' }), {}, 'PROPUESTA_ID'],
      ['PROPUESTA_ID no UUID', config({ propuesta_id: 'abc' }), {}, 'PROPUESTA_ID'],
      ['rechazo real sin MOTIVO', config({ modo: 'decision_real', operacion: 'rechazo' }), {}, 'exige MOTIVO'],
      ['cancelación real con MOTIVO en blanco', config({ modo: 'decision_real', operacion: 'cancelacion', motivo: '  ' }), {}, 'exige MOTIVO'],
      ['MONGODB_URI_DECISION ausente', config(), { uri: undefined }, 'No se usa MONGODB_URI como alternativa'],
      ['MONGODB_URI_DECISION vacía', config(), { uri: '' }, 'MONGODB_URI_DECISION ausente'],
      ['MONGODB_URI_DECISION igual a MONGODB_URI', config(), { uriBackend: URI_FALSA }, 'igual a MONGODB_URI'],
      ['allowlist ausente', config(), { operadoresJson: undefined }, ErrorConfiguracionOperadores],
      ['allowlist JSON inválido', config(), { operadoresJson: '[{' }, ErrorConfiguracionOperadores],
      ['allowlist vacía', config(), { operadoresJson: '[]' }, ErrorConfiguracionOperadores],
      ['allowlist duplicada', config(), { operadoresJson: JSON.stringify([operador, operador]) }, ErrorConfiguracionOperadores]
    ];
    for (const [nombre, cfg, opciones, esperado] of casos) {
      const { deps, llamadas, log } = crearEntorno(opciones);
      await assertRechaza(ejecutar(cfg, deps, log), esperado, nombre);
      assert.strictEqual(llamadas.conectar.length, 0, `[${nombre}] no conecta`);
    }

    // Las dependencias reales nunca caen en MONGODB_URI.
    const reales = crearDependenciasComando({ MONGODB_URI: URI_BACKEND, OPERADORES_AUTORIZADOS_JSON: OPERADORES_JSON });
    assert.strictEqual(reales.uriDecision(), undefined);
    assert.strictEqual(reales.operadoresJson(), OPERADORES_JSON);
    console.log('2) 14 configuraciones inválidas abortan sin conectar; sin fallback a MONGODB_URI: OK');
  }

  // ============================================================
  // 3) Conexión: error sin filtrar la URI, base equivocada
  // ============================================================
  {
    {
      const errorConectar = new Error(`querySrv ENOTFOUND para ${URI_FALSA} (password ${SECRETO})`);
      const { deps, log } = crearEntorno({ errorConectar });
      const err = await assertRechaza(ejecutar(config(), deps, log), 'No se pudo conectar con MONGODB_URI_DECISION', 'error de conexión');
      assert.ok(!err.message.includes(SECRETO) && !err.message.includes(URI_FALSA));
    }
    {
      const { deps, llamadas, log } = crearEntorno({ dbName: 'test' });
      await assertRechaza(ejecutar(config(), deps, log), 'Base de datos inesperada', 'db distinta');
      assert.deepStrictEqual([llamadas.usuarios, llamadas.leer], [0, 0]);
    }
    {
      const { deps, llamadas, log } = crearEntorno();
      await ejecutar(config(), deps, log);
      assert.deepStrictEqual(llamadas.conectar, [URI_FALSA], 'conecta con MONGODB_URI_DECISION');
    }
    console.log('3) error de conexión sin URI ni contraseña; base inesperada aborta antes de leer: OK');
  }

  // ============================================================
  // 4) solo_lectura muestra todo y no escribe
  // ============================================================
  {
    const propuesta = propuestaEn('pendiente_aprobacion');
    const { deps, llamadas, logs, log } = crearEntorno({ propuesta });
    const r = await ejecutar(config(), deps, log);
    assert.deepStrictEqual(r, { modo: 'solo_lectura', escrito: false, gate_ok: true, identidad_ok: true });
    assert.deepStrictEqual([llamadas.preguntar, llamadas.decidir.length], [0, 0]);
    const salida = logs.join('\n');
    for (const esperado of [
      propuesta.payload_hash,
      propuesta.payload_hash.slice(0, 12),
      'version_coordinacion:   0',
      'estado:                 pendiente_aprobacion',
      JSON.stringify(propuesta.payload.valor_anterior),
      JSON.stringify('£20'),
      JSON.stringify({ importe: 20, moneda: 'GBP' }),
      'hash recalculado: coincide',
      'Filtro CAS que se usaría',
      '"decision_aprobacion_id": null',
      'Operador: operador.prueba',
      'Gate de índices (INDICES_DECISION): OK',
      'no se escribió nada'
    ]) {
      assert.ok(salida.includes(esperado), `la salida debe incluir ${esperado}`);
    }

    // Con problemas, solo_lectura informa pero sigue mostrando.
    const conProblemas = crearEntorno({
      propuesta: propuestaEn('aplicada'),
      usuarios: [],
      errorIndices: new ErrorPrecondicionIndices('falta eventos_propuesta.evento_id_1')
    });
    const r2 = await ejecutar(config(), conProblemas.deps, conProblemas.log);
    assert.deepStrictEqual(r2, { modo: 'solo_lectura', escrito: false, gate_ok: false, identidad_ok: false });
    const salida2 = conProblemas.logs.join('\n');
    for (const esperado of ['Identidad RECHAZADA', 'Operación NO permitida', 'Gate de índices FALLARÍA']) {
      assert.ok(salida2.includes(esperado), esperado);
    }
    assert.deepStrictEqual([conProblemas.llamadas.preguntar, conProblemas.llamadas.decidir.length], [0, 0]);
    console.log('4) solo_lectura: muestra payload, hash, versión, valores y CAS; con identidad/gate/transición inválidos solo informa: OK');
  }

  // ============================================================
  // 5) Hash guardado distinto del recalculado, propuesta inexistente
  // ============================================================
  {
    for (const modo of ['solo_lectura', 'decision_real']) {
      const propuesta = propuestaEn('pendiente_aprobacion');
      propuesta.payload = { ...propuesta.payload, valor_propuesto: { ...propuesta.payload.valor_propuesto, valor: '£99' } };
      const { deps, llamadas, log } = crearEntorno({ propuesta });
      await assertRechaza(ejecutar(config({ modo }), deps, log), 'hash recalculado', `hash manipulado (${modo})`);
      assert.deepStrictEqual([llamadas.preguntar, llamadas.decidir.length], [0, 0]);
    }
    const { deps, log } = crearEntorno({ propuesta: null });
    await assertRechaza(ejecutar(config(), deps, log), 'No existe la propuesta', 'inexistente');
    console.log('5) payload manipulado aborta en ambos modos; propuesta inexistente aborta: OK');
  }

  // ============================================================
  // 6) decision_real aborta antes de pedir confirmación
  // ============================================================
  {
    const sinDecision = { ...propuestaEn('aprobada'), decision_aprobacion_id: null };
    const casos = [
      ['identidad rechazada', { usuarios: [{ user: 'backend-app', db: 'admin' }] }, config({ modo: 'decision_real' }), ErrorActorNoAutorizado],
      ['gate de índices', { errorIndices: new ErrorPrecondicionIndices('falta') }, config({ modo: 'decision_real' }), ErrorPrecondicionIndices],
      ['aprobar una aprobada', { propuesta: propuestaEn('aprobada') }, config({ modo: 'decision_real' }), 'Operación no permitida'],
      ['cancelar una pendiente', {}, config({ modo: 'decision_real', operacion: 'cancelacion', motivo: 'x' }), 'Operación no permitida'],
      ['cancelar aprobada sin decisión', { propuesta: sinDecision }, config({ modo: 'decision_real', operacion: 'cancelacion', motivo: 'x' }), 'inconsistencia']
    ];
    for (const [nombre, opciones, cfg, esperado] of casos) {
      const { deps, llamadas, log } = crearEntorno(opciones);
      await assertRechaza(ejecutar(cfg, deps, log), esperado, nombre);
      assert.deepStrictEqual([llamadas.preguntar, llamadas.decidir.length], [0, 0], nombre);
    }
    console.log('6) decision_real: identidad, gate o transición inválidos abortan sin pedir confirmación: OK');
  }

  // ============================================================
  // 7) Confirmación por prefijo de payload_hash
  // ============================================================
  {
    const propuesta = propuestaEn('pendiente_aprobacion');
    const h = propuesta.payload_hash;
    for (const [nombre, respuesta] of [
      ['11 caracteres', h.slice(0, 11)],
      ['13 caracteres', h.slice(0, 13)],
      ['hash completo', h],
      ['mayúsculas', h.slice(0, 12).toUpperCase()],
      ['otro prefijo', h.slice(1, 13)],
      ['vacía', '']
    ]) {
      const { deps, llamadas, log } = crearEntorno({ propuesta, respuesta });
      await assertRechaza(ejecutar(config({ modo: 'decision_real' }), deps, log), 'no coincide', nombre);
      assert.deepStrictEqual([llamadas.preguntar, llamadas.decidir.length], [1, 0], nombre);
    }
    console.log('7) confirmación distinta de los 12 primeros caracteres exactos → no se llama al servicio: OK');
  }

  // ============================================================
  // 8) Confirmación correcta: el servicio recibe EXACTAMENTE lo mostrado
  // ============================================================
  {
    const casos = [
      ['aprobacion', propuestaEn('pendiente_aprobacion'), ''],
      ['rechazo', propuestaEn('pendiente_aprobacion'), 'fuente no oficial'],
      ['cancelacion', propuestaEn('aprobada'), 'ya no aplica'],
      ['cancelacion', propuestaEn('revision_requerida'), 'revisión descartada']
    ];
    for (const [operacion, propuesta, motivo] of casos) {
      const etiqueta = `${operacion} desde ${propuesta.estado}`;
      const { deps, llamadas, logs, log } = crearEntorno({ propuesta, respuesta: `  ${propuesta.payload_hash.slice(0, 12)}\n` });
      const r = await ejecutar(config({ modo: 'decision_real', operacion, motivo }), deps, log);
      assert.strictEqual(r.escrito, true, etiqueta);
      assert.strictEqual(llamadas.decidir.length, 1, etiqueta);
      const esperado = {
        tipo_evento: operacion,
        propuesta_id: PROPUESTA_ID,
        estado_esperado: propuesta.estado,
        payload_hash_esperado: propuesta.payload_hash,
        version_coordinacion_esperada: propuesta.version_coordinacion,
        decision_aprobacion_id_esperado: propuesta.decision_aprobacion_id
      };
      if (motivo) esperado.motivo = motivo;
      assert.deepStrictEqual(llamadas.decidir[0].entrada, esperado, etiqueta);
      assert.deepStrictEqual(construirEntradaDesdeVista(operacion, propuesta, motivo), esperado);
      assert.strictEqual(llamadas.decidir[0].json, OPERADORES_JSON, `[${etiqueta}] el servicio recibe la misma allowlist`);
      assert.strictEqual(llamadas.leer, 1, `[${etiqueta}] no se relee tras confirmar`);
      assert.ok(logs.join('\n').includes('=== RESULTADO ==='));
    }

    // Resultado cas_no_coincide → escrito false (exit code 1 en main).
    const { deps, log } = crearEntorno({ resultadoDecision: { resultado: 'cas_no_coincide', escrito: false } });
    const r = await ejecutar(config({ modo: 'decision_real' }), deps, log);
    assert.strictEqual(r.escrito, false);
    console.log('8) confirmación correcta: el servicio recibe los valores mostrados, sin releer; cas_no_coincide → escrito false: OK');
  }

  // ============================================================
  // 9) Ninguna salida contiene la URI ni la contraseña
  // ============================================================
  {
    assert.ok(TODOS_LOS_LOGS.length > 50);
    for (const linea of TODOS_LOS_LOGS) {
      assert.ok(!linea.includes(SECRETO), `salida con contraseña: ${linea}`);
      assert.ok(!linea.includes(URI_FALSA), `salida con URI: ${linea}`);
      assert.ok(!/mongodb(\+srv)?:\/\//.test(linea), `salida con una URI de Mongo: ${linea}`);
    }
    console.log(`9) ${TODOS_LOS_LOGS.length} líneas de salida y mensajes de error revisados: ninguno contiene la URI ni la contraseña: OK`);
  }

  console.log('\nTodas las pruebas offline del comando pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
