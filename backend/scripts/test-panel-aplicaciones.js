// Prueba local de la ruta de aplicación con identidad OIDC falsa y servicio
// de aplicación fake. No conecta a Mongo, producción ni servicios externos.
const assert = require('assert');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('requiere preload-solo-loopback');
const { crearApp } = require('../app');
const { crearVerificadorGoogle } = require('../services/panel/verificar-token-google');
const { pedir } = require('./lib/http-prueba');
const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');
const { ErrorCuerpoAplicacion, ErrorAplicacionNoAplica, ErrorAplicacionCambio, ErrorAplicacionIncierta, ErrorAplicacionNoDisponible } = require('../services/panel/aplicaciones-propuestas');

const ID = '054d03c8-e9ba-4352-8370-e4f88534f612';
const ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app',
  OPERADORES_PANEL_JSON: JSON.stringify([
    { proveedor: 'google', sub: '5000', email: 'aplicar@example.test', identificador: 'operador.aplicar', permisos: ['ver', 'aplicar'] },
    { proveedor: 'google', sub: '1000', email: 'decidir@example.test', identificador: 'operador.decidir', permisos: ['ver', 'decidir'] },
    { proveedor: 'google', sub: '3000', email: 'ver@example.test', identificador: 'operador.ver', permisos: ['ver'] },
    { proveedor: 'google', sub: '2000', email: 'sin_ver@example.test', identificador: 'operador.sin_ver', permisos: ['aplicar'] }
  ])
};
const llamadas = [];
const registros = [];
let falloAplicacion = null;
const aplicacion = { propuesta_id: ID, resultado: 'exito', destino_modificado: true, estado_propuesta_nuevo: 'aplicada', version_coordinacion_nueva: 8, decision_aprobacion_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612', evento_id: 'e54d03c8-e9ba-4352-8370-e4f88534f612', intento_id: 'f54d03c8-e9ba-4352-8370-e4f88534f612', aplicado_en: '2026-10-13T12:00:00.000Z', ya_aplicada: false };
const servicio = { aplicar: async (...args) => { const keys = Object.keys(args[1] || {}).sort(); if (keys.join('|') !== ['decision_aprobacion_id_esperado', 'estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada'].sort().join('|')) throw new ErrorCuerpoAplicacion('claves'); llamadas.push(args); if (falloAplicacion) throw falloAplicacion; return { aplicacion }; } };
(async () => {
  const emisor = await crearEmisorPrueba();
  const app = crearApp({ panel: { env: ENV, verificador: crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: emisor.localJWKSet }), registrar: e => registros.push(e), aplicaciones: servicio } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const token = async sub => emisor.firmar({ sub, email: ENV.OPERADORES_PANEL_JSON && ({ '5000': 'aplicar@example.test', '1000': 'decidir@example.test', '3000': 'ver@example.test', '2000': 'sin_ver@example.test' }[sub]) });
    const body = { estado_esperado: 'aprobada', payload_hash_esperado: 'a'.repeat(64), version_coordinacion_esperada: 7, decision_aprobacion_id_esperado: 'd54d03c8-e9ba-4352-8370-e4f88534f612' };
    const post = async (sub, valor = body, auth = true) => pedir(port, 'POST', `/api/panel/propuestas/${ID}/aplicacion`, { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${await token(sub)}` } : {}) }, JSON.stringify(valor));
    assert.equal((await post('5000', body, false)).status, 401);
    assert.equal((await post('3000')).status, 403, 'ver sin aplicar no alcanza');
    assert.equal((await post('1000')).status, 403, 'decidir no sustituye aplicar');
    assert.equal((await post('2000')).status, 403, 'aplicar exige ver');
    assert.equal(llamadas.length, 0, 'las autorizaciones fallidas no alcanzan el servicio');
    const invalido = await post('5000', { ...body, actor: 'injected' });
    assert.equal(invalido.status, 400); assert.equal(llamadas.length, 0);
    const ok = await post('5000');
    assert.equal(ok.status, 200);
    const payload = JSON.parse(ok.body);
    assert.deepEqual(payload, { aplicacion });
    assert.deepEqual(Object.keys(llamadas[0][1]).sort(), Object.keys(body).sort());
    assert.equal(llamadas[0][2].identificador, 'operador.aplicar');
    assert.equal(llamadas[0][2].identidad_operador.sub, '5000');
    assert.match(llamadas[0][3], /^[0-9a-f-]{36}$/);
    assert.ok(!/email|sub|payload|evidencia|host|credencial/i.test(ok.body));
    assert.ok(registros.some(e => e.evento === 'panel_aplicacion' && e.origen === 'panel' && e.request_id === llamadas[0][3] && e.intento_id === aplicacion.intento_id && e.evento_id === aplicacion.evento_id));
    falloAplicacion = new ErrorAplicacionNoAplica({ destino_modificado: false, resultado: 'fuente_cambio', estado_propuesta_nuevo: 'revision_requerida', intento_id: 'f54d03c8-e9ba-4352-8370-e4f88534f612' });
    const semantic = await post('5000'); const semanticJson = JSON.parse(semantic.body);
    assert.equal(semantic.status, 422); assert.deepEqual(semanticJson.error.aplicacion, { destino_modificado: false, resultado: 'fuente_cambio', estado_propuesta_nuevo: 'revision_requerida', intento_id: 'f54d03c8-e9ba-4352-8370-e4f88534f612' });
    assert.match(semantic.headers['x-request-id'], /^[0-9a-f-]{36}$/); assert.ok(!semantic.body.includes('NO_MOSTRAR'));
    falloAplicacion = new ErrorAplicacionCambio({ estado: 'aplicada', payload_hash: 'b'.repeat(64), version_coordinacion: 8, decision_aprobacion_id: 'a54d03c8-e9ba-4352-8370-e4f88534f613', ultimo_evento_id: 'e54d03c8-e9ba-4352-8370-e4f88534f612' });
    assert.equal((await post('5000')).status, 409);
    falloAplicacion = new ErrorAplicacionIncierta('f54d03c8-e9ba-4352-8370-e4f88534f612');
    const incierto = await post('5000');
    assert.equal(incierto.status, 500);
    assert.deepStrictEqual(Object.keys(JSON.parse(incierto.body).error).sort(), ['codigo', 'mensaje', 'request_id']);
    assert.ok(registros.some(e => e.evento === 'panel_aplicacion' && e.resultado === 'incierto' && e.intento_id === aplicacion.intento_id));
    falloAplicacion = new ErrorAplicacionNoDisponible();
    assert.equal((await post('5000')).status, 503);
    process.stdout.write('Ruta aplicar: permiso ver+aplicar sin decidir, cuerpo por lista blanca, actor/request_id auditados y respuesta mínima: OK\n');
  } catch (e) { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; }
  finally { server.close(); }
})();
