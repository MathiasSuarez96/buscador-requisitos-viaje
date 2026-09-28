// Pruebas offline (sin red, sin Mongo, sin .env) del adaptador de
// revalidación services/propuestas/adaptadores/govuk-uk-eta.js y del
// registro services/propuestas/adaptadores/index.js.
//
// Toda respuesta de GOV.UK es un fetch FALSO inyectado (fetchImpl). El
// fetch global es un espía durante todo el archivo: la única llamada que
// le llega es la de la prueba 9, que lo invoca a propósito para
// comprobar el default. Cubre: respuestas correctas, formatos ambiguos,
// secciones ausentes/duplicadas, timeout (request y body), errores de
// red, 429, 5xx, 404/410 (y demás 4xx) y JSON inválido.
//
// Uso: node scripts/test-adaptador-govuk-uk-eta.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

let llamadasFetchGlobal = 0;
globalThis.fetch = async () => {
  llamadasFetchGlobal++;
  throw new TypeError('fetch global no permitido en pruebas offline');
};

const adaptador = require('../services/propuestas/adaptadores/govuk-uk-eta');
const { ADAPTADORES, ErrorSinAdaptador, validarAdaptador, elegirAdaptador } = require('../services/propuestas/adaptadores');
const { URL_ETA, REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');
const { canonicalizarValor } = require('../services/propuestas/canonicalizacion-propuestas');
const { construirPropuesta } = require('../services/propuestas/registrar-ejecucion-lectura');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');

const PROPUESTA_ID = '22222222-2222-4222-8222-222222222222';
const REVALIDADA_EN = new Date('2026-09-28T12:00:00.000Z');
const ahora = () => new Date(REVALIDADA_EN);

// Propuesta con la forma REAL que produce el servicio de registro.
function propuestaEta() {
  const entrada = {
    run_id: '11111111-1111-4111-8111-111111111111',
    iniciado_en: new Date('2026-09-27T16:24:30.000Z'),
    campo: 'costo',
    fuente: { nombre: 'GOV.UK', url: URL_ETA, capturado_en: '2026-09-27T16:24:31.692Z' },
    evidencia: { extraccion: { overview: { costo_extraido: 20, moneda: 'GBP' } } },
    estado_ejecucion: 'ok',
    destino_id: '6a87828da8282a4aa6ddfbda',
    requisito_id: REQUISITO_ID_ETA,
    valor_previo_en_mongo: { presente: false, valor: null },
    resultado_comparacion: { categoria: 'SIN_COSTO_PREVIO_EN_MONGO', ambiguo: false },
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' } }
  };
  return {
    ...construirPropuesta(entrada, PROPUESTA_ID, '2026-09-27T16:24:32.532Z'),
    estado: 'aprobada',
    version_coordinacion: 1
  };
}

const FECHAS = {
  first_published_at: '2025-05-28T11:00:06+01:00',
  public_updated_at: '2025-05-28T11:00:06+01:00',
  updated_at: '2026-09-18T15:20:42+01:00'
};
const conPartes = (parts) => ({ ...FECHAS, details: { parts } });
const parte = (slug, body) => ({ slug, body });
const OVERVIEW_20 = parte('overview', '<p>An ETA costs £20. <a href="/eta/apply">Apply</a></p>');
const APPLY_20 = parte('apply', '<p>It costs £20 to apply online or through the app.</p>');

function respuesta({ status = 200, statusText = 'OK', json = null, jsonImpl = null } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText, json: jsonImpl ?? (async () => structuredClone(json)) };
}
const responde = (json) => async () => respuesta({ json });
const status = (s, texto) => async () => respuesta({ status: s, statusText: texto });
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const esperaAbort = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError())));

// Corre revalidar con un fetch falso, contando llamadas y capturando la
// consola (el adaptador no debe imprimir nada).
async function revalidarCon(fetchFalso, opciones = {}) {
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    llamadas.push({ url, tieneSignal: init?.signal instanceof AbortSignal });
    return fetchFalso(url, init);
  };
  const impreso = [];
  const consola = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => impreso.push(a.join(' '));
  try {
    const r = await adaptador.revalidar(propuestaEta(), { timeoutMs: 20, ahora, fetchImpl, ...opciones });
    return { r, llamadas, impreso };
  } finally {
    Object.assign(console, consola);
  }
}

