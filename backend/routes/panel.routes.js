/**
 * Router del panel (/api/panel):
 *
 *   GET /sesion — exige un token VÁLIDO pero no autorización previa.
 *     Devuelve únicamente la identidad propia verificada, si está autorizada
 *     y sus permisos. No entrega ni consulta propuestas. Sirve para obtener
 *     el sub inicial con OPERADORES_PANEL_JSON=[].
 *
 *   GET /propuestas y GET /propuestas/:propuesta_id — solo lectura (ver
 *     services/panel/lectura-propuestas.js). Consulta inválida → 400
 *     solicitud_invalida; propuesta inexistente → 404; sin conexión a
 *     Mongo → 503 no_disponible (registrado como error).
 *
 * Todo lo que no es /sesion exige autenticación + autorización (permiso
 * "ver"); una ruta inexistente responde 404 recién después de eso. Todavía
 * no hay rutas de aprobación, rechazo ni aplicación.
 *
 * Sin configuración válida el router entero responde 503 (falla cerrado).
 */

const express = require('express');
const { resolverOperadorPanel } = require('../services/panel/operadores-panel');
const {
  ErrorConsultaInvalida,
  ErrorLecturaNoDisponible,
  validarConsultaListado,
  validarPropuestaId
} = require('../services/panel/lectura-propuestas');
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

// Errores del lector → errores públicos del panel (mensajes fijos).
function traducirLectura(err) {
  if (err instanceof ErrorConsultaInvalida) return new ErrorPanel(400, 'solicitud_invalida', `consulta_${err.message}`);
  if (err instanceof ErrorLecturaNoDisponible) return new ErrorPanel(503, 'no_disponible', err.message);
  return err;
}

const leer = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(traducirLectura(err));
  }
};

// { config, verificador, registrar, propuestas } con config válida, o
// { config: null, registrar } si la configuración es inválida.
// propuestas: lector de services/panel/lectura-propuestas.js.
function crearRouterPanel({ config, verificador, registrar, propuestas }) {
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

  router.get(
    '/propuestas',
    leer(async (req, res) => {
      res.json(await propuestas.listar(validarConsultaListado(req.query)));
    })
  );

  router.get(
    '/propuestas/:propuesta_id',
    leer(async (req, res) => {
      if (Object.keys(req.query).length > 0) throw new ErrorConsultaInvalida('parametro_no_admitido');
      const detalle = await propuestas.detalle(validarPropuestaId(req.params.propuesta_id), req.operador);
      if (detalle === null) throw new ErrorPanel(404, 'no_encontrado', 'propuesta_inexistente');
      res.json(detalle);
    })
  );

  router.use((req, res, next) => next(new ErrorPanel(404, 'no_encontrado')));
  router.use(manejarErroresPanel(registrar));
  return router;
}

module.exports = { crearRouterPanel };
