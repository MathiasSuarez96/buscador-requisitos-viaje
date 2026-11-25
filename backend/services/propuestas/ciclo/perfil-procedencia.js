/**
 * Perfiles de PROCEDENCIA del ciclo 2.0: requisitos ya publicados como confirmados con una fuente no
 * oficial (IATA) cuyo contenido completo puede respaldar una fuente oficial explícita.
 *
 * Por qué no alcanza con «el valor coincide»: aplicar cualquier cambio 2.0 fija fecha_verificacion
 * (plan-aplicacion-requisito-v2.js). Cambiar solo la fuente renovaría la fecha de una descripción que
 * la fuente nueva no respalda. Por eso el perfil define el requisito CANÓNICO completo que la lectura
 * respalda (obligatorio, descripción de redacción propia que repite las condiciones de la fuente
 * —nacionalidad, documento, duración, motivo— y fuente oficial) y:
 *
 *  - sin_cambio        si el requisito publicado ya es el canónico (repetir no escribe ni renueva);
 *  - cambio_aplicable  con tipo_cambio 'procedencia' (obligatorio coincide: cambia la procedencia y la
 *                      descripción) o 'valor' (también cambia obligatorio). Las observaciones
 *                      'cambio_de_procedencia' y 'descripcion_reemplazada' dejan a la vista la fuente y
 *                      la descripción anteriores (lo que deja de publicarse);
 *  - revision_humana   si el requisito tiene campos que la fuente no respalda (recomendado, link,
 *                      plazo_antes_del_vuelo, costo: la fecha se renovaría sobre ellos), si su estado
 *                      no está entre los admitidos (por defecto solo 'confirmado'), o si el cambio
 *                      exigiría tocar `recomendado`.
 *
 * La política de cada perfil autoriza solo obligatorio, descripcion y fuente de ESE requisito. Un perfil
 * cuyo canónico incluye `estado` (estados_admitidos con 'verificar') también lo autoriza: CONFIRMA un
 * requisito en 'verificar' cuando la fuente respalda todos sus campos publicados.
 */
const CAMPOS_FUERA_DE_FUENTE = Object.freeze(['recomendado', 'link', 'plazo_antes_del_vuelo', 'costo']);
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const presente = v => v !== undefined && v !== null;
const CAMPOS_CANONICOS = Object.freeze(['obligatorio', 'descripcion', 'fuente', 'estado']);

function crearEvaluarProcedencia(canonico, estadosAdmitidos = ['confirmado']) {
  return function evaluar(requisito, hechos) {
    const c = canonico(hechos);
    const observaciones = [];
    const base = { esperado: c.obligatorio, observaciones };
    if (!estadosAdmitidos.includes(requisito.estado)) {
      return { ...base, decision: 'revision_humana', motivo: 'estado_no_confirmado', detalle: `El requisito está en ${JSON.stringify(requisito.estado ?? null)}; la política solo admite ${estadosAdmitidos.join(', ')}.` };
    }
    const fuera = CAMPOS_FUERA_DE_FUENTE.filter(k => presente(requisito[k]));
    if (fuera.length) {
      return { ...base, decision: 'revision_humana', motivo: 'campos_sin_respaldo',
        detalle: `El requisito tiene ${fuera.join(', ')}, que esta fuente no respalda; aplicar renovaría su fecha de verificación.` };
    }
    const cambios = CAMPOS_CANONICOS.filter(k => k !== 'estado' || c.estado !== undefined).filter(k => requisito[k] !== c[k]).map(k => ({ campo: k, propuesto: valor(c[k]) }));
    if (cambios.length === 0) return { ...base, decision: 'sin_cambio' };
    if (requisito.fuente !== c.fuente) {
      observaciones.push({ codigo: 'cambio_de_procedencia', detalle: `fuente ${JSON.stringify(requisito.fuente ?? null)} → ${JSON.stringify(c.fuente)}` });
    }
    if (requisito.descripcion !== c.descripcion) {
      observaciones.push({ codigo: 'descripcion_reemplazada',
        detalle: `Descripción anterior: ${JSON.stringify(requisito.descripcion ?? null)}. Se reemplaza por redacción propia respaldada por la fuente; lo que la fuente no dice deja de publicarse.` });
    }
    return { ...base, decision: 'cambio_aplicable', tipo_cambio: requisito.obligatorio === c.obligatorio ? 'procedencia' : 'valor', cambios };
  };
}

/**
 * def: { nombre, politica, adaptador, destino:{codigo_iso}, requisito:{tipo, nombre}, contexto_viajero,
 *   campo_evidencia, canonico(hechos) -> {obligatorio, descripcion, fuente[, estado]}, estados_admitidos? }
 * Con estados_admitidos distinto de ['confirmado'], canonico debe fijar estado 'confirmado'.
 */
function crearPerfilProcedencia(def) {
  const estados = Object.freeze([...(def.estados_admitidos ?? ['confirmado'])]);
  if (estados.some(e => !['confirmado', 'verificar'].includes(e)) || !estados.includes('confirmado')) throw new TypeError(`perfil ${def.nombre}: estados_admitidos inválidos.`);
  const confirma = estados.includes('verificar');
  const canonico = confirma ? h => { const c = def.canonico(h); if (c.estado !== 'confirmado') throw new TypeError(`perfil ${def.nombre}: el canónico debe confirmar el estado.`); return c; } : def.canonico;
  return Object.freeze({
    nombre: def.nombre, version: '1', politica: Object.freeze({ ...def.politica }), adaptador: def.adaptador,
    destino: Object.freeze({ ...def.destino }), requisito: Object.freeze({ ...def.requisito }),
    contexto_viajero: Object.freeze({ ...def.contexto_viajero }), campo_evidencia: def.campo_evidencia,
    campos_autorizados: Object.freeze(confirma ? [...CAMPOS_CANONICOS] : ['obligatorio', 'descripcion', 'fuente']),
    campos_sin_evidencia: CAMPOS_FUERA_DE_FUENTE,
    estados_admitidos: estados,
    tipo: 'procedencia', canonico, evaluar: crearEvaluarProcedencia(canonico, estados)
  });
}

module.exports = { crearPerfilProcedencia, crearEvaluarProcedencia, CAMPOS_FUERA_DE_FUENTE };
