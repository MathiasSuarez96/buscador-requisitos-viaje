/**
 * Lectura de propuestas para el panel (solo lectura, driver NATIVO).
 *
 * No registra modelos de Mongoose ni importa servicios que los registren
 * (aplicar-propuesta.js, decidir-propuesta.js): recibe `obtenerDb()` y lee
 * con db.collection(...). Así se preserva la diferencia entre un campo
 * AUSENTE y un campo en null (sin hidratación ni defaults de schema) y el
 * panel no puede disparar autoCreate/autoIndex.
 *
 * LISTADO (GET /api/panel/propuestas?estado=&limite=&cursor=)
 *   filtro:  { estado: { $in: estados } } (+ { _id: { $lt: cursor } })
 *   orden:   { _id: -1 } — total y determinista (_id es único). ObjectId
 *            crece con el tiempo de creación, así que es "más nuevas
 *            primero" con desempate implícito.
 *   límite:  limite + 1 para saber si hay página siguiente.
 *   cursor:  "v1.<_id hex de la última propuesta>.<máscara de estados>"
 *            (máscara: 2 hex, un bit por estado de ESTADOS_PROPUESTA).
 *            Opaco para el cliente, sin JSON ni base64 (no se parece a un
 *            token) y atado al filtro: uno de otro filtro se rechaza (400).
 *   destino: después de leer la página, UNA sola lectura de destinos
 *            (nunca una por propuesta): destinos.find({ _id: { $in } }) con
 *            los destino_id DEL DOCUMENTO de la página (nunca los de
 *            payload), únicos y ordenados, sin el documento extra del
 *            límite + 1, y proyección { _id, pais, codigo_iso }. Usa el
 *            índice _id_. Sin ids válidos no se consulta. Un destino_id
 *            null, inválido o inexistente → destino: null. Si la lectura
 *            falla, falla todo el listado (el error no se traga).
 *   Sin acciones: el listado no lee eventos ni requisitos de los destinos
 *   y nunca afirma que una propuesta sea aplicable. Solo alertas locales
 *   (hash, consistencia).
 *
 * DETALLE (GET /api/panel/propuestas/:propuesta_id)
 *   1. propuestas_cambio.findOne({ propuesta_id })
 *   2-4. evaluarIntegridad (la MISMA función que usa la aprobación POST):
 *      hash recalculado en el servidor (hashSobreCanonico);
 *      destinos.findOne({ _id: ObjectId(payload.destino_id) }) con
 *      proyección { pais, codigo_iso, requisitos }; identidad con
 *      clasificarIdentidadRequisito + validarIdentidad del adaptador;
 *      valor actual del campo { presente, valor } contra valor_anterior
 *   5. eventos_propuesta.find({ propuesta_id }) ordenado por
 *      { version_coordinacion_nueva: 1, _id: 1 }, con proyección que NO
 *      trae detalle.identidad_operador (sub, email, usuario_atlas).
 *   requisito_actual.destino: destinoSeguro, el mismo saneamiento que el
 *   destino del listado.
 *   acciones_bloqueadas: { aprobar: [...], rechazar: [...] }, los motivos
 *   por los que cada acción NO está disponible ([] = permitida):
 *     - coordinación (ambas): payload_hash_invalido,
 *       version_coordinacion_invalida, decision_previa_existente;
 *     - integridad (solo aprobar): hash_no_coincide, datos_inconsistentes,
 *       requisito_no_coincide, valor_actual_cambio;
 *     - estado y permiso (ambas): estado_no_permite_decision,
 *       sin_permiso_decidir.
 *   acciones_permitidas: las de lista vacía, en orden ['aprobar', 'rechazar'].
 *   Regla: el panel solo ofrece una decisión si puede construir un body
 *   válido y el CAS puede coincidir con los datos actuales (payload_hash
 *   SHA-256 hex, version_coordinacion entero seguro >= 0 y, si está
 *   pendiente, decision_aprobacion_id null).
 *
 * Nunca se devuelve: el payload canónico, fragmento_html ni ningún otro
 * campo de la evidencia fuera de la lista blanca, identidad_operador
 * (sub, email, usuario_atlas), tokens, URIs ni mensajes de error internos.
 * Toda respuesta se construye campo por campo: nada se copia con spread
 * desde un documento leído.
 */

const { ObjectId } = require('bson');
const { hashSobreCanonico, canonicalizarValor, SHA256_HEX } = require('../propuestas/canonicalizacion-propuestas');
const { ESTADOS_PROPUESTA } = require('../propuestas/contrato-propuestas');
const { clasificarIdentidadRequisito } = require('../propuestas/identidad-requisito');
const { ErrorSinAdaptador, elegirAdaptador } = require('../propuestas/adaptadores');
const { validarSobreRequisitoV2 } = require('../propuestas/payload-requisito-v2');
const { ErrorContratoRequisitoV2, capturarIdentidadEInstantanea } = require('../propuestas/contrato-requisito-v2');
const { sanearTexto } = require('../../utils/sanear-registro');

