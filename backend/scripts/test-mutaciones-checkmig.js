// Mutaciones del adaptador 2.0 de CheckMig y de su fuente, aisladas en memoria de procesos hijos:
// no modifica archivos ni conecta. Cada mutación debe hacer caer al menos una de las dos suites
// de CheckMig por una aserción. La mutación «cuelgue» comprueba la guarda contra el verde falso:
// sin temporizadores pendientes el proceso sale solo, y ambas suites deben terminar con exit 1
// sin imprimir su línea final.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const F = path.resolve(__dirname, '../services/propuestas/fuentes/migracion-colombia-checkmig.js');
const A = path.resolve(__dirname, '../services/propuestas/adaptadores/v2/migracion-colombia-checkmig.js');
const SUITES = ['test-adaptador-v2-checkmig.js', 'test-prototipo-checkmig.js'].map(s => path.join(__dirname, s));
const preload = path.join(__dirname, 'preload-solo-loopback.js');
const LINEA_FINAL = /: OK\n/;

const mutaciones = [
  ['M1 texto de «Dirigido a:» dentro de hechos', F, 'alcance: { viajeros, sentidos },', 'alcance: { viajeros, sentidos, texto: a.texto ?? null },'],
  ['M2 listas sin ordenar antes de hashHechos', F, '? [...xs].sort(compararCodigo) : null);', '? [...xs] : null);'],
  ['M3 hechos dentro de un resultado ambiguo', A, "({ tipo: 'ambiguo', motivo,", "({ tipo: 'ambiguo', hechos: {}, motivo,"],
  ['M4 redirección seguida sin validar el destino', F, 'if (!destinoOficial(destino)) {', 'if (destino === null) {'],
  ['M5 sin límite de tamaño durante la lectura', F, 'if (total > maximo) {', 'if (false) {'],
  ['M6 hash del HTML dentro de hechos', A, 'hechos: n.hechos, hechos_hash: hashHechos(n.hechos),', 'hechos: { ...n.hechos, html: ex.fuente.contenido_sha256 }, hechos_hash: hashHechos(n.hechos),'],
  ['M7 respaldo «la oración nombra CheckMig»', F, '    if (completa !== null) {', '    if (completa === null && /checkmig/.test(s)) completa = true;\n    if (completa !== null) {'],
  ['M8 sin chequeo de varias fuentes', A, "if (p.fuentes.length > 1) return no('varias_fuentes');", ''],
  ['M9 propuesta incompatible que igual consulta', A, "if (!c.compatible) return { tipo: 'incompatible', codigo: c.codigo };", "if (!c.compatible) { await leerFicha({ fetch, ahora }); return { tipo: 'incompatible', codigo: c.codigo }; }"],
  ['M10 «de uso» aceptado fuera de la ficha de CheckMig', F, 'if (fichaCheckmig && ADMITIDA_A.test(clausula) && INICIO_A.test(s))', 'if (ADMITIDA_A.test(clausula) && INICIO_A.test(s))'],
  ['M11 HTTP 404 tratado como respuesta', F, 'return fallo(`http_${status}`, { http_status: status });', "if (status === 404) return { tipo: 'respuesta', html: '', recibida_en: ahora(), diagnostico: diagnostico({ http_status: status }) }; return fallo(`http_${status}`, { http_status: status });"],
  ['M12 continuación de B sin validar', F, 'else if (ADMITIDA_B.test(clausula)) completa = corte === 0 && FIN_GLOBAL.test(despues);', 'else if (ADMITIDA_B.test(clausula)) completa = corte === 0;'],
  ['M13 prefijo de B sin validar', F, 'else if (ADMITIDA_B.test(clausula)) completa = corte === 0 && FIN_GLOBAL.test(despues);', 'else if (ADMITIDA_B.test(clausula)) completa = FIN_GLOBAL.test(despues);'],
  ['M14 continuación de C sin validar', F, 'completa = corte === 0 && FIN_GLOBAL.test(despues.slice(objetoC[0].length));', 'completa = corte === 0;'],
  ['M15 oración A sin validar entera', F, 'completa = A_COMPLETA.test(s);', 'completa = true;'],
  ['M16 URL de la fuente por prefijo, no exacta', A, 'f.url !== URL_FICHA', '!String(f.url).startsWith(URL_FICHA)']
];
const CUELGUE = ['M17 cuelgue sin temporizadores (verde falso)', F, "const html = new TextDecoder('utf-8').decode(cuerpo.bytes);", "await new Promise(() => {}); const html = new TextDecoder('utf-8').decode(cuerpo.bytes);"];

