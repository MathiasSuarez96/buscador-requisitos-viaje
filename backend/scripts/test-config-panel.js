// Pruebas offline de la configuración del panel: OPERADORES_PANEL_JSON,
// GOOGLE_CLIENT_ID, PANEL_ORIGENES_PERMITIDOS y la resolución del operador.
//
// Uso: node scripts/test-config-panel.js

const assert = require('assert');

const { CLIENT_ID } = require('./lib/tokens-prueba');
const { COMANDO_PANEL, ErrorConfiguracionPanel, cargarOperadoresPanel, resolverOperadorPanel } = require('../services/panel/operadores-panel');
const { validarResolucionIdentidad } = require('../services/propuestas/decidir-propuesta');
const { cargarConfigPanel } = require('../services/panel/config-panel');

const OP = { proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] };
const json = (v) => JSON.stringify(v);
const ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  OPERADORES_PANEL_JSON: json([OP]),
  PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app'
};

function falla(fn, etiqueta, noDebeContener = []) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ErrorConfiguracionPanel, `[${etiqueta}] se esperaba ErrorConfiguracionPanel, llegó ${err?.constructor?.name}: ${err?.message}`);
  for (const x of noDebeContener) assert.ok(!err.message.includes(x), `[${etiqueta}] el mensaje repite un valor: ${err.message}`);
  return err;
}

// ============================================================
// 1) OPERADORES_PANEL_JSON
// ============================================================
{
  assert.deepStrictEqual(cargarOperadoresPanel('[]'), [], '[] es válido');
  const ops = cargarOperadoresPanel(json([OP, { ...OP, sub: '2000', email: 'otro@example.com', identificador: 'otro', permisos: ['ver'] }]));
  assert.strictEqual(ops.length, 2);
  assert.ok(Object.isFrozen(ops) && Object.isFrozen(ops[0]) && Object.isFrozen(ops[0].permisos), 'congelada en profundidad');

  const SECRETO = 'valor-que-no-debe-repetirse';
  const invalidos = [
    ['ausente', undefined],
    ['vacía', '  '],
    ['JSON inválido', `[{${SECRETO}`],
    ['no es array', json({ ...OP })],
    ['entrada null', json([null])],
    ['clave extra', json([{ ...OP, rol: SECRETO }])],
    ['falta permisos', json([{ proveedor: OP.proveedor, sub: OP.sub, email: OP.email, identificador: OP.identificador }])],
    ['proveedor no soportado', json([{ ...OP, proveedor: 'github' }])],
    ['sub con espacios', json([{ ...OP, sub: ' 1000' }])],
    ['sub demasiado largo', json([{ ...OP, sub: '1'.repeat(256) }])],
    ['email inválido', json([{ ...OP, email: 'operador' }])],
    ['identificador vacío', json([{ ...OP, identificador: '' }])],
    ['permisos vacío', json([{ ...OP, permisos: [] }])],
    ['permiso desconocido', json([{ ...OP, permisos: ['ver', 'aplicar'] }])],
    ['permisos repetidos', json([{ ...OP, permisos: ['ver', 'ver'] }])],
    ['permisos no array', json([{ ...OP, permisos: 'ver' }])],
    ['sub duplicado', json([OP, { ...OP, identificador: 'otro' }])],
    ['identificador duplicado', json([OP, { ...OP, sub: '2000' }])]
  ];
  for (const [nombre, texto] of invalidos) falla(() => cargarOperadoresPanel(texto), nombre, [SECRETO]);
  console.log(`1) OPERADORES_PANEL_JSON: [] válido; lista congelada; ${invalidos.length} formas inválidas → ErrorConfiguracionPanel sin repetir valores: OK`);
}