const COLECCIONES = Object.freeze({ propuestas: 'propuestas_cambio', eventos: 'eventos_propuesta', destinos: 'destinos' });
const ESTADO_POR_DEFECTO = 'pendiente_aprobacion';
const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 50;
const MAXIMO_EVENTOS = 200;
// Mismo allowlist que PropuestaCambio (CAMPOS_PROPONIBLES); copiado para no
// registrar el modelo.
const CAMPOS_PROPONIBLES = Object.freeze(['costo']);
const PARAMETROS_LISTADO = Object.freeze(['estado', 'limite', 'cursor']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const CURSOR = /^v1\.([0-9a-f]{24})\.([0-9a-f]{2})$/;
const CODIGO_ISO = /^[A-Z]{2}$/;
const CODIGO_V2 = /^[a-z0-9_]{1,80}$/;
const CAMPOS_REQUISITO_V2 = Object.freeze(['obligatorio', 'recomendado', 'descripcion', 'fuente', 'link', 'plazo_antes_del_vuelo', 'estado']);
// Entrada inválida del cliente → 400 solicitud_invalida en la ruta.
class ErrorConsultaInvalida extends Error {}
// Sin conexión a Mongo → 503 no_disponible en la ruta (se registra como error).
class ErrorLecturaNoDisponible extends Error {}

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texto = (v, max = 200) => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max)}…` : v) : null);
const fechaIso = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'string' && v.length <= 40 && !Number.isNaN(new Date(v).getTime())) return v;
  return null;
};
const hexDe = (v) => {
  if (v instanceof ObjectId || v?._bsontype === 'ObjectId') return v.toHexString();
  return typeof v === 'string' && OBJECT_ID_HEX.test(v) ? v : null;
};
const urlHttp = (v) => (typeof v === 'string' && v.length <= 500 && /^https?:\/\/[^\s<>"']+$/.test(v) ? v : null);
// Texto libre que llega a una respuesta: sin marcas HTML, saneado (tokens,
// JWT, URIs) y sin ningún "<" ni ">" (los marcadores de redacción quedan
// como "redactado"), recortado.
const textoSeguro = (v, max = 300) =>
  typeof v === 'string' ? texto(sanearTexto(v.replace(/<[^>]*>?/g, '')).replace(/[<>]/g, '').trim(), max) : null;

// ------------------------------------------------------------------
// Entrada (puras)
// ------------------------------------------------------------------

function falla(m) {
  throw new ErrorConsultaInvalida(m);
}

// Pura. Lista canónica de estados (sin repetidos, en el orden de
// ESTADOS_PROPUESTA). `valor` es el string crudo de la query o undefined.
function validarEstados(valor) {
  if (valor === undefined) return [ESTADO_POR_DEFECTO];
  if (typeof valor !== 'string' || valor === '' || valor.length > 300) falla('estado');
  const pedidos = valor.split(',');
  if (pedidos.some((e) => !ESTADOS_PROPUESTA.includes(e))) falla('estado_desconocido');
  if (new Set(pedidos).size !== pedidos.length) falla('estado_repetido');
  return ESTADOS_PROPUESTA.filter((e) => pedidos.includes(e));
}

function validarLimite(valor) {
  if (valor === undefined) return LIMITE_POR_DEFECTO;
  if (typeof valor !== 'string' || !/^[1-9][0-9]{0,2}$/.test(valor)) falla('limite');
  const n = Number(valor);
  if (n > LIMITE_MAXIMO) falla('limite');
  return n;
}

const mascaraEstados = (estados) =>
  ESTADOS_PROPUESTA.reduce((m, e, i) => (estados.includes(e) ? m | (1 << i) : m), 0)
    .toString(16)
    .padStart(2, '0');

function codificarCursor(despuesDe, estados) {
  return `v1.${despuesDe}.${mascaraEstados(estados)}`;
}

// Pura. Devuelve el ObjectId desde el que seguir (exclusivo) o null.
function validarCursor(valor, estados) {
  if (valor === undefined) return null;
  const m = typeof valor === 'string' ? CURSOR.exec(valor) : null;
  if (!m) falla('cursor');
  if (m[2] !== mascaraEstados(estados)) falla('cursor_de_otro_filtro');
  return ObjectId.createFromHexString(m[1]);
}

// Pura. query: req.query de Express. Solo estado, limite y cursor, cada uno
// como string único (un parámetro repetido llega como array → inválido).
function validarConsultaListado(query) {
  if (!esObjeto(query)) falla('query');
  const extras = Object.keys(query).filter((k) => !PARAMETROS_LISTADO.includes(k));
  if (extras.length > 0) falla('parametro_no_admitido');
  const estados = validarEstados(query.estado);
  const limite = validarLimite(query.limite);
  const despuesDe = validarCursor(query.cursor, estados);
  return { estados, limite, despuesDe };
}

function validarPropuestaId(valor) {
  if (typeof valor !== 'string' || !UUID.test(valor)) falla('propuesta_id');
  return valor;
}

// Puras. Consultas exactas (las pruebas las comparan contra lo enviado).
function consultaListado({ estados, limite, despuesDe }) {
  const filtro = { estado: { $in: [...estados] } };
  if (despuesDe) filtro._id = { $lt: despuesDe };
  return {
    filtro,
    opciones: {
      sort: { _id: -1 },
      limit: limite + 1,
      projection: {
        _id: 1,
        propuesta_id: 1,
        estado: 1,
        campo: 1,
        destino_id: 1,
        requisito_id: 1,
        run_id_origen: 1,
        payload: 1,
        payload_hash: 1,
        algoritmo_canonicalizacion: 1,
        algoritmo_hash: 1,
        version_coordinacion: 1,
        createdAt: 1,
        updatedAt: 1
      }
    }
  };
}

// Pura. Lectura de destinos de una página del listado: destino_id del
// documento (no del payload), únicos y ordenados. null = no hay nada que
// leer. `propuestas`: la página, ya sin el documento extra del límite + 1.
function consultaDestinosListado(propuestas) {
  const ids = [...new Set(propuestas.map((p) => hexDe(p.destino_id)).filter((h) => h !== null))].sort();
  if (ids.length === 0) return null;
  return {
    filtro: { _id: { $in: ids.map((h) => ObjectId.createFromHexString(h)) } },
    opciones: { projection: { _id: 1, pais: 1, codigo_iso: 1 } }
  };
}

const PROYECCION_EVENTOS = Object.freeze({
  _id: 1,
  evento_id: 1,
  tipo_evento: 1,
  estado_anterior: 1,
  estado_nuevo: 1,
  ocurrido_en: 1,
  version_coordinacion_nueva: 1,
  hash_contenido_referenciado: 1,
  actor: 1,
  motivo: 1,
  intento_aplicacion_id: 1,
  'detalle.comando.nombre': 1,
  'detalle.identidad_operador.metodo': 1
});

// ------------------------------------------------------------------
// Integridad y resúmenes (puras)
// ------------------------------------------------------------------

// Pura. { coincide, recalculado } — recalculado null si el sobre no se
// puede canonicalizar o declara un algoritmo no soportado.
function verificarHash(p) {
  let recalculado = null;
  try {
    recalculado = hashSobreCanonico(p.payload, p.algoritmo_canonicalizacion, p.algoritmo_hash);
  } catch {
    recalculado = null;
  }
  const declarado = typeof p.payload_hash === 'string' && SHA256_HEX.test(p.payload_hash) ? p.payload_hash : null;
  return { coincide: recalculado !== null && declarado !== null && recalculado === declarado, declarado, recalculado };
}

const esValorConPresencia = (v) =>
  esObjeto(v) && typeof v.presente === 'boolean' && Object.hasOwn(v, 'valor') && (v.presente || v.valor === null) && (v.valor === null || typeof v.valor === 'string');

// Pura. Códigos de inconsistencia entre el documento y su payload
// ([] = consistente).
function problemasConsistencia(p) {
  const problemas = [];
  const pl = p.payload;
  if (!esObjeto(pl)) return ['payload_invalido'];
  if (pl.propuesta_id !== p.propuesta_id) problemas.push('propuesta_id_distinto');
  if (hexDe(p.destino_id) === null || hexDe(p.destino_id) !== pl.destino_id) problemas.push('destino_id_distinto');
  if (hexDe(p.requisito_id) === null || hexDe(p.requisito_id) !== pl.requisito_id) problemas.push('requisito_id_distinto');
  if (p.campo !== pl.campo) problemas.push('campo_distinto');
  if (!CAMPOS_PROPONIBLES.includes(pl.campo)) problemas.push('campo_no_soportado');
  if (!esValorConPresencia(pl.valor_anterior)) problemas.push('valor_anterior_invalido');
  if (!esObjeto(pl.valor_propuesto) || typeof pl.valor_propuesto.valor !== 'string') problemas.push('valor_propuesto_invalido');
  return problemas;
}

// Pura. En 2.0 los identificadores externos siguen siendo parte de la
// integridad del documento, aunque la forma del payload sea distinta de 1.0.
function problemasConsistenciaV2(p) {
  const problemas = [];
  const pl = p.payload;
  if (!esObjeto(pl)) return ['payload_invalido'];
  if (pl.propuesta_id !== p.propuesta_id) problemas.push('propuesta_id_distinto');
  if (hexDe(p.destino_id) === null || hexDe(p.destino_id) !== pl.destino_id) problemas.push('destino_id_distinto');
  if (hexDe(p.requisito_id) === null || hexDe(p.requisito_id) !== pl.requisito_id) problemas.push('requisito_id_distinto');
  if (p.run_id_origen !== pl.run_id_origen) problemas.push('run_id_origen_distinto');
  if (p.campo !== 'requisito' || pl.campo !== 'requisito') problemas.push('campo_distinto');
  return problemas;
}

const valorConPresencia = (v) => (esValorConPresencia(v) ? { presente: v.presente, valor: v.valor } : null);

function valorPropuestoSeguro(pl) {
  const vp = esObjeto(pl?.valor_propuesto) ? pl.valor_propuesto : {};
  const vn = esObjeto(vp.valor_normalizado) ? vp.valor_normalizado : {};
  return {
    valor: texto(vp.valor, 100),
    importe: Number.isInteger(vn.importe) ? vn.importe : null,
    moneda: typeof vn.moneda === 'string' && /^[A-Z]{3}$/.test(vn.moneda) ? vn.moneda : null
  };
}

function fuenteSegura(pl) {
  const f = esObjeto(pl?.fuente) ? pl.fuente : {};
  return { nombre: texto(f.nombre, 100), url: urlHttp(f.url), capturado_en: fechaIso(f.capturado_en) };
}

function valorCapturadoSeguro(valor) {
  if (!esObjeto(valor) || typeof valor.presente !== 'boolean' || !['ausente', 'null', 'string'].includes(valor.bson_tipo)) return null;
  if (valor.bson_tipo === 'ausente' && valor.presente === false && valor.valor === null) return { presente: false, bson_tipo: 'ausente', valor: null };
  if (valor.bson_tipo === 'null' && valor.presente === true && valor.valor === null) return { presente: true, bson_tipo: 'null', valor: null };
  if (valor.bson_tipo === 'string' && valor.presente === true && typeof valor.valor === 'string' && valor.valor.length <= 10_000) return { presente: true, bson_tipo: 'string', valor: valor.valor };
  return null;
}

// Proyección pública mínima del contrato 2.0. No expone la instantánea
// completa, identidad, hechos, hashes de fuentes ni run_id_origen.
function resumenRequisitoV2(pl) {
  if (!esObjeto(pl) || pl.version_contrato !== '2.0') return null;
  const cambios = [];
  let completo = Array.isArray(pl.cambios) && pl.cambios.length <= CAMPOS_REQUISITO_V2.length && esObjeto(pl.instantanea_anterior);
  if (Array.isArray(pl.cambios) && esObjeto(pl.instantanea_anterior)) {
    for (const cambio of pl.cambios.slice(0, CAMPOS_REQUISITO_V2.length)) {
      if (!esObjeto(cambio) || !CAMPOS_REQUISITO_V2.includes(cambio.campo)) { completo = false; continue; }
      const anterior = valorCapturadoSeguro(pl.instantanea_anterior[cambio.campo]);
      const propuesto = valorCapturadoSeguro(cambio.propuesto);
      if (anterior && propuesto) cambios.push({ campo: cambio.campo, anterior, propuesto });
      else completo = false;
    }
  }
  const advertencias = Array.isArray(pl.advertencias)
    ? [...new Set(pl.advertencias.filter((a) => typeof a === 'string' && CODIGO_V2.test(a)))].sort().slice(0, 20)
    : [];
  return { completo, cambios, advertencias };
}

// Pura. Resumen SEGURO de la evidencia: solo fuente, URL, fechas, valor
// extraído, moneda, secciones (sin fragmento_html) y avisos saneados.
function resumenEvidencia(pl) {
  const ev = esObjeto(pl?.valor_propuesto?.evidencia) ? pl.valor_propuesto.evidencia : {};
  const fuente = fuenteSegura(pl);
  const vp = valorPropuestoSeguro(pl);
  const fg = esObjeto(ev.fuente_govuk) ? ev.fuente_govuk : {};
  const extraccion = esObjeto(ev.extraccion) ? ev.extraccion : {};
  const secciones = Object.keys(extraccion)
    .filter((k) => /^[a-z_]{1,32}$/.test(k) && esObjeto(extraccion[k]))
    .slice(0, 5)
    .map((k) => ({
      seccion: k,
      costo_extraido: Number.isInteger(extraccion[k].costo_extraido) ? extraccion[k].costo_extraido : null,
      moneda: typeof extraccion[k].moneda === 'string' && /^[A-Z]{3}$/.test(extraccion[k].moneda) ? extraccion[k].moneda : null
    }));
  const comparacion = esObjeto(ev.comparacion_govuk) ? ev.comparacion_govuk : {};
  const avisos = (Array.isArray(ev.avisos) ? ev.avisos : []).filter((a) => typeof a === 'string').slice(0, 10).map((a) => textoSeguro(a, 200));
  return {
    fuente: fuente.nombre,
    url: fuente.url,
    capturado_en: fuente.capturado_en,
    fuente_actualizada_en: fechaIso(fg.public_updated_at),
    valor_extraido: vp.valor,
    importe: vp.importe,
    moneda: vp.moneda,
    secciones,
    coincide_entre_secciones: typeof comparacion.coincide_entre_secciones === 'boolean' ? comparacion.coincide_entre_secciones : null,
    avisos
  };
}

// Pura. pais PARA MOSTRAR, en este orden:
//  1. no string, o string mal formado (sustituto Unicode aislado) → null
//     entero: es un dato corrupto y no se muestra a medias;
//  2. cada tramo de caracteres de control o separadores de línea (\n, \r,
//     \t, U+0085, U+2028, U+2029, ...) → UN espacio; los espacios comunes
//     no se tocan;
//  3. sin marcas HTML, saneado (tokens, JWT, URIs), sin "<" ni ">", sin
//     espacios en los extremos;
//  4. vacío → null; más de 100 code points → los primeros 100 y "…" (el
//     corte nunca parte un par sustituto).
// Solo afecta lo que se muestra: la integridad lee el documento original.
function paisSeguro(valor) {
  if (typeof valor !== 'string' || !valor.isWellFormed()) return null;
  const limpio = sanearTexto(valor.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/<[^>]*>?/g, ''))
    .replace(/[<>]/g, '')
    .trim();
  if (limpio === '') return null;
  const puntos = Array.from(limpio);
  return puntos.length > 100 ? `${puntos.slice(0, 100).join('')}…` : limpio;
}

// Pura. Destino por lista blanca, el MISMO en el listado y en
// requisito_actual.destino del detalle: pais con paisSeguro; codigo_iso
// solo si son dos letras mayúsculas (no se corrige). null si no hay
// destino o su _id no es un ObjectId. Nunca devuelve requisitos ni otros
// campos.
function destinoSeguro(destino) {
  if (!esObjeto(destino)) return null;
  const destinoId = hexDe(destino._id);
  if (destinoId === null) return null;
  return {
    destino_id: destinoId,
    pais: paisSeguro(destino.pais),
    codigo_iso: typeof destino.codigo_iso === 'string' && CODIGO_ISO.test(destino.codigo_iso) ? destino.codigo_iso : null
  };
}

// Pura. Ítem del listado con `destino` justo después de destino_id; el
// resto de los campos, sin cambios.
function conDestino(resumen, destino) {
  const item = {};
  for (const [clave, valor] of Object.entries(resumen)) {
    item[clave] = valor;
    if (clave === 'destino_id') item.destino = destino;
  }
  return item;
}

function resumenListado(p) {
  const hash = verificarHash(p);
  const problemas = p.payload?.version_contrato === '2.0' ? problemasConsistenciaV2(p) : problemasConsistencia(p);
  const alertas = [];
  if (!hash.coincide) alertas.push('hash_no_coincide');
  if (problemas.length > 0) alertas.push('datos_inconsistentes');
  const pl = esObjeto(p.payload) ? p.payload : {};
  return {
    propuesta_id: texto(p.propuesta_id, 36),
    estado: ESTADOS_PROPUESTA.includes(p.estado) ? p.estado : null,
    campo: texto(p.campo, 50),
    destino_id: hexDe(p.destino_id),
    requisito_id: hexDe(p.requisito_id),
    valor_anterior: valorConPresencia(pl.valor_anterior),
    valor_propuesto: valorPropuestoSeguro(pl),
    fuente: fuenteSegura(pl),
    version_coordinacion: Number.isInteger(p.version_coordinacion) ? p.version_coordinacion : null,
    creada_en: fechaIso(p.createdAt),
    actualizada_en: fechaIso(p.updatedAt),
    alertas
  };
}

// Pura. Identificadores con forma de email se ocultan salvo que sean del
// propio operador (no se exponen emails de otros operadores).
function actorSeguro(actor, operador) {
  const tipo = actor?.tipo === 'humano' || actor?.tipo === 'sistema' ? actor.tipo : null;
  let identificador = texto(actor?.identificador, 100);
  if (identificador !== null && identificador.includes('@') && identificador !== operador.identificador) identificador = '(oculto)';
  return { tipo, identificador };
}

const ORIGENES_CONOCIDOS = ['decidir-propuesta', 'panel-propuestas', 'aplicar-propuesta'];
const METODOS_CONOCIDOS = ['connection_status', 'oidc_google'];

function eventoSeguro(e, operador) {
  const origen = e.detalle?.comando?.nombre;
  const metodo = e.detalle?.identidad_operador?.metodo;
  return {
    evento_id: texto(e.evento_id, 36),
    tipo_evento: texto(e.tipo_evento, 50),
    estado_anterior: ESTADOS_PROPUESTA.includes(e.estado_anterior) ? e.estado_anterior : null,
    estado_nuevo: ESTADOS_PROPUESTA.includes(e.estado_nuevo) ? e.estado_nuevo : null,
    ocurrido_en: fechaIso(e.ocurrido_en),
    version_coordinacion_nueva: Number.isInteger(e.version_coordinacion_nueva) ? e.version_coordinacion_nueva : null,
    hash_contenido_referenciado: typeof e.hash_contenido_referenciado === 'string' && SHA256_HEX.test(e.hash_contenido_referenciado) ? e.hash_contenido_referenciado : null,
    actor: actorSeguro(e.actor, operador),
    origen: ORIGENES_CONOCIDOS.includes(origen) ? origen : null,
    metodo_identidad: METODOS_CONOCIDOS.includes(metodo) ? metodo : null,
    motivo: textoSeguro(e.motivo, 500),
    intento_aplicacion_id: typeof e.intento_aplicacion_id === 'string' && UUID.test(e.intento_aplicacion_id) ? e.intento_aplicacion_id : null
  };
}

// Pura. Valor realmente presente en el subdocumento, distinguiendo ausente
// de null explícito (misma regla que observarValor en aplicar-propuesta.js).
function observarValor(requisito, campo) {
  const presente = Object.hasOwn(requisito, campo) && requisito[campo] !== undefined;
  return { presente, valor: presente ? requisito[campo] : null };
}

const mismoValorConPresencia = (a, b) => a.presente === b.presente && (a.valor ?? null) === (b.valor ?? null);

// Pura. Estado del requisito actual frente a la propuesta.
//   estado: coincide | destino_no_encontrado | requisito_id_no_encontrado |
//           requisito_id_duplicado | identidad_semantica_no_coincide |
//           identidad_no_verificable | no_evaluable
//   valor_actual: { presente, valor } del campo (null si no hay requisito)
//   valor: coincide | cambio | null (no evaluable)
function evaluarRequisitoActual(p, destino, adaptador) {
  const pl = esObjeto(p.payload) ? p.payload : {};
  const destinoPublico = destinoSeguro(destino);
  const vacio = (estado) => ({ estado, destino: destinoPublico, requisito: null, valor_actual: null, valor: null });
  if (typeof pl.requisito_id !== 'string' || !OBJECT_ID_HEX.test(pl.requisito_id)) return vacio('no_evaluable');

  const validarIdentidad = adaptador ? adaptador.validarIdentidad : () => ({ ok: true });
  const c = clasificarIdentidadRequisito(destino, pl.requisito_id, validarIdentidad);
  if (!c.ok && c.categoria !== 'identidad_semantica_no_coincide') return vacio(c.categoria);

  const req = c.ok
    ? c.requisito
    : destino.requisitos.find((r) => esObjeto(r) && r._id != null && String(r._id) === pl.requisito_id);
  const requisito = { requisito_id: hexDe(req._id), tipo: texto(req.tipo, 50), nombre: texto(req.nombre, 100) };
  const campo = CAMPOS_PROPONIBLES.includes(pl.campo) ? pl.campo : null;
  const valorActual = campo ? observarValor(req, campo) : null;
  const valorActualSeguro = valorActual ? { presente: valorActual.presente, valor: valorActual.valor === null ? null : texto(String(valorActual.valor), 100) } : null;
  const anterior = valorConPresencia(pl.valor_anterior);
  const valor = valorActual && anterior ? (mismoValorConPresencia(valorActual, anterior) ? 'coincide' : 'cambio') : null;
  let estado = 'coincide';
  if (!c.ok) estado = 'identidad_semantica_no_coincide';
  else if (!adaptador) estado = 'identidad_no_verificable';
  return { estado, destino: destinoPublico, requisito, valor_actual: valorActualSeguro, valor };
}

// Pura. En 2.0 no existe un único campo/valor_anterior: la precondición es
// la identidad y la instantánea completa del requisito.
function evaluarRequisitoActualV2(p, destino) {
  const pl = esObjeto(p.payload) ? p.payload : {};
  const destinoPublico = destinoSeguro(destino);
  const vacio = (estado) => ({ estado, destino: destinoPublico, requisito: null, valor_actual: null, valor: null });
  if (!esObjeto(destino)) return vacio('destino_no_encontrado');
  if (typeof pl.requisito_id !== 'string' || !OBJECT_ID_HEX.test(pl.requisito_id)) return vacio('no_evaluable');
  const coincidencias = Array.isArray(destino.requisitos)
    ? destino.requisitos.filter((r) => esObjeto(r) && r._id != null && String(r._id) === pl.requisito_id)
    : [];
  if (coincidencias.length === 0) return vacio('requisito_id_no_encontrado');
  if (coincidencias.length > 1) return vacio('requisito_id_duplicado');
  const req = coincidencias[0];
  const requisito = { requisito_id: hexDe(req._id), tipo: texto(req.tipo, 50), nombre: texto(req.nombre, 100) };
  try {
    const capturado = capturarIdentidadEInstantanea(req);
    const igual = (a, b) => JSON.stringify(canonicalizarValor(a)) === JSON.stringify(canonicalizarValor(b));
    if (!igual(capturado.identidad_requisito, pl.identidad_requisito)) {
      return { estado: 'identidad_semantica_no_coincide', destino: destinoPublico, requisito, valor_actual: null, valor: null };
    }
    const coincide = igual(capturado.instantanea_anterior, pl.instantanea_anterior);
    return { estado: 'coincide', destino: destinoPublico, requisito, valor_actual: null, valor: coincide ? 'coincide' : 'cambio' };
  } catch (err) {
    if (err instanceof ErrorContratoRequisitoV2) return { estado: 'no_evaluable', destino: destinoPublico, requisito, valor_actual: null, valor: null };
    throw err;
  }
}

const ACCIONES = Object.freeze(['aprobar', 'rechazar', 'aplicar']);

// Pura. Precondiciones de COORDINACIÓN: sin ellas no se puede armar un body
// válido o el CAS no puede coincidir con los datos actuales. Bloquean
// aprobar y rechazar. decisionAprobacionId: el del documento, con ausente
// como null (así lo trata el filtro CAS).
function motivosCoordinacion({ hash, version, decisionAprobacionId, estado }) {
  const motivos = [];
  if (hash.declarado === null) motivos.push('payload_hash_invalido');
  if (!Number.isSafeInteger(version) || version < 0) motivos.push('version_coordinacion_invalida');
  if (estado === 'pendiente_aprobacion' && decisionAprobacionId !== null) motivos.push('decision_previa_existente');
  return motivos;
}

// Pura. Problemas de integridad que impiden APROBAR ([] = íntegra). Los
// mismos códigos usa el 422 propuesta_no_decidible de la aprobación. Un
// payload_hash inválido es de coordinación (motivosCoordinacion).
function motivosIntegridad({ hash, problemas, requisitoActual }) {
  const motivos = [];
  if (hash.declarado !== null && !hash.coincide) motivos.push('hash_no_coincide');
  if (problemas.length > 0) motivos.push('datos_inconsistentes');
  if (requisitoActual.estado !== 'coincide') motivos.push('requisito_no_coincide');
  if (requisitoActual.valor !== 'coincide') motivos.push('valor_actual_cambio');
  return motivos;
}

// Pura y compartida por GET y POST. Solo los errores esperados del contrato
// se traducen a un motivo público; un bug inesperado se propaga como 500.
function motivosIntegridadV2(p) {
  try {
    validarSobreRequisitoV2({
      algoritmo_canonicalizacion: p.algoritmo_canonicalizacion,
      algoritmo_hash: p.algoritmo_hash,
      payload: p.payload,
      payload_hash: p.payload_hash
    });
    return [];
  } catch (err) {
    if (err instanceof ErrorContratoRequisitoV2) return ['payload_2_invalido'];
    throw err;
  }
}

// Pura. Motivos por los que cada acción no está disponible; permitidas son
// las que quedan sin motivos. version/decisionAprobacionId: los del
// documento (el detalle los pasa siempre).
function calcularAcciones({ hash, problemas, requisitoActual, estado, operador, version = 0, versionContrato = '1.0', decisionAprobacionId = null, decisionAprobacionValida = true, motivosAprobacion = null }) {
  const coordinacion = motivosCoordinacion({ hash, version, decisionAprobacionId, estado });
  const idAprobacionValido = typeof decisionAprobacionId === 'string' && UUID.test(decisionAprobacionId);
  const bloqueos = [];
  if (estado !== 'pendiente_aprobacion') bloqueos.push('estado_no_permite_decision');
  if (!operador.permisos.includes('decidir')) bloqueos.push('sin_permiso_decidir');
  const integridad = motivosAprobacion ?? motivosIntegridad({ hash, problemas, requisitoActual });
  const acciones_bloqueadas = {
    aprobar: [...coordinacion, ...integridad, ...bloqueos],
    rechazar: [...coordinacion, ...bloqueos],
    aplicar: [
      ...coordinacion,
      ...integridad,
      ...(versionContrato === '2.0' ? ['contrato_2_no_aplicable'] : []),
      ...(estado === 'aprobada' ? [] : ['estado_no_permite_aplicar']),
      ...(operador.permisos.includes('aplicar') ? [] : ['sin_permiso_aplicar']),
      ...(decisionAprobacionValida && idAprobacionValido ? [] : ['decision_aprobacion_invalida'])
    ]
  };
  return { acciones_permitidas: ACCIONES.filter((a) => acciones_bloqueadas[a].length === 0), acciones_bloqueadas };
}

// ------------------------------------------------------------------
// Lector (I/O nativo, solo lecturas)
// ------------------------------------------------------------------

function elegirAdaptadorOpcional(p, adaptadores) {
  try {
    return adaptadores ? elegirAdaptador(p, adaptadores) : elegirAdaptador(p);
  } catch (err) {
    if (err instanceof ErrorSinAdaptador) return null;
    throw err;
  }
}

// Lectura + evaluación de integridad de una propuesta: ÚNICA fuente para el
// detalle GET y la aprobación POST. d: Db nativo; solo lee destinos (y solo
// si payload.destino_id es un ObjectId válido).
async function evaluarIntegridad(d, p, adaptadores) {
  const hash = verificarHash(p);
  const pl = esObjeto(p.payload) ? p.payload : {};
  const contrato2 = pl.version_contrato === '2.0';
  const problemas = contrato2 ? problemasConsistenciaV2(p) : problemasConsistencia(p);
  const motivosContrato = contrato2 ? motivosIntegridadV2(p) : [];
  let requisitoActual = { estado: 'no_evaluable', destino: null, requisito: null, valor_actual: null, valor: null };
  // Un payload 2.0 inválido se bloquea antes de consultar o comparar el
  // requisito vivo. Así un documento incompleto produce un 422 controlado.
  if (motivosContrato.length === 0 && typeof pl.destino_id === 'string' && OBJECT_ID_HEX.test(pl.destino_id)) {
    const destino = await d
      .collection(COLECCIONES.destinos)
      .findOne({ _id: ObjectId.createFromHexString(pl.destino_id) }, { projection: { pais: 1, codigo_iso: 1, requisitos: 1 } });
    requisitoActual = contrato2
      ? evaluarRequisitoActualV2(p, destino)
      : evaluarRequisitoActual(p, destino, elegirAdaptadorOpcional(p, adaptadores));
  }
  const motivosBase = motivosIntegridad({ hash, problemas, requisitoActual });
  return { hash, problemas, requisitoActual, motivos: [...motivosContrato, ...motivosBase] };
}

// obtenerDb: () => Db nativo conectado, o null/undefined si no hay conexión.
function crearLectorPropuestas({ obtenerDb, adaptadores } = {}) {
  if (typeof obtenerDb !== 'function') throw new TypeError('crearLectorPropuestas: obtenerDb es obligatorio.');
  const db = () => {
    const d = obtenerDb();
    if (!d || typeof d.collection !== 'function') throw new ErrorLecturaNoDisponible('sin_conexion_mongo');
    return d;
  };

  // Mapa hex → documento de destino leído (sin sanear todavía).
  async function leerDestinosListado(d, pagina) {
    const consulta = consultaDestinosListado(pagina);
    if (consulta === null) return new Map();
    const docs = await d.collection(COLECCIONES.destinos).find(consulta.filtro, consulta.opciones).toArray();
    return new Map(docs.map((doc) => [hexDe(doc._id), doc]));
  }

  async function listar(consulta) {
    const d = db();
    const { filtro, opciones } = consultaListado(consulta);
    const docs = await d.collection(COLECCIONES.propuestas).find(filtro, opciones).toArray();
    const pagina = docs.slice(0, consulta.limite);
    const hayMas = docs.length > consulta.limite;
    const destinos = await leerDestinosListado(d, pagina);
    const destinoDe = (p) => {
      const hex = hexDe(p.destino_id);
      return hex !== null && destinos.has(hex) ? destinoSeguro(destinos.get(hex)) : null;
    };
    return {
      propuestas: pagina.map((p) => conDestino(resumenListado(p), destinoDe(p))),
      filtro: { estados: [...consulta.estados] },
      limite: consulta.limite,
      siguiente_cursor: hayMas ? codificarCursor(hexDe(pagina.at(-1)._id), consulta.estados) : null
    };
  }

  // null si no existe.
  async function detalle(propuestaId, operador) {
    const d = db();
    const p = await d.collection(COLECCIONES.propuestas).findOne({ propuesta_id: propuestaId });
    if (!p) return null;

    const { hash, problemas, requisitoActual, motivos } = await evaluarIntegridad(d, p, adaptadores);
    const pl = esObjeto(p.payload) ? p.payload : {};

    const eventos = await d
      .collection(COLECCIONES.eventos)
      .find({ propuesta_id: propuestaId }, { sort: { version_coordinacion_nueva: 1, _id: 1 }, limit: MAXIMO_EVENTOS + 1, projection: PROYECCION_EVENTOS })
      .toArray();
    let aprobacionValida = false;
    if (typeof p.decision_aprobacion_id === 'string' && UUID.test(p.decision_aprobacion_id)) {
      const aprobacion = await d.collection(COLECCIONES.eventos).findOne({ evento_id: p.decision_aprobacion_id });
      aprobacionValida = aprobacion?.evento_id === p.decision_aprobacion_id && aprobacion.tipo_evento === 'aprobacion' &&
        aprobacion.propuesta_id === propuestaId && aprobacion.estado_anterior === 'pendiente_aprobacion' && aprobacion.estado_nuevo === 'aprobada' &&
        aprobacion.hash_contenido_referenciado === p.payload_hash && aprobacion.version_coordinacion_nueva === p.version_coordinacion &&
        aprobacion.actor?.tipo === 'humano' && p.ultimo_evento_id === p.decision_aprobacion_id;
    }

    const base = resumenListado(p);
    const resumen2 = resumenRequisitoV2(pl);
    const motivosDetalle = pl.version_contrato === '2.0' && resumen2?.completo !== true ? [...motivos, 'resumen_2_incompleto'] : motivos;
    delete base.alertas;
    return {
      propuesta: {
        ...base,
        version_contrato: pl.version_contrato === '2.0' ? '2.0' : '1.0',
        requisito_v2: resumen2,
        payload_hash: hash.declarado,
        decision_aprobacion_id: typeof p.decision_aprobacion_id === 'string' && UUID.test(p.decision_aprobacion_id) ? p.decision_aprobacion_id : null,
        ultimo_evento_id: typeof p.ultimo_evento_id === 'string' && UUID.test(p.ultimo_evento_id) ? p.ultimo_evento_id : null,
        evidencia: resumenEvidencia(pl)
      },
      integridad: {
        hash_coincide: hash.coincide,
        hash_recalculado: hash.recalculado,
        consistente: problemas.length === 0,
        problemas
      },
      requisito_actual: requisitoActual,
      eventos: eventos.slice(0, MAXIMO_EVENTOS).map((e) => eventoSeguro(e, operador)),
      eventos_truncados: eventos.length > MAXIMO_EVENTOS,
      ...calcularAcciones({
        hash,
        problemas,
        requisitoActual,
        estado: p.estado,
        operador,
        version: p.version_coordinacion ?? null,
        versionContrato: pl.version_contrato,
        decisionAprobacionId: p.decision_aprobacion_id ?? null,
        decisionAprobacionValida: aprobacionValida,
        motivosAprobacion: motivosDetalle
      })
    };
  }

  return Object.freeze({ listar, detalle });
}

module.exports = {
  COLECCIONES,
  ESTADO_POR_DEFECTO,
  LIMITE_POR_DEFECTO,
  LIMITE_MAXIMO,
  MAXIMO_EVENTOS,
  PROYECCION_EVENTOS,
  ErrorConsultaInvalida,
  ErrorLecturaNoDisponible,
  validarConsultaListado,
  validarPropuestaId,
  codificarCursor,
  consultaListado,
  consultaDestinosListado,
  paisSeguro,
  destinoSeguro,
  verificarHash,
  problemasConsistencia,
  problemasConsistenciaV2,
  resumenEvidencia,
  resumenRequisitoV2,
  resumenListado,
  eventoSeguro,
  observarValor,
  evaluarRequisitoActual,
  evaluarRequisitoActualV2,
  ACCIONES,
  motivosCoordinacion,
  motivosIntegridad,
  motivosIntegridadV2,
  calcularAcciones,
  evaluarIntegridad,
  crearLectorPropuestas
};
