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
 *   POST /propuestas/:propuesta_id/aprobacion y /rechazo — exigen además
 *     el permiso "decidir" (ver services/panel/decisiones-propuestas.js).
 *     Orden: 401 → 403 → 400 → 404 → reenvío 200 → 409 → 422 → servicio.
 *       200 { decision }            ya_registrada: true en un reenvío idéntico
 *       400 solicitud_invalida      id, query o body inválidos
 *       404 no_encontrado           la propuesta no existe
 *       409 propuesta_cambio        lo visto ya no es lo actual (+ `actual`)
 *       422 propuesta_no_decidible  aprobación sin integridad, o pendiente con
 *                                   decisión previa (+ `motivos`)
 *       500 resultado_incierto      no se pudo confirmar la escritura
 *       500 error_interno           inconsistencia, o ErrorEntradaInvalida /
 *                                   ErrorTransicionInvalida del servicio (el
 *                                   400 ya se resolvió en la frontera HTTP)
 *       503 no_disponible           sin Mongo, sin índices o transacción
 *                                   revertida por un error transitorio
 *     Cada decisión registrada (o reenvío reconocido) deja un panel_decision
 *     en el registro.
 *
 * Todo lo que no es /sesion exige autenticación + autorización (permiso
 * "ver"); una ruta inexistente responde 404 recién después de eso. Todavía
 * no hay rutas de cancelación ni aplicación.
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
  ErrorCuerpoInvalido,
  ErrorPropuestaInexistente,
  ErrorPropuestaCambio,
  ErrorPropuestaNoDecidible,
  ErrorResultadoIncierto,
  ErrorDecisionNoDisponible,
  ErrorEntradaInvalida,
  ErrorTransicionInvalida
} = require('../services/panel/decisiones-propuestas');
const {
  ErrorPanel,
  asignarRequestId,
  protecciones,
  crearCorsPanel,
  exigirJson,
  parserJson,
  crearAutenticar,
  crearAutorizar,
  crearExigirPermiso,
  manejarErroresPanel
} = require('../middleware/panel');

// Errores del lector → errores públicos del panel (mensajes fijos).
function traducirLectura(err) {
  if (err instanceof ErrorConsultaInvalida) return new ErrorPanel(400, 'solicitud_invalida', `consulta_${err.message}`);
  if (err instanceof ErrorLecturaNoDisponible) return new ErrorPanel(503, 'no_disponible', err.message);
  return err;
}

// Errores de una decisión → errores públicos del panel. Lo que no se
// reconoce sigue tal cual y termina en 500 error_interno.
function traducirDecision(err) {
  if (err instanceof ErrorCuerpoInvalido) return new ErrorPanel(400, 'solicitud_invalida', `cuerpo_${err.message}`);
  if (err instanceof ErrorPropuestaInexistente) return new ErrorPanel(404, 'no_encontrado', err.message);
  if (err instanceof ErrorPropuestaCambio) return new ErrorPanel(409, 'propuesta_cambio', 'propuesta_cambio', { datos: { actual: err.actual } });
  if (err instanceof ErrorPropuestaNoDecidible) {
    return new ErrorPanel(422, 'propuesta_no_decidible', `no_decidible_${err.motivos.join('+')}`, { datos: { motivos: [...err.motivos] } });
  }
  if (err instanceof ErrorResultadoIncierto) return new ErrorPanel(500, 'resultado_incierto', 'resultado_incierto', { causa: err.causa });
  if (err instanceof ErrorDecisionNoDisponible) return new ErrorPanel(503, 'no_disponible', err.message, { causa: err.causa });
  // Tras la validación HTTP, una entrada o transición rechazada por el
  // servicio es un error de programación: 500, nunca 400.
  if (err instanceof ErrorEntradaInvalida) return new ErrorPanel(500, 'error_interno', 'servicio_entrada_invalida', { causa: err });
  if (err instanceof ErrorTransicionInvalida) return new ErrorPanel(500, 'error_interno', 'servicio_transicion_invalida', { causa: err });
  return traducirLectura(err);
}

const manejar = (traducir, fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(traducir(err));
  }
};
const leer = (fn) => manejar(traducirLectura, fn);

// { config, verificador, registrar, propuestas, decisiones } con config
// válida, o { config: null, registrar } si la configuración es inválida.
// propuestas: lector de services/panel/lectura-propuestas.js.
// decisiones: services/panel/decisiones-propuestas.js.
function crearRouterPanel({ config, verificador, registrar, propuestas, decisiones }) {
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

  const decidir = (tipoEvento) =>
    manejar(traducirDecision, async (req, res) => {
      if (Object.keys(req.query).length > 0) throw new ErrorConsultaInvalida('parametro_no_admitido');
      const { decision, registro } = await decisiones.decidir(tipoEvento, validarPropuestaId(req.params.propuesta_id), req.body, req.operador);
      registrar({
        nivel: 'info',
        evento: 'panel_decision',
        request_id: req.requestId,
        propuesta_id: decision.propuesta_id,
        evento_id: decision.evento_id,
        tipo_evento: decision.tipo_evento,
        identificador: req.operador.identificador,
        ...registro
      });
      res.json({ decision });
    });
  const exigirDecidir = crearExigirPermiso('decidir');
  router.post('/propuestas/:propuesta_id/aprobacion', exigirDecidir, decidir('aprobacion'));
  router.post('/propuestas/:propuesta_id/rechazo', exigirDecidir, decidir('rechazo'));

  router.use((req, res, next) => next(new ErrorPanel(404, 'no_encontrado')));
  router.use(manejarErroresPanel(registrar));
  return router;
}

module.exports = { crearRouterPanel };
