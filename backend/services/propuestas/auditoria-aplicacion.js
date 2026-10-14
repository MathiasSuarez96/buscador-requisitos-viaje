/** Lista cerrada: nunca token, email, headers ni datos del cuerpo ajenos al CAS. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAMPOS_PANEL = Object.freeze(['origen', 'request_id', 'operador', 'identidad', 'comando', 'instantanea']);
const CAMPOS_INSTANTANEA = Object.freeze(['propuesta_id', 'estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada', 'decision_aprobacion_id_esperado']);
function exacto(v, campos) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) throw new Error('auditoria: estructura inválida');
  const keys = Reflect.ownKeys(v);
  if (keys.length !== campos.length || keys.some(k => !campos.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value') || !Object.getOwnPropertyDescriptor(v, k).enumerable)) throw new Error('auditoria: campos inválidos');
}
function texto(v) {
  if (typeof v !== 'string' || !v.length || v.length > 255 || v.trim() !== v || /[\x00-\x1f\x7f]/.test(v)) throw new Error('auditoria: identidad inválida');
}
function validarAuditoria(a, entrada, soloPanel = false) {
  // Inspecciona descriptores antes de leer valores: no ejecuta getters.
  const origen = a && Object.getOwnPropertyDescriptor(a, 'origen');
  const panel = origen && Object.hasOwn(origen, 'value') && origen.value === 'panel';
  if (soloPanel && !panel) throw new Error('auditoria: origen inválido');
  exacto(a, panel ? CAMPOS_PANEL : ['origen', 'operador', 'identidad', 'comando']);
  texto(a.operador);
  exacto(a.comando, ['nombre', 'version']);
  if (a.comando.nombre !== (panel ? 'panel-propuestas' : 'aplicar-propuesta') || a.comando.version !== '1') throw new Error('auditoria: comando inválido');
  if (panel) {
    if (typeof a.request_id !== 'string' || !UUID.test(a.request_id)) throw new Error('auditoria: request_id inválido');
    exacto(a.identidad, ['metodo', 'sub']);
    if (a.identidad.metodo !== 'oidc_google') throw new Error('auditoria: método inválido');
    texto(a.identidad.sub);
    exacto(a.instantanea, CAMPOS_INSTANTANEA);
    const s = a.instantanea;
    if (typeof s.propuesta_id !== 'string' || !UUID.test(s.propuesta_id) || s.estado_esperado !== 'aprobada' || typeof s.payload_hash_esperado !== 'string' || !/^[0-9a-f]{64}$/.test(s.payload_hash_esperado) || !Number.isSafeInteger(s.version_coordinacion_esperada) || s.version_coordinacion_esperada < 0 || typeof s.decision_aprobacion_id_esperado !== 'string' || !UUID.test(s.decision_aprobacion_id_esperado)) throw new Error('auditoria: instantánea inválida');
    if (entrada && CAMPOS_INSTANTANEA.some(k => s[k] !== entrada[k])) throw new Error('auditoria: instantánea divergente');
  } else {
    if (a.origen !== 'comando_administrativo') throw new Error('auditoria: origen inválido');
    exacto(a.identidad, ['metodo', 'usuario_atlas', 'db_autenticacion']);
    if (a.identidad.metodo !== 'connection_status') throw new Error('auditoria: método inválido');
    texto(a.identidad.usuario_atlas); texto(a.identidad.db_autenticacion);
  }
  // Copia defensiva: ninguna referencia mutable del llamador sobrevive al primer await.
  return Object.freeze({ ...a, identidad: Object.freeze({ ...a.identidad }), comando: Object.freeze({ ...a.comando }), ...(panel ? { instantanea: Object.freeze({ ...a.instantanea }) } : {}) });
}
module.exports = { CAMPOS_PANEL, CAMPOS_INSTANTANEA, validarAuditoria };
