// Pruebas offline (sin .env, sin red, sin Mongo) para
// scripts/aplicar-propuesta.js. Todas las dependencias son falsas: el
// comando nunca conecta ni escribe; `aplicar` solo registra con qué
// entrada se lo llamó y el adaptador devuelve respuestas guionadas. El
// flujo transaccional del servicio se prueba en
// scripts/test-servicio-aplicacion-propuesta.js.
//
// Uso: node scripts/test-aplicar-propuesta.js

const assert = require('assert');
const { ObjectId } = require('bson');

const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const { ErrorConfiguracionOperadores, ErrorActorNoAutorizado } = require('../services/propuestas/operadores-autorizados');
const { ErrorPrecondicionIndices } = require('../services/propuestas/indices-propuestas');
const { ErrorSinAdaptador, elegirAdaptador } = require('../services/propuestas/adaptadores');
const adaptadorGovUk = require('../services/propuestas/adaptadores/govuk-uk-eta');
const { REQUISITO_ID_ETA, URL_ETA, FUENTE_NOMBRE } = require('../services/propuestas/fuentes/govuk-uk-eta');
const {
  ErrorInconsistencia,
  ErrorPropuestaNoSoportada,
  ErrorEscrituraAbortada,
  filtroCasPropuesta,
  filtroDestino
} = require('../services/propuestas/aplicar-propuesta');
const {
  construirEntradaDesdeVista,
  previsionDe,
  codigoSalida,
  paraMostrar,
  mensajeDeError,
  ejecutar,
  crearDependenciasComando
} = require('./aplicar-propuesta');

const PROPUESTA_ID = '22222222-2222-4222-8222-222222222222';
const APROBACION_ID = '99999999-9999-4999-8999-000000000001';
const DESTINO_HEX = '0000000000000000000000a1';
const OTRO_REQ_HEX = '0000000000000000000000b3';
const SECRETO = 'secreto-falso-9f3';
const URI_FALSA = `mongodb+srv://operador-prueba:${SECRETO}@cluster-falso.example.net/buscador_requisitos?retryWrites=true`;
const URI_BACKEND = 'mongodb+srv://backend-app:otra-clave@cluster-falso.example.net/buscador_requisitos';
const USUARIO = { user: 'operador-prueba', db: 'admin' };
const OPERADORES_JSON = JSON.stringify([{ usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' }]);
const AHORA = new Date('2026-09-30T10:00:00.000Z');
const REVALIDADA_EN = new Date('2026-09-30T10:00:01.000Z');

// Como structuredClone, pero conserva ObjectId (structuredClone lo
// convierte en un objeto plano).
function clonar(v) {
  if (v instanceof ObjectId) return ObjectId.createFromHexString(v.toHexString());
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clonar);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)]));
  return v;
}

const AUSENTE = { presente: false, valor: null };
const NULO = { presente: true, valor: null };
const VALOR16 = { presente: true, valor: '£16' };

function fixture({ valorAnterior = VALOR16 } = {}) {
  const p = construirPropuesta(
    {
      run_id: '11111111-1111-4111-8111-111111111111',
      campo: 'costo',
      fuente: { nombre: FUENTE_NOMBRE, url: URL_ETA, capturado_en: '2026-09-24T12:00:01.000Z' },
      evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP' } } },
      destino_id: DESTINO_HEX,
      requisito_id: REQUISITO_ID_ETA,
      valor_previo_en_mongo: { ...valorAnterior },
      valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } }
    },
    PROPUESTA_ID,
    '2026-09-24T12:00:02.000Z'
  );
  const propuesta = {
    ...p,
    estado: 'aprobada',
    version_coordinacion: 1,
    decision_aprobacion_id: APROBACION_ID,
    ultimo_evento_id: APROBACION_ID
  };
  const aprobacion = {
    evento_id: APROBACION_ID,
    propuesta_id: PROPUESTA_ID,
    tipo_evento: 'aprobacion',
    estado_anterior: 'pendiente_aprobacion',
    estado_nuevo: 'aprobada',
    hash_contenido_referenciado: propuesta.payload_hash,
    version_coordinacion_nueva: 1,
    ocurrido_en: new Date('2026-09-28T10:00:00.000Z'),
    actor: { tipo: 'humano', identificador: 'operador.previo' }
  };
  return { propuesta, aprobacion };
}

function requisitoEta(costo = VALOR16, extra = {}) {
  const r = { _id: ObjectId.createFromHexString(REQUISITO_ID_ETA), tipo: 'formulario_digital', nombre: 'UK ETA', obligatorio: 'si' };
  if (costo.presente) r.costo = costo.valor;
  return { ...r, ...extra };
}

function destinoCon(requisitos) {
  return { _id: ObjectId.createFromHexString(DESTINO_HEX), pais: 'Reino Unido', requisitos };
}

