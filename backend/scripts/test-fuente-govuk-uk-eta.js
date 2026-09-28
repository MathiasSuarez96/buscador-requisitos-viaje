// Pruebas offline (sin red, sin Mongo, sin .env) de
// services/propuestas/fuentes/govuk-uk-eta.js: extracción del costo,
// selección de secciones, fetch con timeout y la decisión
// extraerCostoEta(), comparada contra el main() REAL del piloto
// (scripts/piloto-lectura-uk-eta.js) con dependencias falsas.
//
// El fetch global se reemplaza por un espía durante todo el archivo, y
// `dotenv` por otro espía ANTES de importar el piloto (defensa en
// profundidad: el piloto ya no lo llama al importarse, solo por CLI).
// Ninguna prueba sale a la red ni lee .env.
//
// Uso: node scripts/test-fuente-govuk-uk-eta.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let llamadasFetchGlobal = 0;
globalThis.fetch = async () => {
  llamadasFetchGlobal++;
  throw new TypeError('fetch global no permitido en pruebas offline');
};

let llamadasDotenv = 0;
{
  const rutaDotenv = require.resolve('dotenv');
  const falso = new Module(rutaDotenv);
  falso.exports = {
    config: () => {
      llamadasDotenv++;
      return { parsed: {} };
    }
  };
  falso.loaded = true;
  require.cache[rutaDotenv] = falso;
}

const fuente = require('../services/propuestas/fuentes/govuk-uk-eta');
const piloto = require('./piloto-lectura-uk-eta.js');
const { canonicalizarValor } = require('../services/propuestas/canonicalizacion-propuestas');

const {
  URL_ETA,
  ErrorFuenteGovUk,
  extraerCosto,
  seleccionarParteUnica,
  fetchJsonConTimeout,
  resumenFuenteGovUk,
  resumenEvidencia,
  extraerCostoEta
} = fuente;

const FECHAS = {
  first_published_at: '2025-05-28T11:00:06+01:00',
  public_updated_at: '2025-05-28T11:00:06+01:00',
  updated_at: '2026-09-18T15:20:42+01:00'
};
const conPartes = (parts) => ({ ...FECHAS, details: { parts } });
const parte = (slug, body) => ({ slug, body });
const OVERVIEW_20 = parte('overview', '<p>An ETA costs £20. <a href="/eta/apply">Apply</a></p>');
const APPLY_20 = parte('apply', '<p>It costs £20 to apply online or through the app.</p>');

// Escenarios de la fuente. `esperado`: 'ok' con su costo, o 'ambiguo'
// con los motivos exactos.
const ESCENARIOS = [
  ['ok', conPartes([OVERVIEW_20, APPLY_20]), { estado: 'ok', costo: 20 }],
  ['ok al final del texto', conPartes([parte('overview', 'costs £20'), parte('apply', 'pay £20')]), { estado: 'ok', costo: 20 }],
  ['ok seguido de punto', conPartes([parte('overview', 'costs £20. Then'), parte('apply', 'pay £20, online')]), { estado: 'ok', costo: 20 }],
  ['ok otro importe', conPartes([parte('overview', 'costs £25'), parte('apply', 'pay £25')]), { estado: 'ok', costo: 25 }],
  ['overview ≠ apply', conPartes([OVERVIEW_20, parte('apply', 'pay £25')]), { estado: 'ambiguo', motivos: ['overview_apply_distintos'] }],
  ['dos £ en overview', conPartes([parte('overview', '£20 y £30abc'), APPLY_20]), { estado: 'ambiguo', motivos: ['overview_formato_sospechoso'] }],
  ['decimal con punto', conPartes([parte('overview', 'costs £20.50'), APPLY_20]), { estado: 'ambiguo', motivos: ['overview_formato_sospechoso'] }],
  ['decimal con coma', conPartes([OVERVIEW_20, parte('apply', 'pay £20,50')]), { estado: 'ambiguo', motivos: ['apply_formato_sospechoso'] }],
  ['alfanumérico pegado', conPartes([parte('overview', 'costs £20m'), APPLY_20]), { estado: 'ambiguo', motivos: ['overview_formato_sospechoso'] }],
  ['sin £ en ninguna sección', conPartes([parte('overview', 'free'), parte('apply', 'no fee')]), { estado: 'ambiguo', motivos: ['overview_sin_costo', 'apply_sin_costo'] }],
  ['overview ausente', conPartes([APPLY_20]), { estado: 'ambiguo', motivos: ['overview_ausente'] }],
  ['apply ausente', conPartes([OVERVIEW_20]), { estado: 'ambiguo', motivos: ['apply_ausente'] }],
  ['overview duplicado', conPartes([OVERVIEW_20, OVERVIEW_20, APPLY_20]), { estado: 'ambiguo', motivos: ['overview_duplicado'] }],
  ['apply duplicado', conPartes([OVERVIEW_20, APPLY_20, APPLY_20]), { estado: 'ambiguo', motivos: ['apply_duplicado'] }],
  ['body no string', conPartes([parte('overview', 20), APPLY_20]), { estado: 'ambiguo', motivos: ['overview_sin_costo'] }],
  ['sin details', { ...FECHAS }, { estado: 'ambiguo', motivos: ['sin_details_parts'] }],
  ['parts no es array', { ...FECHAS, details: { parts: 'x' } }, { estado: 'ambiguo', motivos: ['sin_details_parts'] }],
  ['json null', null, { estado: 'ambiguo', motivos: ['sin_details_parts'] }]
];

