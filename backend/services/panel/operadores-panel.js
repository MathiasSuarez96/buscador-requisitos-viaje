/**
 * Allowlist de operadores del panel (OPERADORES_PANEL_JSON) y resolución
 * del operador a partir de una identidad YA VERIFICADA (token OIDC).
 *
 * Forma de cada entrada, sin claves extra:
 *   { "proveedor": "google", "sub": "<sub de Google>", "email": "...",
 *     "identificador": "<id lógico del actor>", "permisos": ["ver", "decidir"] }
 *
 *  - Se identifica por proveedor + sub (estable). El email de la lista es
 *    informativo: un token con el mismo email y otro sub NO autoriza.
 *  - `[]` es una lista válida (nadie autorizado todavía): permite que el
 *    primer inicio de sesión obtenga su sub en /api/panel/sesion.
 *  - Ausente, JSON inválido, entradas mal formadas o duplicadas →
 *    ErrorConfiguracionPanel (el panel falla cerrado). Los mensajes no
 *    repiten el contenido de la variable.
 *
 * El operador resuelto se construye y congela acá, nunca a partir del body.
 */

const VARIABLE = 'OPERADORES_PANEL_JSON';
// Origen de las decisiones tomadas desde el panel: queda en
// EventoPropuesta.detalle.comando (la CLI usa { nombre: 'decidir-propuesta' }).
const COMANDO_PANEL = Object.freeze({ nombre: 'panel-propuestas', version: '1' });
const PROVEEDORES = Object.freeze(['google']);
const PERMISOS = Object.freeze(['ver', 'decidir']);
const CLAVES = ['email', 'identificador', 'permisos', 'proveedor', 'sub'];

class ErrorConfiguracionPanel extends Error {}

const esTexto = (v) => typeof v === 'string' && v.trim() !== '' && v === v.trim();

function congelarProfundo(v) {
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v)) congelarProfundo(x);
    Object.freeze(v);
  }
  return v;
}

// Pura. Devuelve la lista validada y congelada, o lanza.
function cargarOperadoresPanel(texto) {
  const falla = (m) => {
    throw new ErrorConfiguracionPanel(`${VARIABLE}: ${m}`);
  };
  if (typeof texto !== 'string' || texto.trim() === '') falla('ausente o vacía.');
  let lista;
  try {
    lista = JSON.parse(texto);
  } catch {
    falla('no es JSON válido.');
  }
  if (!Array.isArray(lista)) falla('debe ser un array JSON.');

  const vistosSub = new Set();
  const vistosIdentificador = new Set();
  const operadores = lista.map((op, i) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) falla(`la entrada ${i} debe ser un objeto.`);
    const claves = Object.keys(op).sort();
    if (claves.length !== CLAVES.length || !claves.every((c, j) => c === CLAVES[j])) {
      falla(`la entrada ${i} debe tener exactamente las claves ${CLAVES.join(', ')}.`);
    }
    for (const c of ['proveedor', 'sub', 'email', 'identificador']) {
      if (!esTexto(op[c])) falla(`la entrada ${i}: "${c}" debe ser un string no vacío y sin espacios al borde.`);
    }
    if (!PROVEEDORES.includes(op.proveedor)) falla(`la entrada ${i}: proveedor no soportado.`);
    if (op.sub.length > 255) falla(`la entrada ${i}: sub demasiado largo.`);
    if (!/^[^\s@]+@[^\s@]+$/.test(op.email)) falla(`la entrada ${i}: email inválido.`);
    if (!Array.isArray(op.permisos) || op.permisos.length === 0) falla(`la entrada ${i}: permisos debe ser un array no vacío.`);
    if (!op.permisos.every((p) => PERMISOS.includes(p))) falla(`la entrada ${i}: permiso desconocido (válidos: ${PERMISOS.join(', ')}).`);
    if (new Set(op.permisos).size !== op.permisos.length) falla(`la entrada ${i}: permisos repetidos.`);
    const claveSub = `${op.proveedor}\u0000${op.sub}`;
    if (vistosSub.has(claveSub)) falla(`la entrada ${i} repite un proveedor + sub ya listado.`);
    if (vistosIdentificador.has(op.identificador)) falla(`la entrada ${i} repite un identificador ya listado.`);
    vistosSub.add(claveSub);
    vistosIdentificador.add(op.identificador);
    return { proveedor: op.proveedor, sub: op.sub, email: op.email, identificador: op.identificador, permisos: [...op.permisos] };
  });
  return congelarProfundo(operadores);
}

// Pura. identidad: la devuelta por el verificador (ya verificada). Devuelve
// el operador congelado o null si no está en la lista. El email del token
// (verificado) es el que queda como evidencia. El operador trae la forma
// completa que exige decidirPropuesta (actor, identidad_operador, comando):
// se puede pasar tal cual como resolverIdentidad: () => req.operador.
function resolverOperadorPanel(identidad, operadores) {
  if (identidad === null || typeof identidad !== 'object' || identidad.email_verificado !== true) return null;
  const op = operadores.find((o) => o.proveedor === identidad.proveedor && o.sub === identidad.sub);
  if (!op) return null;
  return congelarProfundo({
    identificador: op.identificador,
    permisos: [...op.permisos],
    actor: { tipo: 'humano', identificador: op.identificador },
    identidad_operador: { metodo: `oidc_${identidad.proveedor}`, sub: identidad.sub, email: identidad.email },
    comando: { ...COMANDO_PANEL }
  });
}

module.exports = {
  VARIABLE,
  COMANDO_PANEL,
  PROVEEDORES,
  PERMISOS,
  ErrorConfiguracionPanel,
  cargarOperadoresPanel,
  resolverOperadorPanel,
  congelarProfundo
};
