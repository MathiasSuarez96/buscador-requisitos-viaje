// Ejecuta el cuerpo REAL de cada CLI en un proceso hijo. Solo se sustituye
// la biblioteca delegada para forzar cada resultado sin conectar a una base.
// El recorrido real con Mongo está en test-operacion-indice-transversal.js.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const raiz = process.env.CLI_RAIZ_PRUEBA || __dirname;
const hash = 'a'.repeat(64), hashReversion = 'b'.repeat(64);
const secreto = 'SECRETO_FICTICIO_CLI';
const argsOperacion = ['--plan', 'plan-prueba.json', '--confirmo', hash, '--salida', 'comprobante-prueba.json'];
const argsReversion = [...argsOperacion, '--confirmo-reversion', hashReversion, '--comprobante-creacion', 'creacion-prueba.json', '--confirmo-sin-servicios-dependientes'];
const argsGenerador = ['--informe', 'informe-prueba.json', '--simulacion', 'simulacion-prueba.json', '--carpeta', 'carpeta-prueba', '--host', 'cluster0.simulacion.mongodb.net'];

function correr(nombre, caso, args) {
  const archivo = path.join(raiz, nombre), lib = path.join(raiz, 'lib/operacion-indice-transversal.js');
  const codigo = `const fs=require('node:fs');const Module=require('node:module');const assert=require('node:assert/strict');
  const nombre=${JSON.stringify(nombre)},caso=${JSON.stringify(caso)},args=${JSON.stringify(args)};let llamadas=0;
  class ErrorOperacionIndice extends Error{constructor(c){super(c);this.codigo=c;}}
  const responder=()=>{if(caso==='error_conocido')throw new ErrorOperacionIndice('caso_controlado');
    if(caso==='error_externo')throw new Error(process.env.MONGODB_INDICE_OPERADOR_URI);
    return {estado:caso,codigo:caso==='confirmado'?null:'resultado_de_prueba',plan_hash:${JSON.stringify(hash)}};};
  const mock={ErrorOperacionIndice,ejecutar:async(o)=>{llamadas++;
    assert.equal(o.tipo,nombre.startsWith('crear')?'crear':'revertir');assert.equal(o.confirmado,${JSON.stringify(hash)});
    assert.equal(o.archivoPlan,'plan-prueba.json');assert.equal(o.salida,'comprobante-prueba.json');
    assert.equal(o.uri,process.env.MONGODB_INDICE_OPERADOR_URI);assert.equal(typeof o.crearCliente,'function');
    if(o.tipo==='revertir'){assert.equal(o.confirmadoReversion,${JSON.stringify(hashReversion)});assert.equal(o.confirmarSinDependientes,true);assert.equal(o.comprobanteCreacion,'creacion-prueba.json');}
    return responder();},guardarPlan:o=>{llamadas++;assert.equal(o.host,'cluster0.simulacion.mongodb.net');
      assert.equal(o.informe,'informe-prueba.json');assert.equal(o.simulacion,'simulacion-prueba.json');assert.equal(o.carpeta,'carpeta-prueba');return responder();}};
  require.cache[${JSON.stringify(lib)}]={id:${JSON.stringify(lib)},filename:${JSON.stringify(lib)},loaded:true,exports:mock};
  const principal=new Module(${JSON.stringify(archivo)},module);principal.filename=${JSON.stringify(archivo)};
  principal.paths=Module._nodeModulePaths(${JSON.stringify(path.resolve(__dirname, '..'))});
  process.mainModule=principal;process.argv=[process.execPath,principal.filename,...args];require.cache[principal.filename]=principal;
  principal._compile(fs.readFileSync(principal.filename,'utf8'),principal.filename);
  console.log('__LLAMADAS__='+llamadas);`;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    env: { ...process.env, MONGODB_INDICE_OPERADOR_URI: `mongodb+srv://usuario:${secreto}@host-ficticio.mongodb.net/base` },
    encoding: 'utf8', timeout: 15000
  });
}
function comprobar(r, esperado, llamadas) {
  assert.ok(!r.error && r.status !== null, 'CLI sin error de infraestructura');
  assert.equal(r.status, esperado, `exit real del CLI\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`__LLAMADAS__=${llamadas}`));
  assert.doesNotMatch(r.stdout + r.stderr, /SECRETO_FICTICIO_CLI|mongodb:\/\/|mongodb\+srv:\/\/|host-ficticio|usuario:/);
}
for (const [nombre, args] of [['crear-indice-transversal.js', argsOperacion], ['revertir-indice-transversal.js', argsReversion]]) {
  comprobar(correr(nombre, 'confirmado', []), 0, 0);
  comprobar(correr(nombre, 'confirmado', ['--argumento-desconocido']), 1, 0);
  for (const caso of ['confirmado', 'abortado_sin_envio', 'incierto_requiere_lectura_independiente', 'fallo_confirmado_sin_cambio_de_indices', 'error_conocido', 'error_externo']) {
    comprobar(correr(nombre, caso, args), caso === 'confirmado' ? 0 : 1, 1);
  }
}
// Y7: la confirmación de servicios dependientes exige el argumento exacto, aun con 11 argumentos.
for (const casi of ['--confirmo-sin-servicios', '--confirmo-sin-servicios-dependientes=si', '--CONFIRMO-SIN-SERVICIOS-DEPENDIENTES', '--confirmo-sin-servicios-dependientes ']) {
  comprobar(correr('revertir-indice-transversal.js', 'confirmado', [...argsReversion.slice(0, 10), casi]), 1, 0);
}
comprobar(correr('generar-plan-indice-transversal.js', 'confirmado', []), 0, 0);
comprobar(correr('generar-plan-indice-transversal.js', 'confirmado', ['--argumento-desconocido']), 1, 0);
for (const caso of ['confirmado', 'error_conocido', 'error_externo']) comprobar(correr('generar-plan-indice-transversal.js', caso, argsGenerador), caso === 'confirmado' ? 0 : 1, 1);
console.log('CLI reales: ayuda sin operación; argumentos cerrados; forwarding; éxito exit 0 y aborto/fallo/incierto exit 1; errores seguros: OK');
