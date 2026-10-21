const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const raiz = path.resolve(__dirname, '..');
const preload = path.join(__dirname, 'preload-solo-loopback.js');
const decide = 'services/propuestas/decidir-propuesta.js';
const panel = 'services/panel/decisiones-propuestas.js';
const registro = 'services/propuestas/registrar-ejecucion-lectura.js';
const suite = 'scripts/test-decisiones-advertencias.js';
const mutaciones = [
  ['omite versión del CAS', decide, [["'payload.version_contrato': e.version_contrato_esperada ?? '1.0'", "'payload.version_contrato': null"]], suite],
  ['omite advertencias del CAS', decide, [["filtro['payload.advertencias'] = { $eq: [...e.advertencias_aceptadas] };", 'if (false) {}']], suite],
  ['vuelve al array directo casteado como in', decide, [["filtro['payload.advertencias'] = { $eq: [...e.advertencias_aceptadas] };", "filtro['payload.advertencias'] = [...e.advertencias_aceptadas];"]], 'scripts/test-cas-advertencias-mongo.js'],
  ['acepta aprobación sin lista de advertencias', decide, [["if (!tieneAdvertencias) falla('advertencias_aceptadas es obligatoria para aprobar contrato 2.0.');", "if (!tieneAdvertencias) e.advertencias_aceptadas = [];"]], suite],
  ['acepta códigos duplicados', decide, [["compararCodigo(copia[i - 1], codigo) >= 0", "compararCodigo(copia[i - 1], codigo) > 0"]], suite],
  ['acepta propiedades extra en la lista', decide, [["if (claves.length !== valor.length + 1 || claves.some((k) => k !== 'length' && (typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k)))) falla('advertencias_aceptadas contiene propiedades adicionales.');", 'if (false) {}']], suite],
  ['acepta faltantes o reordena silenciosamente advertencias', decide, [["if (i > 0 && compararCodigo(copia[i - 1], codigo) >= 0) falla('advertencias_aceptadas debe estar ordenada y no contener duplicados.');", 'if (false) {}'], ['return Object.freeze(copia);', 'return Object.freeze(copia.sort(compararCodigo));']], suite],
  ['acepta advertencias en rechazo', decide, [["} else if (tieneAdvertencias) falla('advertencias_aceptadas no se admite en rechazo o cancelación 2.0.');", '} else if (false) {}']], suite],
  ['omite advertencias aceptadas del evento', decide, [["if (e.tipo_evento === 'aprobacion') detalle.advertencias_aceptadas = [...e.advertencias_aceptadas];", 'if (false) {}']], suite],
  ['agrega metadatos a eventos 1.0', decide, [["const detalle = { identidad_operador: { ...resolucion.identidad_operador }, comando: { nombre: comando.nombre, version: comando.version } };", "const detalle = { identidad_operador: { ...resolucion.identidad_operador }, comando: { nombre: comando.nombre, version: comando.version } }; detalle.version_contrato = '2.0';"]], suite],
  ['trata distinto reenvío como idéntico', panel, [["(versionContrato !== '2.0' || entrada.tipo_evento !== 'aprobacion' || arraysExactos(p.payload?.advertencias, entrada.advertencias_aceptadas))", 'true'], ['detalleVersionCorrecto &&', 'true &&']], suite],
  ['omite versión esperada del panel al comparar', panel, [["&& p.payload?.version_contrato === (entrada.version_contrato_esperada ?? '1.0')", '&& true']], suite],
  ['omite CAS exacto de advertencias en relectura del panel', panel, [["&& (entrada.tipo_evento !== 'aprobacion' || (entrada.version_contrato_esperada ?? '1.0') !== '2.0' || arraysExactos(p.payload?.advertencias, entrada.advertencias_aceptadas))", '&& true']], suite],
  ['omite validacion integral 2.0 del panel', panel, [["const motivos = motivosIntegridadV2(completa);", "const motivos = [];"]], suite],
  ['disfraza bug del validador como 422', panel, [["if (err instanceof ErrorContratoRequisitoV2) return ['payload_2_invalido'];\n    throw err;", "return ['payload_2_invalido'];"]], suite],
  ['omite 409 en segunda lectura 2.0', panel, [["if (!completa || !coincideLoVisto(entrada, completa)) throw new ErrorPropuestaCambio(actualSeguro(p, await leerUltimoEvento(p)));\n      const motivos = motivosIntegridadV2(completa);", "if (!completa) throw new ErrorPropuestaCambio(actualSeguro(p, await leerUltimoEvento(p)));\n      const motivos = motivosIntegridadV2(completa);"]], suite],
  ['valida integridad tambien al rechazar 2.0', panel, [["if (tipoEvento === 'aprobacion' && entrada.version_contrato_esperada === '2.0')", "if (entrada.version_contrato_esperada === '2.0')"]], suite],
  ['habilita registro productivo 2.0', registro, [["if (versionDeclarada !== undefined && versionDeclarada !== VERSION_CONTRATO_REGISTRO)", 'if (false)']], 'scripts/test-servicio-ejecucion-lectura.js']
];
function run(mut) {
  const source = `const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');const root=${JSON.stringify(raiz)};const m=${JSON.stringify(mut)};if(m){const f=path.join(root,m[1]);let s=fs.readFileSync(f,'utf8');for(const [a,b] of m[2]){if(s.split(a).length!==2)throw new Error('ANCLA NO UNICA: '+m[0]);s=s.replace(a,b)}const mod=new Module(f,module);mod.filename=f;mod.paths=Module._nodeModulePaths(path.dirname(f));require.cache[f]=mod;mod._compile(s,f)}require(path.join(root,m?m[3]:${JSON.stringify(suite)}));`;
  return spawnSync(process.execPath, ['--require', preload, '-e', source], { cwd: raiz, encoding: 'utf8', timeout: 60000 });
}
const base = run(null);
assert.equal(base.status, 0, `Base: ${base.stdout}\n${base.stderr}`);
for (const m of mutaciones) {
  const r = run(m);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${m[0]}: ${r.error}`);
  assert.equal(r.status, 1, `Sobrevivió: ${m[0]}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/, `No murió por aserción: ${m[0]}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO|ANCLA NO UNICA/);
  console.log(`Detectada por aserción: ${m[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones de decisiones detectadas por AssertionError.`);
