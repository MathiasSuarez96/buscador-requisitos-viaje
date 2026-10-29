const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const archivo = path.join(__dirname, 'lib/operacion-indice-transversal.js');
const prueba = path.join(__dirname, 'test-operacion-indice-transversal.js');
const mutaciones = [
  ['omite hash confirmado', "if (!/^[a-f0-9]{64}$/.test(confirmado) || sha(bytes) !== confirmado) falla('hash_plan_no_confirmado');", ''],
  ['omite huella del código', "if (!igual(plan.codigo, codigo)) falla('codigo_no_coincide');", ''],
  ['omite vencimiento del plan', "falla('plan_vencido_o_fecha_invalida');", 'void 0;'],
  ['omite hash del informe', "if (sha(bytesInforme) !== plan.informe?.sha256_bytes) falla('informe_base_alterado');", ''],
  ['omite hash de la simulación', "if (sha(bytesSimulacion) !== plan.simulacion?.sha256_bytes) falla('simulacion_alterada');", ''],
  ['omite operador y privilegios reales', "verificarOperador(await db.command({ connectionStatus: 1, showPrivileges: true }), tipo === 'crear' ? 'createIndex' : 'dropIndex');", ''],
  ['omite comprobación de privilegios', "falla('privilegios_insuficientes');", 'void 0;'],
  ['omite cambio en el prechequeo', "falla('prechequeo_cambio');", 'void 0;'],
  ['omite vigencia de relectura', "falla('prechequeo_o_plan_vencido');", 'void 0;'],
  ['omite versión del servidor', "falla('version_servidor_no_admitida');", 'void 0;'],
  ['omite host vinculado al plan', 'destinoUri.hostname !== plan.cluster_srv', 'false'],
  ['omite fase de escritura', 'permitirEscritura && enviados === 0', 'enviados === 0'],
  ['permite segunda escritura', 'enviados === 0', 'true'],
  ['reserva sin exclusividad', "fs.openSync(destino, 'wx', 0o600)", "fs.openSync(destino, 'w', 0o600)"],
  ['omite verificación del índice después de crear', "evaluarIndice(recibo.indices_despues, SPEC).estado !== 'ya_existe'", 'false'],
  ['declara aborto conocido tras corte posterior', "error = e;\n    recibo.estado = monitor?.enviados ? 'incierto_requiere_lectura_independiente' : 'abortado_sin_envio';", "error = e;\n    recibo.estado = 'abortado_sin_envio';"],
  ['error externo pisa la huella del código', "recibo.codigo_resultado = e instanceof ErrorOperacionIndice ? e.codigo : 'error_externo_no_publicado';", "recibo.codigo = e instanceof ErrorOperacionIndice ? e.codigo : 'error_externo_no_publicado';"],
  ['fallo confirmado pisa la huella del código', 'recibo.codigo_resultado = confirmados.get(e.code);', 'recibo.codigo = confirmados.get(e.code);'],
  ['fallo de cierre pisa la huella del código', "recibo.codigo_cierre = 'cierre_o_monitor_no_concluyente';", "recibo.codigo = 'cierre_o_monitor_no_concluyente';"],
  ['cierre fallido tapa la causa principal', 'if (!error) error = new ErrorOperacionIndice(recibo.codigo_cierre);', 'error = new ErrorOperacionIndice(recibo.codigo_cierre); recibo.codigo_resultado = recibo.codigo_cierre;'],
  ['violación ya reportada se informa como cierre', "else if (!['comando_fuera_de_alcance', 'monitor_violo_alcance'].includes(error.codigo)) cierreFallido = true;", 'else cierreFallido = true;'],
  ['quita persistencia del comprobante intermedio', "    try { escribirDescriptor(fd, { ...intermedio, comprobante_hash: sha(JSON.stringify(intermedio)) }); }\n    catch { falla('comprobante_intermedio_no_escribible'); }\n", ''],
  ['envía aunque falle el comprobante intermedio', "catch { falla('comprobante_intermedio_no_escribible'); }", 'catch { /* sigue */ }'],
  ['omite autorización separada de reversión', "if (confirmadoReversion !== sha(Buffer.concat([bytes, Buffer.from('\\0reversion')])) || confirmarSinDependientes !== true) falla('reversion_no_confirmada');", '']
];
function correr(m) {
  const codigo = `const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');const f=${JSON.stringify(archivo)};const m=${JSON.stringify(m)};
  if(m){let s=fs.readFileSync(f,'utf8').split(String.fromCharCode(13)).join('');if(s.split(m[1]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(f,module);mod.filename=f;mod.paths=Module._nodeModulePaths(path.dirname(f));require.cache[f]=mod;mod._compile(s.replace(m[1],m[2]),f);}
  require(${JSON.stringify(prueba)});`;
  // El proceso hijo del test (corte abrupto) recibe la misma mutación por entorno.
  const env = { ...process.env };
  if (m) env.MUTACION_OPERACION_INDICE = JSON.stringify([m[1], m[2]]); else delete env.MUTACION_OPERACION_INDICE;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, env
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
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones de operación de índice detectadas por aserciones.`);
