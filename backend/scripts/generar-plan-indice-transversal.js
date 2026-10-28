const { guardarPlan, ErrorOperacionIndice } = require('./lib/operacion-indice-transversal');
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) console.log('Sin conexión. Uso: node scripts/generar-plan-indice-transversal.js --informe RUTA --simulacion EVIDENCIA --carpeta CARPETA_NUEVA_PRIVADA --host HOST_SRV_SIN_CREDENCIALES');
  else if (args.length !== 8 || args[0] !== '--informe' || args[2] !== '--simulacion' || args[4] !== '--carpeta' || args[6] !== '--host') {
    console.error('argumentos_invalidos'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(guardarPlan({ informe: args[1], simulacion: args[3], carpeta: args[5], host: args[7] }))); }
    catch (e) { console.error(e instanceof ErrorOperacionIndice ? e.codigo : 'generacion_abortada_sin_detalles_externos'); process.exitCode = 1; }
  }
}
