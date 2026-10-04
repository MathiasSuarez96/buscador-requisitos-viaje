/**
 * Verificación de ID tokens de Google (OIDC) para el panel de propuestas.
 *
 * Validación estricta, todo en el servidor:
 *  - tamaño: hasta LARGO_MAXIMO_TOKEN bytes y forma JWS compacta, antes de
 *    analizar nada;
 *  - firma: solo RS256, con `kid` presente y una clave del JWKS de Google;
 *  - iss: exactamente https://accounts.google.com o accounts.google.com;
 *  - aud: exactamente el client ID del panel (string, no lista); si viene
 *    `azp`, también tiene que ser el client ID;
 *  - exp / nbf / iat: con tolerancia de reloj TOLERANCIA_SEG; iat en el
 *    futuro (más allá de la tolerancia) se rechaza;
 *  - sub y email: strings no vacíos; email_verified === true (booleano).
 *
 * JWKS remoto (createRemoteJWKSet de jose) con timeout, cooldown y caché.
 * Falla CERRADO: si las claves no se pueden obtener (timeout, error de red,
 * respuesta no 200, JSON inválido) se lanza ErrorAutenticacionNoDisponible
 * y nunca se acepta el token.
 *
 * jose 6 es solo ESM: se carga con import() dinámico desde CommonJS, una
 * sola vez y bajo demanda.
 *
 * Ningún mensaje de error incluye el token ni partes de él.
 */

const URL_JWKS_GOOGLE = 'https://www.googleapis.com/oauth2/v3/certs';
const EMISORES_GOOGLE = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);
const LARGO_MAXIMO_TOKEN = 4096;
const TOLERANCIA_SEG = 30;
const OPCIONES_JWKS = Object.freeze({ timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 10 * 60 * 1000 });
const FORMA_JWS_COMPACTA = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CLIENT_ID_GOOGLE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

// 401: el token no autentica (formato, firma, claims, vencido…).
class ErrorTokenInvalido extends Error {
  constructor(motivo) {
    super(`Token inválido (${motivo}).`);
    this.motivo = motivo;
  }
}
// 503: no se pudo verificar (JWKS inaccesible). Nunca se acepta el token.
class ErrorAutenticacionNoDisponible extends Error {
  constructor(motivo) {
    super(`No se pudo verificar la autenticación (${motivo}).`);
    this.motivo = motivo;
  }
}

let josePromesa = null;
const cargarJose = () => (josePromesa ??= import('jose'));

// Códigos de jose que significan "no se pudieron obtener las claves".
const CODIGOS_JWKS_NO_DISPONIBLE = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

function clasificarErrorJose(err) {
  if (err instanceof ErrorTokenInvalido || err instanceof ErrorAutenticacionNoDisponible) return err;
  const code = err?.code;
  if (CODIGOS_JWKS_NO_DISPONIBLE.has(code)) return new ErrorAutenticacionNoDisponible(code === 'ERR_JWKS_TIMEOUT' ? 'jwks_timeout' : 'jwks_invalido');
  if (typeof code === 'string' && code.startsWith('ERR_J')) {
    // Respuesta HTTP no 200 del JWKS: jose la informa como JOSEError genérico.
    if (code === 'ERR_JOSE_GENERIC') return new ErrorAutenticacionNoDisponible('jwks_respuesta');
    const motivos = {
      ERR_JWT_EXPIRED: 'vencido',
      ERR_JWT_CLAIM_VALIDATION_FAILED: `claim_${err.claim ?? 'invalido'}`,
      ERR_JWS_SIGNATURE_VERIFICATION_FAILED: 'firma',
      ERR_JOSE_ALG_NOT_ALLOWED: 'algoritmo',
      ERR_JWKS_NO_MATCHING_KEY: 'clave_desconocida',
      ERR_JWKS_MULTIPLE_MATCHING_KEYS: 'clave_ambigua',
      ERR_JWS_INVALID: 'formato',
      ERR_JWT_INVALID: 'formato'
    };
    return new ErrorTokenInvalido(motivos[code] ?? 'rechazado');
  }
  // Cualquier otro error (red, fetch, import de jose…): falla cerrado.
  return new ErrorAutenticacionNoDisponible('verificador');
}

