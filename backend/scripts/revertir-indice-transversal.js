const { ejecutar, ErrorOperacionIndice } = require('./lib/operacion-indice-transversal');
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) console.log('Reversión SEPARADA, nunca automática. Tras autorización propia: --plan RUTA --confirmo SHA256_PLAN --salida COMPROBANTE_NUEVO --confirmo-reversion SHA256_REVERSION --comprobante-creacion RUTA --confirmo-sin-servicios-dependientes');
  else if (args.length !== 11 || args[0] !== '--plan' || args[2] !== '--confirmo' || args[4] !== '--salida'
    || args[6] !== '--confirmo-reversion' || args[8] !== '--comprobante-creacion' || args[10] !== '--confirmo-sin-servicios-dependientes') {
    console.error('argumentos_invalidos'); process.exitCode = 1;
  } else {
    const { MongoClient } = require('mongodb');
    ejecutar({ tipo: 'revertir', archivoPlan: args[1], confirmado: args[3], salida: args[5], confirmadoReversion: args[7],
      comprobanteCreacion: args[9], confirmarSinDependientes: true, uri: process.env.MONGODB_INDICE_OPERADOR_URI,
      crearCliente: (u, o) => new MongoClient(u, o) })
      .then(r => { console.log(JSON.stringify(r)); if (r.estado !== 'confirmado' || r.codigo) process.exitCode = 1; })
      .catch(e => { console.error(e instanceof ErrorOperacionIndice ? e.codigo : 'operacion_abortada_sin_detalles_externos'); process.exitCode = 1; });
  }
}
