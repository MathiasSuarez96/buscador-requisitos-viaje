/**
 * Allowlist de operadores humanos que pueden aprobar, rechazar o
 * cancelar propuestas, y resolución del actor a partir del usuario de
 * Atlas autenticado en la conexión (connectionStatus).
 *
 * PLAN A — credencial personal: cada operador se conecta con SU propio
 * usuario de base de datos (MONGODB_URI_DECISION), distinto del usuario
 * del backend. La lista vive en OPERADORES_AUTORIZADOS_JSON del .env
 * local (ignorado por git); en el repositorio solo queda esta validación
 * de estructura y un ejemplo ficticio. Forma de cada entrada, sin claves
 * extra:
 *
 *   { "usuario_atlas": "...", "db": "admin", "identificador": "..." }
 *
 * `identificador` es el id lógico que queda en EventoPropuesta.actor.
 *
 * LO QUE ESTO NO ES: ni autenticación fuerte ni no repudio. connectionStatus
 * solo informa qué usuario abrió la conexión. Quien tenga esa credencial
 * puede escribir directamente en propuestas_cambio y eventos_propuesta sin
 * pasar por el servicio, e incluso fabricar un evento con otro actor. Es
 * evidencia OPERATIVA de quién corrió el comando. La identidad autenticada
 * queda para el panel futuro (identidad resuelta por el backend).
 *
 * Evidencia guardada en EventoPropuesta.detalle.identidad_operador:
 * { metodo: 'connection_status', usuario_atlas, db_autenticacion }.
 * usuario_atlas se conserva a propósito: es el NOMBRE del usuario de base
 * de datos (no una contraseña ni parte de la URI) y es lo que permite
 * auditar después qué credencial abrió la conexión y cruzarlo con el
 * actor.identificador y con los logs de acceso de Atlas.
 *
 * Esta resolución es la garantía principal de que decide un operador
 * personal: si connectionStatus no devuelve exactamente un usuario
 * incluido en la allowlist, no se escribe nada. La comparación
 * MONGODB_URI_DECISION ≠ MONGODB_URI del comando es solo defensa en
 * profundidad (ver scripts/decidir-propuesta.js).
 *
 * Toda falla de configuración (ausente, JSON inválido, lista vacía,
 * entradas mal formadas o duplicadas) lanza ErrorConfiguracionOperadores
 * y el servicio la evalúa ANTES del gate de índices y de cualquier
 * transacción. Los mensajes no repiten el contenido de la variable.
 */

class ErrorConfiguracionOperadores extends Error {}
class ErrorActorNoAutorizado extends Error {}

const VARIABLE_OPERADORES = 'OPERADORES_AUTORIZADOS_JSON';
const CLAVES_OPERADOR = ['db', 'identificador', 'usuario_atlas'];

// Ficticio: solo documenta la forma. Nunca poner usuarios reales en git.
const EJEMPLO_OPERADORES_AUTORIZADOS_JSON = JSON.stringify([
  { usuario_atlas: 'operador-ejemplo', db: 'admin', identificador: 'operador.ejemplo' }
]);

function esTextoNoVacio(v) {
  return typeof v === 'string' && v.trim() !== '' && v === v.trim();
}

// Pura. Devuelve la lista validada y congelada, o lanza.
function cargarOperadoresAutorizados(texto) {
  const falla = (m) => {
    throw new ErrorConfiguracionOperadores(`${VARIABLE_OPERADORES}: ${m}`);
  };
  if (typeof texto !== 'string' || texto.trim() === '') falla('ausente o vacía.');

  let lista;
  try {
    lista = JSON.parse(texto);
  } catch {
    falla('no es JSON válido.'); // sin repetir el contenido
  }
  if (!Array.isArray(lista)) falla('debe ser un array JSON.');
  if (lista.length === 0) falla('la lista está vacía; nadie podría decidir.');

  const vistosUsuario = new Set();
  const vistosIdentificador = new Set();
  const operadores = lista.map((op, i) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) falla(`la entrada ${i} debe ser un objeto.`);
    const claves = Object.keys(op).sort();
    if (claves.length !== CLAVES_OPERADOR.length || !claves.every((c, j) => c === CLAVES_OPERADOR[j])) {
      falla(`la entrada ${i} debe tener exactamente las claves ${CLAVES_OPERADOR.join(', ')}.`);
    }
    for (const clave of CLAVES_OPERADOR) {
      if (!esTextoNoVacio(op[clave])) falla(`la entrada ${i}: "${clave}" debe ser un string no vacío y sin espacios al borde.`);
    }
    const claveUsuario = `${op.db}\u0000${op.usuario_atlas}`;
    if (vistosUsuario.has(claveUsuario)) falla(`la entrada ${i} repite un usuario_atlas + db ya listado.`);
    if (vistosIdentificador.has(op.identificador)) falla(`la entrada ${i} repite un identificador ya listado.`);
    vistosUsuario.add(claveUsuario);
    vistosIdentificador.add(op.identificador);
    return Object.freeze({ usuario_atlas: op.usuario_atlas, db: op.db, identificador: op.identificador });
  });
  return Object.freeze(operadores);
}

// Pura. usuariosAutenticados: authInfo.authenticatedUsers de
// connectionStatus ([{ user, db }]). Devuelve el actor y la evidencia
// que se guarda en EventoPropuesta.detalle.identidad_operador.
function resolverActor(usuariosAutenticados, operadores) {
  const rechaza = (m) => {
    throw new ErrorActorNoAutorizado(`Operador no autorizado: ${m}`);
  };
  if (!Array.isArray(usuariosAutenticados)) rechaza('connectionStatus no devolvió authenticatedUsers.');
  if (usuariosAutenticados.length === 0) rechaza('la conexión no tiene ningún usuario autenticado.');
  if (usuariosAutenticados.length > 1) {
    rechaza(`la conexión tiene ${usuariosAutenticados.length} usuarios autenticados; la identidad es ambigua.`);
  }
  const [{ user, db } = {}] = usuariosAutenticados;
  if (!esTextoNoVacio(user) || !esTextoNoVacio(db)) rechaza('el usuario autenticado no trae user/db válidos.');

  const operador = operadores.find((o) => o.usuario_atlas === user && o.db === db);
  if (!operador) {
    if (operadores.some((o) => o.usuario_atlas === user)) {
      rechaza(`"${user}" está en ${VARIABLE_OPERADORES} pero autenticado contra la base "${db}", no la listada.`);
    }
    rechaza(`"${user}" no está en ${VARIABLE_OPERADORES}.`);
  }
  return {
    actor: { tipo: 'humano', identificador: operador.identificador },
    identidad_operador: { metodo: 'connection_status', usuario_atlas: user, db_autenticacion: db }
  };
}

module.exports = {
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  VARIABLE_OPERADORES,
  EJEMPLO_OPERADORES_AUTORIZADOS_JSON,
  cargarOperadoresAutorizados,
  resolverActor
};