// opciones: { clientId (obligatorio), jwks?: resolvedor de claves de jose
// (pruebas: createLocalJWKSet), urlJwks?, opcionesJwks?, toleranciaSeg?,
// ahora?: () => Date }
function crearVerificadorGoogle(opciones = {}) {
  const { clientId, jwks = null, urlJwks = URL_JWKS_GOOGLE, opcionesJwks = OPCIONES_JWKS, toleranciaSeg = TOLERANCIA_SEG, ahora = () => new Date() } = opciones;
  if (typeof clientId !== 'string' || !CLIENT_ID_GOOGLE.test(clientId)) {
    throw new TypeError('crearVerificadorGoogle: clientId con forma de client ID de Google es obligatorio.');
  }
  let resolvedor = jwks;

  async function verificar(token) {
    if (typeof token !== 'string' || token === '') throw new ErrorTokenInvalido('ausente');
    if (Buffer.byteLength(token, 'utf8') > LARGO_MAXIMO_TOKEN) throw new ErrorTokenInvalido('demasiado_largo');
    if (!FORMA_JWS_COMPACTA.test(token)) throw new ErrorTokenInvalido('formato');

    let resultado;
    try {
      const jose = await cargarJose();
      let encabezado;
      try {
        encabezado = jose.decodeProtectedHeader(token);
      } catch {
        // decodeProtectedHeader lanza TypeError ante un encabezado ilegible: es
        // un token mal formado (401), no una falla del verificador (503).
        throw new ErrorTokenInvalido('formato');
      }
      if (encabezado.alg !== 'RS256') throw new ErrorTokenInvalido('algoritmo');
      if (typeof encabezado.kid !== 'string' || encabezado.kid === '') throw new ErrorTokenInvalido('sin_kid');
      resolvedor ??= jose.createRemoteJWKSet(new URL(urlJwks), opcionesJwks);
      resultado = await jose.jwtVerify(token, resolvedor, {
        algorithms: ['RS256'],
        issuer: [...EMISORES_GOOGLE],
        audience: clientId,
        clockTolerance: toleranciaSeg,
        currentDate: ahora(),
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'email_verified']
      });
    } catch (err) {
      throw clasificarErrorJose(err);
    }

    const p = resultado.payload;
    const ahoraSeg = Math.floor(ahora().getTime() / 1000);
    if (p.aud !== clientId) throw new ErrorTokenInvalido('claim_aud');
    if (p.azp !== undefined && p.azp !== clientId) throw new ErrorTokenInvalido('claim_azp');
    if (typeof p.iat !== 'number' || p.iat > ahoraSeg + toleranciaSeg) throw new ErrorTokenInvalido('claim_iat');
    if (typeof p.sub !== 'string' || p.sub === '' || p.sub.length > 255) throw new ErrorTokenInvalido('claim_sub');
    if (typeof p.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(p.email) || p.email.length > 320) throw new ErrorTokenInvalido('claim_email');
    if (p.email_verified !== true) throw new ErrorTokenInvalido('email_no_verificado');

    return Object.freeze({ proveedor: 'google', iss: p.iss, sub: p.sub, email: p.email, email_verificado: true });
  }

  return Object.freeze({ verificar });
}

module.exports = {
  URL_JWKS_GOOGLE,
  EMISORES_GOOGLE,
  LARGO_MAXIMO_TOKEN,
  TOLERANCIA_SEG,
  OPCIONES_JWKS,
  CLIENT_ID_GOOGLE,
  ErrorTokenInvalido,
  ErrorAutenticacionNoDisponible,
  crearVerificadorGoogle,
  cargarJose
};
