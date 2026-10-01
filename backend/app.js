/**
 * App de Express sin efectos al cargarse: no conecta a Mongo ni escucha
 * un puerto (eso lo hace server.js). Así las rutas se pueden probar en un
 * puerto efímero de 127.0.0.1 con modelos falsos.
 *
 * config/mongoose va primero: las rutas cargan los modelos.
 */

require('./config/mongoose');
const express = require('express');
const cors = require('cors');
const destinosRoutes = require('./routes/destinos.routes');

function crearApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api/destinos', destinosRoutes);

  return app;
}

module.exports = { crearApp };
