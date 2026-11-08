// H2.1/H2.2 — mutaciones de los modelos versionados, la persistencia 2.0, el evento 2.0 y su lectura en el panel.
// Cada mutación compila el módulo alterado en memoria y corre la suite indicada en un proceso hijo.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const I = path.join(__dirname, '../models/propuestas/IntentoAplicacion.model.js');
const H = path.join(__dirname, '../models/propuestas/HistorialCambio.model.js');
const P = path.join(__dirname, '../services/propuestas/persistencia-aplicacion-v2.js');
const E = path.join(__dirname, '../models/propuestas/EventoPropuesta.model.js');
const L = path.join(__dirname, '../services/panel/lectura-propuestas.js');
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
  ['intento: fuente_nombre sin guardia de tipo (defecto P3)', I, ESQUEMA, "typeof r.fuente_nombre !== 'string' || r.fuente_nombre.trim()", 'r.fuente_nombre.trim()'],
  ['intento: revalidación vacía sin guardia', I, ESQUEMA, "    if (doc.revalidaciones.some((r) => r == null)) falla2('revalidaciones[] no admite elementos vacíos.');\n", ''],
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
  ['historial: cambio vacío sin guardia', H, ESQUEMA, '    if (c == null) falla2(`cambios[${i}] vacío.`);\n', ''],
  ['historial: cambios sin orden', H, ESQUEMA, "    if (previo !== null && !(previo < c.campo)) falla2(", '    if (false) falla2('],
  ['historial: fecha nueva sin validar', H, ESQUEMA, "  if (nueva.bson_tipo !== 'string' || !esFechaCalendario(nueva.valor)) falla2(", '  if (false) falla2('],
  ['historial: 1.0 admite campos 2.0', H, ESQUEMA, "    if (mezclados.length) throw new Error(`historial_cambios: un documento 1.0", "    if (false) throw new Error(`historial_cambios: un documento 1.0"],
  ['persistencia: sin comparar entrada y documento', P, ESQUEMA, '  if (distintas.length) throw new mongoose.Error.StrictModeError(', '  if (false) throw new mongoose.Error.StrictModeError('],
  ['persistencia: ObjectId → String admitido', P, ESQUEMA, '  if (v?._bsontype === \'ObjectId\') return `ObjectId(${v.toHexString()})`;', '  if (v?._bsontype === \'ObjectId\') return JSON.stringify(v.toHexString());'],
  ['persistencia: string ISO → Date admitido', P, ESQUEMA, "  if (v instanceof Date) return Number.isNaN(v.getTime()) ? NO_ADMITIDO : `Date(${v.toISOString()})`;", '  if (v instanceof Date) return JSON.stringify(v.toISOString());'],
  ['persistencia: tipos no persistibles sin chequeo previo', P, ESQUEMA, '  if (noAdmitidas.length) throw new mongoose.Error.StrictModeError(', '  if (false) throw new mongoose.Error.StrictModeError('],
  ['persistencia: función como marcador comparable (defecto P2)', P, ESQUEMA, '  return NO_ADMITIDO;\n}', '  return `${typeof v}()`;\n}'],
  ['persistencia: undefined siempre como ausente', P, ESQUEMA, '    ? !opcionalAusente(Modelo, ruta, salida)', '    ? false'],
  ['persistencia: undefined declarado sin exigir ausencia en la salida', P, ESQUEMA, '  return declarada && !salida.has(ruta);', '  return declarada;'],
  ['persistencia: subruta de Mixed raíz como declarada', P, ESQUEMA, "    && (partes.length === 1 || Modelo.schema.path(partes.slice(0, -1).join('.'))?.instance !== 'Mixed');", ';'],
  ['persistencia: hex → ObjectId rechazado', P, ESQUEMA, "  || (typeof entrada === 'string' && typeof salida === 'string' && entrada.startsWith('\"') && salida.startsWith('ObjectId(') && `ObjectId(${JSON.parse(entrada)})` === salida);", '  || false;'],
  ['persistencia: evento sin sesión en save', P, PERSIST, 'await nuevo(EventoPropuesta, doc).save({ session }); },', 'await nuevo(EventoPropuesta, doc).save(); },'],
  ['persistencia: instancia reutilizada entre reintentos', P, PERSIST, "  const m = new Modelo(doc, null, { strict: 'throw' });\n  const salida",
    "  const CACHE = (nuevo.cache ??= new WeakMap());\n  if (CACHE.has(doc)) return CACHE.get(doc);\n  const m = new Modelo(doc, null, { strict: 'throw' }); CACHE.set(doc, m);\n  const salida"],
  ['persistencia: historial sin sesión en save', P, PERSIST, 'await nuevo(HistorialCambio, doc).save({ session }); },', 'await nuevo(HistorialCambio, doc).save(); },'],
  ['persistencia: intento sin sesión en save', P, PERSIST, 'await nuevo(IntentoAplicacion, doc).save({ session }); },', 'await nuevo(IntentoAplicacion, doc).save(); },'],
  ['persistencia: no exige sesión', P, PERSIST, "  if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {", '  if (false) {'],
  ["evento: detalle 2.0 nunca validado", E, ESQUEMA, "    if (esPlano(d) && d.version_contrato === '2.0') validarDetalleV2(this, d);", "    if (false) validarDetalleV2(this, d);"],
  ["evento: admite copias en el detalle", E, ESQUEMA, "  if (!clavesExactas(d, CLAVES_DETALLE_V2)) falla2(", "  if (false) falla2("],
  ["evento: tipo sin regla 2.0", E, ESQUEMA, "  if (!resultados) falla2(", "  if (false) falla2("],
  ["evento: resultado sin coherencia", E, ESQUEMA, "  if (!resultados.includes(d.resultado)) falla2(", "  if (false) falla2("],
  ["evento: actor de cualquier proceso", E, ESQUEMA, "  if (ev.actor?.tipo !== 'sistema' || ev.actor?.identificador !== PROCESO_V2.nombre) falla2(", "  if (false) falla2("],
  ["evento: adaptador libre", E, ESQUEMA, "  if (!clavesExactas(d.adaptador, ['nombre', 'version']) || !NOMBRE_TECNICO.test(d.adaptador.nombre) || !NOMBRE_TECNICO.test(d.adaptador.version)) falla2(", "  if (false) falla2("],
  ["evento: auditoría sin validar", E, ESQUEMA, "  try { a = validarAuditoria(d.auditoria); } catch { falla2('auditoria inválida.'); }", "  a = d.auditoria ?? {};"],
  ["evento: instantánea sin comparar", E, ESQUEMA, "  if (s && (s.propuesta_id", "  if (false && (s.propuesta_id"],
  ["evento: proceso 2.0 sin versión aceptado", E, ESQUEMA, "    else if (esPlano(d) && d.proceso_aplicador?.nombre === PROCESO_V2.nombre) throw", "    else if (false) throw"],
  ["lector: expone identidad_operador del evento", L, PERSIST, "    metodo_identidad: METODOS_CONOCIDOS.includes(metodo) ? metodo : null,", "    metodo_identidad: METODOS_CONOCIDOS.includes(metodo) ? metodo : null, identidad_operador: e.detalle?.identidad_operador,"],
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
