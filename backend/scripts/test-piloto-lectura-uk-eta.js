// Pruebas offline (sin conexión a Mongo, sin red) de la integración de
// scripts/piloto-lectura-uk-eta.js con el servicio de registro. Importa
// el piloto como módulo: la guarda `require.main === module` impide que
// eso dispare el fetch a GOV.UK o la conexión a Mongo (prueba 0).
//
// main() se ejecuta SOLO con dependencias falsas (fetch, conexión,
// búsqueda del requisito, servicio de registro y desconexión): nunca
// toca la red ni Mongo (pruebas 6 a 11).
//
// Uso: node scripts/test-piloto-lectura-uk-eta.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// fetch espía durante TODO el archivo (no solo en la importación): si
// algún camino llegara a usar el fetch real en vez del inyectado, la
// llamada falla y el contador lo delata al final (nunca sale a la red).
let llamadasFetch = 0;
globalThis.fetch = async () => {
  llamadasFetch++;
  throw new Error('fetch no permitido en pruebas offline');
};

const piloto = require('./piloto-lectura-uk-eta.js');
const EjecucionLectura = require('../models/propuestas/EjecucionLectura.model.js');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');
const { canonicalizarValor } = require('../services/propuestas/canonicalizacion-propuestas');
const {
  debeGenerarPropuesta,
  validarEntrada,
  construirEjecucion,
  construirPropuesta
} = require('../services/propuestas/registrar-ejecucion-lectura');

const {
  main,
  REGISTRAR,
  ETAPAS_EMITIDAS,
  parsearCostoMongo,
  compararConMongo,
  resumenFuenteGovUk,
  construirEntradaRegistroFallo,
  construirEntradaRegistroOk
} = piloto;

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const DESTINO_ID = new mongoose.Types.ObjectId('000000000000000000000001');
const REQUISITO_ID = '6aaddd0e9f54309f9d8272dc';
const FECHA_EJECUCION = '2026-09-24T12:00:01.000Z';
const INICIADO_EN = new Date('2026-09-24T12:00:00.000Z');
const FINALIZADO_EN = new Date('2026-09-24T12:00:05.000Z');

const JSON_GOVUK = {
  first_published_at: '2023-10-01T00:00:00.000+01:00',
  public_updated_at: '2026-04-09T10:00:00.000+01:00',
  updated_at: '2026-04-09T10:00:00.000+01:00'
};
const EXTRACCION = { costo: 20, sospechoso: false, fragmento: 'It costs £20 to apply' };

function requisitoEta(extra = {}) {
  return { _id: REQUISITO_ID, tipo: 'formulario_digital', nombre: 'UK ETA', ...extra };
}

// Replica el camino OK de main() a partir de un requisito leído de Mongo.
function entradaOkPara(requisito, json = JSON_GOVUK) {
  const resultado = compararConMongo(20, 'GBP', requisito.costo);
  return construirEntradaRegistroOk({
    runId: RUN_ID,
    iniciadoEn: INICIADO_EN,
    fechaEjecucion: FECHA_EJECUCION,
    json,
    resultadoOverview: EXTRACCION,
    resultadoApply: EXTRACCION,
    destinoId: DESTINO_ID,
    requisitoId: REQUISITO_ID,
    requisito,
    resultado,
    costoGovUk: 20
  });
}

// La entrada pasa la validación del servicio y produce documentos
// válidos contra los modelos reales (ejecución y, si corresponde,
// propuesta).
async function assertEntradaRegistrable(entrada, etiqueta) {
  validarEntrada(entrada);
  await new EjecucionLectura(construirEjecucion(entrada, null, FINALIZADO_EN)).validate();
  if (entrada.estado_ejecucion === 'ok' && debeGenerarPropuesta(entrada.resultado_comparacion.categoria)) {
    const propuesta = construirPropuesta(entrada, '22222222-2222-4222-8222-222222222222', '2026-09-24T12:00:04.000Z');
    await new PropuestaCambio(propuesta).validate();
  }
  return etiqueta;
}

// --- Mundo falso para ejecutar main() sin red ni Mongo ---