const CLAVES = {
  valor: ['evidencia', 'fuente_nombre', 'revalidada_en', 'tipo', 'url', 'valor'],
  ambiguo: ['evidencia', 'fuente_nombre', 'motivo', 'revalidada_en', 'tipo', 'url'],
  no_disponible: ['evidencia', 'motivo', 'tipo']
};

// Forma exacta por tipo, canonicalizable, una sola llamada a la URL
// oficial con signal, y nada impreso.
function assertForma({ r, llamadas, impreso }, tipo, etiqueta) {
  assert.strictEqual(r.tipo, tipo, `${etiqueta}: tipo (motivo ${r.motivo})`);
  assert.deepStrictEqual(Object.keys(r).sort(), CLAVES[tipo], `${etiqueta}: claves`);
  if (tipo !== 'no_disponible') {
    assert.strictEqual(r.revalidada_en.getTime(), REVALIDADA_EN.getTime(), `${etiqueta}: revalidada_en del reloj inyectado`);
    assert.strictEqual(r.fuente_nombre, 'GOV.UK');
    assert.strictEqual(r.url, URL_ETA);
  }
  assert.doesNotThrow(() => canonicalizarValor(r), `${etiqueta}: canonicalizable (sin undefined)`);
  assert.deepStrictEqual(llamadas, [{ url: URL_ETA, tieneSignal: true }], `${etiqueta}: una sola llamada`);
  assert.deepStrictEqual(impreso, [], `${etiqueta}: no imprime nada`);
}

