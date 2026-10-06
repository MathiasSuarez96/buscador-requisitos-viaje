/**
 * Middlewares del panel de propuestas (/api/panel).
 *
 *  - asignarRequestId: request_id generado SIEMPRE en el servidor
 *    (crypto.randomUUID); cualquier X-Request-Id recibido se ignora.
 *  - protecciones: Cache-Control: no-store (y Pragma/nosniff) en TODA
 *    respuesta del panel, incluidos errores y preflight.
 *  - crearCorsPanel: solo los orígenes exactos de la configuración; un
 *    origen rechazado no recibe Access-Control-Allow-Origin y su preflight
 *    se responde 403.
 *  - exigirJson + parser propio de 8 KB: toda escritura debe ser JSON.
 *  - crearAutenticar: Authorization: Bearer <token> estricto → identidad
 *    verificada por el servidor (req.identidadVerificada, congelada).
 *  - crearAutorizar: operador de la allowlist con el permiso pedido →
 *    req.operador, construido y congelado acá, no escribible. Nada del body,
 *    la query ni otros headers participa.
 *  - crearExigirPermiso: permiso adicional sobre el req.operador ya
 *    resuelto (p. ej. "decidir" después del gate de "ver").
 *  - manejarErroresPanel: { error: { codigo, mensaje, request_id } } con
 *    mensajes fijos; el detalle va solo al registro saneado. Únicas
 *    excepciones, ya armadas por lista blanca: `actual` en un 409 y
 *    `motivos` en un 422.
 */

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { ErrorTokenInvalido, ErrorAutenticacionNoDisponible, LARGO_MAXIMO_TOKEN } = require('../services/panel/verificar-token-google');
const { resolverOperadorPanel } = require('../services/panel/operadores-panel');
const { sanearTexto } = require('../utils/sanear-registro');

const LIMITE_BODY = '8kb';

// datos: bloque público (solo se usa el de DATOS_PUBLICOS[status]).
// causa: error original, solo para el registro de un 5xx.
class ErrorPanel extends Error {
  constructor(status, codigo, motivo = codigo, { datos = null, causa = null } = {}) {
    super(motivo);
    this.status = status;
    this.codigo = codigo;
    this.motivo = motivo;
    this.datos = datos;
    this.causa = causa;
  }
}

const DATOS_PUBLICOS = Object.freeze({ 409: 'actual', 422: 'motivos' });

const MENSAJES = Object.freeze({
  no_autenticado: 'Se requiere un token válido.',
  autenticacion_no_disponible: 'No se pudo verificar la autenticación. Probá de nuevo más tarde.',
  no_autorizado: 'No tenés permiso para usar el panel.',
  sin_permiso: 'No tenés permiso para esta acción.',
  origen_no_permitido: 'Origen no permitido.',
  no_disponible: 'El panel no está disponible.',
  no_encontrado: 'Recurso no encontrado.',
  cuerpo_demasiado_grande: 'El cuerpo de la solicitud es demasiado grande.',
  json_invalido: 'El cuerpo no es JSON válido.',
  tipo_no_soportado: 'El cuerpo debe ser application/json.',
  solicitud_invalida: 'Solicitud inválida.',
  propuesta_cambio: 'La propuesta cambió desde que la viste. Recargala antes de decidir.',
  propuesta_no_decidible: 'La propuesta no se puede decidir así: no pasó las verificaciones (ver motivos). Recargar no lo resuelve.',
  resultado_incierto: 'No se pudo confirmar si la decisión quedó registrada. Revisá la propuesta antes de reintentar.',
  error_interno: 'Error interno.'
});

const fijo = (obj, clave, valor) => Object.defineProperty(obj, clave, { value: valor, enumerable: true, writable: false, configurable: false });

function asignarRequestId(req, res, next) {
  const id = crypto.randomUUID();
  fijo(req, 'requestId', id);
  res.set('X-Request-Id', id);
  next();
}

function protecciones(req, res, next) {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  next();
}

function crearCorsPanel(origenes) {
  const permitidos = new Set(origenes);
  const corsPermitido = cors({
    origin: (origen, cb) => cb(null, typeof origen === 'string' && permitidos.has(origen)),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-Id'],
    credentials: false,
    maxAge: 600,
    optionsSuccessStatus: 204
  });
  return [
    corsPermitido,
    // Llega acá solo si cors no respondió: un preflight de un origen no
    // permitido (sin Access-Control-Allow-Origin).
    (req, res, next) => (req.method === 'OPTIONS' ? next(new ErrorPanel(403, 'origen_no_permitido')) : next())
  ];
}

