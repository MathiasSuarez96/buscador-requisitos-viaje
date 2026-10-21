// Mutaciones dirigidas de despacho 1.0/2.0 y captura; hijos aislados, sin red.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const raiz = path.resolve(__dirname, '..');
const preload = path.join(__dirname, 'preload-solo-loopback.js');
const modelo = 'models/propuestas/PropuestaCambio.model.js';
const payload = 'services/propuestas/payload-requisito-v2.js';
const contrato = 'services/propuestas/contrato-requisito-v2.js';
const registro = 'services/propuestas/registrar-ejecucion-lectura.js';
const mutaciones = [
  ['trata toda version como 1.0', modelo, 'const version = this.payload.version_contrato;', 'const version = VERSION_CONTRATO_PROPUESTA;', 'test-modelo-propuesta-v2.js'],
  ['trata toda version como 2.0', modelo, 'const version = this.payload.version_contrato;', "const version = '2.0';", 'test-modelo-propuesta-v2.js'],
  ['acepta 1.0 + requisito', modelo, "if (version === VERSION_CONTRATO_PROPUESTA && this.campo === 'requisito')", 'if (false)', 'test-modelo-propuesta-v2.js'],
  ['acepta 2.0 + costo', modelo, "if (version === '2.0' && this.campo === 'costo')", 'if (false)', 'test-modelo-propuesta-v2.js'],
  ['omite validacion canonica 2.0', payload, 'const esperado = crearSobreRequisitoV2(entrada);', 'const esperado = sobre;', 'test-modelo-propuesta-v2.js'],
  ['omite comparacion con hash almacenado', modelo, 'if (sobreValidado.payload_hash !== this.payload_hash)', 'if (false)', 'test-modelo-propuesta-v2.js'],
  ['omite coincidencia de campos externos', modelo, 'if (valorEnPayload !== valorExterno)', 'if (false)', 'test-modelo-propuesta-v2.js'],
  ['separa captura de identidad e instantanea', contrato, 'const instantanea_anterior = capturarInstantanea(requisito);', "const instantanea_anterior = capturarInstantanea({ ...requisito, descripcion: 'instantanea de otro requisito' });", 'test-contrato-requisito-v2.js'],
  ['desincroniza catalogo de tipos', contrato, "  'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico'", "  'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico', 'otro'", 'test-contrato-requisito-v2.js'],
  ['acepta link invalido en instantanea', contrato, "if (link.presente && (link.bson_tipo !== 'string' || link.valor !== link.valor.trim() || !esHttps(link.valor)))", 'if (false)', 'test-payload-requisito-v2.js'],
  ['habilita registro productivo 2.0', registro, 'if (versionDeclarada !== undefined && versionDeclarada !== VERSION_CONTRATO_REGISTRO)', 'if (false)', 'test-servicio-ejecucion-lectura.js']
];
function ejecutar(mutacion) {
  const codigo = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const path = require('node:path');
    const raiz = ${JSON.stringify(raiz)};
    const mutacion = ${JSON.stringify(mutacion)};
    if (mutacion) {
      const archivo = path.join(raiz, mutacion[1]);
      const original = fs.readFileSync(archivo, 'utf8');
      if (original.split(mutacion[2]).length !== 2) throw new Error('ANCLA NO UNICA: ' + mutacion[0]);
      const modulo = new Module(archivo, module);
      modulo.filename = archivo;
      modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
      require.cache[archivo] = modulo;
      modulo._compile(original.replace(mutacion[2], mutacion[3]), archivo);
    }
    require(path.join(raiz, 'scripts', mutacion ? mutacion[4] : 'test-modelo-propuesta-v2.js'));
  `;
  return spawnSync(process.execPath, ['--require', preload, '-e', codigo], { cwd: raiz, encoding: 'utf8', timeout: 60000 });
}
const base = ejecutar(null);
assert.equal(base.status, 0, `Base: ${base.stdout}\n${base.stderr}`);
for (const mutacion of mutaciones) {
  const r = ejecutar(mutacion);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${mutacion[0]}: ${r.error}`);
  assert.equal(r.status, 1, `Sobrevivio: ${mutacion[0]}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/, `Sin asercion: ${mutacion[0]}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO|ANCLA NO UNICA/);
  console.log(`Detectada por asercion: ${mutacion[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones de integracion detectadas por asercion.`);
