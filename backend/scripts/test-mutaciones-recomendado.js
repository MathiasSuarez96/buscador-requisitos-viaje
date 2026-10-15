const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const raiz = resolve(__dirname, '..');
const temporal = mkdtempSync(join(tmpdir(), 'mutaciones-recomendado-'));
const mutaciones = [
  ['enum omite verificar', "recomendado: {\n    type: String,\n    enum: ['si', 'no', 'verificar']", "recomendado: {\n    type: String,\n    enum: ['si', 'no']"],
  ['null se acepta', 'validator: (valor) => valor !== null', 'validator: (valor) => true'],
  ['combinación contradictoria se acepta', "if (this.obligatorio === 'si' && ['si', 'verificar'].includes(this.recomendado))", 'if (false)']
];

function ejecutar() {
  const r = spawnSync(process.execPath, [join(temporal, 'scripts/test-recomendado-destino.js')], { cwd: temporal, encoding: 'utf8', timeout: 30000 });
  return { ...r, salida: r.stdout + '\\n' + r.stderr };
}

try {
  mkdirSync(join(temporal, 'models'));
  mkdirSync(join(temporal, 'scripts'));
  cpSync(join(raiz, 'models/Destino.model.js'), join(temporal, 'models/Destino.model.js'));
  cpSync(join(raiz, 'scripts/test-recomendado-destino.js'), join(temporal, 'scripts/test-recomendado-destino.js'));
  symlinkSync(join(raiz, 'node_modules'), join(temporal, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

  const base = ejecutar();
  assert.equal(base.status, 0, 'línea base fallida:\\n' + base.salida);
  let detectadas = 0;
  for (const [nombre, antes, despues] of mutaciones) {
    const archivo = join(temporal, 'models/Destino.model.js');
    const original = readFileSync(archivo, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(original.split(antes).length, 2, 'ancla no única: ' + nombre);
    writeFileSync(archivo, original.replace(antes, despues));
    const r = ejecutar();
    writeFileSync(archivo, original);
    assert.ok(r.status !== null && r.status !== 0, nombre + ': mutación sobrevivió\\n' + r.salida);
    assert.match(r.salida, /AssertionError/, nombre + ': no falló por las aserciones\\n' + r.salida);
    process.stdout.write('Detectada: ' + nombre + '\\n');
    detectadas++;
  }

  const archivo = join(temporal, 'models/Destino.model.js');
  const original = readFileSync(archivo, 'utf8').replaceAll('\r\n', '\n');
  const antes = "recomendado: {\n    type: String,\n    enum: ['si', 'no', 'verificar']";
  assert.equal(original.split(antes).length, 2, 'ancla default-null');
  writeFileSync(archivo, original.replace(antes, "recomendado: {\n    type: String,\n    default: null,\n    enum: ['si', 'no', 'verificar']"));
  const ausencia = ejecutar();
  writeFileSync(archivo, original);
  assert.ok(ausencia.status !== null && ausencia.status !== 0, 'default null sobrevivió\\n' + ausencia.salida);
  assert.match(ausencia.salida, /AssertionError/);
  process.stdout.write('Detectada: ausencia se convierte en null\n');
  detectadas++;
  process.stdout.write(detectadas + '/' + (mutaciones.length + 1) + ' mutaciones dirigidas detectadas\\n');
} finally {
  try { unlinkSync(join(temporal, 'node_modules')); } catch { /* El enlace puede no haberse creado. */ }
  assert.ok(resolve(temporal).startsWith(resolve(tmpdir()) + '\\') || resolve(temporal).startsWith(resolve(tmpdir()) + '/'));
  rmSync(temporal, { recursive: true, force: true });
}