function respuesta({ status = 200, statusText = 'OK', json = null, jsonImpl = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: jsonImpl ?? (async () => structuredClone(json))
  };
}

// fetch que no responde hasta que se aborta (como el fetch real).
function fetchQueEspera(url, { signal }) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
}

async function assertRechaza(promesa, verificar, etiqueta) {
  let err;
  try {
    await promesa;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `[${etiqueta}] se esperaba un error`);
  verificar(err);
  return err;
}

// --- main() real del piloto con dependencias falsas (ver test-piloto) ---
async function correrPiloto(jsonGovUk) {
  const registradas = [];
  let conectado = false;
  const deps = {
    registrar: true,
    fetchJson: async () => structuredClone(jsonGovUk),
    conectar: async () => {
      conectado = true;
    },
    buscarRequisito: async () => ({
      requisito: { _id: '6aaddd0e9f54309f9d8272dc', tipo: 'formulario_digital', nombre: 'UK ETA' },
      requisitoId: '6aaddd0e9f54309f9d8272dc',
      destinoId: '000000000000000000000001',
      motivo: null,
      categoriaFallo: null
    }),
    registrarEjecucion: async (entrada) => {
      registradas.push(entrada);
      return { run_id: entrada.run_id, estado_ejecucion: entrada.estado_ejecucion };
    },
    desconectar: async () => {
      conectado = false;
    },
    estaConectado: () => conectado
  };
  const avisos = [];
  const consola = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.error = () => {};
  console.warn = (...args) => avisos.push(args.join(' '));
  const exitCodePrevio = process.exitCode;
  try {
    const resumen = await piloto.main(deps);
    return { resumen, entrada: registradas[0], avisos };
  } finally {
    Object.assign(console, consola);
    process.exitCode = exitCodePrevio;
  }
}

