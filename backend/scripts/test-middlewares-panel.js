// Pruebas de punta a punta del panel en este bloque: app real en 127.0.0.1,
// verificador real de Google con claves propias y JWKS local (o servido en
// 127.0.0.1), configuración real cargada desde un entorno de prueba.
// Cubre request_id, no-store, CORS, límites de body/token, autenticación,
// autorización, /sesion, fallo cerrado y saneo de registros y respuestas.
//
// Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-middlewares-panel.js

const assert = require('assert');
const http = require('http');

const { pedir, get } = require('./lib/http-prueba');
const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');
const { crearApp } = require('../app');
const { crearVerificadorGoogle, ErrorAutenticacionNoDisponible } = require('../services/panel/verificar-token-google');
const { cargarOperadoresPanel } = require('../services/panel/operadores-panel');
const { crearAutorizar, crearAutenticar } = require('../middleware/panel');
const Destino = require('../models/Destino.model');

// La API pública se usa solo para comprobar que sigue respondiendo: doble
// sin Mongo (destino inexistente → 404 del controlador público).
Destino.findOne = async () => null;

const ORIGEN = 'https://toctoc-requisitos.vercel.app';
const OPERADORES = [
  { proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] },
  { proveedor: 'google', sub: '2000', email: 'solo-decidir@example.com', identificador: 'solo.decidir', permisos: ['decidir'] }
];
const envDe = (extra = {}) => ({
  GOOGLE_CLIENT_ID: CLIENT_ID,
  OPERADORES_PANEL_JSON: JSON.stringify(OPERADORES),
  PANEL_ORIGENES_PERMITIDOS: ORIGEN,
  ...extra
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Todo lo observable (respuestas y registros) se acumula y se revisa al final.
const OBSERVADO = [];
const TOKENS = [];
const REGISTROS = [];

async function levantar(panel) {
  const app = crearApp({ panel: { registrar: (e) => REGISTROS.push(e), ...panel } });
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const puerto = servidor.address().port;
  const llamar = async (metodo, ruta, headers = {}, cuerpo = null) => {
    const r = await pedir(puerto, metodo, ruta, headers, cuerpo);
    OBSERVADO.push(JSON.stringify(r.headers), r.body);
    return r;
  };
  return { llamar, cerrar: () => new Promise((r) => servidor.close(r)) };
}

const cuerpo = (r) => (r.body ? JSON.parse(r.body) : null);

function assertError(r, status, codigo, etiqueta) {
  assert.strictEqual(r.status, status, `[${etiqueta}] status (cuerpo: ${r.body})`);
  const b = cuerpo(r);
  assert.deepStrictEqual(Object.keys(b), ['error'], `[${etiqueta}] forma`);
  assert.deepStrictEqual(Object.keys(b.error).sort(), ['codigo', 'mensaje', 'request_id'], `[${etiqueta}] forma del error`);
  assert.strictEqual(b.error.codigo, codigo, `[${etiqueta}] codigo`);
  assert.strictEqual(b.error.request_id, r.headers['x-request-id'], `[${etiqueta}] request_id del cuerpo = header`);
  assert.match(b.error.request_id, UUID, `[${etiqueta}] request_id generado por el servidor`);
  assert.strictEqual(r.headers['cache-control'], 'no-store', `[${etiqueta}] no-store`);
  return b;
}

(async () => {
  const emisor = await crearEmisorPrueba();
  let verificaciones = 0;
  const verificadorReal = crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: emisor.localJWKSet });
  const verificador = {
    verificar: (t) => {
      verificaciones++;
      return verificadorReal.verificar(t);
    }
  };
  const token = async (claims) => {
    const t = await emisor.firmar(claims);
    TOKENS.push(t);
    return t;
  };
  const bearer = async (claims) => ({ Authorization: `Bearer ${await token(claims)}` });

  const { llamar, cerrar } = await levantar({ env: envDe(), verificador });
  try {
    // ============================================================
    // 1) /sesion exige un token válido (sin autorización previa)
    // ============================================================
    {
      const sinToken = await llamar('GET', '/api/panel/sesion');
      assertError(sinToken, 401, 'no_autenticado', 'sin token');
      assert.strictEqual(sinToken.headers['www-authenticate'], 'Bearer');
      const t = await token();
      const formatos = [
        ['Basic', { Authorization: 'Basic dXN1YXJpbzpjbGF2ZQ==' }],
        ['bearer en minúscula', { Authorization: `bearer ${t}` }],
        ['Bearer sin token', { Authorization: 'Bearer' }],
        ['doble espacio', { Authorization: `Bearer  ${t}` }],
        ['dos tokens', { Authorization: `Bearer ${t} ${t}` }],
        // (Un espacio FINAL no se prueba: el parser HTTP lo quita del valor, RFC 9110.)
        ['otro esquema', { Authorization: `Token ${t}` }],
        ['vencido', await bearer({ exp: Math.floor(Date.now() / 1000) - 300 })],
        ['audiencia ajena', await bearer({ aud: '999-otra.apps.googleusercontent.com' })],
        ['email no verificado', await bearer({ email_verified: false })]
      ];
      for (const [nombre, headers] of formatos) assertError(await llamar('GET', '/api/panel/sesion', headers), 401, 'no_autenticado', nombre);

      const antes = verificaciones;
      const largo = 'a'.repeat(4200);
      assertError(await llamar('GET', '/api/panel/sesion', { Authorization: `Bearer ${largo}.${largo}.${largo}` }), 401, 'no_autenticado', 'header > 4 KB');
      assert.strictEqual(verificaciones, antes, 'un header de más de 4 KB no llega al verificador');
      console.log(`1) /sesion: sin token y ${formatos.length + 1} formatos/tokens inválidos → 401 (WWW-Authenticate: Bearer); header > 4 KB rechazado sin verificar: OK`);
    }

    // ============================================================
    // 2) /sesion con token válido: identidad propia, autorizado o no
    // ============================================================
    {
      const desconocido = await llamar('GET', '/api/panel/sesion', await bearer({ sub: '9999', email: 'nuevo@example.com' }));
      assert.strictEqual(desconocido.status, 200);
      assert.strictEqual(desconocido.headers['cache-control'], 'no-store');
      assert.deepStrictEqual(cuerpo(desconocido), {
        identidad: { proveedor: 'google', sub: '9999', email: 'nuevo@example.com', email_verificado: true },
        autorizado: false,
        identificador: null,
        permisos: []
      });

      const autorizado = await llamar('GET', '/api/panel/sesion', await bearer());
      assert.deepStrictEqual(cuerpo(autorizado), {
        identidad: { proveedor: 'google', sub: '1000', email: 'operador@example.com', email_verificado: true },
        autorizado: true,
        identificador: 'operador.panel',
        permisos: ['ver', 'decidir']
      });

      // La identidad sale SOLO del token: body, query y headers extra se ignoran.
      const intento = await llamar(
        'GET',
        '/api/panel/sesion?sub=1000&identificador=operador.panel',
        { ...(await bearer({ sub: '9999' })), 'X-Operador': 'operador.panel', 'X-Sub': '1000', 'Content-Type': 'application/json' },
        JSON.stringify({ sub: '1000', actor: { tipo: 'humano', identificador: 'operador.panel' }, operador: { permisos: ['ver', 'decidir'] } })
      );
      assert.strictEqual(intento.status, 200);
      assert.deepStrictEqual([cuerpo(intento).identidad.sub, cuerpo(intento).autorizado, cuerpo(intento).permisos], ['9999', false, []]);
      console.log('2) /sesion con token válido: sub desconocido → autorizado:false sin propuestas; operador → permisos; body/query/headers con identidad ignorados: OK');
    }

    // ============================================================
    // 3) El resto del panel exige autenticación + autorización + permiso
    // ============================================================
    {
      for (const ruta of ['/api/panel/propuestas', '/api/panel/propuestas/x', '/api/panel/cualquier-cosa']) {
        assertError(await llamar('GET', ruta), 401, 'no_autenticado', `${ruta} sin token`);
        assertError(await llamar('GET', ruta, await bearer({ sub: '9999' })), 403, 'no_autorizado', `${ruta} fuera de la lista`);
        assertError(await llamar('GET', ruta, await bearer({ sub: '2000' })), 403, 'sin_permiso', `${ruta} sin permiso ver`);
        assertError(await llamar('GET', ruta, await bearer()), 404, 'no_encontrado', `${ruta} autorizado (todavía no existe)`);
      }
      // POST /sesion no existe: también queda detrás de autenticación.
      assertError(await llamar('POST', '/api/panel/sesion', { 'Content-Type': 'application/json' }, '{}'), 401, 'no_autenticado', 'POST /sesion sin token');
      console.log('3) /propuestas y cualquier otra ruta: sin token 401, fuera de la lista 403, sin permiso "ver" 403, autorizado 404 (bloques 3/4): OK');
    }

    // ============================================================
    // 4) request_id siempre generado por el servidor
    // ============================================================
    {
      const ids = new Set();
      for (let i = 0; i < 5; i++) {
        const r = await llamar('GET', '/api/panel/sesion', { 'X-Request-Id': 'del-cliente-123' });
        assert.match(r.headers['x-request-id'], UUID);
        assert.notStrictEqual(r.headers['x-request-id'], 'del-cliente-123');
        ids.add(r.headers['x-request-id']);
      }
      assert.strictEqual(ids.size, 5, 'un request_id distinto por pedido');
      console.log('4) request_id: UUID nuevo por pedido, el X-Request-Id del cliente se ignora: OK');
    }

    // ============================================================
    // 5) CORS: solo el origen exacto; rechazado → sin Access-Control-Allow-Origin
    // ============================================================
    {
      const pre = await llamar('OPTIONS', '/api/panel/sesion', { Origin: ORIGEN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' });
      assert.strictEqual(pre.status, 204);
      assert.strictEqual(pre.headers['access-control-allow-origin'], ORIGEN);
      assert.match(pre.headers['access-control-allow-methods'], /GET,POST/);
      assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
      assert.strictEqual(pre.headers['access-control-allow-credentials'], undefined);
      assert.strictEqual(pre.headers['cache-control'], 'no-store');

      const ok = await llamar('GET', '/api/panel/sesion', { Origin: ORIGEN, ...(await bearer()) });
      assert.strictEqual(ok.headers['access-control-allow-origin'], ORIGEN);
      assert.match(ok.headers['access-control-expose-headers'], /X-Request-Id/);

      for (const otro of ['https://evil.example', 'https://toctoc-requisitos.vercel.app.evil.example', 'http://toctoc-requisitos.vercel.app', 'null']) {
        const p = await llamar('OPTIONS', '/api/panel/sesion', { Origin: otro, 'Access-Control-Request-Method': 'GET' });
        assertError(p, 403, 'origen_no_permitido', `preflight ${otro}`);
        assert.strictEqual(p.headers['access-control-allow-origin'], undefined, `preflight ${otro}: sin ACAO`);
        const g = await llamar('GET', '/api/panel/sesion', { Origin: otro, ...(await bearer()) });
        assert.strictEqual(g.headers['access-control-allow-origin'], undefined, `GET ${otro}: sin ACAO`);
      }
      // La API pública mantiene su CORS abierto.
      const publica = await llamar('GET', '/api/destinos/zz', { Origin: 'https://evil.example' });
      assert.strictEqual(publica.headers['access-control-allow-origin'], '*');
      console.log('5) CORS: preflight y GET del origen exacto con ACAO; 4 orígenes ajenos (incluido sufijo y http) sin ACAO y preflight 403; API pública intacta: OK');
    }

    // ============================================================
    // 6) Body: solo JSON y como máximo 8 KB
    // ============================================================
    {
      const auth = await bearer();
      assertError(await llamar('POST', '/api/panel/propuestas', { ...auth, 'Content-Type': 'text/plain' }, 'hola'), 415, 'tipo_no_soportado', 'text/plain');
      assertError(await llamar('POST', '/api/panel/propuestas', auth, '{}'), 415, 'tipo_no_soportado', 'sin Content-Type');
      assertError(await llamar('POST', '/api/panel/propuestas', { ...auth, 'Content-Type': 'application/json' }, JSON.stringify({ x: 'y'.repeat(8300) })), 413, 'cuerpo_demasiado_grande', '> 8 KB');
      assertError(await llamar('POST', '/api/panel/propuestas', { ...auth, 'Content-Type': 'application/json' }, '{"x":'), 400, 'json_invalido', 'JSON roto');
      assertError(await llamar('POST', '/api/panel/propuestas', { ...auth, 'Content-Type': 'application/json' }, '"texto"'), 400, 'json_invalido', 'JSON no objeto (strict)');
      // Dentro del límite: llega a la autorización y, como no existe, 404.
      assertError(await llamar('POST', '/api/panel/propuestas', { ...auth, 'Content-Type': 'application/json' }, JSON.stringify({ x: 'y'.repeat(7000) })), 404, 'no_encontrado', '7 KB');
      console.log('6) body: text/plain o sin tipo 415, > 8 KB 413, JSON roto/no estricto 400, 7 KB pasa: OK');
    }
  } finally {
    await cerrar();
  }

  // ============================================================
  // 7) Configuración ausente o inválida → todo el panel 503, sin verificar
  // ============================================================
  {
    const invalidas = [
      ['sin variables', {}],
      ['sin GOOGLE_CLIENT_ID', envDe({ GOOGLE_CLIENT_ID: undefined })],
      ['client ID inválido', envDe({ GOOGLE_CLIENT_ID: 'x' })],
      ['OPERADORES_PANEL_JSON ausente', envDe({ OPERADORES_PANEL_JSON: undefined })],
      ['OPERADORES_PANEL_JSON inválido', envDe({ OPERADORES_PANEL_JSON: '[{' })],
      ['origen con ruta', envDe({ PANEL_ORIGENES_PERMITIDOS: `${ORIGEN}/panel.html` })]
    ];
    for (const [nombre, env] of invalidas) {
      const antes = verificaciones;
      const { llamar: l, cerrar: c } = await levantar({ env, verificador });
      try {
        assertError(await l('GET', '/api/panel/sesion', await bearer()), 503, 'no_disponible', `${nombre}: /sesion`);
        assertError(await l('GET', '/api/panel/propuestas', await bearer()), 503, 'no_disponible', `${nombre}: /propuestas`);
        const pre = await l('OPTIONS', '/api/panel/sesion', { Origin: ORIGEN, 'Access-Control-Request-Method': 'GET' });
        assert.strictEqual(pre.headers['access-control-allow-origin'], undefined, `${nombre}: sin CORS`);
        assert.strictEqual(verificaciones, antes, `${nombre}: no verifica tokens`);
        assert.strictEqual((await l('GET', '/api/destinos/zz')).status, 404, `${nombre}: la API pública sigue respondiendo`);
      } finally {
        await c();
      }
    }
    // OPERADORES_PANEL_JSON=[] es válido: /sesion funciona, todo lo demás 403.
    const { llamar: l, cerrar: c } = await levantar({ env: envDe({ OPERADORES_PANEL_JSON: '[]' }), verificador });
    try {
      const s = await l('GET', '/api/panel/sesion', await bearer());
      assert.deepStrictEqual([s.status, cuerpo(s).autorizado, cuerpo(s).identidad.sub], [200, false, '1000']);
      assertError(await l('GET', '/api/panel/propuestas', await bearer()), 403, 'no_autorizado', 'lista vacía');
    } finally {
      await c();
    }
    console.log(`7) ${invalidas.length} configuraciones inválidas → todo /api/panel 503 sin verificar tokens ni CORS, API pública intacta; OPERADORES_PANEL_JSON=[] válido: OK`);
  }

  // ============================================================
  // 8) JWKS inaccesible → 503 (falla cerrado), nunca 200
  // ============================================================
  {
    const caido = http.createServer((req, res) => res.writeHead(500).end());
    await new Promise((r) => caido.listen(0, '127.0.0.1', r));
    const urlJwks = `http://127.0.0.1:${caido.address().port}/certs`;
    const remoto = crearVerificadorGoogle({ clientId: CLIENT_ID, urlJwks, opcionesJwks: { timeoutDuration: 300, cooldownDuration: 30000, cacheMaxAge: 600000 } });
    const { llamar: l, cerrar: c } = await levantar({ env: envDe(), verificador: remoto });
    try {
      assertError(await l('GET', '/api/panel/sesion', await bearer()), 503, 'autenticacion_no_disponible', 'JWKS 500 en /sesion');
      assertError(await l('GET', '/api/panel/propuestas', await bearer()), 503, 'autenticacion_no_disponible', 'JWKS 500 en /propuestas');
    } finally {
      await c();
      await new Promise((r) => caido.close(r));
    }
    console.log('8) JWKS que responde 500 → 503 autenticacion_no_disponible (fallo cerrado): OK');
  }

  // ============================================================
  // 9) Error inesperado → 500 genérico; detalle solo en el registro saneado
  // ============================================================
  {
    const t = await token();
    const roto = {
      verificar: async () => {
        throw new Error(`fallo interno con ${t} y mongodb+srv://u:clave-secreta@cluster.example/db y Bearer ${t}`);
      }
    };
    const { llamar: l, cerrar: c } = await levantar({ env: envDe(), verificador: roto });
    const previos = REGISTROS.length;
    try {
      // Un error no clasificado es inesperado: 500, sin autenticar (falla cerrado).
      const r = await l('GET', '/api/panel/sesion', { Authorization: `Bearer ${t}` });
      const b = assertError(r, 500, 'error_interno', 'error genérico del verificador');
      assert.strictEqual(b.error.mensaje, 'Error interno.');
      const reg = REGISTROS.slice(previos).find((e) => e.evento === 'panel_error');
      assert.strictEqual(reg.status, 500);
      assert.match(reg.error, /<jwt-redactado>/);
      assert.match(reg.error, /<uri-mongodb-redactada>/);
      assert.match(reg.error, /Bearer <redactado>/);
    } finally {
      await c();
    }
    // Un error inesperado fuera del verificador (p. ej. en autorizar) → 500.
    const { manejarErroresPanel } = require('../middleware/panel');
    const capturados = [];
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(s) { this.s = s; return this; }, json(b) { this.b = b; } };
    manejarErroresPanel((e) => capturados.push(e))(new Error(`explotó con ${t} mongodb://u:clave-secreta@h/x`), { requestId: 'r-1', method: 'GET', baseUrl: '/api/panel', path: '/x' }, res);
    assert.strictEqual(res.s, 500);
    assert.deepStrictEqual(res.b, { error: { codigo: 'error_interno', mensaje: 'Error interno.', request_id: 'r-1' } });
    assert.match(capturados[0].error, /<jwt-redactado>/);
    assert.match(capturados[0].error, /<uri-mongodb-redactada>/);
    REGISTROS.push(...capturados);
    OBSERVADO.push(JSON.stringify(res.b));
    console.log('9) error con token/URI en el mensaje: respuesta con mensaje fijo; el registro conserva el detalle saneado: OK');
  }

  // ============================================================
  // 10) req.operador: lo construye y congela el servidor
  // ============================================================
  {
    const operadores = cargarOperadoresPanel(JSON.stringify(OPERADORES));
    const req = {
      identidadVerificada: Object.freeze({ proveedor: 'google', iss: 'https://accounts.google.com', sub: '1000', email: 'operador@example.com', email_verificado: true }),
      body: { actor: { tipo: 'humano', identificador: 'intruso' }, operador: { identificador: 'intruso', permisos: ['decidir'] } },
      headers: { 'x-operador': 'intruso' }
    };
    let siguiente = false;
    crearAutorizar(operadores, 'ver')(req, {}, () => (siguiente = true));
    assert.ok(siguiente);
    assert.strictEqual(req.operador.identificador, 'operador.panel', 'del token + allowlist, no del body');
    assert.ok(Object.isFrozen(req.operador) && Object.isFrozen(req.operador.actor) && Object.isFrozen(req.operador.permisos) && Object.isFrozen(req.operador.identidad_operador));
    const d = Object.getOwnPropertyDescriptor(req, 'operador');
    assert.deepStrictEqual([d.writable, d.configurable], [false, false], 'no reasignable');
    assert.throws(() => {
      'use strict';
      req.operador = { identificador: 'intruso' };
    }, TypeError);
    assert.throws(() => {
      'use strict';
      req.operador.permisos.push('aplicar');
    }, TypeError);
    // Sin identidad verificada (autorizar sin autenticar) → 403.
    assert.throws(() => crearAutorizar(operadores, 'ver')({ body: { operador: {} } }, {}, () => {}), (e) => e.status === 403 && e.codigo === 'no_autorizado');
    // autenticar también fija identidadVerificada como no escribible.
    const reqA = { headers: { authorization: `Bearer ${await token()}` } };
    await crearAutenticar(verificador)(reqA, {}, () => {});
    assert.strictEqual(Object.getOwnPropertyDescriptor(reqA, 'identidadVerificada').writable, false);
    console.log('10) req.operador construido desde token + allowlist, congelado en profundidad y no reasignable; body/headers con identidad ignorados; sin identidad → 403: OK');
  }

  // ============================================================
  // 11) Ningún token, JWT, URI ni credencial en respuestas o registros
  // ============================================================
  {
    const texto = [...OBSERVADO, ...REGISTROS.map((r) => JSON.stringify(r))].join('\n');
    assert.ok(REGISTROS.length > 40, `registros: ${REGISTROS.length}`);
    assert.ok(!/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(texto), 'sin JWT');
    assert.ok(!/Bearer [A-Za-z0-9]/.test(texto), 'sin Bearer con credencial');
    assert.ok(!/mongodb(\+srv)?:\/\/[^<]/.test(texto), 'sin URIs de Mongo');
    assert.ok(!texto.includes('clave-secreta'), 'sin contraseñas');
    for (const t of TOKENS) for (const seg of t.split('.')) assert.ok(!texto.includes(seg), 'sin segmentos de tokens');
    // Los registros de error traen lo necesario para diagnosticar.
    const errores = REGISTROS.filter((r) => r.evento === 'panel_error');
    assert.ok(errores.every((e) => UUID.test(e.request_id) || e.request_id === 'r-1'));
    assert.ok(errores.every((e) => typeof e.ruta === 'string' && !e.ruta.includes('?')), 'ruta sin query string');
    console.log(`11) ${OBSERVADO.length} piezas de respuesta y ${REGISTROS.length} registros: 0 tokens, 0 JWT, 0 URIs, 0 credenciales; rutas sin query: OK`);
  }

  console.log('\nTodas las pruebas de los middlewares del panel pasaron (solo 127.0.0.1).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
