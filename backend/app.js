/**
 * App de Express sin efectos al cargarse: no conecta a Mongo ni escucha
 * un puerto (eso lo hace server.js). Así las rutas se pueden probar en un
 * puerto efímero de 127.0.0.1 con modelos falsos.
 *
 * config/mongoose va primero: las rutas cargan los modelos.
 *
 * /api/panel se monta ANTES que el CORS público y tiene su propio CORS
 * restringido, su parser JSON de 8 KB y su manejo de errores: ninguna
 * respuesta del panel pasa por el CORS abierto de la API pública. No hay
 * parser JSON global: las rutas públicas son solo GET y no leen el body.
 */

const mongoose = require('./config/mongoose');
const express = require('express');
const cors = require('cors');
const destinosRoutes = require('./routes/destinos.routes');
const { crearRouterPanel } = require('./routes/panel.routes');
const { cargarConfigPanel } = require('./services/panel/config-panel');
const { crearVerificadorGoogle } = require('./services/panel/verificar-token-google');
const { crearLectorPropuestas } = require('./services/panel/lectura-propuestas');
const { crearRegistrador } = require('./utils/sanear-registro');

// Db nativo de la conexión de Mongoose, solo si está conectada (readyState 1).
const dbConectada = () => (mongoose.connection.readyState === 1 ? mongoose.connection.db : null);

// panel: { env, verificador?, registrar?, propuestas? }. Sin env, el panel
// queda deshabilitado (503): crearApp() nunca lee process.env por su cuenta.
// propuestas: lector inyectable; por defecto lee con el driver nativo de la
// conexión de Mongoose (sin modelos de propuestas).
function armarPanel({ env = {}, verificador, registrar = crearRegistrador(), propuestas } = {}) {
  let config = null;
  try {
    config = cargarConfigPanel(env);
  } catch (err) {
    registrar({ nivel: 'aviso', evento: 'panel_deshabilitado', motivo: err.message });
    return { config: null, verificador: null, registrar };
  }
  return {
    config,
    verificador: verificador ?? crearVerificadorGoogle({ clientId: config.clientId }),
    registrar,
    propuestas: propuestas ?? crearLectorPropuestas({ obtenerDb: dbConectada })
  };
}

function crearApp({ panel } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.use('/api/panel', crearRouterPanel(armarPanel(panel)));

  app.use(cors());
  app.use('/api/destinos', destinosRoutes);

  return app;
}

module.exports = { crearApp };