const JSON_GOVUK_COMPLETO = {
  ...JSON_GOVUK,
  details: {
    parts: [
      { slug: 'overview', body: '<p>It costs £20 to apply for an ETA.</p>' },
      { slug: 'apply', body: '<p>You need to pay £20 when you apply.</p>' }
    ]
  }
};

const BUSQUEDA_OK = {
  requisito: requisitoEta(),
  requisitoId: REQUISITO_ID,
  destinoId: DESTINO_ID,
  motivo: null,
  categoriaFallo: null
};

// modosConectar: comportamiento de cada llamada a conectar(), en orden
// ('ok' | 'falla' sin abrir | 'abre_y_falla', ej. base inesperada). Si
// hay más llamadas que modos, se repite el último.
function crearMundoFalso({
  registrar,
  fetchFalla = null,
  jsonGovUk = JSON_GOVUK_COMPLETO,
  modosConectar = ['ok'],
  busqueda = BUSQUEDA_OK,
  buscarFalla = null,
  resultadoRegistro = { run_id: RUN_ID, estado_ejecucion: 'ok', accion: 'propuesta_creada', propuesta: null, colisiones: 0 },
  registrarFalla = null,
  desconectarFalla = null
} = {}) {
  const llamadas = { fetch: 0, conectar: [], buscar: 0, registrar: [], desconectar: 0 };
  let conectado = false;

  const deps = {
    fetchJson: async () => {
      llamadas.fetch++;
      if (fetchFalla) throw fetchFalla;
      return jsonGovUk;
    },
    conectar: async (opciones) => {
      const modo = modosConectar[Math.min(llamadas.conectar.length, modosConectar.length - 1)];
      llamadas.conectar.push(opciones ?? null);
      if (modo === 'falla') throw new Error('conexión rechazada (simulada)');
      conectado = true;
      if (modo === 'abre_y_falla') throw new Error('Base de datos inesperada (simulada)');
    },
    buscarRequisito: async () => {
      llamadas.buscar++;
      if (buscarFalla) throw buscarFalla;
      return busqueda;
    },
    registrarEjecucion: async (entrada) => {
      llamadas.registrar.push(entrada);
      if (registrarFalla) throw registrarFalla;
      return { ...resultadoRegistro, run_id: entrada.run_id };
    },
    desconectar: async () => {
      llamadas.desconectar++;
      if (desconectarFalla) throw desconectarFalla;
      conectado = false;
    },
    estaConectado: () => conectado
  };
  if (registrar !== undefined) deps.registrar = registrar;
  return { deps, llamadas };
}

// Ejecuta main() capturando la consola y aislando process.exitCode.
async function correrMain(deps) {
  const salida = [];
  const consolaOriginal = { log: console.log, warn: console.warn, error: console.error };
  const capturar = (tipo) => (...args) => salida.push(`[${tipo}] ${args.join(' ')}`);
  console.log = capturar('log');
  console.warn = capturar('warn');
  console.error = capturar('error');
  const exitCodePrevio = process.exitCode;
  process.exitCode = undefined;
  try {
    const resumen = await main(deps);
    return { resumen, salida: salida.join('\n'), exitCode: process.exitCode };
  } finally {
    Object.assign(console, consolaOriginal);
    process.exitCode = exitCodePrevio;
  }
}

