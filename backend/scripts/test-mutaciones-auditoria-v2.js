// H2.1 — mutaciones de los modelos versionados y de la persistencia 2.0.
// Cada mutación compila el módulo alterado en memoria y corre la suite indicada en un proceso hijo.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const I = path.join(__dirname, '../models/propuestas/IntentoAplicacion.model.js');
const H = path.join(__dirname, '../models/propuestas/HistorialCambio.model.js');
const P = path.join(__dirname, '../services/propuestas/persistencia-aplicacion-v2.js');
const ESQUEMA = 'test-modelos-auditoria-v2.js', PERSIST = 'test-persistencia-aplicacion-v2.js';
const mutaciones = [
  ['intento: versión 2.0 nunca reconocida', I, ESQUEMA, "const esV2 = (doc) => doc.version_contrato === '2.0';", 'const esV2 = (doc) => false;'],
  ['intento: acepta versiones desconocidas', I, ESQUEMA, 'version_contrato: { type: String, enum: VERSIONES_CONTRATO, immutable: true },', 'version_contrato: { type: String, immutable: true },'],
  ['intento: 1.0 admite campos 2.0', I, ESQUEMA, "    if (mezclados.length) throw new Error(`intentos_aplicacion: un documento 1.0 no admite campos 2.0", "    if (false) throw new Error(`intentos_aplicacion: un documento 1.0 no admite campos 2.0"],
  ['intento: 2.0 admite campos 1.0', I, ESQUEMA, "  if (mezclados.length) falla2(`campos exclusivos del 1.0", "  if (false) falla2(`campos exclusivos del 1.0"],
  ['intento: evidencia_fresca obligatoria también en 2.0', I, ESQUEMA, 'required: function () { return !esV2(this); }, immutable: true },', 'required: true, immutable: true },'],
  ['intento: revalidacion 1.0 exigida en 2.0', I, ESQUEMA, 'return !esV2(this) && exigeRevalidacion(this);', 'return exigeRevalidacion(this);'],
  ['intento: [] implícito en revalidaciones', I, ESQUEMA, 'revalidaciones: { type: [revalidacionV2Schema], default: undefined, immutable: true },', 'revalidaciones: { type: [revalidacionV2Schema], immutable: true },'],
  ['intento: etapa 0 admite revalidaciones', I, ESQUEMA, "    if (doc.revalidaciones !== undefined) falla2('el rechazo de etapa 0 no admite revalidaciones.');", ''],
  ['intento: revalidaciones no obligatorias', I, ESQUEMA, "    if (!Array.isArray(doc.revalidaciones) || doc.revalidaciones.length === 0) falla2('revalidaciones es obligatoria y no vacía.');", ''],
  ['intento: URL de revalidación sin control', I, ESQUEMA, "      if (!urlHttpsSinCredenciales(r.url)) falla2(", '      if (false) falla2('],
  ['intento: categoría de conflicto sin coherencia', I, ESQUEMA, '    if (!categorias.includes(doc.conflicto.categoria)) falla2(', '    if (false) falla2('],
  ['intento: conflicto no obligatorio', I, ESQUEMA, '    if (doc.conflicto == null) falla2(', '    if (false) falla2('],
  ['intento: fecha sin validar', I, ESQUEMA, "    if (typeof fecha !== 'string' || !esFechaCalendario(fecha)) falla2(", '    if (false) falla2('],
  ['intento: fecha String (convierte Date)', I, ESQUEMA, 'fecha_verificacion: { type: mongoose.Schema.Types.Mixed, immutable: true },', 'fecha_verificacion: { type: String, immutable: true },'],
  ['intento: error_externo no obligatorio', I, ESQUEMA, "    if (doc.error_externo == null) falla2('escritura_abortada exige error_externo.');", ''],
  ['intento: aprobación de otra decisión', I, ESQUEMA, "    if (doc.aprobacion.evento_id !== doc.decision_aprobacion_id) falla2(", '    if (false) falla2('],
  ['intento: identidad_operador libre', I, ESQUEMA, "  if (canonico(doc.identidad_operador) !== canonico(doc.auditoria.identidad)) falla2(", '  if (false) falla2('],
  ['intento: adaptador de texto libre', I, ESQUEMA, "  if (!NOMBRE_TECNICO.test(doc.adaptador?.nombre ?? '') || !NOMBRE_TECNICO.test(doc.adaptador?.version ?? '')) falla2(", '  if (false) falla2('],
  ['intento: autoIndex activado', I, PERSIST, "    collection: 'intentos_aplicacion',\n    timestamps: false,\n    autoIndex: false,", "    collection: 'intentos_aplicacion',\n    timestamps: false,\n    autoIndex: true,"],
  ['historial: versión 2.0 nunca reconocida', H, ESQUEMA, "const esV2 = (doc) => doc.version_contrato === '2.0';", 'const esV2 = (doc) => false;'],
  ['historial: cambio sin efecto aceptado', H, ESQUEMA, "anterior.valor === nuevo.valor) falla2(`cambios[${i}] sin efecto.`);", 'anterior.valor === nuevo.valor && false) falla2(`cambios[${i}] sin efecto.`);'],
  ['historial: cambios sin orden', H, ESQUEMA, "    if (previo !== null && !(previo < c.campo)) falla2(", '    if (false) falla2('],
  ['historial: fecha nueva sin validar', H, ESQUEMA, "  if (nueva.bson_tipo !== 'string' || !esFechaCalendario(nueva.valor)) falla2(", '  if (false) falla2('],
  ['historial: 1.0 admite campos 2.0', H, ESQUEMA, "    if (mezclados.length) throw new Error(`historial_cambios: un documento 1.0", "    if (false) throw new Error(`historial_cambios: un documento 1.0"],
  ['persistencia: sin comparar entrada y documento', P, ESQUEMA, '  if (distintas.length) throw new mongoose.Error.StrictModeError(', '  if (false) throw new mongoose.Error.StrictModeError('],
  ['persistencia: ObjectId → String admitido', P, ESQUEMA, '  if (v?._bsontype === \'ObjectId\') return `ObjectId(${v.toHexString()})`;', '  if (v?._bsontype === \'ObjectId\') return JSON.stringify(v.toHexString());'],
  ['persistencia: string ISO → Date admitido', P, ESQUEMA, "  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalida' : v.toISOString()})`;", '  if (v instanceof Date) return JSON.stringify(v.toISOString());'],
  ['persistencia: función tratada como ausente', P, ESQUEMA, "  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return `${typeof v}()`;\n", ''],
  ['persistencia: hex → ObjectId rechazado', P, ESQUEMA, "  || (entrada?.startsWith('\"') && salida?.startsWith('ObjectId(') && `ObjectId(${JSON.parse(entrada)})` === salida);", '  || false;'],
  ['persistencia: evento sin sesión en save', P, PERSIST, 'await nuevo(EventoPropuesta, doc).save({ session }); },', 'await nuevo(EventoPropuesta, doc).save(); },'],
  ['persistencia: instancia reutilizada entre reintentos', P, PERSIST, "function nuevo(Modelo, doc) {\n  const m = new Modelo(doc, null, { strict: 'throw' });",
    "const CACHE = new WeakMap();\nfunction nuevo(Modelo, doc) {\n  if (CACHE.has(doc)) return CACHE.get(doc);\n  const m = new Modelo(doc, null, { strict: 'throw' }); CACHE.set(doc, m);"],
  ['persistencia: historial sin sesión en save', P, PERSIST, 'await nuevo(HistorialCambio, doc).save({ session }); },', 'await nuevo(HistorialCambio, doc).save(); },'],
  ['persistencia: intento sin sesión en save', P, PERSIST, 'await nuevo(IntentoAplicacion, doc).save({ session }); },', 'await nuevo(IntentoAplicacion, doc).save(); },'],
  ['persistencia: no exige sesión', P, PERSIST, "  if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {", '  if (false) {']
];
function correr(m, suite) {
  const prueba = path.join(__dirname, suite);
  const codigo = `const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');const m=${JSON.stringify(m)};
  if(m){const f=m[1];let s=fs.readFileSync(f,'utf8').split(String.fromCharCode(13)).join('');if(s.split(m[3]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(f,module);mod.filename=f;mod.paths=Module._nodeModulePaths(path.dirname(f));require.cache[f]=mod;mod._compile(s.replace(m[3],()=>m[4]),f);}
  require(${JSON.stringify(prueba)});`;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
}
for (const suite of [ESQUEMA, PERSIST]) { const b = correr(null, suite); assert.equal(b.status, 0, `base ${suite}\n${b.stdout}\n${b.stderr}`); }
// Solo AssertionError cuenta como detección; el resto se informa por separado y hace fallar la suite.
const clases = { detectada: [], sobrevive: [], muerte_invalida: [], infraestructura: [] };
for (const m of mutaciones) {
  const r = correr(m, m[2]);
  const primera = (r.stderr ?? '').split('\n').map(l => l.trim()).find(l => /^\w*Error\b/.test(l) || /ANCLA NO UNICA|SOLO-LOOPBACK BLOQUEADO/.test(l)) ?? '';
  const clase = r.error || r.status === null || /ANCLA NO UNICA|SOLO-LOOPBACK BLOQUEADO/.test(primera) ? 'infraestructura'
    : r.status === 0 ? 'sobrevive' : /^AssertionError\b/.test(primera) ? 'detectada' : 'muerte_invalida';
  clases[clase].push(m[0]);
  console.log(`${clase}: ${m[0]}${clase === 'detectada' ? '' : `\n  ${primera || r.error?.code || `exit ${r.status}`}`}`);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(clases).map(([k, v]) => [k, v.length]))));
assert.equal(clases.detectada.length, mutaciones.length, `No detectadas por aserción: ${JSON.stringify({ ...clases, detectada: undefined })}`);
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones de auditoría 2.0 detectadas por aserciones.`);
