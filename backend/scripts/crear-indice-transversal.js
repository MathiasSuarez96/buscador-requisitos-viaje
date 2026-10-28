const { ejecutar, ErrorOperacionIndice } = require('./lib/operacion-indice-transversal');
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) console.log('NO ejecuta por defecto. Tras revisión y confirmación: --plan RUTA --confirmo SHA256_BYTES --salida COMPROBANTE_NUEVO_PRIVADO. URI en MONGODB_INDICE_OPERADOR_URI.');
  else if (args.length !== 6 || args[0] !== '--plan' || args[2] !== '--confirmo' || args[4] !== '--salida') {
    console.error('argumentos_invalidos'); process.exitCode = 1;
  } else {
    const { MongoClient } = require('mongodb');
    ejecutar({ tipo: 'crear', archivoPlan: args[1], confirmado: args[3], salida: args[5],
      uri: process.env.MONGODB_INDICE_OPERADOR_URI, crearCliente: (u, o) => new MongoClient(u, o) })
      .then(r => { console.log(JSON.stringify(r)); if (r.estado !== 'confirmado' || r.codigo) process.exitCode = 1; })
      .catch(e => { console.error(e instanceof ErrorOperacionIndice ? e.codigo : 'operacion_abortada_sin_detalles_externos'); process.exitCode = 1; });
  }
}
