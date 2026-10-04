/**
 * Saneo de todo texto que el panel escribe en logs o devuelve en errores.
 * Nunca deben salir tokens, JWT, URIs con credenciales ni secretos.
 *
 * Se redactan:
 *  - esquemas de autorización con credencial (Bearer, Basic);
 *  - cualquier JWT o JWS compacto (tres segmentos base64url; el encabezado
 *    de un JOSE siempre empieza con "eyJ");
 *  - URIs de MongoDB completas;
 *  - userinfo (usuario:clave@) de cualquier otra URI;
 *  - pares clave=valor / clave: valor de secretos conocidos.
 * Recorta a LARGO_MAXIMO caracteres.
 *
 * Puro y sin dependencias del proyecto: se puede usar desde cualquier
 * módulo sin registrar modelos.
 */

const LARGO_MAXIMO = 2000;

const PATRONES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redactado>'],
  [/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<jwt-redactado>'],
  [/mongodb(?:\+srv)?:\/\/[^\s'"<>]*/gi, '<uri-mongodb-redactada>'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, '$1<credenciales-redactadas>@'],
  [/\b(password|passwd|pwd|secret|client_secret|token|id_token|access_token|refresh_token|api[_-]?key|authorization)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1$2<redactado>']
];

function sanearTexto(valor) {
  let s = String(valor ?? '');
  for (const [patron, reemplazo] of PATRONES) s = s.replace(patron, reemplazo);
  return s.length > LARGO_MAXIMO ? `${s.slice(0, LARGO_MAXIMO)}…` : s;
}

// Copia profunda con sanearTexto aplicado a cada string (y a los mensajes de
// errores). Claves con nombre de secreto se redactan enteras.
const CLAVES_SECRETAS = /^(authorization|token|id_token|access_token|refresh_token|password|secret|client_secret|cookie|set-cookie|uri|mongodb_uri.*)$/i;

function sanearValor(v, profundidad = 0) {
  if (profundidad > 8) return '<profundidad-excedida>';
  if (v instanceof Error) return { nombre: v.name, mensaje: sanearTexto(v.message) };
  if (typeof v === 'string') return sanearTexto(v);
  if (Array.isArray(v)) return v.map((x) => sanearValor(x, profundidad + 1));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, CLAVES_SECRETAS.test(k) ? '<redactado>' : sanearValor(x, profundidad + 1)]));
  }
  return v;
}

// Registrador de una línea JSON por evento, siempre saneada.
function crearRegistrador(escribir = (linea) => console.error(linea)) {
  return (evento) => escribir(JSON.stringify(sanearValor({ en: new Date().toISOString(), ...evento })));
}

module.exports = { LARGO_MAXIMO, sanearTexto, sanearValor, crearRegistrador };