(async () => {
  // ============================================================
  // 1) Interfaz: el adaptador y el registro cumplen el contrato.
  // ============================================================
  {
    assert.ok(Object.isFrozen(ADAPTADORES));
    assert.deepStrictEqual(ADAPTADORES, [adaptador]);
    assert.strictEqual(validarAdaptador(adaptador), adaptador);
    assert.strictEqual(adaptador.nombre, 'govuk-uk-eta');
    assert.strictEqual(adaptador.version, '1');
    assert.ok(Object.isFrozen(adaptador));
    // El adaptador no importa Mongoose, modelos ni dotenv.
    const codigo = fs.readFileSync(path.join(__dirname, '../services/propuestas/adaptadores/govuk-uk-eta.js'), 'utf8');
    const requires = [...codigo.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(requires, ['../canonicalizacion-propuestas', '../fuentes/govuk-uk-eta']);
    console.log('1) interfaz del adaptador y del registro; sin Mongoose ni dotenv: OK');
  }

  // ============================================================
  // 2) soporta(): solo la propuesta exacta del UK ETA.
  // ============================================================
  {
    const base = propuestaEta();
    await new PropuestaCambio(base).validate(); // la fixture es una propuesta válida real
    assert.strictEqual(adaptador.soporta(base), true);
    assert.strictEqual(adaptador.soporta({ ...base, requisito_id: new mongoose.Types.ObjectId(REQUISITO_ID_ETA) }), true, 'requisito_id ObjectId (lean)');

    const conPayload = (cambios) => ({ ...base, payload: { ...base.payload, ...cambios } });
    const negativos = [
      ['campo externo distinto', { ...base, campo: 'nombre' }],
      ['campo del payload distinto', conPayload({ campo: 'nombre' })],
      ['tipo_propuesta distinto', conPayload({ tipo_propuesta: 'otra' })],
      ['requisito_id externo distinto', { ...base, requisito_id: '000000000000000000000002' }],
      ['requisito_id del payload distinto', conPayload({ requisito_id: '000000000000000000000002' })],
      ['fuente.url distinta', conPayload({ fuente: { ...base.payload.fuente, url: 'https://www.gov.uk/api/content/otra' } })],
      ['fuente.nombre distinto', conPayload({ fuente: { ...base.payload.fuente, nombre: 'Otra' } })],
      ['moneda distinta', conPayload({ valor_propuesto: { ...base.payload.valor_propuesto, valor_normalizado: { importe: 20, moneda: 'USD' } } })],
      ['sin payload', { ...base, payload: undefined }],
      ['sin fuente', conPayload({ fuente: undefined })],
      ['null', null],
      ['undefined', undefined],
      ['array', []],
      ['string', 'propuesta']
    ];
    for (const [nombre, p] of negativos) assert.strictEqual(adaptador.soporta(p), false, nombre);
    console.log(`2) soporta(): propuesta real → true; ${negativos.length} variantes → false: OK`);
  }

  // ============================================================
  // 3) validarIdentidad(): tipo y nombre exactos.
  // ============================================================
  {
    const ok = { _id: REQUISITO_ID_ETA, tipo: 'formulario_digital', nombre: 'UK ETA', costo: '£20' };
    assert.deepStrictEqual(adaptador.validarIdentidad(ok), { ok: true });
    const negativos = [
      ['tipo distinto', { ...ok, tipo: 'visa' }, { tipo: 'visa', nombre: 'UK ETA' }],
      ['nombre distinto', { ...ok, nombre: 'UK eTA' }, { tipo: 'formulario_digital', nombre: 'UK eTA' }],
      ['sin nombre', { _id: REQUISITO_ID_ETA, tipo: 'formulario_digital' }, { tipo: 'formulario_digital', nombre: null }],
      ['null', null, { tipo: null, nombre: null }],
      ['string', 'UK ETA', { tipo: null, nombre: null }]
    ];
    for (const [nombre, requisito, encontrado] of negativos) {
      const r = adaptador.validarIdentidad(requisito);
      assert.deepStrictEqual(
        r,
        {
          ok: false,
          categoria: 'identidad_semantica_no_coincide',
          detalle: { esperado: { tipo: 'formulario_digital', nombre: 'UK ETA' }, encontrado }
        },
        nombre
      );
      canonicalizarValor(r);
    }
    console.log(`3) validarIdentidad(): ok + ${negativos.length} identidades rechazadas con detalle: OK`);
  }

  // ============================================================
  // 4) Respuestas correctas → valor, con la forma del payload.
  // ============================================================
  {
    const base = propuestaEta();
    const casos = [
      ['£20 en ambas secciones', conPartes([OVERVIEW_20, APPLY_20]), 20],
      ['£20 al final del texto', conPartes([parte('overview', 'costs £20'), parte('apply', 'pay £20')]), 20],
      ['£25 (otro importe: lo decide el servicio)', conPartes([parte('overview', 'costs £25'), parte('apply', 'pay £25')]), 25]
    ];
    for (const [nombre, json, importe] of casos) {
      const res = await revalidarCon(responde(json));
      assertForma(res, 'valor', nombre);
      assert.deepStrictEqual(res.r.valor, { valor: `£${importe}`, valor_normalizado: { importe, moneda: 'GBP' } }, nombre);
      assert.deepStrictEqual(res.r.evidencia.avisos, []);
      assert.strictEqual(res.r.evidencia.comparacion_govuk.costo_extraido_consistente, importe);
    }
    // Con £20, el valor revalidado es canónicamente igual al propuesto.
    const { r } = await revalidarCon(responde(conPartes([OVERVIEW_20, APPLY_20])));
    const propuesto = { valor: base.payload.valor_propuesto.valor, valor_normalizado: base.payload.valor_propuesto.valor_normalizado };
    assert.deepStrictEqual(canonicalizarValor(r.valor), canonicalizarValor(propuesto));
    console.log(`4) respuestas correctas → valor (${casos.length} casos), comparable con valor_propuesto: OK`);
  }

  // ============================================================
  // 5) Formatos ambiguos y secciones ausentes/duplicadas → ambiguo.
  // ============================================================
  {
    const casos = [
      ['overview ≠ apply', conPartes([OVERVIEW_20, parte('apply', 'pay £25')]), 'overview_apply_distintos'],
      ['dos £ en una sección', conPartes([parte('overview', '£20 y £30abc'), APPLY_20]), 'overview_formato_sospechoso'],
      ['decimal con punto', conPartes([parte('overview', 'costs £20.50'), APPLY_20]), 'overview_formato_sospechoso'],
      ['decimal con coma', conPartes([OVERVIEW_20, parte('apply', 'pay £20,50')]), 'apply_formato_sospechoso'],
      ['alfanumérico pegado', conPartes([parte('overview', 'costs £20m'), APPLY_20]), 'overview_formato_sospechoso'],
      ['sin £ (¿gratis?)', conPartes([parte('overview', 'free'), parte('apply', 'no fee')]), 'overview_sin_costo,apply_sin_costo'],
      ['overview ausente', conPartes([APPLY_20]), 'overview_ausente'],
      ['apply ausente', conPartes([OVERVIEW_20]), 'apply_ausente'],
      ['overview duplicado', conPartes([OVERVIEW_20, OVERVIEW_20, APPLY_20]), 'overview_duplicado'],
      ['apply duplicado', conPartes([OVERVIEW_20, APPLY_20, APPLY_20]), 'apply_duplicado'],
      ['ambas ausentes', conPartes([]), 'overview_ausente,apply_ausente'],
      ['sin details', { ...FECHAS }, 'sin_details_parts'],
      ['parts no es array', { ...FECHAS, details: { parts: {} } }, 'sin_details_parts'],
      ['JSON null', null, 'sin_details_parts'],
      ['JSON array', [], 'sin_details_parts'],
      ['JSON string', 'eta', 'sin_details_parts'],
      ['elemento null en parts', conPartes([null, OVERVIEW_20, APPLY_20]), 'estructura_inesperada']
    ];
    for (const [nombre, json, motivo] of casos) {
      const res = await revalidarCon(responde(json));
      assertForma(res, 'ambiguo', nombre);
      assert.strictEqual(res.r.motivo, motivo, nombre);
      assert.ok(Array.isArray(res.r.evidencia.avisos), `${nombre}: avisos en la evidencia`);
    }
    console.log(`5) formatos ambiguos y secciones ausentes/duplicadas → ambiguo (${casos.length} casos), sin imprimir: OK`);
  }

  // ============================================================
  // 6) Timeout (request y body) y errores de red → no_disponible.
  // ============================================================
  {
    const casos = [
      ['timeout en la request', async (url, { signal }) => esperaAbort(signal), 'timeout'],
      ['timeout leyendo el body', async (url, { signal }) => respuesta({ jsonImpl: () => esperaAbort(signal) }), 'timeout'],
      ['error de red (fetch failed)', async () => Promise.reject(new TypeError('fetch failed')), 'red'],
      ['DNS', async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'red'],
      ['conexión cortada leyendo el body', async () => respuesta({ jsonImpl: async () => Promise.reject(new Error('socket hang up')) }), 'red']
    ];
    for (const [nombre, fetchFalso, motivo] of casos) {
      const inicio = Date.now();
      const res = await revalidarCon(fetchFalso);
      assertForma(res, 'no_disponible', nombre);
      assert.strictEqual(res.r.motivo, motivo, nombre);
      assert.strictEqual(res.r.evidencia.causa, motivo);
      assert.strictEqual(res.r.evidencia.timeout_ms, 20);
      assert.ok(Date.now() - inicio < 2000, `${nombre}: respeta timeoutMs`);
    }
    console.log(`6) timeout (request/body) y errores de red → no_disponible (${casos.length} casos): OK`);
  }

  // ============================================================
  // 7) Status HTTP: 429 / 408 / 425 / 5xx / no-OK fuera de 4xx →
  //    no_disponible; 404 / 410 y demás 4xx → ambiguo.
  // ============================================================
  {
    const casos = [
      [429, 'Too Many Requests', 'no_disponible'],
      [408, 'Request Timeout', 'no_disponible'],
      [425, 'Too Early', 'no_disponible'],
      [500, 'Internal Server Error', 'no_disponible'],
      [502, 'Bad Gateway', 'no_disponible'],
      [503, 'Service Unavailable', 'no_disponible'],
      [504, 'Gateway Timeout', 'no_disponible'],
      [304, 'Not Modified', 'no_disponible'],
      [404, 'Not Found', 'ambiguo'],
      [410, 'Gone', 'ambiguo'],
      [400, 'Bad Request', 'ambiguo'],
      [403, 'Forbidden', 'ambiguo'],
      [451, 'Unavailable For Legal Reasons', 'ambiguo']
    ];
    for (const [s, texto, tipo] of casos) {
      const res = await revalidarCon(status(s, texto));
      assertForma(res, tipo, `HTTP ${s}`);
      assert.strictEqual(res.r.motivo, `http_${s}`);
      assert.deepStrictEqual(res.r.evidencia, {
        causa: 'http',
        status: s,
        mensaje: `La API de GOV.UK respondió ${s} ${texto}.`,
        timeout_ms: 20
      });
    }
    console.log(`7) status HTTP clasificados (${casos.length}: 429/408/425/5xx/304 → no_disponible; 404/410/4xx → ambiguo): OK`);
  }

  // ============================================================
  // 8) JSON inválido → no_disponible.
  // ============================================================
  {
    const res = await revalidarCon(async () => respuesta({ jsonImpl: async () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) }));
    assertForma(res, 'no_disponible', 'JSON inválido');
    assert.strictEqual(res.r.motivo, 'json_invalido');
    assert.strictEqual(res.r.evidencia.mensaje, 'Unexpected token < in JSON');
    console.log('8) JSON inválido → no_disponible (json_invalido): OK');
  }

  // ============================================================
  // 9) Defaults: timeoutMs 8000 y fetch global resuelto en la llamada
  //    (acá el espía); nunca lanza por la fuente.
  // ============================================================
  {
    const r = await adaptador.revalidar(propuestaEta(), { ahora });
    assert.strictEqual(r.tipo, 'no_disponible');
    assert.strictEqual(r.motivo, 'red');
    assert.strictEqual(r.evidencia.timeout_ms, 8000);
    assert.strictEqual(llamadasFetchGlobal, 1, 'la única llamada al fetch global es esta, deliberada, y la atrapa el espía');
    console.log('9) defaults: timeoutMs 8000 y fetch global (espía) cuando no se inyecta: OK');
  }

  // ============================================================
  // 10) Propuesta no soportada → TypeError sin ninguna llamada.
  // ============================================================
  {
    let llamadas = 0;
    const p = { ...propuestaEta(), campo: 'nombre' };
    let err;
    try {
      await adaptador.revalidar(p, { fetchImpl: async () => llamadas++, ahora });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof TypeError);
    assert.strictEqual(llamadas, 0);
    console.log('10) revalidar con una propuesta no soportada → TypeError (error de programación), sin fetch: OK');
  }

  // ============================================================
  // 11) elegirAdaptador y validarAdaptador.
  // ============================================================
  {
    assert.strictEqual(elegirAdaptador(propuestaEta()), adaptador);
    assert.throws(() => elegirAdaptador({ ...propuestaEta(), campo: 'nombre' }), ErrorSinAdaptador);
    const clon = Object.freeze({ ...adaptador, nombre: 'clon' });
    assert.throws(() => elegirAdaptador(propuestaEta(), [adaptador, clon]), (e) => e instanceof ErrorSinAdaptador && /govuk-uk-eta, clon/.test(e.message));
    assert.throws(() => elegirAdaptador(propuestaEta(), []), ErrorSinAdaptador);

    const invalidos = [
      ['null', null],
      ['sin nombre', Object.freeze({ ...adaptador, nombre: '' })],
      ['sin version', Object.freeze({ ...adaptador, version: undefined })],
      ['sin revalidar', Object.freeze({ ...adaptador, revalidar: undefined })],
      ['no congelado', { ...adaptador }]
    ];
    for (const [nombre, a] of invalidos) {
      assert.throws(() => validarAdaptador(a), TypeError, nombre);
      assert.throws(() => elegirAdaptador(propuestaEta(), [a]), TypeError, `${nombre} en elegirAdaptador`);
    }
    console.log(`11) elegirAdaptador (1 / 0 / 2 candidatos) y ${invalidos.length} adaptadores inválidos rechazados: OK`);
  }

  assert.strictEqual(llamadasFetchGlobal, 1, 'ninguna prueba salió a la red (solo la llamada deliberada al espía)');
  assert.strictEqual(mongoose.connection.readyState, 0, 'ninguna prueba conectó a Mongo');

  console.log('\nTodas las pruebas offline del adaptador GOV.UK pasaron (sin red, sin Mongo, sin .env).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
