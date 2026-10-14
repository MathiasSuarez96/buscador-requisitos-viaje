// Mutaciones reales en una copia temporal; no edita fuentes ni abre conexiones.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const raiz = path.resolve(__dirname, '..');
const servicio = 'services/propuestas/aplicar-propuesta.js';
const audit = 'services/propuestas/auditoria-aplicacion.js';
const panel = 'services/panel/aplicaciones-propuestas.js';
const testServicio = 'test-servicio-aplicacion-propuesta.js';
const testPanel = 'test-servicio-panel-aplicaciones.js';
const mutaciones = [
  ['inicio omite auditoría', servicio, 'function construirInicio(ctx, proceso) {', 'function construirInicio(ctx, proceso) { ctx = { ...ctx, auditoria: undefined };', testServicio, 'AUD-INICIO'],
  ['intento omite auditoría', servicio, 'function construirIntento(ctx, r) {', 'function construirIntento(ctx, r) { ctx = { ...ctx, auditoria: undefined };', testServicio, 'AUD-INTENTO'],
  ['evento omite auditoría', servicio, 'function construirEvento(ctx, tipoEvento, t, resultado, motivo) {', 'function construirEvento(ctx, tipoEvento, t, resultado, motivo) { ctx = { ...ctx, auditoria: undefined };', testServicio, 'AUD-EVENTO'],
  ['servicio confía en wrapper HTTP', servicio, 'auditoriaPanel = validarAuditoria(auditoriaPanel, entrada, true)', 'auditoriaPanel = auditoriaPanel', testServicio, 'AUD-INTERNA'],
  ['identidad permite campos extra', audit, "exacto(a.identidad, ['metodo', 'sub']);", '', testServicio, 'AUD-INTERNA'],
  ['request_id no validado', audit, "if (typeof a.request_id !== 'string' || !UUID.test(a.request_id))", 'if (false)', testServicio, 'AUD-INTERNA'],
  ['auditoría no copia identidad', audit, 'identidad: Object.freeze({ ...a.identidad })', 'identidad: a.identidad', testServicio, 'AUD-INICIO copia aislada'],
  ['CAS omite decision_aprobacion_id esperado', servicio, '    decision_aprobacion_id: ctx.decision_aprobacion_id_esperado,\n    ultimo_evento_id:', '    ultimo_evento_id:', testServicio, 'CAS exacto y cambio de aprobación'],
  ['CAS omite ultimo_evento_id esperado', servicio, '    ultimo_evento_id: ctx.decision_aprobacion_id_esperado', '', testServicio, 'CAS exacto'],
  ['perdedor de carrera devuelve reenvío 200', panel, 'throw new ErrorAplicacionCambio(actualSeguro(actual, ev), resultado.intento_id ?? null);', 'return { aplicacion: { ya_aplicada: true } };', testPanel, 'CARRERA'],
  ['respuesta 200 con destino_modificado false', panel, '    destino_modificado: true,', '    destino_modificado: false,', testPanel, 'éxito exige destino_modificado true'],
  ['respuesta 200 con propuesta no aplicada', panel, "!p || p.estado !== 'aplicada' ||", '!p ||', testPanel, 'validación respuestaAplicada'],
  ['fuente caída después de inicio devuelve 503', panel, "    if (resultado?.resultado === 'exito') {", "    if (resultado?.resultado === 'fuente_temporalmente_no_disponible') throw new ErrorAplicacionNoDisponible();\n    if (resultado?.resultado === 'exito') {", testPanel, 'fuente caída con intento exige 422'],
  ['CLI muestra CAS incompleto', 'scripts/aplicar-propuesta.js', '    decision_aprobacion_id_esperado: entrada.decision_aprobacion_id_esperado', '    decision_aprobacion_id: decision', 'test-aplicar-propuesta.js', 'solo_lectura filtro CAS real'],
];
const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'mutaciones-aplicacion-'));
try {
  for (const p of ['services', 'models', 'scripts', 'utils', 'package.json']) fs.cpSync(path.join(raiz, p), path.join(copia, p), { recursive: true });
  fs.symlinkSync(path.join(raiz, 'node_modules'), path.join(copia, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const ejecutar = test => spawnSync(process.execPath, ['--require', path.join(copia, 'scripts/preload-solo-loopback.js'), path.join(copia, 'scripts', test)], { cwd: copia, encoding: 'utf8', timeout: 30000 });
  for (const test of new Set(mutaciones.map(m => m[4]))) {
    const r = ejecutar(test); assert.equal(r.status, 0, `Base ${test}: ${r.stdout}\n${r.stderr}`);
  }
  for (const [nombre, archivo, antes, despues, test, caso] of mutaciones) {
    const ruta = path.join(copia, archivo), original = fs.readFileSync(ruta, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(original.split(antes).length, 2, `ancla no única: ${nombre}`);
    fs.writeFileSync(ruta, original.replace(antes, despues));
    const r = ejecutar(test);
    fs.writeFileSync(ruta, original);
    assert.ok(!r.error && r.status !== null, `infraestructura: ${nombre}: ${r.error}`);
    assert.equal(r.status, 1, `sobrevivió: ${nombre}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /AssertionError/, `sin aserción: ${nombre}\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /SyntaxError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO/);
    console.log(`Detectada: ${nombre} → ${test} / ${caso}`);
  }
  console.log(`${mutaciones.length}/${mutaciones.length} mutaciones backend detectadas por aserciones; bases correctas.`);
} finally {
  try { fs.unlinkSync(path.join(copia, 'node_modules')); } catch { /* creación incompleta */ }
  assert.ok(path.resolve(copia).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(copia, { recursive: true, force: true });
}