(async () => {
  // ============================================================
  // 1) El módulo no importa nada (ni Mongoose, ni modelos, ni red
  //    directa, ni dotenv) e importarlo no dispara fetch.
  // ============================================================
  {
    const codigo = fs.readFileSync(path.join(__dirname, '../services/propuestas/fuentes/govuk-uk-eta.js'), 'utf8');
    assert.deepStrictEqual([...codigo.matchAll(/require\(/g)], [], 'la fuente compartida no debe hacer require de nada');
    assert.strictEqual(llamadasFetchGlobal, 0);
    console.log('1) la fuente compartida no importa módulos ni hace fetch al cargarse: OK');
  }

  // ============================================================
  // 2) extraerCosto y seleccionarParteUnica: casos y avisos.
  // ============================================================
  {
    const casos = [
      ['It costs £20 to apply', 20, false],
      ['costs £20', 20, false],
      ['costs £20. Next', 20, false],
      ['costs £20, then', 20, false],
      ['free', null, false],
      ['£20 y £30abc', null, true],
      ['£20.50', null, true],
      ['£20,50', null, true],
      ['£20.50.75', null, true],
      ['£20m', null, true],
      ['£ sin número', null, false],
      [42, null, false],
      [undefined, null, false]
    ];
    for (const [html, costo, sospechoso] of casos) {
      const avisos = [];
      const r = extraerCosto(html, { avisar: (m) => avisos.push(m) });
      assert.strictEqual(r.costo, costo, `costo de ${JSON.stringify(html)}`);
      assert.strictEqual(r.sospechoso, sospechoso, `sospechoso de ${JSON.stringify(html)}`);
      assert.strictEqual(avisos.length, sospechoso ? 1 : 0, `avisos de ${JSON.stringify(html)}`);
      if (costo !== null) assert.ok(r.fragmento.includes(`£${costo}`));
    }
    // Sin `avisar`, el aviso va a console.warn resuelto en la llamada.
    const capturados = [];
    const warn = console.warn;
    console.warn = (m) => capturados.push(m);
    try {
      extraerCosto('£1 £2');
      seleccionarParteUnica([], 'overview');
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(capturados.length, 2);

    const avisos = [];
    const avisar = (m) => avisos.push(m);
    assert.deepStrictEqual(seleccionarParteUnica([OVERVIEW_20, APPLY_20], 'apply', { avisar }), { parte: APPLY_20, sospechoso: false });
    assert.deepStrictEqual(seleccionarParteUnica([APPLY_20], 'overview', { avisar }), { parte: null, sospechoso: false });
    assert.deepStrictEqual(seleccionarParteUnica([APPLY_20, APPLY_20], 'apply', { avisar }), { parte: null, sospechoso: true });
    assert.strictEqual(avisos.length, 2);
    console.log(`2) extraerCosto (${casos.length} casos) y seleccionarParteUnica; avisar inyectable y console.warn por defecto: OK`);
  }

  // ============================================================
  // 3) extraerCostoEta: decisión y motivos de cada escenario;
  //    evidencia canonicalizable (sin undefined).
  // ============================================================
  {
    for (const [nombre, json, esperado] of ESCENARIOS) {
      const avisos = [];
      const r = extraerCostoEta(json, { avisar: (m) => avisos.push(m) });
      assert.strictEqual(r.estado, esperado.estado, nombre);
      if (esperado.estado === 'ok') {
        assert.strictEqual(r.costo, esperado.costo, nombre);
        assert.strictEqual(r.moneda, 'GBP');
        assert.deepStrictEqual(r.motivos, []);
        assert.deepStrictEqual(r.evidencia.comparacion_govuk, {
          coincide_entre_secciones: true,
          costo_extraido_consistente: esperado.costo,
          moneda: 'GBP'
        });
      } else {
        assert.deepStrictEqual(r.motivos, esperado.motivos, nombre);
        assert.strictEqual(r.costo, null);
        assert.strictEqual(r.evidencia.comparacion_govuk, undefined, `${nombre}: sin comparación si es ambiguo`);
      }
      assert.deepStrictEqual(r.evidencia.fuente_govuk, resumenFuenteGovUk(json), nombre);
      canonicalizarValor(r.evidencia); // lanza si hay undefined
    }
    console.log(`3) extraerCostoEta: ${ESCENARIOS.length} escenarios con decisión y motivos exactos: OK`);
  }

  // ============================================================
  // 4) Golden: extraerCostoEta decide igual que el main() REAL del
  //    piloto (sin modificar), con la misma evidencia y los mismos
  //    avisos, en cada escenario.
  // ============================================================
  {
    for (const [nombre, json] of ESCENARIOS) {
      const avisosEta = [];
      const eta = extraerCostoEta(json, { avisar: (m) => avisosEta.push(m) });
      const { resumen, entrada, avisos } = await correrPiloto(json);
      assert.ok(entrada, `${nombre}: el piloto registró la corrida`);
      if (eta.estado === 'ok') {
        assert.strictEqual(resumen.lectura.estado, 'ok', `${nombre}: el piloto también da ok`);
        assert.deepStrictEqual(entrada.evidencia.extraccion, eta.evidencia.extraccion, nombre);
        assert.deepStrictEqual(entrada.evidencia.comparacion_govuk, eta.evidencia.comparacion_govuk, nombre);
        assert.deepStrictEqual(entrada.evidencia.fuente_govuk, eta.evidencia.fuente_govuk, nombre);
        assert.strictEqual(entrada.valor_propuesto.valor, `£${eta.costo}`, nombre);
      } else if (eta.motivos.includes('sin_details_parts')) {
        assert.strictEqual(resumen.lectura.etapa_fallo, 'parseo_fuente', `${nombre}: el piloto falla al parsear`);
      } else {
        assert.strictEqual(resumen.lectura.etapa_fallo, 'comparacion_fuente', `${nombre}: el piloto lo marca sospechoso`);
        assert.deepStrictEqual(entrada.evidencia.evidencia, eta.evidencia.extraccion, nombre);
      }
      // Los mismos avisos, en el mismo orden (el piloto además avisa su
      // propia conclusión "SOSPECHOSO: los costos no coinciden...").
      assert.deepStrictEqual(avisos.slice(0, avisosEta.length), avisosEta, `${nombre}: avisos`);
    }
    console.log(`4) golden: extraerCostoEta coincide con el main() real del piloto en los ${ESCENARIOS.length} escenarios: OK`);
  }

  // ============================================================
  // 5) fetchJsonConTimeout: mismos mensajes que antes, más causa y
  //    status; el timeout cubre request y body; el timer se limpia.
  // ============================================================
  {
    const ok = { ...FECHAS, details: { parts: [] } };
    assert.deepStrictEqual(await fetchJsonConTimeout(URL_ETA, 1000, { fetchImpl: async () => respuesta({ json: ok }) }), ok);

    const casos = [
      ['404', async () => respuesta({ status: 404, statusText: 'Not Found' }), 'http', 404, 'La API de GOV.UK respondió 404 Not Found.'],
      ['503', async () => respuesta({ status: 503, statusText: 'Service Unavailable' }), 'http', 503, 'La API de GOV.UK respondió 503 Service Unavailable.'],
      ['timeout en request', fetchQueEspera, 'timeout', null, `Timeout de 20ms haciendo fetch/lectura a ${URL_ETA}.`],
      [
        'timeout leyendo body',
        async (url, { signal }) =>
          respuesta({
            jsonImpl: () =>
              new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
              )
          }),
        'timeout',
        null,
        `Timeout de 20ms haciendo fetch/lectura a ${URL_ETA}.`
      ],
      ['red', async () => Promise.reject(new TypeError('fetch failed')), 'red', null, 'fetch failed'],
      [
        'json inválido',
        async () => respuesta({ jsonImpl: async () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) }),
        'json_invalido',
        null,
        'Unexpected token < in JSON'
      ],
      ['body cortado', async () => respuesta({ jsonImpl: async () => Promise.reject(new Error('socket hang up')) }), 'red', null, 'socket hang up']
    ];
    for (const [nombre, fetchImpl, causa, status, mensaje] of casos) {
      const inicio = Date.now();
      await assertRechaza(
        fetchJsonConTimeout(URL_ETA, 20, { fetchImpl }),
        (err) => {
          assert.ok(err instanceof ErrorFuenteGovUk, `${nombre}: clase`);
          assert.strictEqual(err.causa, causa, `${nombre}: causa`);
          assert.strictEqual(err.status, status, `${nombre}: status`);
          assert.strictEqual(err.message, mensaje, `${nombre}: mismo mensaje que antes`);
        },
        nombre
      );
      assert.ok(Date.now() - inicio < 2000, `${nombre}: respeta el timeout`);
    }

    // El timer se limpia al terminar: el signal no se aborta después.
    let signalVisto;
    await fetchJsonConTimeout(URL_ETA, 20, {
      fetchImpl: async (url, { signal }) => {
        signalVisto = signal;
        return respuesta({ json: ok });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(signalVisto.aborted, false, 'el timer se limpió al terminar');

    // Sin fetchImpl usa el fetch global resuelto en cada llamada (acá, el espía).
    await assertRechaza(
      fetchJsonConTimeout(URL_ETA, 1000),
      (err) => assert.strictEqual(err.causa, 'red'),
      'fetch global'
    );
    assert.strictEqual(llamadasFetchGlobal, 1, 'solo la llamada deliberada llegó al fetch global (espía)');
    console.log(`5) fetchJsonConTimeout: ok + ${casos.length} fallas con mensaje original, causa y status; timer limpio: OK`);
  }

  // ============================================================
  // 6) resúmenes: sin undefined.
  // ============================================================
  {
    assert.strictEqual(resumenFuenteGovUk(null), null);
    assert.deepStrictEqual(resumenFuenteGovUk({}), { url: URL_ETA, first_published_at: null, public_updated_at: null, updated_at: null });
    const vacio = { costo: null, sospechoso: false, fragmento: null };
    canonicalizarValor(resumenEvidencia(vacio, vacio));
    console.log('6) resumenFuenteGovUk / resumenEvidencia canonicalizables: OK');
  }

  assert.strictEqual(llamadasFetchGlobal, 1, 'ninguna prueba salió a la red (solo la llamada deliberada al espía)');
  assert.strictEqual(llamadasDotenv, 0, 'nadie llamó a dotenv.config() (.env nunca se leyó)');

  console.log('\nTodas las pruebas offline de la fuente GOV.UK pasaron (sin red, sin Mongo, sin .env).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
