// Ayudante SOLO para pruebas: genera un par de claves RS256 propio y firma
// ID tokens con la forma de los de Google. Nada sale de la máquina: el JWKS
// es local (createLocalJWKSet) o se sirve desde un servidor en 127.0.0.1.

const CLIENT_ID = '123456789012-pruebaclienteid.apps.googleusercontent.com';

async function crearEmisorPrueba({ kid = 'prueba-1' } = {}) {
  const jose = await import('jose');
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = { keys: [jwk] };

  // claims: se mezclan con los de un token válido; un valor `undefined`
  // elimina ese claim. opciones.header se mezcla con el encabezado.
  async function firmar(claims = {}, { header = {}, clave = privateKey, alg = 'RS256' } = {}) {
    const ahora = Math.floor(Date.now() / 1000);
    const base = {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: '1000',
      email: 'operador@example.com',
      email_verified: true,
      iat: ahora,
      exp: ahora + 600
    };
    const payload = { ...base, ...claims };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const encabezado = { alg, kid, ...header };
    for (const k of Object.keys(encabezado)) if (encabezado[k] === undefined) delete encabezado[k];
    return new jose.SignJWT(payload).setProtectedHeader(encabezado).sign(clave);
  }

  return { jose, jwk, jwks, localJWKSet: jose.createLocalJWKSet(jwks), privateKey, firmar };
}

module.exports = { CLIENT_ID, crearEmisorPrueba };
