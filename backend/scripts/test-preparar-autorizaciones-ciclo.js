// preparar-autorizaciones-ciclo.js: conserva exactas las entradas vigentes, agrega solo la política
// pedida, valida la lista con el cargador real y escribe solo fuera del repositorio. Sin base ni red.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./preparar-autorizaciones-ciclo');
const R = require('../services/propuestas/ciclo/config-ciclo-real');

const AHORA = new Date('2026-11-25T12:00:00.000Z');
const ent = (politica, desde = '2026-11-23T17:20:36.052Z') => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: desde,
  vence_en: new Date(Date.parse(desde) + 90 * 86_400_000).toISOString() });
const SIETE = [ent('checkmig-colombia-obligatoriedad@1', '2026-11-23T00:10:38.704Z'), ent('govuk-reino-unido-turismo-uy@1', '2026-11-23T02:14:26.326Z'),
  ent('alta-auswaertiges-amt-alemania@1', '2026-11-23T02:14:26.326Z'), ent('auswaertiges-amt-alemania-visa@1', '2026-11-23T02:14:26.326Z'),
  ent('govuk-gb-pasaporte-uy@1'), ent('embajada-italia-it-visa-uy@1'), ent('embajada-italia-it-pasaporte-uy@1')];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorizaciones-'));
const actuales = path.join(dir, 'actuales.json');
fs.writeFileSync(actuales, JSON.stringify(SIETE, null, 2));
const correr = (extra, salida) => { const log = []; const c = P.ejecutar(['--actuales', actuales, '--autorizada-por', 'persona.autorizante', '--salida', salida, ...extra], { log: l => log.push(l), ahora: AHORA }); return { c, log: log.join('\n') }; };
const ETIAS = ['--agregar', 'comision-europea-etias-uy@1'];

try {
  // Camino correcto: 8 entradas, las 7 previas idénticas, la nueva al final y vigente.
  const salida = path.join(dir, 'nuevas.json');
  const r = correr(ETIAS, salida);
  assert.equal(r.c, 0, r.log);
  const lista = JSON.parse(fs.readFileSync(salida, 'utf8'));
  assert.equal(lista.length, 8);
  assert.equal(JSON.stringify(lista.slice(0, 7)), JSON.stringify(SIETE), 'las siete previas quedan exactas');
  assert.deepEqual(lista[7], { politica: 'comision-europea-etias-uy@1', autorizada_por: 'persona.autorizante', autorizada_en: AHORA.toISOString(), vence_en: '2027-02-23T12:00:00.000Z' });
  for (const a of lista) assert.notEqual(R.leerAutorizacion({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) }, AHORA, a.politica).autorizacion, null, a.politica);
  assert.match(r.log, /Entradas previas idénticas: sha256 ([0-9a-f]{64}) = \1\./);
  assert.ok(!/mongodb|SECRETO|password/i.test(r.log));
  // Habilita los seis perfiles ETIAS con el cargador real del ciclo.
  const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
  const env = { MONGODB_URI_CICLO: 'mongodb+srv://ciclo:x@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) };
  for (const n of ['at', 'hr', 'fi', 'fr', 'it', 'pt']) assert.equal(R.cargarConfigCicloReal(env, AHORA, { perfil: `comision-etias-${n}` }).politica_habilitada, true, n);
  // No sobrescribe.
  assert.deepEqual([correr(ETIAS, salida).c, correr(ETIAS, salida).log.includes('ya existe')], [1, true]);
  // Rechazos sin escribir nada.
  const rechazos = [
    ['ya presente (no se renueva)', ['--agregar', 'govuk-gb-pasaporte-uy@1'], 'ya está en la lista'],
    ['política desconocida', ['--agregar', 'inventada@1'], 'no es una política conocida'],
    ['cantidad distinta de la esperada', [...ETIAS, '--esperadas', '6'], 'se esperaban 6'],
    ['vigencia mayor a 90 días', [...ETIAS, '--dias', '91'], '--dias'],
    ['autorizada_en no exacta', [...ETIAS, '--autorizada-en', '2026-11-25'], 'ISO UTC exacta'],
    ['nueva ya vencida', [...ETIAS, '--autorizada-en', '2026-08-01T00:00:00.000Z', '--dias', '30'], 'no queda vigente']
  ];
  for (const [nombre, extra, texto] of rechazos) {
    const s = path.join(dir, `${nombre.replace(/\W+/g, '-')}.json`);
    const x = correr(extra, s);
    assert.deepEqual([x.c, x.log.includes(texto), fs.existsSync(s)], [1, true, false], `${nombre}: ${x.log}`);
  }
  // Una entrada actual inválida para el cargador real: no se escribe nada.
  fs.writeFileSync(actuales, JSON.stringify([...SIETE.slice(0, 6), { ...SIETE[6], extra: 1 }]));
  const inval = path.join(dir, 'invalida.json');
  assert.deepEqual([correr(ETIAS, inval).c, fs.existsSync(inval)], [1, false]);
  // Salida dentro del repositorio: rechazada.
  fs.writeFileSync(actuales, JSON.stringify(SIETE));
  const dentro = path.join(__dirname, '..', 'no-debe-existir-autorizaciones.json');
  assert.deepEqual([correr(ETIAS, dentro).c, fs.existsSync(dentro)], [1, false]);
  assert.equal(P.fueraDelRepositorio(path.join(__dirname, 'x.json')), false);
  assert.equal(P.fueraDelRepositorio(path.join(os.tmpdir(), 'x.json')), true);
  assert.equal(P.ejecutar([], { log: () => {} }), 1, 'sin argumentos: ayuda y exit 1');
  process.exitCode = 0;
  console.log('preparar-autorizaciones-ciclo: siete previas exactas, solo la política nueva, cargador real, fuera del repositorio y rechazos sin escribir: OK');
} catch (err) {
  process.exitCode = 1;
  console.error(err);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