const DESTINO_OK = () =>
  destinoCon([{ _id: ObjectId.createFromHexString(OTRO_REQ_HEX), tipo: 'visa', obligatorio: 'no' }, requisitoEta(VALOR16)]);

const RESP_VALOR = {
  tipo: 'valor',
  valor: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } },
  revalidada_en: REVALIDADA_EN,
  fuente_nombre: FUENTE_NOMBRE,
  url: URL_ETA,
  evidencia: { avisos: [], secciones: { overview: '<p>£20</p>', apply: '<p>£20</p>' } }
};

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
    revalidacion = RESP_VALOR,
    errorRevalidar = null,
    adaptador: adaptadorForzado,
    resultadoAplicar = { resultado: 'exito', intento_id: 'x' },
    errorAplicar = null
  } = opciones;
  // Sin default de desestructuración: un `undefined`/`null` explícito
  // tiene que llegar tal cual (variable ausente, documento inexistente).
  const tomar = (clave, porDefecto) => (clave in opciones ? opciones[clave] : porDefecto);
  const base = fixture();
  const uri = tomar('uri', URI_FALSA);
  const operadoresJson = tomar('operadoresJson', OPERADORES_JSON);
  const propuesta = tomar('propuesta', base.propuesta);
  const evento = tomar('evento', base.aprobacion);
  const destino = tomar('destino', DESTINO_OK());
  const llamadas = { conectar: [], usuarios: 0, leer: 0, leerEvento: [], leerDestino: [], indices: 0, revalidar: 0, preguntar: 0, aplicar: [] };
  const adaptador =
    adaptadorForzado ??
    Object.freeze({
      nombre: adaptadorGovUk.nombre,
      version: adaptadorGovUk.version,
      soporta: adaptadorGovUk.soporta,
      validarIdentidad: adaptadorGovUk.validarIdentidad,
      revalidar: async (p, { ahora }) => {
        llamadas.revalidar++;
        assert.strictEqual(typeof ahora, 'function', 'revalidar recibe el reloj');
        if (errorRevalidar) throw errorRevalidar;
        return clonar(revalidacion);
      }
    });
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
      return propuesta && propuesta.propuesta_id === id ? clonar(propuesta) : null;
    },
    leerEvento: async (id) => {
      llamadas.leerEvento.push(id);
      return evento && evento.evento_id === id ? clonar(evento) : null;
    },
    leerDestino: async (filtro) => {
      llamadas.leerDestino.push(filtro);
      return destino ? clonar(destino) : null;
    },
    elegirAdaptador: (p) => elegirAdaptador(p, [adaptador]),
    ahora: () => AHORA,
    preguntar: async () => {
      llamadas.preguntar++;
      return respuesta ?? propuesta.payload_hash.slice(0, 12);
    },
    aplicar: async (entrada, json) => {
      llamadas.aplicar.push({ entrada, json });
      if (errorAplicar) throw errorAplicar;
      return resultadoAplicar;
    }
  };
  const log = (linea) => {
    logs.push(String(linea));
    TODOS_LOS_LOGS.push(String(linea));
  };
  return { deps, llamadas, logs, log };
}

const config = (extra = {}) => ({ modo: 'solo_lectura', propuesta_id: PROPUESTA_ID, ...extra });
const REAL = config({ modo: 'aplicacion_real' });

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

const sinEscrituras = (llamadas, etiqueta) =>
  assert.deepStrictEqual([llamadas.preguntar, llamadas.aplicar.length], [0, 0], `[${etiqueta}] no pregunta ni aplica`);