function exigirJson(req, res, next) {
  const conCuerpo = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (conCuerpo && !req.is('application/json')) return next(new ErrorPanel(415, 'tipo_no_soportado'));
  next();
}

const parserJson = express.json({ limit: LIMITE_BODY, strict: true, type: 'application/json' });

const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

function crearAutenticar(verificador) {
  return async function autenticar(req, res, next) {
    const h = req.headers.authorization;
    if (h === undefined) throw new ErrorTokenInvalido('sin_token');
    if (typeof h !== 'string' || h.length > LARGO_MAXIMO_TOKEN + 'Bearer '.length) throw new ErrorTokenInvalido('demasiado_largo');
    const m = BEARER.exec(h);
    if (!m) throw new ErrorTokenInvalido('formato_autorizacion');
    const identidad = await verificador.verificar(m[1]);
    fijo(req, 'identidadVerificada', Object.freeze({ ...identidad }));
    next();
  };
}

function crearAutorizar(operadores, permiso) {
  return function autorizar(req, res, next) {
    const op = resolverOperadorPanel(req.identidadVerificada, operadores);
    if (!op) throw new ErrorPanel(403, 'no_autorizado');
    if (!op.permisos.includes(permiso)) throw new ErrorPanel(403, 'sin_permiso', `sin_permiso_${permiso}`);
    fijo(req, 'operador', op);
    next();
  };
}

// Después de crearAutorizar: no vuelve a resolver el operador.
function crearExigirPermiso(permiso) {
  return function exigirPermiso(req, res, next) {
    if (!req.operador?.permisos?.includes(permiso)) throw new ErrorPanel(403, 'sin_permiso', `sin_permiso_${permiso}`);
    next();
  };
}

// Clasifica cualquier error en { status, codigo, motivo }.
function clasificar(err) {
  if (err instanceof ErrorPanel) return { status: err.status, codigo: err.codigo, motivo: err.motivo };
  if (err instanceof ErrorTokenInvalido) return { status: 401, codigo: 'no_autenticado', motivo: err.motivo };
  if (err instanceof ErrorAutenticacionNoDisponible) return { status: 503, codigo: 'autenticacion_no_disponible', motivo: err.motivo };
  switch (err?.type) {
    case 'entity.too.large':
      return { status: 413, codigo: 'cuerpo_demasiado_grande', motivo: 'limite_body' };
    case 'entity.parse.failed':
      return { status: 400, codigo: 'json_invalido', motivo: 'json_invalido' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { status: 415, codigo: 'tipo_no_soportado', motivo: err.type };
    default:
      break;
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) return { status: 400, codigo: 'solicitud_invalida', motivo: 'solicitud_invalida' };
  return { status: 500, codigo: 'error_interno', motivo: 'error_interno' };
}

function manejarErroresPanel(registrar) {
  // eslint-disable-next-line no-unused-vars
  return function manejarErrores(err, req, res, next) {
    const { status, codigo, motivo } = clasificar(err);
    const original = err instanceof ErrorPanel && err.causa ? err.causa : err;
    const clave = DATOS_PUBLICOS[status];
    const datos = err instanceof ErrorPanel && clave && err.datos && Object.hasOwn(err.datos, clave) ? { [clave]: err.datos[clave] } : {};
    registrar({
      nivel: status >= 500 ? 'error' : 'aviso',
      evento: 'panel_error',
      request_id: req.requestId ?? null,
      metodo: req.method,
      ruta: req.baseUrl + req.path, // sin query string
      status,
      codigo,
      motivo,
      ...(status >= 500 ? { error: `${original?.name ?? 'Error'}: ${sanearTexto(original?.message ?? original)}` } : {})
    });
    if (status === 401) res.set('WWW-Authenticate', 'Bearer');
    res.status(status).json({ error: { codigo, mensaje: MENSAJES[codigo], request_id: req.requestId ?? null, ...datos } });
  };
}

module.exports = {
  LIMITE_BODY,
  MENSAJES,
  ErrorPanel,
  asignarRequestId,
  protecciones,
  crearCorsPanel,
  exigirJson,
  parserJson,
  crearAutenticar,
  crearAutorizar,
  crearExigirPermiso,
  clasificar,
  manejarErroresPanel
};