(async () => {
  // ============================================================
  // 0) Importar el piloto no dispara fetch ni conexión a Mongo; sin
  //    el flag, REGISTRAR es false.
  // ============================================================
  {
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(llamadasFetch, 0, 'importar el piloto no debe hacer fetch');
    assert.strictEqual(mongoose.connection.readyState, 0, 'importar el piloto no debe conectar a Mongo');
    assert.strictEqual(REGISTRAR, false, 'sin --registrar en process.argv, REGISTRAR debe ser false');

    console.log('0) importar el piloto no dispara fetch ni conexión; REGISTRAR false por defecto: OK');
  }

  // ============================================================
  // 1) Etapas: las que emite el piloto son subconjunto del enum real, y
  //    ETAPAS_EMITIDAS coincide con las asignaciones a etapaActual del
  //    código fuente (para que la lista exportada no quede desfasada).
  // ============================================================
  {
    const enumEtapas = EjecucionLectura.schema.path('etapa_fallo').enumValues;
    for (const etapa of ETAPAS_EMITIDAS) {
      assert.ok(enumEtapas.includes(etapa), `etapa "${etapa}" no está en ETAPAS_FALLO`);
    }

    const fuente = fs.readFileSync(path.join(__dirname, 'piloto-lectura-uk-eta.js'), 'utf8');
    const enCodigo = new Set([...fuente.matchAll(/etapaActual = '([a-z_]+)'/g)].map((m) => m[1]));
    assert.deepStrictEqual([...enCodigo].sort(), [...ETAPAS_EMITIDAS].sort());
    assert.ok(![...enCodigo].some((e) => e.includes('govuk')), 'no deben quedar etapas *_govuk');

    console.log('1) etapas del piloto ⊂ ETAPAS_FALLO y sincronizadas con el código: OK');
  }

  // ============================================================
  // 2) Ida y vuelta: el valor propuesto, escrito en Mongo, da COINCIDE
  //    en una segunda pasada simulada (y ya no genera propuesta).
  // ============================================================
  {
    for (const costoInicial of [undefined, null, '', 'verificar', '£15', 'GBP 15', '15 GBP']) {
      const requisito = costoInicial === undefined ? requisitoEta() : requisitoEta({ costo: costoInicial });
      const entrada = entradaOkPara(requisito);
      assert.ok(
        debeGenerarPropuesta(entrada.resultado_comparacion.categoria),
        `costo inicial ${JSON.stringify(costoInicial)} debería generar propuesta (categoría ${entrada.resultado_comparacion.categoria})`
      );

      const { valor, valor_normalizado } = entrada.valor_propuesto;
      assert.strictEqual(valor, '£20');
      assert.deepStrictEqual(parsearCostoMongo(valor), { estado: 'ok', importe: valor_normalizado.importe, moneda: valor_normalizado.moneda });

      // Segunda pasada: el requisito ya tiene el valor propuesto.
      const segunda = compararConMongo(20, 'GBP', valor);
      assert.strictEqual(segunda.categoria, 'COINCIDE', `segunda pasada tras ${JSON.stringify(costoInicial)}`);
      assert.ok(!debeGenerarPropuesta(segunda.categoria));
      const entradaSegunda = entradaOkPara(requisitoEta({ costo: valor }));
      assert.strictEqual(entradaSegunda.valor_propuesto, undefined, 'COINCIDE no lleva valor_propuesto');
      await assertEntradaRegistrable(entradaSegunda, 'segunda-pasada');
    }

    console.log('2) ida y vuelta: £20 propuesto → COINCIDE en la segunda pasada: OK');
  }

  // ============================================================
  // 3) resumenFuenteGovUk: nunca undefined (canonicalizable aunque
  //    GOV.UK omita fechas).
  // ============================================================
  {
    const sinFechas = resumenFuenteGovUk({});
    assert.deepStrictEqual(sinFechas, {
      url: 'https://www.gov.uk/api/content/eta',
      first_published_at: null,
      public_updated_at: null,
      updated_at: null
    });
    canonicalizarValor(sinFechas);
    assert.strictEqual(resumenFuenteGovUk(null), null);
    assert.strictEqual(resumenFuenteGovUk(JSON_GOVUK).updated_at, JSON_GOVUK.updated_at);

    // Y llega intacto a una entrada registrable con propuesta.
    await assertEntradaRegistrable(entradaOkPara(requisitoEta(), {}), 'govuk-sin-fechas');

    console.log('3) resumenFuenteGovUk con ?? null (sin undefined): OK');
  }

  // ============================================================
  // 4) Entradas OK de cada categoría: pasan validarEntrada y generan
  //    documentos válidos; valor_previo distingue ausente de nulo.
  // ============================================================
  {
    const casos = [
      ['ausente', requisitoEta(), 'SIN_COSTO_PREVIO_EN_MONGO', { presente: false, valor: null }],
      ['nulo explícito', requisitoEta({ costo: null }), 'SIN_COSTO_PREVIO_EN_MONGO', { presente: true, valor: null }],
      ['verificar', requisitoEta({ costo: 'verificar' }), 'SIN_COSTO_PREVIO_EN_MONGO', { presente: true, valor: 'verificar' }],
      ['importe distinto', requisitoEta({ costo: '£15' }), 'IMPORTE_NO_COINCIDE', { presente: true, valor: '£15' }],
      ['coincide', requisitoEta({ costo: '£20' }), 'COINCIDE', { presente: true, valor: '£20' }],
      // MONEDA_DISTINTA no es alcanzable hoy: parsearCostoMongo solo
      // reconoce GBP (con certeza) y "$" (AMBIGUA).
      ['coincide en formato "GBP 20"', requisitoEta({ costo: 'GBP 20' }), 'COINCIDE', { presente: true, valor: 'GBP 20' }],
      ['moneda ambigua', requisitoEta({ costo: '$20' }), 'MONEDA_AMBIGUA', { presente: true, valor: '$20' }],
      ['formato ambiguo', requisitoEta({ costo: '20.50 GBP' }), 'FORMATO_AMBIGUO_EN_MONGO', { presente: true, valor: '20.50 GBP' }],
      ['valor inesperado', requisitoEta({ costo: 20 }), 'VALOR_INESPERADO_EN_MONGO', { presente: true, valor: 20 }]
    ];
    for (const [etiqueta, requisito, categoria, valorPrevio] of casos) {
      const entrada = entradaOkPara(requisito);
      assert.strictEqual(entrada.resultado_comparacion.categoria, categoria, etiqueta);
      assert.deepStrictEqual(entrada.valor_previo_en_mongo, valorPrevio, etiqueta);
      assert.strictEqual(entrada.destino_id, String(DESTINO_ID));
      assert.strictEqual(entrada.requisito_id, REQUISITO_ID);
      assert.strictEqual(entrada.fuente.capturado_en, FECHA_EJECUCION);
      assert.strictEqual('valor_propuesto' in entrada, debeGenerarPropuesta(categoria), `${etiqueta}: valor_propuesto solo si propone`);
      await assertEntradaRegistrable(entrada, etiqueta);
    }

    console.log('4) entradas OK de cada categoría registrables: OK');
  }

  // ============================================================
  // 5) Entradas de FALLO en cada etapa emitida: registrables, incluso
  //    antes de tener respuesta de GOV.UK (capturado_en null).
  // ============================================================
  {
    for (const etapa of ETAPAS_EMITIDAS) {
      const sinFuente = etapa === 'fetch_fuente';
      const entrada = construirEntradaRegistroFallo({
        runId: RUN_ID,
        iniciadoEn: INICIADO_EN,
        fechaEjecucion: sinFuente ? null : FECHA_EJECUCION,
        etapaFallo: etapa,
        error: `falla simulada en ${etapa}`,
        datosObtenidos: {
          fuente_govuk: resumenFuenteGovUk(sinFuente ? null : JSON_GOVUK),
          evidencia: { overview: { costo_extraido: null, moneda: 'GBP', fragmento_html: null } },
          destino_id: null
        },
        destinoId: etapa === 'construccion_salida' ? DESTINO_ID : null,
        requisitoId: etapa === 'construccion_salida' ? REQUISITO_ID : null
      });
      assert.strictEqual(entrada.estado_ejecucion, 'fallo');
      assert.strictEqual(entrada.etapa_fallo, etapa);
      assert.strictEqual(entrada.fuente.capturado_en, sinFuente ? null : FECHA_EJECUCION);
      await assertEntradaRegistrable(entrada, `fallo-${etapa}`);
    }

    console.log('5) entradas de fallo en cada etapa emitida registrables: OK');
  }

  // ============================================================
  // 6) Sin --registrar: nunca llama al servicio, en ningún camino. Los
  //    registros impresos llevan los campos precisos.
  // ============================================================
  {
    const escenarios = [
      ['lectura exitosa', {}, { estado: 'ok', etapa_fallo: null, error: null, categoria: 'SIN_COSTO_PREVIO_EN_MONGO' }],
      ['fallo de fetch', { fetchFalla: new Error('Timeout de 8000ms (simulado)') }, { estado: 'fallo', etapa_fallo: 'fetch_fuente', error: 'Timeout de 8000ms (simulado)', categoria: null }],
      [
        'GOV.UK sospechoso',
        {
          jsonGovUk: {
            ...JSON_GOVUK,
            details: { parts: [{ slug: 'overview', body: '£20' }, { slug: 'apply', body: '£25' }] }
          }
        },
        {
          estado: 'fallo',
          etapa_fallo: 'comparacion_fuente',
          error: 'Los costos de "overview" y "apply" no coinciden, falta alguno de los dos, o hubo ambigüedad en la extracción.',
          categoria: null
        }
      ],
      [
        'requisito no identificable',
        { busqueda: { requisito: null, requisitoId: null, destinoId: DESTINO_ID, motivo: 'no encontrado (simulado)', categoriaFallo: 'requisito_id_no_encontrado' } },
        { estado: 'fallo', etapa_fallo: 'identificacion_requisito_mongo', error: 'no encontrado (simulado)', categoria: null }
      ],
      [
        'error en la búsqueda',
        { buscarFalla: new Error('cursor timeout (simulado)') },
        { estado: 'fallo', etapa_fallo: 'identificacion_requisito_mongo', error: 'cursor timeout (simulado)', categoria: null }
      ]
    ];
    for (const [etiqueta, opciones, lecturaEsperada] of escenarios) {
      for (const registrar of [false, undefined]) {
        const { deps, llamadas } = crearMundoFalso({ ...opciones, registrar });
        const { resumen, salida } = await correrMain(deps);
        const nombre = `${etiqueta} (registrar=${registrar === undefined ? 'default' : registrar})`;
        assert.strictEqual(llamadas.registrar.length, 0, `${nombre}: no debe llamar al servicio`);
        assert.deepStrictEqual(resumen.lectura, lecturaEsperada, `${nombre}: resumen.lectura`);
        assert.strictEqual(resumen.registro.solicitado, false, nombre);
        assert.strictEqual(resumen.registro.intentado, false, nombre);
        assert.ok(salida.includes('"escritura_en_destinos_realizada": false'), `${nombre}: falta escritura_en_destinos_realizada`);
        assert.ok(salida.includes('"registro_persistente_solicitado": false'), `${nombre}: falta registro_persistente_solicitado`);
        assert.ok(!salida.includes('"escritura_realizada"'), `${nombre}: no debe quedar escritura_realizada`);
        assert.ok(!salida.includes('=== REGISTRO EN MONGO'), nombre);
      }
    }

    console.log('6) sin --registrar nunca llama al servicio (5 caminos): OK');
  }

  // ============================================================
  // 7) Con registro y lectura exitosa: llama al servicio UNA vez con la
  //    entrada OK; reutiliza la conexión de lectura.
  // ============================================================
  {
    const { deps, llamadas } = crearMundoFalso({ registrar: true });
    const { resumen, salida, exitCode } = await correrMain(deps);

    assert.strictEqual(llamadas.registrar.length, 1);
    const [entrada] = llamadas.registrar;
    assert.strictEqual(entrada.estado_ejecucion, 'ok');
    assert.strictEqual(entrada.run_id, resumen.run_id);
    assert.strictEqual(entrada.resultado_comparacion.categoria, 'SIN_COSTO_PREVIO_EN_MONGO');
    assert.deepStrictEqual(entrada.valor_propuesto, { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } });
    await assertEntradaRegistrable(entrada, 'entrada-ok-de-main');

    assert.deepStrictEqual(llamadas.conectar, [null, { serverSelectionTimeoutMS: 10000 }], 'conexión de lectura + verificación al registrar');
    assert.strictEqual(llamadas.desconectar, 1);
    assert.strictEqual(resumen.lectura.estado, 'ok');
    assert.strictEqual(resumen.registro.intentado, true);
    assert.strictEqual(resumen.registro.error, null);
    assert.strictEqual(exitCode, undefined, 'lectura limpia y registro ok: sin exitCode de error');
    assert.ok(salida.includes('"registro_persistente_solicitado": true'));
    assert.ok(salida.includes('"escritura_en_destinos_realizada": false'));

    // Si el servicio devuelve estado 'fallo' (ej. no pudo crear la
    // propuesta), la corrida termina con exitCode 1.
    const conFalloServicio = crearMundoFalso({
      registrar: true,
      resultadoRegistro: { estado_ejecucion: 'fallo', accion: 'fallo_registrado', etapa_fallo: 'creacion_propuesta', propuesta: null, colisiones: 0 }
    });
    const r2 = await correrMain(conFalloServicio.deps);
    assert.strictEqual(r2.exitCode, 1);
    assert.strictEqual(conFalloServicio.llamadas.desconectar, 1);

    console.log('7) con registro y lectura exitosa llama al servicio una vez: OK');
  }

  // ============================================================
  // 8) Con fallo de GOV.UK: conecta SOLO para registrar el fallo.
  // ============================================================
  {
    const { deps, llamadas } = crearMundoFalso({ registrar: true, fetchFalla: new Error('Timeout de 8000ms (simulado)') });
    const { resumen, exitCode } = await correrMain(deps);

    assert.strictEqual(llamadas.buscar, 0, 'no llega a leer Mongo');
    assert.deepStrictEqual(llamadas.conectar, [{ serverSelectionTimeoutMS: 10000 }], 'una sola conexión, con timeout, solo para registrar');
    assert.strictEqual(llamadas.registrar.length, 1);
    const [entrada] = llamadas.registrar;
    assert.strictEqual(entrada.estado_ejecucion, 'fallo');
    assert.strictEqual(entrada.etapa_fallo, 'fetch_fuente');
    assert.strictEqual(entrada.error_mensaje, 'Timeout de 8000ms (simulado)');
    assert.strictEqual(entrada.fuente.capturado_en, null);
    await assertEntradaRegistrable(entrada, 'entrada-fallo-fetch-de-main');
    assert.strictEqual(llamadas.desconectar, 1);
    assert.strictEqual(resumen.lectura.etapa_fallo, 'fetch_fuente');
    assert.strictEqual(exitCode, 1);

    console.log('8) con fallo de GOV.UK intenta registrar el fallo: OK');
  }

  // ============================================================
  // 9) Si el registro también falla, se conservan AMBOS errores y
  //    exitCode = 1 (con y sin conexión abierta).
  // ============================================================
  {
    const casos = [
      ['el servicio lanza', { registrarFalla: new Error('Falta el índice uniq_propuesta_activa (simulado)') }, 'Falta el índice uniq_propuesta_activa (simulado)', 1],
      ['no se puede conectar', { modosConectar: ['falla'] }, 'conexión rechazada (simulada)', 0]
    ];
    for (const [etiqueta, opciones, errorRegistro, desconexionesEsperadas] of casos) {
      const { deps, llamadas } = crearMundoFalso({ registrar: true, fetchFalla: new Error('Timeout de 8000ms (simulado)'), ...opciones });
      const { resumen, salida, exitCode } = await correrMain(deps);

      assert.strictEqual(resumen.lectura.error, 'Timeout de 8000ms (simulado)', etiqueta);
      assert.strictEqual(resumen.registro.intentado, true, etiqueta);
      assert.strictEqual(resumen.registro.error, errorRegistro, etiqueta);
      assert.ok(salida.includes('Timeout de 8000ms (simulado)'), `${etiqueta}: error de lectura impreso`);
      assert.ok(salida.includes(`No se pudo registrar la ejecución en Mongo: ${errorRegistro}`), `${etiqueta}: error de registro impreso`);
      assert.strictEqual(exitCode, 1, etiqueta);
      assert.strictEqual(llamadas.desconectar, desconexionesEsperadas, etiqueta);
    }

    console.log('9) si el registro también falla se conservan ambos errores y exitCode = 1: OK');
  }

  // ============================================================
  // 10) Cierre de recursos: si se abrió conexión, se desconecta
  //     EXACTAMENTE una vez, incluso ante errores; si nunca se abrió, no
  //     se desconecta.
  // ============================================================
  {
    const casos = [
      ['sin registro, lectura exitosa', { registrar: false }, 1],
      ['sin registro, fallo de fetch (nunca conecta)', { registrar: false, fetchFalla: new Error('red caída') }, 0],
      ['sin registro, conexión rechazada (nunca abre)', { registrar: false, modosConectar: ['falla'] }, 0],
      ['sin registro, conexión abierta y base inesperada', { registrar: false, modosConectar: ['abre_y_falla'] }, 1],
      ['sin registro, error en la búsqueda', { registrar: false, buscarFalla: new Error('cursor timeout') }, 1],
      ['con registro, lectura exitosa', { registrar: true }, 1],
      ['con registro, base inesperada en lectura y en registro', { registrar: true, modosConectar: ['abre_y_falla'] }, 1],
      ['con registro, el servicio lanza', { registrar: true, registrarFalla: new Error('run_id duplicado') }, 1],
      ['con registro, fallo de fetch y conexión rechazada', { registrar: true, fetchFalla: new Error('red caída'), modosConectar: ['falla'] }, 0]
    ];
    for (const [etiqueta, opciones, esperadas] of casos) {
      const { deps, llamadas } = crearMundoFalso(opciones);
      const { resumen } = await correrMain(deps);
      assert.strictEqual(llamadas.desconectar, esperadas, `${etiqueta}: desconexiones`);
      assert.strictEqual(resumen.desconexion.intentada, esperadas === 1, etiqueta);
      assert.strictEqual(deps.estaConectado(), false, `${etiqueta}: no debe quedar conexión abierta`);
    }

    // Un error al desconectar no rechaza main(): se intenta una sola vez,
    // se reporta y deja exitCode = 1.
    const { deps, llamadas } = crearMundoFalso({ registrar: true, desconectarFalla: new Error('socket cerrado (simulado)') });
    const { resumen, salida, exitCode } = await correrMain(deps);
    assert.strictEqual(llamadas.desconectar, 1);
    assert.strictEqual(resumen.desconexion.error, 'socket cerrado (simulado)');
    assert.ok(salida.includes('Error al desconectar de Mongo: socket cerrado (simulado)'));
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(resumen.registro.error, null, 'el registro previo no se ve afectado');

    console.log('10) cierre de recursos: desconecta exactamente una vez si hubo conexión, incluso ante errores: OK');
  }

  // ============================================================
  // 11) Cada camino de fallo con --registrar registra con su etapa.
  // ============================================================
  {
    const casos = [
      ['fetch', { fetchFalla: new Error('x') }, 'fetch_fuente'],
      ['parseo', { jsonGovUk: { ...JSON_GOVUK } }, 'parseo_fuente'],
      ['GOV.UK sospechoso', { jsonGovUk: { ...JSON_GOVUK, details: { parts: [{ slug: 'overview', body: '£20' }] } } }, 'comparacion_fuente'],
      ['conexión de lectura', { modosConectar: ['falla', 'ok'] }, 'conexion_mongo'],
      [
        'requisito no identificable',
        { busqueda: { requisito: null, requisitoId: '6aaddd0e9f54309f9d8272dc', destinoId: DESTINO_ID, motivo: 'identidad no coincide', categoriaFallo: 'identidad_semantica_no_coincide' } },
        'identificacion_requisito_mongo'
      ]
    ];
    for (const [etiqueta, opciones, etapa] of casos) {
      const { deps, llamadas } = crearMundoFalso({ registrar: true, ...opciones });
      const { exitCode } = await correrMain(deps);
      assert.strictEqual(llamadas.registrar.length, 1, etiqueta);
      const [entrada] = llamadas.registrar;
      assert.strictEqual(entrada.estado_ejecucion, 'fallo', etiqueta);
      assert.strictEqual(entrada.etapa_fallo, etapa, etiqueta);
      assert.strictEqual(entrada.requisito_id, null, `${etiqueta}: requisito no identificado → null`);
      await assertEntradaRegistrable(entrada, `main-${etiqueta}`);
      assert.strictEqual(exitCode, 1, etiqueta);
      assert.strictEqual(llamadas.desconectar, 1, `${etiqueta}: desconecta una vez (conexión del registro)`);
    }

    console.log('11) cada camino de fallo con --registrar registra con su etapa: OK');
  }

  assert.strictEqual(llamadasFetch, 0, 'ningún camino debe usar el fetch real (siempre el inyectado)');

  console.log('\nTodas las pruebas offline del piloto pasaron (sin red ni conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
