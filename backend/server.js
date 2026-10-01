// Arranque del servidor. Ejecutado directamente (node server.js): carga el
// .env ANTES que config/mongoose, la app y los modelos; después conecta a
// Mongo y escucha. Requerido como módulo (pruebas): no carga el .env, no
// conecta ni escucha.
const esPrincipal = require.main === module;
if (esPrincipal) require('dotenv').config();

// config/mongoose antes que la app (y con ella, los modelos).
const mongoose = require('./config/mongoose');
const { crearApp } = require('./app');

function iniciar(env = process.env) {
  const app = crearApp();

  mongoose.connect(env.MONGODB_URI)
    .then(() => console.log('Conectado a MongoDB Atlas'))
    .catch((err) => console.error('Error de conexión:', err));

  const PORT = env.PORT || 3000;
  return app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
}

if (esPrincipal) iniciar();

module.exports = { iniciar };