(async () => {
  // ============================================================
  // 1) Saneo de mensajes de error y formato de ObjectId
  // ============================================================
  {
    const casos = [
      new Error(`fallo al conectar a ${URI_FALSA}: timeout`),
      new Error(`auth failed for password ${SECRETO}`),
      new Error('otra uri mongodb://alguien:clave@otro.example/x suelta'),
      new Error('proxy https://usuario:clave-http@proxy.example/ caído'),
      new Error('token=abc123 y password: "hunter2"')
    ];
    for (const err of casos) {
      const limpio = mensajeDeError(err, URI_FALSA);
      for (const prohibido of [URI_FALSA, SECRETO, 'mongodb://', 'mongodb+srv://', 'clave@', 'clave-http', 'abc123', 'hunter2']) {
        assert.ok(!limpio.includes(prohibido), `"${limpio}" contiene ${prohibido}`);
      }
    }
    const conIntento = Object.assign(new Error('x'), { intento_id: 'intento-1' });
    assert.strictEqual(mensajeDeError(conIntento, URI_FALSA), 'x [intento_id intento-1]');
    assert.strictEqual(mensajeDeError('texto plano', undefined), 'texto plano');

    const oid = ObjectId.createFromHexString(DESTINO_HEX);
    assert.deepStrictEqual(paraMostrar({ _id: oid, a: [oid], d: AHORA, s: DESTINO_HEX, n: null }), {
      _id: `ObjectId("${DESTINO_HEX}")`,
      a: [`ObjectId("${DESTINO_HEX}")`],
      d: AHORA.toISOString(),
      s: DESTINO_HEX,
      n: null
    });
    // Orden del servicio: precondiciones → revalidación → destino.
    assert.strictEqual(previsionDe({ precondiciones: null, revalidacion: null, destino: null }), 'exito');
    assert.strictEqual(previsionDe({ precondiciones: 'propuesta_no_aplicable', revalidacion: 'fuente_cambio', destino: 'valor_actual_cambio' }), 'propuesta_no_aplicable');
    assert.strictEqual(previsionDe({ precondiciones: null, revalidacion: 'fuente_cambio', destino: 'identidad_requisito_cambio' }), 'fuente_cambio');
    assert.strictEqual(previsionDe({ precondiciones: null, revalidacion: null, destino: 'valor_actual_cambio' }), 'valor_actual_cambio');

    // Código de salida: 1 siempre que una aplicación real no termine en exito.
    assert.strictEqual(codigoSalida({ modo: 'solo_lectura', escrito: false }), 0);
    assert.strictEqual(codigoSalida({ modo: 'aplicacion_real', aplicado: true }), 0);
    assert.strictEqual(codigoSalida({ modo: 'aplicacion_real', aplicado: false }), 1);
    assert.strictEqual(codigoSalida({ modo: 'aplicacion_real' }), 1);
    console.log('1) mensajeDeError oculta URI, contraseña, userinfo y password=; paraMostrar distingue ObjectId de string; previsionDe en orden del servicio; codigoSalida: OK');
  }

  // ============================================================
  // 2) Aborta ANTES de conectar
  // ============================================================
  {
    const operador = { usuario_atlas: 'operador-prueba', db: 'admin', identificador: 'operador.prueba' };
    const casos = [
      ['modo desconocido', config({ modo: 'decision_real' }), {}, 'Modo desconocido'],
      ['PROPUESTA_ID vacío', config({ propuesta_id: '' }), {}, 'PROPUESTA_ID'],
      ['PROPUESTA_ID no UUID', config({ propuesta_id: 'abc' }), {}, 'PROPUESTA_ID'],
      ['MONGODB_URI_DECISION ausente', config(), { uri: undefined }, 'No se usa MONGODB_URI como alternativa'],
      ['MONGODB_URI_DECISION vacía', config(), { uri: '  ' }, 'MONGODB_URI_DECISION ausente'],
      ['MONGODB_URI_DECISION igual a MONGODB_URI', config(), { uriBackend: URI_FALSA }, 'igual a MONGODB_URI'],
      ['allowlist ausente', config(), { operadoresJson: undefined }, ErrorConfiguracionOperadores],
      ['allowlist JSON inválido', config(), { operadoresJson: '[{' }, ErrorConfiguracionOperadores],
      ['allowlist vacía', config(), { operadoresJson: '[]' }, ErrorConfiguracionOperadores],
      ['allowlist duplicada', config(), { operadoresJson: JSON.stringify([operador, operador]) }, ErrorConfiguracionOperadores]
    ];
    for (const [nombre, cfg, opciones, esperado] of casos) {
      for (const modo of ['solo_lectura', 'aplicacion_real']) {
        const c = cfg.modo === 'solo_lectura' ? { ...cfg, modo } : cfg;
        const { deps, llamadas, log } = crearEntorno(opciones);
        await assertRechaza(ejecutar(c, deps, log), esperado, `${nombre} (${c.modo})`);
        assert.strictEqual(llamadas.conectar.length, 0, `[${nombre}] no conecta`);
        assert.strictEqual(llamadas.revalidar, 0, `[${nombre}] no revalida`);
      }
    }

    // Las dependencias reales nunca caen en MONGODB_URI y no conectan al construirse.
    const reales = crearDependenciasComando({ MONGODB_URI: URI_BACKEND, OPERADORES_AUTORIZADOS_JSON: OPERADORES_JSON });
    assert.strictEqual(reales.uriDecision(), undefined);
    assert.strictEqual(reales.uriBackend(), URI_BACKEND);
    assert.strictEqual(reales.operadoresJson(), OPERADORES_JSON);
    assert.strictEqual(reales.elegirAdaptador(fixture().propuesta), adaptadorGovUk, 'el adaptador real soporta el fixture');
    console.log(`2) ${casos.length} configuraciones inválidas × 2 modos abortan sin conectar ni revalidar; sin fallback a MONGODB_URI: OK`);
  }

  // ============================================================
  // 3) Conexión: error sin filtrar la URI, base equivocada
  // ============================================================
  {
    {
      const errorConectar = new Error(`querySrv ENOTFOUND para ${URI_FALSA} (password ${SECRETO})`);
      const { deps, log } = crearEntorno({ errorConectar });
      const err = await assertRechaza(ejecutar(config(), deps, log), 'No se pudo conectar con MONGODB_URI_DECISION', 'error de conexión');
      assert.ok(!err.message.includes(SECRETO) && !err.message.includes(URI_FALSA) && !/mongodb(\+srv)?:\/\//.test(err.message));
    }
    {
      const { deps, llamadas, log } = crearEntorno({ dbName: 'test' });
      await assertRechaza(ejecutar(config(), deps, log), 'Base de datos inesperada', 'db distinta');
      assert.deepStrictEqual([llamadas.usuarios, llamadas.leer, llamadas.revalidar], [0, 0, 0]);
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
    const { propuesta } = fixture();
    const { deps, llamadas, logs, log } = crearEntorno();
    const r = await ejecutar(config(), deps, log);
    assert.deepStrictEqual(r, { modo: 'solo_lectura', escrito: false, gate_ok: true, identidad_ok: true, prevision: 'exito' });
    sinEscrituras(llamadas, 'solo_lectura');
    assert.deepStrictEqual([llamadas.leer, llamadas.indices, llamadas.revalidar], [1, 1, 1]);
    assert.deepStrictEqual(llamadas.leerEvento, [APROBACION_ID]);
    assert.strictEqual(llamadas.leerDestino.length, 1);
    assert.ok(llamadas.leerDestino[0]._id instanceof ObjectId, 'el destino se lee por ObjectId, no por string');
    assert.strictEqual(llamadas.leerDestino[0]._id.toHexString(), DESTINO_HEX);

    const salida = logs.join('\n');
    const entrada = construirEntradaDesdeVista(propuesta);
    const casEsperado = filtroCasPropuesta({
      propuesta_id: PROPUESTA_ID,
      hash_esperado: propuesta.payload_hash,
      version_esperada: 1,
      decision_aprobacion_id: APROBACION_ID
    });
    for (const esperado of [
      propuesta.payload_hash,
      propuesta.payload_hash.slice(0, 12),
      'estado:                 aprobada',
      'version_coordinacion:   1',
      'hash recalculado: coincide',
      'adaptador: govuk-uk-eta v1',
      '=== EVENTO DE APROBACIÓN ===',
      `"evento_id": "${APROBACION_ID}"`,
      'Precondiciones de la propuesta: OK',
      '=== REQUISITO ACTUAL DEL DESTINO ===',
      '"nombre": "UK ETA"',
      `"_id": "ObjectId(\\"${REQUISITO_ID_ETA}\\")"`,
      'Valor actual de costo: {"presente":true,"valor":"£16"} = valor_anterior',
      '=== FILTROS CAS QUE SE USARÍAN ===',
      JSON.stringify(casEsperado, null, 2),
      '"version_coordinacion": 1',
      '"estado": "aplicada"',
      `"_id": "ObjectId(\\"${DESTINO_HEX}\\")"`,
      '"$elemMatch"',
      '"costo": "£16"',
      '"requisitos.$.costo": "£20"',
      'Gate de índices (INDICES_APLICACION): OK',
      'REVALIDACIÓN NUEVA (solo vista; el servicio revalida otra vez)',
      'tipo: valor',
      `revalidada_en: ${REVALIDADA_EN.toISOString()}`,
      '<p>£20</p>',
      'Coincide con valor_propuesto.',
      'Resultado previsto: exito',
      'no se escribió nada'
    ]) {
      assert.ok(salida.includes(esperado), `la salida debe incluir ${esperado}`);
    }
    // El filtro del destino mostrado es EXACTAMENTE el del servicio.
    assert.ok(salida.includes(JSON.stringify(paraMostrar(filtroDestino(
      { destino_id: ObjectId.createFromHexString(DESTINO_HEX), requisito_id: ObjectId.createFromHexString(REQUISITO_ID_ETA) },
      'costo',
      VALOR16
    )), null, 2)));
    assert.deepStrictEqual(Object.keys(entrada).sort(), ['payload_hash_esperado', 'propuesta_id', 'version_coordinacion_esperada']);

    // Precondición del valor: ausente → $exists:false, null → $type:'null'; nunca {costo:null}.
    for (const [valorAnterior, fragmento] of [
      [AUSENTE, '"$exists": false'],
      [NULO, '"$type": "null"']
    ]) {
      const f = fixture({ valorAnterior });
      const destino = destinoCon([requisitoEta(valorAnterior)]);
      const e = crearEntorno({ propuesta: f.propuesta, evento: f.aprobacion, destino });
      const r2 = await ejecutar(config(), e.deps, e.log);
      assert.strictEqual(r2.prevision, 'exito', fragmento);
      const s = e.logs.join('\n');
      const desde = s.indexOf('destinos.updateOne filtro');
      const filtroMostrado = s.slice(desde, s.indexOf('\nupdate:', desde));
      assert.ok(filtroMostrado.includes(fragmento), fragmento);
      assert.ok(!filtroMostrado.includes('"costo": null'), `[${fragmento}] el filtro nunca es {costo: null}`);
    }
    console.log('4) solo_lectura: propuesta, evento, requisito actual, filtros CAS exactos (ObjectId, $exists/$type), gate y revalidación; no escribe: OK');
  }

  // ============================================================
  // 5) solo_lectura con problemas: informa, prevé el resultado y no escribe
  // ============================================================
  const f = fixture();
  const reqDuplicado = () => destinoCon([requisitoEta(VALOR16), requisitoEta(VALOR16)]);
  const PROBLEMAS = [
    ['estado pendiente', { propuesta: { ...f.propuesta, estado: 'pendiente_aprobacion' } }, 'propuesta_no_aplicable', 'estado_no_aprobada'],
    ['evento de aprobación inexistente', { evento: null }, 'propuesta_no_aplicable', `no existe el evento ${APROBACION_ID}`],
    ['sin decision_aprobacion_id', { propuesta: { ...f.propuesta, decision_aprobacion_id: null } }, 'propuesta_no_aplicable', 'la propuesta no tiene decision_aprobacion_id'],
    ['evento con otro hash', { evento: { ...f.aprobacion, hash_contenido_referenciado: 'f'.repeat(64) } }, 'propuesta_no_aplicable', 'aprobacion_invalida'],
    ['destino inexistente', { destino: null }, 'identidad_requisito_cambio', 'destino_no_encontrado'],
    ['requisito ausente', { destino: destinoCon([]) }, 'identidad_requisito_cambio', 'requisito_id_no_encontrado'],
    ['requisito duplicado', { destino: reqDuplicado() }, 'identidad_requisito_cambio', 'requisito_id_duplicado'],
    ['identidad semántica', { destino: destinoCon([requisitoEta(VALOR16, { nombre: 'Otro' })]) }, 'identidad_requisito_cambio', 'identidad_semantica_no_coincide'],
    ['valor actual cambió', { destino: destinoCon([requisitoEta({ presente: true, valor: '£18' })]) }, 'valor_actual_cambio', '≠ valor_anterior'],
    ['valor actual ausente', { destino: destinoCon([requisitoEta(AUSENTE)]) }, 'valor_actual_cambio', '{"presente":false,"valor":null}'],
    ['valor actual null', { destino: destinoCon([requisitoEta(NULO)]) }, 'valor_actual_cambio', '{"presente":true,"valor":null}'],
    // Solo difiere la presencia: ausente ≠ null explícito.
    [
      'esperaba ausente, hay null',
      { propuesta: fixture({ valorAnterior: AUSENTE }).propuesta, evento: fixture({ valorAnterior: AUSENTE }).aprobacion, destino: destinoCon([requisitoEta(NULO)]) },
      'valor_actual_cambio',
      '{"presente":true,"valor":null} ≠ valor_anterior {"presente":false,"valor":null}'
    ],
    [
      'esperaba null, está ausente',
      { propuesta: fixture({ valorAnterior: NULO }).propuesta, evento: fixture({ valorAnterior: NULO }).aprobacion, destino: destinoCon([requisitoEta(AUSENTE)]) },
      'valor_actual_cambio',
      '{"presente":false,"valor":null} ≠ valor_anterior {"presente":true,"valor":null}'
    ],
    [
      'fuente no disponible',
      { revalidacion: { tipo: 'no_disponible', motivo: 'timeout', evidencia: { causa: 'timeout', mensaje: `fallo ${URI_BACKEND}` } } },
      'fuente_temporalmente_no_disponible',
      'tipo: no_disponible'
    ],
    [
      'extracción ambigua',
      { revalidacion: (({ valor, ...resto }) => ({ ...resto, tipo: 'ambiguo', motivo: 'overview_distinto_de_apply' }))(RESP_VALOR) },
      'extraccion_ambigua',
      'overview_distinto_de_apply'
    ],
    ['fuente cambió', { revalidacion: { ...RESP_VALOR, valor: { valor: '£25', valor_normalizado: { importe: 25, moneda: 'GBP' } } } }, 'fuente_cambio', '"£25"'],
    ['revalidar lanza', { errorRevalidar: new Error(`bug con ${URI_FALSA}`) }, 'indeterminado (la revalidación de la vista lanzó un error)', 'La revalidación de la vista lanzó un error']
  ];
  {
    for (const [nombre, opciones, previsto, fragmento] of PROBLEMAS) {
      const { deps, llamadas, logs, log } = crearEntorno(opciones);
      const r = await ejecutar(config(), deps, log);
      assert.strictEqual(r.prevision, previsto, nombre);
      assert.strictEqual(r.escrito, false, nombre);
      sinEscrituras(llamadas, nombre);
      const s = logs.join('\n');
      assert.ok(s.includes(`Resultado previsto: ${previsto}`), `[${nombre}] prevé ${previsto}`);
      assert.ok(s.includes(fragmento), `[${nombre}] muestra ${fragmento}\n${s}`);
      assert.ok(s.includes('=== FILTROS CAS QUE SE USARÍAN ==='), `[${nombre}] igual muestra los filtros`);
      const noAplicable = previsto === 'propuesta_no_aplicable';
      assert.strictEqual(llamadas.revalidar, noAplicable ? 0 : 1, `[${nombre}] ${noAplicable ? 'no consulta la fuente' : 'revalida en la vista'}`);
      assert.strictEqual(s.includes('revalidación omitida por propuesta no aplicable'), noAplicable, `[${nombre}] aviso de revalidación omitida`);
    }
    // La evidencia de la fuente sale saneada (texto de error con URI de Mongo).
    {
      const { deps, logs, log } = crearEntorno({ revalidacion: PROBLEMAS.find(([n]) => n === 'fuente no disponible')[1].revalidacion });
      await ejecutar(config(), deps, log);
      const s = logs.join('\n');
      assert.ok(s.includes('<uri-mongodb-redactada>'), 'evidencia.mensaje saneada con sanearTextosError');
      assert.ok(!s.includes('otra-clave'), 'sin la contraseña del backend');
    }
    // Texto fuera de CLAVES_TEXTO_ERROR (avisos) no lo sanea sanearTextosError:
    // lo cubre ocultarUri sobre CADA línea impresa.
    {
      const revalidacion = { ...RESP_VALOR, evidencia: { avisos: [`eco de ${URI_FALSA}`, `clave ${SECRETO}`] } };
      const { deps, logs, log } = crearEntorno({ revalidacion });
      await ejecutar(config(), deps, log);
      const s = logs.join('\n');
      assert.ok(s.includes('eco de [MONGODB_URI_DECISION oculta]'), 'URI exacta reemplazada en la salida');
      assert.ok(s.includes('clave ***'), 'contraseña reemplazada en la salida');
    }
    // Identidad y gate rechazados: se informan y se sigue mostrando.
    {
      const e = crearEntorno({ usuarios: [], errorIndices: new ErrorPrecondicionIndices('falta intentos_aplicacion.intento_id_1') });
      const r = await ejecutar(config(), e.deps, e.log);
      assert.deepStrictEqual([r.identidad_ok, r.gate_ok, r.prevision], [false, false, 'exito']);
      const s = e.logs.join('\n');
      for (const esperado of ['Identidad RECHAZADA', 'Gate de índices FALLARÍA', 'intento_id_1', 'Resultado previsto: exito']) {
        assert.ok(s.includes(esperado), esperado);
      }
      sinEscrituras(e.llamadas, 'identidad y gate');
    }
    // Varios problemas a la vez: se prevé el primero en el orden del
    // servicio y se listan los demás.
    const FUENTE_25 = { ...RESP_VALOR, valor: { valor: '£25', valor_normalizado: { importe: 25, moneda: 'GBP' } } };
    {
      const e = crearEntorno({ evento: null, destino: null, revalidacion: FUENTE_25 });
      const r = await ejecutar(config(), e.deps, e.log);
      assert.strictEqual(r.prevision, 'propuesta_no_aplicable');
      assert.strictEqual(e.llamadas.revalidar, 0, 'no consulta la fuente');
      assert.ok(e.logs.join('\n').includes('Otros problemas detectados (el servicio registra solo el primero): identidad_requisito_cambio'));
    }
    {
      const e = crearEntorno({ destino: destinoCon([requisitoEta({ presente: true, valor: '£18' })]), revalidacion: FUENTE_25 });
      const r = await ejecutar(config(), e.deps, e.log);
      assert.strictEqual(r.prevision, 'fuente_cambio', 'la revalidación va antes que el destino');
      assert.ok(e.logs.join('\n').includes('Otros problemas detectados (el servicio registra solo el primero): valor_actual_cambio'));
    }
    console.log(`5) solo_lectura: ${PROBLEMAS.length} problemas de propuesta/destino/fuente + identidad/gate se informan con su resultado previsto, sin escribir: OK`);
  }

  // ============================================================
  // 6) Lo que el servicio rechazaría sin persistir aborta en ambos modos
  // ============================================================
  {
    const manipulada = { ...f.propuesta, payload: { ...f.propuesta.payload, valor_propuesto: { ...f.propuesta.payload.valor_propuesto, valor: '£99' } } };
    const idsInvalidos = { ...f.propuesta, destino_id: 'otro' };
    const otroCampo = { ...f.propuesta, campo: 'nombre' };
    const casos = [
      ['propuesta inexistente', { propuesta: null }, 'No existe la propuesta'],
      ['hash manipulado', { propuesta: manipulada }, 'hash recalculado'],
      ['ids externos ≠ payload', { propuesta: idsInvalidos }, ErrorInconsistencia],
      ['campo no aplicable', { propuesta: otroCampo }, ErrorPropuestaNoSoportada],
      [
        'sin adaptador',
        { adaptador: Object.freeze({ ...adaptadorGovUk, soporta: () => false }) },
        ErrorSinAdaptador
      ]
    ];
    for (const [nombre, opciones, esperado] of casos) {
      for (const modo of ['solo_lectura', 'aplicacion_real']) {
        const { deps, llamadas, log } = crearEntorno(opciones);
        await assertRechaza(ejecutar(config({ modo }), deps, log), esperado, `${nombre} (${modo})`);
        sinEscrituras(llamadas, nombre);
        assert.strictEqual(llamadas.revalidar, 0, `[${nombre}] no revalida`);
      }
    }
    console.log(`6) ${casos.length} casos que el servicio rechazaría sin persistir abortan en ambos modos, sin revalidar: OK`);
  }

  // ============================================================
  // 7) aplicacion_real: configuración/integridad aborta; un resultado
  //    operativo previsto se muestra, se confirma y lo registra el servicio
  // ============================================================
  {
    for (const [nombre, opciones, esperado] of [
      ['identidad rechazada', { usuarios: [{ user: 'backend-app', db: 'admin' }] }, ErrorActorNoAutorizado],
      ['gate de índices', { errorIndices: new ErrorPrecondicionIndices('falta') }, ErrorPrecondicionIndices]
    ]) {
      const { deps, llamadas, log } = crearEntorno(opciones);
      await assertRechaza(ejecutar(REAL, deps, log), esperado, nombre);
      sinEscrituras(llamadas, nombre);
    }

    for (const [nombre, opciones, previsto] of PROBLEMAS) {
      // El servicio revalida por su cuenta: su resultado es independiente de la vista.
      const resultado = previsto.startsWith('indeterminado') ? 'fuente_temporalmente_no_disponible' : previsto;
      const { deps, llamadas, logs, log } = crearEntorno({ ...opciones, resultadoAplicar: { resultado } });
      const r = await ejecutar(REAL, deps, log);
      assert.strictEqual(r.prevision, previsto, nombre);
      assert.strictEqual(r.aplicado, false, nombre);
      assert.strictEqual(codigoSalida(r), 1, `[${nombre}] código de salida 1`);
      assert.deepStrictEqual([llamadas.preguntar, llamadas.aplicar.length], [1, 1], `[${nombre}] confirma y llama al servicio`);
      assert.deepStrictEqual(llamadas.aplicar[0].entrada, construirEntradaDesdeVista(opciones.propuesta ?? f.propuesta), nombre);
      assert.strictEqual(llamadas.revalidar, previsto === 'propuesta_no_aplicable' ? 0 : 1, `[${nombre}] la vista consulta la fuente a lo sumo una vez`);
      const salida = logs.join('\n');
      assert.ok(salida.includes(`ATENCIÓN: la vista prevé ${previsto}`), `[${nombre}] avisa antes de confirmar`);
      assert.ok(salida.includes(`"resultado": "${resultado}"`), `[${nombre}] muestra el resultado del servicio`);

      // Con un resultado previsto distinto de exito, la confirmación sigue siendo exacta.
      const mal = crearEntorno({ ...opciones, respuesta: f.propuesta.payload_hash.slice(0, 11) });
      await assertRechaza(ejecutar(REAL, mal.deps, mal.log), 'no coincide', `${nombre} (confirmación incorrecta)`);
      assert.deepStrictEqual([mal.llamadas.preguntar, mal.llamadas.aplicar.length], [1, 0], nombre);
    }
    console.log(`7) aplicacion_real: identidad y gate abortan; ${PROBLEMAS.length} resultados operativos previstos se avisan, se confirman y los registra el servicio (código 1): OK`);
  }

  // ============================================================
  // 8) Confirmación por prefijo de payload_hash
  // ============================================================
  {
    const h = f.propuesta.payload_hash;
    for (const [nombre, respuesta] of [
      ['11 caracteres', h.slice(0, 11)],
      ['13 caracteres', h.slice(0, 13)],
      ['hash completo', h],
      ['mayúsculas', h.slice(0, 12).toUpperCase()],
      ['otro prefijo', h.slice(1, 13)],
      ['vacía', '']
    ]) {
      const { deps, llamadas, log } = crearEntorno({ respuesta });
      await assertRechaza(ejecutar(REAL, deps, log), 'no coincide', nombre);
      assert.deepStrictEqual([llamadas.preguntar, llamadas.aplicar.length], [1, 0], nombre);
    }
    console.log('8) confirmación distinta de los 12 primeros caracteres exactos → no se llama al servicio: OK');
  }

  // ============================================================
  // 9) Confirmación correcta: el servicio recibe EXACTAMENTE lo mostrado
  // ============================================================
  {
    const esperado = {
      propuesta_id: PROPUESTA_ID,
      payload_hash_esperado: f.propuesta.payload_hash,
      version_coordinacion_esperada: 1
    };
    const { deps, llamadas, logs, log } = crearEntorno({ respuesta: `  ${f.propuesta.payload_hash.slice(0, 12)}\n` });
    const r = await ejecutar(REAL, deps, log);
    assert.strictEqual(r.aplicado, true);
    assert.strictEqual(r.prevision, 'exito');
    assert.strictEqual(codigoSalida(r), 0);
    assert.ok(!logs.join('\n').includes('ATENCIÓN'), 'sin aviso cuando se prevé exito');
    assert.strictEqual(llamadas.aplicar.length, 1);
    assert.deepStrictEqual(llamadas.aplicar[0].entrada, esperado, 'solo propuesta_id, hash y versión: la revalidación de la vista no viaja');
    assert.deepStrictEqual(construirEntradaDesdeVista(f.propuesta), esperado);
    assert.strictEqual(llamadas.aplicar[0].json, OPERADORES_JSON, 'el servicio recibe la misma allowlist');
    assert.deepStrictEqual([llamadas.leer, llamadas.revalidar], [1, 1], 'no relee ni revalida tras confirmar (lo hace el servicio)');
    assert.ok(logs.join('\n').includes('=== RESULTADO ==='));

    // La vista prevé exito pero el servicio registra otra cosa (p. ej. la
    // evidencia venció o hubo una carrera) → aplicado false, código 1.
    for (const resultado of ['propuesta_no_aplicable', 'fuente_cambio', 'revalidacion_vencida', 'valor_actual_cambio']) {
      const e = crearEntorno({ resultadoAplicar: { resultado } });
      const r2 = await ejecutar(REAL, e.deps, e.log);
      assert.strictEqual(r2.prevision, 'exito', resultado);
      assert.strictEqual(r2.aplicado, false, resultado);
      assert.strictEqual(codigoSalida(r2), 1, resultado);
      assert.ok(e.logs.join('\n').includes(`"resultado": "${resultado}"`), resultado);
    }

    // Un error del servicio se propaga tal cual (main lo sanea con mensajeDeError).
    const causa = new Error(`E11000 ${URI_FALSA}`);
    const errServicio = new ErrorEscrituraAbortada(
      { intento_id: '33333333-3333-4333-8333-000000000001', propuesta_id: PROPUESTA_ID },
      { etapa_fallo: 'escritura_aplicacion' },
      causa
    );
    const e = crearEntorno({ errorAplicar: errServicio });
    const err = await assertRechaza(ejecutar(REAL, e.deps, e.log), ErrorEscrituraAbortada, 'error del servicio');
    assert.strictEqual(err, errServicio);
    const mensaje = mensajeDeError(err, URI_FALSA);
    TODOS_LOS_LOGS.push(mensaje);
    assert.ok(mensaje.includes('[intento_id 33333333-3333-4333-8333-000000000001]'));
    console.log('9) confirmación correcta: el servicio recibe solo los valores mostrados, sin releer; vista exito + servicio no-exito → código 1; errores con intento_id: OK');
  }

  // ============================================================
  // 10) Ninguna salida contiene la URI ni la contraseña
  // ============================================================
  {
    assert.ok(TODOS_LOS_LOGS.length > 500);
    for (const linea of TODOS_LOS_LOGS) {
      assert.ok(!linea.includes(SECRETO), `salida con contraseña: ${linea}`);
      assert.ok(!linea.includes('otra-clave'), `salida con contraseña del backend: ${linea}`);
      assert.ok(!linea.includes(URI_FALSA), `salida con URI: ${linea}`);
      assert.ok(!/mongodb(\+srv)?:\/\//.test(linea), `salida con una URI de Mongo: ${linea}`);
    }
    console.log(`10) ${TODOS_LOS_LOGS.length} líneas de salida y mensajes de error revisados: ninguno contiene la URI ni la contraseña: OK`);
  }

  console.log('\nTodas las pruebas offline del comando de aplicación pasaron (sin .env, sin red, sin Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
