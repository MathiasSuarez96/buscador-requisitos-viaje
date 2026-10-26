// Núcleo puro del aplicador 2.0. No está conectado al servicio publicado.
// El servicio transaccional deberá validar aprobación/índices y persistir
// intento, historial y evento junto con este update mediante Destino.collection.
const { ObjectId } = require('bson');
const { validarSobreRequisitoV2, hashHechos, ALGORITMO_HECHOS_HASH } = require('./payload-requisito-v2');
const { capturarIdentidadEInstantanea, CAMPOS_INSTANTANEA, validarValorCapturado } = require('./contrato-requisito-v2');
const { VENTANA_REVALIDACION_MS } = require('./contrato-propuestas');
const { canonicalizarValor } = require('./canonicalizacion-propuestas');
const igual = (a, b) => JSON.stringify(canonicalizarValor(a)) === JSON.stringify(canonicalizarValor(b));

function fechaMontevideo(t) {
  if (!(t instanceof Date) || !Number.isFinite(t.getTime())) throw new TypeError('Instante inválido');
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(t);
  const tomar = tipo => partes.find(p => p.type === tipo).value;
  return `${tomar('year')}-${tomar('month')}-${tomar('day')}`;
}

function condicion(capturado) {
  const v = validarValorCapturado(capturado, 'precondición');
  if (!v.presente) return { $exists: false };
  // $type por sí solo también acepta un array que contenga ese tipo.
  // $not array mantiene el CAS escalar, y $eq trata textos "$..." literalmente.
  return { $eq: v.valor, $type: v.bson_tipo, $not: { $type: 'array' } };
}

function verificarRevalidaciones(payload, revalidaciones, t) {
  fechaMontevideo(t);
  if (!Array.isArray(revalidaciones) || revalidaciones.length !== payload.fuentes.length) {
    throw new Error('revalidaciones_incompletas');
  }
  const urls = new Set();
  let primera = t.getTime();
  for (const fuente of payload.fuentes) {
    const rs = revalidaciones.filter(r => r?.url === fuente.url);
    if (rs.length !== 1 || urls.has(fuente.url)) throw new Error('revalidacion_no_unica');
    urls.add(fuente.url);
    const r = rs[0];
    if (r.tipo !== 'hechos' || r.fuente_nombre !== fuente.nombre || r.algoritmo_hechos_hash !== ALGORITMO_HECHOS_HASH) {
      throw new Error('revalidacion_invalida');
    }
    if (!(r.revalidada_en instanceof Date) || !Number.isFinite(r.revalidada_en.getTime())) throw new Error('fecha_revalidacion_invalida');
    const edad = t.getTime() - r.revalidada_en.getTime();
    if (edad < 0 || edad > VENTANA_REVALIDACION_MS) throw new Error('revalidacion_vencida');
    if (hashHechos(r.hechos) !== fuente.hechos_hash || !igual(r.hechos, fuente.hechos)) throw new Error('fuente_cambio');
    primera = Math.min(primera, r.revalidada_en.getTime());
  }
  // Con varias fuentes se conserva la fecha más antigua de la tanda,
  // para no afirmar una verificación posterior a alguna de ellas.
  return new Date(primera);
}

function coincideRequisito(payload, requisito) {
  const actual = capturarIdentidadEInstantanea(requisito);
  return igual(actual.identidad_requisito, payload.identidad_requisito)
    && igual(actual.instantanea_anterior, payload.instantanea_anterior);
}

function construirPlan(sobre, revalidaciones, t) {
  const { payload } = validarSobreRequisitoV2(sobre);
  const revalidadaEn = verificarRevalidaciones(payload, revalidaciones, t);
  const requisitoId = ObjectId.createFromHexString(payload.requisito_id);
  const elemento = {
    _id: requisitoId,
    tipo: { $eq: payload.identidad_requisito.tipo, $type: 'string', $not: { $type: 'array' } },
    nombre: condicion(payload.identidad_requisito.nombre),
    ...Object.fromEntries(CAMPOS_INSTANTANEA.map(campo => [campo, condicion(payload.instantanea_anterior[campo])]))
  };
  const fecha = fechaMontevideo(revalidadaEn);
  const set = { 'requisitos.$[r].fecha_verificacion': fecha, updatedAt: new Date(t) };
  const unset = {};
  for (const cambio of payload.cambios) {
    const ruta = `requisitos.$[r].${cambio.campo}`;
    if (cambio.propuesto.presente) set[ruta] = cambio.propuesto.valor;
    else unset[ruta] = '';
  }
  // El contador evita escribir si hay dos requisitos con el mismo _id.
  const filtro = {
    _id: ObjectId.createFromHexString(payload.destino_id),
    requisitos: { $elemMatch: elemento },
    $expr: { $eq: [{ $size: { $filter: {
      input: { $cond: [{ $isArray: '$requisitos' }, '$requisitos', []] },
      as: 'r', cond: { $eq: ['$$r._id', requisitoId] }
    } } }, 1] }
  };
  return {
    filtro,
    update: { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    opciones: { arrayFilters: [Object.fromEntries(Object.entries(elemento).map(([campo, valor]) => [`r.${campo}`, valor]))] },
    fecha_verificacion: fecha
  };
}

module.exports = { fechaMontevideo, condicion, verificarRevalidaciones, coincideRequisito, construirPlan };
