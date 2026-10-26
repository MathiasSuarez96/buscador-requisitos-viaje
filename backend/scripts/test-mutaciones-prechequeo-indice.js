const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const raiz = path.resolve(__dirname, '..');
const archivo = path.join(__dirname, 'preparar-indice-transversal.js');
const prueba = path.join(__dirname, 'test-indice-transversal-mongo.js');
const mutaciones = [
  ['M1: cuenta historial inactivo', '.find({ estado: { $in: ESTADOS_ACTIVOS } }, {', '.find({}, {'],
  ['M4: omite clasificación de BSON inválido', 'if (!(p.destino_id instanceof ObjectId) || !(p.requisito_id instanceof ObjectId))', 'if (false)'],
  ['M8: omite base esperada', "if (db.databaseName !== 'buscador_requisitos') throw new Error('Base inesperada');", ''],
  ['M9: hash omite contenido activo', 'JSON.stringify(plan)', 'JSON.stringify({ ...plan, propuestas_activas: [] })'],
  ['omite grupos duplicados', 'filter(([, ids]) => ids.length > 1)', 'filter(() => false)'],
  ['ignora índices incompatibles', "indice.estado !== 'conflicto'", 'true']
];
function correr(mutacion) {
  const codigo = `const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');
  const archivo=${JSON.stringify(archivo)};const m=${JSON.stringify(mutacion)};
  if(m){let s=fs.readFileSync(archivo,'utf8');if(s.split(m[1]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(archivo,module);mod.filename=archivo;mod.paths=Module._nodeModulePaths(path.dirname(archivo));
  require.cache[archivo]=mod;mod._compile(s.replace(m[1],m[2]),archivo);}
  require(${JSON.stringify(prueba)});`;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    cwd: raiz, encoding: 'utf8', timeout: 45000
  });
}
const base = correr(null);
assert.equal(base.status, 0, `${base.stdout}\n${base.stderr}`);
for (const m of mutaciones) {
  const r = correr(m);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${m[0]}`);
  assert.equal(r.status, 1, `Sobrevive ${m[0]}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/, `Muerte inválida ${m[0]}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TypeError|ReferenceError|SyntaxError|MODULE_NOT_FOUND|ANCLA NO UNICA|SOLO-LOOPBACK BLOQUEADO/);
  console.log(`Detectada por AssertionError: ${m[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones del prechequeo detectadas por aserciones.`);
