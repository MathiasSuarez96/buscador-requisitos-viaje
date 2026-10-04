// Pruebas del verificador de ID tokens de Google. Claves propias y JWKS
// local; el JWKS remoto (caché, timeout, fallo cerrado) se sirve desde un
// servidor HTTP en 127.0.0.1. Nada sale de la máquina.
//
// Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-verificar-token-google.js

const assert = require('assert');
const http = require('http');

const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');
const {
  LARGO_MAXIMO_TOKEN,
  ErrorTokenInvalido,
  ErrorAutenticacionNoDisponible,
  crearVerificadorGoogle
} = require('../services/panel/verificar-token-google');

const MENSAJES = []; // todos los mensajes de error: se revisan al final

async function rechaza(promesa, Clase, motivo, etiqueta) {
  let err = null;
  try {
    await promesa;
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Clase, `[${etiqueta}] se esperaba ${Clase.name}, llegó ${err?.constructor?.name}: ${err?.message}`);
  if (motivo) assert.strictEqual(err.motivo, motivo, `[${etiqueta}] motivo`);
  MENSAJES.push(err.message);
  return err;
}

(async () => {
  const emisor = await crearEmisorPrueba();
  const otroEmisor = await crearEmisorPrueba(); // mismo kid, otra clave
  let consultasJwks = 0;
  const jwksContado = (...args) => {
    consultasJwks++;
    return emisor.localJWKSet(...args);
  };
  const verificador = crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: jwksContado });
  const ahora = Math.floor(Date.now() / 1000);
  const TOKENS = [];
  const firmar = async (...a) => {
    const t = await emisor.firmar(...a);
    TOKENS.push(t);
    return t;
  };

  // ============================================================
  // 1) Token válido → identidad mínima y congelada
  // ============================================================
  {
    const id = await verificador.verificar(await firmar());
    assert.deepStrictEqual(id, { proveedor: 'google', iss: 'https://accounts.google.com', sub: '1000', email: 'operador@example.com', email_verificado: true });
    assert.ok(Object.isFrozen(id));
    const id2 = await verificador.verificar(await firmar({ iss: 'accounts.google.com', azp: undefined }));
    assert.strictEqual(id2.iss, 'accounts.google.com');
    const id3 = await verificador.verificar(await firmar({ exp: ahora - 10 }));
    assert.strictEqual(id3.sub, '1000', 'vencido hace 10 s, dentro de la tolerancia de 30 s');
    console.log('1) token válido (ambos iss de Google, sin azp, tolerancia de reloj) → identidad congelada { proveedor, iss, sub, email, email_verificado }: OK');
  }

  // ============================================================
  // 2) Claims inválidos
  // ============================================================
  const casosClaims = [
    ['vencido', { exp: ahora - 120 }, 'vencido'],
    ['nbf en el futuro', { nbf: ahora + 300 }, 'claim_nbf'],
    ['iat en el futuro', { iat: ahora + 300 }, 'claim_iat'],
    ['aud ajena', { aud: '999-otra.apps.googleusercontent.com' }, 'claim_aud'],
    ['aud como lista con la nuestra', { aud: [CLIENT_ID, 'otra'] }, 'claim_aud'],
    ['azp ajeno', { azp: '999-otra.apps.googleusercontent.com' }, 'claim_azp'],
    ['iss ajeno', { iss: 'https://evil.example' }, 'claim_iss'],
    ['iss http', { iss: 'http://accounts.google.com' }, 'claim_iss'],
    ['sin email_verified', { email_verified: undefined }, 'claim_email_verified'],
    ['email_verified "true" (string)', { email_verified: 'true' }, 'email_no_verificado'],
    ['email_verified false', { email_verified: false }, 'email_no_verificado'],
    ['sin email', { email: undefined }, 'claim_email'],
    ['email sin @', { email: 'operador' }, 'claim_email'],
    ['sin sub', { sub: undefined }, 'claim_sub'],
    ['sub vacío', { sub: '' }, 'claim_sub'],
    ['sin exp', { exp: undefined }, 'claim_exp'],
    ['sin iat', { iat: undefined }, 'claim_iat']
  ];
  for (const [nombre, claims, motivo] of casosClaims) {
    await rechaza(verificador.verificar(await firmar(claims)), ErrorTokenInvalido, motivo, nombre);
  }
  console.log(`2) ${casosClaims.length} claims inválidos (exp/nbf/iat, aud estricta, azp, iss, email_verified booleano, email, sub) → 401 con motivo: OK`);

  // ============================================================
  // 3) Firma, algoritmo, kid y formato
  // ============================================================
  {
    const valido = await firmar();
    const [h, p, s] = valido.split('.');
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const firmaAlterada = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    const payloadAlterado = `${h}.${enc({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: '2000' })}.${s}`;
    const otraClave = await otroEmisor.firmar();
    const secreto = new TextEncoder().encode('secreto-hs256-de-prueba-suficientemente-largo');
    const hs256 = await new emisor.jose.SignJWT({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1000', email: 'a@b.c', email_verified: true, iat: ahora, exp: ahora + 600 })
      .setProtectedHeader({ alg: 'HS256', kid: 'prueba-1' })
      .sign(secreto);
    const none = `${enc({ alg: 'none', kid: 'prueba-1' })}.${p}.`;
    const noneConFirma = `${enc({ alg: 'none', kid: 'prueba-1' })}.${p}.${s}`;
    const ps256 = await (async () => {
      const { privateKey } = await emisor.jose.generateKeyPair('PS256');
      return new emisor.jose.SignJWT({ sub: '1' }).setProtectedHeader({ alg: 'PS256', kid: 'prueba-1' }).sign(privateKey);
    })();
    TOKENS.push(firmaAlterada, payloadAlterado, otraClave, hs256, none, noneConFirma, ps256);
    const casos = [
      ['firma alterada', firmaAlterada, 'firma'],
      ['payload alterado', payloadAlterado, 'firma'],
      ['firmado con otra clave (mismo kid)', otraClave, 'firma'],
      ['HS256 (confusión de algoritmo)', hs256, 'algoritmo'],
      ['alg none sin firma', none, 'formato'],
      ['alg none con firma', noneConFirma, 'algoritmo'],
      ['PS256', ps256, 'algoritmo'],
      ['sin kid', await firmar({}, { header: { kid: undefined } }), 'sin_kid'],
      ['kid desconocido', await firmar({}, { header: { kid: 'otra-clave' } }), 'clave_desconocida'],
      ['encabezado ilegible', `${Buffer.from('no-json').toString('base64url')}.${p}.${s}`, 'formato'],
      ['dos segmentos', `${h}.${p}`, 'formato'],
      ['basura', 'abc', 'formato'],
      ['con espacios', ` ${valido}`, 'formato'],
      ['vacío', '', 'ausente'],
      ['no string', 12345, 'ausente']
    ];
    for (const [nombre, token, motivo] of casos) await rechaza(verificador.verificar(token), ErrorTokenInvalido, motivo, nombre);
    console.log(`3) ${casos.length} tokens con firma/algoritmo/kid/formato inválidos (incluida la confusión HS256 y alg none) → 401: OK`);
  }

  // ============================================================
  // 4) Límite de 4 KB: se rechaza sin consultar el JWKS
  // ============================================================
  {
    const grande = await firmar({ relleno: 'x'.repeat(LARGO_MAXIMO_TOKEN) });
    assert.ok(Buffer.byteLength(grande) > LARGO_MAXIMO_TOKEN);
    const antes = consultasJwks;
    await rechaza(verificador.verificar(grande), ErrorTokenInvalido, 'demasiado_largo', '> 4 KB');
    assert.strictEqual(consultasJwks, antes, 'no se consultó el JWKS');
    console.log(`4) token de ${Buffer.byteLength(grande)} bytes (> ${LARGO_MAXIMO_TOKEN}) → 401 sin consultar el JWKS: OK`);
  }

  // ============================================================
  // 5) JWKS remoto en 127.0.0.1: caché, timeout, respuestas inválidas,
  //    servidor caído → siempre falla cerrado (503)
  // ============================================================
  {
    const estado = { modo: 'ok', pedidos: 0 };
    const servidor = http.createServer((req, res) => {
      estado.pedidos++;
      if (estado.modo === 'lento') return setTimeout(() => res.end(JSON.stringify(emisor.jwks)), 1500);
      if (estado.modo === '500') return res.writeHead(500).end('error');
      if (estado.modo === 'no-json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{no es json');
      if (estado.modo === 'no-jwks') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"x":1}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(emisor.jwks));
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const urlJwks = `http://127.0.0.1:${servidor.address().port}/certs`;
    const remoto = (opciones = {}) =>
      crearVerificadorGoogle({ clientId: CLIENT_ID, urlJwks, opcionesJwks: { timeoutDuration: 300, cooldownDuration: 30000, cacheMaxAge: 600000, ...opciones } });
    try {
      // Caché: dos verificaciones, un solo pedido.
      const v = remoto();
      await v.verificar(await firmar());
      await v.verificar(await firmar({ sub: '2000' }));
      assert.strictEqual(estado.pedidos, 1, 'el JWKS se descargó una sola vez (caché)');

      const casos = [
        ['lento (> timeout)', 'lento', 'jwks_timeout'],
        ['HTTP 500', '500', 'jwks_respuesta'],
        ['JSON inválido', 'no-json', 'jwks_respuesta'],
        ['JSON que no es JWKS', 'no-jwks', 'jwks_invalido']
      ];
      for (const [nombre, modo, motivo] of casos) {
        estado.modo = modo;
        await rechaza(remoto().verificar(await firmar()), ErrorAutenticacionNoDisponible, motivo, nombre);
      }
      estado.modo = 'ok';
    } finally {
      await new Promise((r) => servidor.close(r));
    }
    // Servidor caído (puerto cerrado): error de red → 503, nunca acepta.
    await rechaza(
      crearVerificadorGoogle({ clientId: CLIENT_ID, urlJwks, opcionesJwks: { timeoutDuration: 300, cooldownDuration: 30000, cacheMaxAge: 600000 } }).verificar(await firmar()),
      ErrorAutenticacionNoDisponible,
      'verificador',
      'servidor caído'
    );
    console.log('5) JWKS remoto en 127.0.0.1: caché (1 descarga para 2 tokens); timeout, 500, JSON inválido, no-JWKS y servidor caído → 503 (fallo cerrado): OK');
  }

  // ============================================================
  // 6) Configuración del verificador y errores sin datos del token
  // ============================================================
  {
    for (const clientId of [undefined, '', 'cualquiera', '123-x.apps.googleusercontent.com.evil.example']) {
      assert.throws(() => crearVerificadorGoogle({ clientId }), TypeError, String(clientId));
    }
    assert.ok(MENSAJES.length > 30);
    for (const m of MENSAJES) {
      assert.ok(!/eyJ|\.ey|Bearer/.test(m), `mensaje con datos del token: ${m}`);
      for (const t of TOKENS) {
        for (const segmento of String(t).split('.').filter((x) => x.length > 8)) assert.ok(!m.includes(segmento), `mensaje con un segmento del token: ${m}`);
      }
    }
    console.log(`6) clientId inválido → TypeError; ${MENSAJES.length} mensajes de error sin el token ni partes de él: OK`);
  }

  console.log('\nTodas las pruebas del verificador de Google pasaron (claves propias, JWKS local y en 127.0.0.1).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
