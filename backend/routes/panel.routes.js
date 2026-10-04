/**
 * Router del panel (/api/panel). En este bloque solo existe:
 *
 *   GET /sesion — exige un token VÁLIDO pero no autorización previa.
 *     Devuelve únicamente la identidad propia verificada, si está autorizada
 *     y sus permisos. No entrega propuestas. Sirve para obtener el sub
 *     inicial con OPERADORES_PANEL_JSON=[].
 *
 * Cualquier otra ruta exige autenticación + autorización (permiso "ver")
 * y, como todavía no existe, responde 404 recién después de eso.
 *
 * Sin configuración válida el router entero responde 503 (falla cerrado).
 */

const express = require('express');
const { resolverOperadorPanel } = require('../services/panel/operadores-panel');
const {
  ErrorPanel,
  asignarRequestId,
  protecciones,
  crearCorsPanel,
  exigirJson,
  parserJson,
  crearAutenticar,
  crearAutorizar,
  manejarErroresPanel
} = require('../middleware/panel');

// { config, verificador, registrar } con config válida, o
// { config: null, registrar } si la configuración es inválida.
function crearRouterPanel({ config, verificador, registrar }) {
  const router = express.Router();
  router.use(asignarRequestId, protecciones);

  if (!config || !verificador) {
    router.use((req, res, next) => next(new ErrorPanel(503, 'no_disponible', 'configuracion')));
    router.use(manejarErroresPanel(registrar));
    return router;
  }

  router.use(crearCorsPanel(config.origenes));
  router.use(exigirJson, parserJson);

  const autenticar = crearAutenticar(verificador);

  router.get('/sesion', autenticar, (req, res) => {
    const id = req.identidadVerificada;
    const op = resolverOperadorPanel(id, config.operadores);
    res.json({
      identidad: { proveedor: id.proveedor, sub: id.sub, email: id.email, email_verificado: id.email_verificado },
      autorizado: op !== null,
      identificador: op ? op.identificador : null,
      permisos: op ? [...op.permisos] : []
    });
  });

  router.use(autenticar, crearAutorizar(config.operadores, 'ver'));
  router.use((req, res, next) => next(new ErrorPanel(404, 'no_encontrado')));
  router.use(manejarErroresPanel(registrar));
  return router;
}

module.exports = { crearRouterPanel };
