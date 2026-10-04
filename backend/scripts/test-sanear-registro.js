// Pruebas offline del saneo de registros y errores (utils/sanear-registro.js).
//
// Uso: node scripts/test-sanear-registro.js

const assert = require('assert');
const { LARGO_MAXIMO, sanearTexto, sanearValor, crearRegistrador } = require('../utils/sanear-registro');

const JWT = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiIxMDAwIn0.c2lnbmF0dXJhLWRlLXBydWViYQ';
const SECRETOS = [JWT, 'clave-super-secreta', 'abc123token', 'eyJhbGciOiJSUzI1NiJ9', 'c2lnbmF0dXJhLWRlLXBydWViYQ'];

// ============================================================
// 1) Texto
// ============================================================
{
  const casos = [
    [`Authorization: Bearer ${JWT}`, ['Authorization: <redactado>']],
    [`Bearer ${JWT}`, ['Bearer <redactado>']],
    ['Authorization: abc123token', ['Authorization: <redactado>']],
    [`token suelto ${JWT} al final`, ['<jwt-redactado>']],
    [`JWS sin payload legible eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJhLWRlLXBydWViYQ`, ['<jwt-redactado>']],
    ['Basic dXN1YXJpbzpjbGF2ZS1zdXBlci1zZWNyZXRh', ['Basic <redactado>']],
    ['falló mongodb+srv://usuario:clave-super-secreta@cluster.example.net/db?x=1', ['<uri-mongodb-redactada>']],
    ['proxy https://usuario:clave-super-secreta@proxy.example/x', ['https://<credenciales-redactadas>@proxy.example/x']],
    ['password=clave-super-secreta y token: abc123token', ['password=<redactado>', 'token: <redactado>']],
    ['{"id_token":"abc123token","client_secret":"clave-super-secreta"}', ['"id_token":<redactado>', '"client_secret":<redactado>']]
  ];
  for (const [entrada, esperados] of casos) {
    const s = sanearTexto(entrada);
    for (const x of SECRETOS) assert.ok(!s.includes(x), `"${s}" contiene un secreto`);
    for (const e of esperados) assert.ok(s.includes(e), `"${s}" debería contener ${e}`);
  }
  // Lo que no es secreto se conserva.
  assert.strictEqual(sanearTexto('GET /api/panel/sesion 401 no_autenticado'), 'GET /api/panel/sesion 401 no_autenticado');
  assert.strictEqual(sanearTexto('https://www.gov.uk/api/content/eta'), 'https://www.gov.uk/api/content/eta');
  assert.strictEqual(sanearTexto(null), '');
  assert.strictEqual(sanearTexto('x'.repeat(LARGO_MAXIMO + 50)).length, LARGO_MAXIMO + 1, 'recorta con …');
  console.log(`1) ${casos.length} formas de secreto (Bearer, JWT/JWS, Basic, URI Mongo, userinfo, clave=valor, JSON) redactadas; texto común intacto; recorte: OK`);
}

// ============================================================
// 2) Objetos, errores y registrador
// ============================================================
{
  const v = sanearValor({
    authorization: `Bearer ${JWT}`,
    headers: { cookie: 'sesion=abc123token', 'x-otro': 'visible' },
    error: new Error(`fallo con ${JWT}`),
    lista: [`mongodb://u:clave-super-secreta@h/db`, 3, null],
    uri: 'https://visible.example'
  });
  assert.strictEqual(v.authorization, '<redactado>');
  assert.strictEqual(v.headers.cookie, '<redactado>');
  assert.strictEqual(v.headers['x-otro'], 'visible');
  assert.deepStrictEqual(v.error, { nombre: 'Error', mensaje: 'fallo con <jwt-redactado>' });
  assert.deepStrictEqual(v.lista, ['<uri-mongodb-redactada>', 3, null]);
  assert.strictEqual(v.uri, '<redactado>', 'clave "uri" siempre redactada');

  const lineas = [];
  const registrar = crearRegistrador((l) => lineas.push(l));
  registrar({ evento: 'prueba', detalle: `Bearer ${JWT}`, motivo: 'claim_aud' });
  assert.strictEqual(lineas.length, 1);
  const r = JSON.parse(lineas[0]);
  assert.strictEqual(r.evento, 'prueba');
  assert.strictEqual(r.motivo, 'claim_aud');
  assert.ok(!lineas[0].includes(JWT) && /^\d{4}-\d{2}-\d{2}T/.test(r.en));
  console.log('2) objetos (claves secretas, errores, listas) y registrador JSON de una línea saneados: OK');
}

console.log('\nTodas las pruebas de saneo de registros pasaron (offline).');