// ============================================================
// 2) Resolución del operador: por proveedor + sub, construido acá
// ============================================================
{
  const ops = cargarOperadoresPanel(json([OP]));
  const identidad = { proveedor: 'google', iss: 'https://accounts.google.com', sub: '1000', email: 'operador@example.com', email_verificado: true };
  const op = resolverOperadorPanel(identidad, ops);
  assert.deepStrictEqual(op, {
    identificador: 'operador.panel',
    permisos: ['ver', 'decidir'],
    actor: { tipo: 'humano', identificador: 'operador.panel' },
    identidad_operador: { metodo: 'oidc_google', sub: '1000', email: 'operador@example.com' },
    comando: { nombre: 'panel-propuestas', version: '1' }
  });
  assert.ok(Object.isFrozen(op) && Object.isFrozen(op.actor) && Object.isFrozen(op.identidad_operador) && Object.isFrozen(op.permisos) && Object.isFrozen(op.comando));
  assert.deepStrictEqual(COMANDO_PANEL, { nombre: 'panel-propuestas', version: '1' });
  assert.ok(Object.isFrozen(COMANDO_PANEL), 'COMANDO_PANEL congelado');
  assert.notStrictEqual(op.comando, COMANDO_PANEL, 'copia, no la constante compartida');
  // El operador cumple la forma que exige decidirPropuesta.
  assert.doesNotThrow(() => validarResolucionIdentidad(op));
  assert.notStrictEqual(op.permisos, ops[0].permisos, 'permisos copiados, no compartidos con la lista');

  assert.strictEqual(resolverOperadorPanel({ ...identidad, sub: '9999' }, ops), null, 'mismo email, otro sub → no autoriza');
  assert.strictEqual(resolverOperadorPanel({ ...identidad, proveedor: 'otro' }, ops), null);
  assert.strictEqual(resolverOperadorPanel({ ...identidad, email_verificado: false }, ops), null);
  assert.strictEqual(resolverOperadorPanel(null, ops), null);
  assert.strictEqual(resolverOperadorPanel(identidad, []), null, 'lista vacía → nadie autorizado');
  // El email de la evidencia es el del token verificado, no el de la lista.
  assert.strictEqual(resolverOperadorPanel({ ...identidad, email: 'nuevo@example.com' }, ops).identidad_operador.email, 'nuevo@example.com');
  console.log('2) operador resuelto por proveedor+sub (no por email), congelado en profundidad, metodo oidc_google, comando panel-propuestas y forma aceptada por decidirPropuesta; email/proveedor/sub ajenos o lista vacía → null: OK');
}

// ============================================================
// 3) cargarConfigPanel: todo o nada
// ============================================================
{
  const c = cargarConfigPanel(ENV);
  assert.strictEqual(c.clientId, CLIENT_ID);
  assert.deepStrictEqual(c.origenes, ['https://toctoc-requisitos.vercel.app']);
  assert.strictEqual(c.operadores.length, 1);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.origenes));
  assert.deepStrictEqual(cargarConfigPanel({ ...ENV, OPERADORES_PANEL_JSON: '[]' }).operadores, [], 'lista vacía válida');
  assert.deepStrictEqual(
    cargarConfigPanel({ ...ENV, PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app, http://localhost:5173' }).origenes,
    ['https://toctoc-requisitos.vercel.app', 'http://localhost:5173']
  );

  const invalidas = [
    ['sin GOOGLE_CLIENT_ID', { ...ENV, GOOGLE_CLIENT_ID: undefined }],
    ['GOOGLE_CLIENT_ID con otra forma', { ...ENV, GOOGLE_CLIENT_ID: 'mi-app' }],
    ['GOOGLE_CLIENT_ID con sufijo extra', { ...ENV, GOOGLE_CLIENT_ID: `${CLIENT_ID}.evil.example` }],
    ['sin OPERADORES_PANEL_JSON', { ...ENV, OPERADORES_PANEL_JSON: undefined }],
    ['OPERADORES_PANEL_JSON inválido', { ...ENV, OPERADORES_PANEL_JSON: 'x' }],
    ['sin orígenes', { ...ENV, PANEL_ORIGENES_PERMITIDOS: undefined }],
    ['origen con barra final', { ...ENV, PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app/' }],
    ['origen con ruta', { ...ENV, PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app/panel.html' }],
    ['origen http no local', { ...ENV, PANEL_ORIGENES_PERMITIDOS: 'http://toctoc-requisitos.vercel.app' }],
    ['origen comodín', { ...ENV, PANEL_ORIGENES_PERMITIDOS: '*' }],
    ['origen vacío en la lista', { ...ENV, PANEL_ORIGENES_PERMITIDOS: 'https://toctoc-requisitos.vercel.app,' }],
    ['orígenes repetidos', { ...ENV, PANEL_ORIGENES_PERMITIDOS: 'https://a.example,https://a.example' }]
  ];
  for (const [nombre, env] of invalidas) falla(() => cargarConfigPanel(env), nombre, ['toctoc-requisitos', 'mi-app', 'evil']);
  console.log(`3) configuración completa válida (incluida la lista vacía y http://localhost); ${invalidas.length} configuraciones inválidas → ErrorConfiguracionPanel sin repetir valores: OK`);
}

console.log('\nTodas las pruebas de configuración del panel pasaron (offline).');