function ejecutar(suite, mutacion) {
  const codigo = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const mutacion = ${JSON.stringify(mutacion)};
    if (mutacion) {
      const [nombre, archivo, antes, despues] = mutacion;
      const original = fs.readFileSync(archivo, 'utf8').replace(/\\r\\n/g, '\\n');
      if (original.split(antes).length !== 2) throw new Error('ANCLA NO UNICA: ' + nombre);
      const modulo = new Module(archivo, module);
      modulo.filename = archivo;
      modulo.paths = Module._nodeModulePaths(require('node:path').dirname(archivo));
      require.cache[archivo] = modulo;
      modulo._compile(original.replace(antes, despues), archivo);
      // Sin esto Node lo trata como un require circular y falla con exports congelados.
      modulo.loaded = true;
    }
    require(${JSON.stringify(suite)});
  `;
  return spawnSync(process.execPath, ['--require', preload, '-e', codigo], { encoding: 'utf8', timeout: 60000 });
}

// Base sin mutar y control del mecanismo: una mutación identidad en cada archivo (se compila en
// memoria igual que las demás) debe pasar las dos suites. Así un fallo de carga nunca se cuenta
// como mutación detectada.
for (const suite of SUITES) {
  for (const mutacion of [null, ['identidad fuente', F, 'const { createHash } = require(\'node:crypto\');', 'const { createHash } = require(\'node:crypto\');'],
    ['identidad adaptador', A, "const NOMBRE = 'migracion-colombia-checkmig';", "const NOMBRE = 'migracion-colombia-checkmig';"]]) {
    const base = ejecutar(suite, mutacion);
    const nombre = `${mutacion ? mutacion[0] : 'base'} / ${path.basename(suite)}`;
    assert.equal(base.status, 0, `${nombre}:\n${base.stdout}\n${base.stderr}`);
    assert.match(base.stdout, LINEA_FINAL, `${nombre}: falta la línea final`);
  }
}
for (const mutacion of mutaciones) {
  const resultados = SUITES.map(s => ({ suite: path.basename(s), r: ejecutar(s, mutacion) }));
  for (const { suite, r } of resultados) {
    assert.ok(!r.error && r.status !== null, `Infraestructura: ${mutacion[0]} en ${suite}: ${r.error}`);
    assert.doesNotMatch(r.stderr, /SyntaxError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO|ANCLA NO UNICA/, `${mutacion[0]} en ${suite}`);
  }
  const caen = resultados.filter(({ r }) => r.status === 1 && /AssertionError/.test(r.stderr)).map(x => x.suite);
  assert.ok(caen.length > 0, `Sobrevivió: ${mutacion[0]}`);
  console.log(`Detectada: ${mutacion[0]} (cae: ${caen.join(', ')})`);
}
for (const suite of SUITES) {
  const r = ejecutar(suite, CUELGUE);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${CUELGUE[0]} en ${path.basename(suite)}`);
  assert.equal(r.status, 1, `Verde falso: ${path.basename(suite)} salió con ${r.status} sin terminar sus aserciones`);
  assert.doesNotMatch(r.stdout, LINEA_FINAL, `${path.basename(suite)}: no debía llegar a la línea final`);
}
console.log(`Detectada: ${CUELGUE[0]} (las dos suites salen con exit 1 sin línea final)`);
console.log(`${mutaciones.length + 1}/${mutaciones.length + 1} mutaciones detectadas.`);
