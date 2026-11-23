/**
 * Alta automática de destinos ausentes (v1), con límites explícitos:
 *
 *  - ENTRADA explícita (config/altas-destinos.json): qué países incorporar y con qué perfil de alta.
 *    El país y su código ISO los fija el perfil; la entrada solo los elige y debe coincidir. No se
 *    descubren destinos ni se inventa ninguno.
 *  - LECTURA: dos lecturas de la fuente oficial con los MISMOS hechos (como H3.3 confirma un cambio)
 *    antes de proponer el alta. Una ambigua o distinta → revisión humana; una caída → reintentar.
 *    Si el destino ya existe no se consulta la fuente (frecuencia acotada: el alta ocurre una vez).
 *  - CONTRATO: el documento nuevo se valida con el modelo Destino y cada requisito con el contrato
 *    2.0 (capturarIdentidadEInstantanea), para que el ciclo de mantenimiento pueda usarlo después.
 *    Lo que la fuente no confirma queda 'verificar'.
 *  - DUPLICADOS, CONCURRENCIA Y REINTENTOS: índices únicos existentes destinos.codigo_iso_1 y
 *    destinos.pais_1, más altas_destino.uniq_alta_por_codigo_iso y alta_id_1 (nuevos). El destino y su
 *    registro de alta se insertan en UNA transacción (snapshot / majority). Otra corrida que gane la
 *    carrera hace fallar la inserción por clave duplicada y esta devuelve 'ya_existe' sin escribir.
 *  - PROCEDENCIA: altas_destino guarda quién (proceso, usuario de Atlas, política y autorizante),
 *    cuándo, de qué fuente (URL, lecturas con HTTP y hashes, hechos, evidencia breve), con qué alcance
 *    (contexto del viajero, requisitos confirmados y a verificar) y con qué resultado.
 *
 * Sin la política habilitada solo informa ('alta_aplicable'), sin escribir nada.
 */
require('../../../config/mongoose');
const { ObjectId } = require('mongodb');
const Destino = require('../../../models/Destino.model');
const { capturarIdentidadEInstantanea } = require('../contrato-requisito-v2');
const { fechaMontevideo } = require('../plan-aplicacion-requisito-v2');
const { verificarConjuntoIndices } = require('../indices-propuestas');
const { PERFILES_ALTA, clavePolitica } = require('./perfiles-alta');

class ErrorEntradaAltas extends Error {}

const VERSION_ENTRADA = 'altas-destinos-v1';
const VERSION_ALTA = 'alta-destino-v1';
const unico = (coleccion, nombre, clave) => Object.freeze({ coleccion, nombre, clave, partialFilterExpression: null });
const INDICES_ALTA = Object.freeze([
  unico('destinos', 'codigo_iso_1', { codigo_iso: 1 }),
  unico('destinos', 'pais_1', { pais: 1 }),
  unico('altas_destino', 'alta_id_1', { alta_id: 1 }),
  unico('altas_destino', 'uniq_alta_por_codigo_iso', { codigo_iso: 1 })
]);
const COLECCIONES_INDICES = [...new Set(INDICES_ALTA.map(s => s.coleccion))];

// Pura. Entrada explícita → [{codigo_iso, pais, perfil}].
function validarEntrada(entrada, perfiles = PERFILES_ALTA) {
  const falla = m => { throw new ErrorEntradaAltas(`altas: ${m}`); };
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada) || Object.keys(entrada).sort().join(',') !== 'destinos,version') falla('la entrada debe tener exactamente version y destinos.');
  if (entrada.version !== VERSION_ENTRADA) falla(`version debe ser ${VERSION_ENTRADA}.`);
  if (!Array.isArray(entrada.destinos) || entrada.destinos.length === 0 || entrada.destinos.length > 10) falla('destinos debe tener entre 1 y 10 entradas.');
  const salida = entrada.destinos.map((d, i) => {
    if (d === null || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'codigo_iso,pais,perfil_alta') falla(`destinos[${i}] debe tener exactamente codigo_iso, pais y perfil_alta.`);
    if (typeof d.codigo_iso !== 'string' || !/^[A-Z]{2}$/.test(d.codigo_iso)) falla(`destinos[${i}].codigo_iso debe ser ISO 3166-1 alfa-2 en mayúsculas.`);
    const perfil = perfiles.find(p => p.nombre === d.perfil_alta);
    if (!perfil) falla(`destinos[${i}].perfil_alta desconocido.`);
    if (perfil.destino.codigo_iso !== d.codigo_iso || perfil.destino.pais !== d.pais) falla(`destinos[${i}] no coincide con el destino que cubre el perfil ${perfil.nombre}.`);
    return Object.freeze({ codigo_iso: d.codigo_iso, pais: d.pais, perfil });
  });
  if (new Set(salida.map(d => d.codigo_iso)).size !== salida.length || new Set(salida.map(d => d.pais)).size !== salida.length) falla('un destino aparece más de una vez.');
  return Object.freeze(salida);
}

const resumenLectura = (l, orden) => ({ orden, tipo: l?.tipo ?? null, url: l?.url ?? null, consultado_en: l?.diagnostico?.consultado_en ?? null,
  http_status: l?.diagnostico?.http_status ?? null, contenido_sha256: l?.diagnostico?.contenido_sha256 ?? null, hechos_hash: l?.hechos_hash ?? null,
  motivo: l?.tipo === 'hechos' ? null : l?.motivo ?? null });
const camposPendientes = l => Object.entries(l.campos ?? {}).filter(([, c]) => c.estado !== 'ok').map(([campo, c]) => ({ campo, motivo: String(c.motivo).split(':')[0] }));

// Documento del destino nuevo, validado con el modelo (validate(), sin escribir) y el contrato 2.0.
async function construirDestino(objetivo, lectura, { hoy, ahora, nuevoId = () => new ObjectId() }) {
  const requisitos = objetivo.perfil.construirRequisitos(lectura.hechos, { hoy }).map(r => ({ _id: nuevoId(), ...r }));
  for (const r of requisitos) capturarIdentidadEInstantanea(r);
  const doc = { _id: nuevoId(), pais: objetivo.pais, codigo_iso: objetivo.codigo_iso, requisitos, createdAt: ahora, updatedAt: ahora };
  try { await new Destino(doc).validate(); }
  catch (error) { throw new TypeError(`altas: el destino construido no cumple el modelo (${Object.keys(error?.errors ?? {}).join(', ') || 'desconocido'}).`); }
  return doc;
}

async function listadosIndices(conexion) {
  return Object.fromEntries(await Promise.all(COLECCIONES_INDICES.map(async c => {
    try { return [c, await conexion.db.collection(c).indexes()]; } catch (e) { if (e?.code === 26) return [c, []]; throw e; }
  })));
}

/**
 * objetivo: elemento de validarEntrada. c: { conexion, fetch, ahora, uuid, politicaHabilitada,
 *   identidad: { politica, autorizada_por, autorizada_en, vence_en, proceso, usuario_atlas, db_autenticacion } | null }
 */
async function ejecutarAlta(objetivo, c) {
  const db = c.conexion.db;
  const base = { codigo_iso: objetivo.codigo_iso, pais: objetivo.pais, perfil: objetivo.perfil.nombre };
  const existente = async () => {
    const d = await db.collection('destinos').findOne({ $or: [{ codigo_iso: objetivo.codigo_iso }, { pais: objetivo.pais }] }, { projection: { _id: 1, codigo_iso: 1 } });
    if (!d) return null;
    const alta = await db.collection('altas_destino').findOne({ codigo_iso: objetivo.codigo_iso }, { projection: { alta_id: 1 } });
    return { ...base, resultado: 'ya_existe', destino_id: d._id.toHexString(), alta_id: alta?.alta_id ?? null, lecturas: [] };
  };
  const ya = await existente();
  if (ya) return ya;

  // Dos lecturas con los mismos hechos.
  const leer = () => objetivo.perfil.adaptador.leer({ fetch: c.fetch, ahora: c.ahora });
  const l1 = await leer();
  const lecturas = [resumenLectura(l1, 1)];
  if (l1.tipo === 'no_disponible') return { ...base, resultado: 'fuente_no_disponible', motivo: l1.motivo, lecturas, pendiente: { tipo: 'reintentar', motivo: l1.motivo } };
  if (l1.tipo !== 'hechos') return { ...base, resultado: 'revision_humana', motivo: 'lectura_ambigua', lecturas, pendiente: { tipo: 'revision_humana', url: l1.url, campos: camposPendientes(l1) } };
  if (!(l1.evidencia?.[objetivo.perfil.campo_evidencia]?.length > 0)) return { ...base, resultado: 'revision_humana', motivo: 'sin_evidencia_confirmada', lecturas, pendiente: { tipo: 'revision_humana' } };
  const l2 = await leer();
  lecturas.push(resumenLectura(l2, 2));
  if (l2.tipo === 'no_disponible') return { ...base, resultado: 'fuente_no_disponible', motivo: l2.motivo, lecturas, pendiente: { tipo: 'reintentar', motivo: l2.motivo } };
  if (l2.tipo !== 'hechos') return { ...base, resultado: 'revision_humana', motivo: 'lectura_ambigua', lecturas, pendiente: { tipo: 'revision_humana', url: l2.url, campos: camposPendientes(l2) } };
  if (l2.hechos_hash !== l1.hechos_hash) return { ...base, resultado: 'revision_humana', motivo: 'cambio_no_confirmado', lecturas, pendiente: { tipo: 'revision_humana' } };

  const ahora = c.ahora();
  const hoy = fechaMontevideo(l1.revalidada_en);
  const destino = await construirDestino(objetivo, l1, { hoy, ahora });
  const alcance = { contexto_viajero: { ...objetivo.perfil.contexto_viajero },
    requisitos_confirmados: destino.requisitos.filter(r => r.estado === 'confirmado').map(r => r.tipo),
    requisitos_a_verificar: destino.requisitos.filter(r => r.estado !== 'confirmado').map(r => r.tipo) };
  const vista = { ...base, hechos: structuredClone(l1.hechos), hechos_hash: l1.hechos_hash, ...alcance,
    visa: { obligatorio: destino.requisitos[0].obligatorio, descripcion: destino.requisitos[0].descripcion, fecha_verificacion: destino.requisitos[0].fecha_verificacion } };
  if (c.politicaHabilitada !== true || !c.identidad) return { ...vista, resultado: 'alta_aplicable', motivo: 'politica_no_habilitada', lecturas, pendiente: { tipo: 'autorizacion', motivo: 'politica_no_habilitada' } };

  verificarConjuntoIndices(INDICES_ALTA, await listadosIndices(c.conexion));
  const altaId = c.uuid();
  const registro = {
    alta_id: altaId, version: VERSION_ALTA, codigo_iso: objetivo.codigo_iso, pais: objetivo.pais, destino_id: destino._id, creado_en: ahora, resultado: 'creado',
    perfil: { nombre: objetivo.perfil.nombre, version: objetivo.perfil.version }, politica: c.identidad.politica,
    autorizacion: { autorizada_por: c.identidad.autorizada_por, autorizada_en: c.identidad.autorizada_en, vence_en: c.identidad.vence_en },
    proceso: { identificador: c.identidad.proceso, usuario_atlas: c.identidad.usuario_atlas, db_autenticacion: c.identidad.db_autenticacion },
    fuente: { nombre: l1.fuente_nombre, url: l1.url, adaptador: { nombre: objetivo.perfil.adaptador.nombre, version: objetivo.perfil.adaptador.version },
      lecturas: [l1, l2].map((l, i) => ({ orden: i + 1, consultado_en: new Date(l.diagnostico.consultado_en), revalidada_en: l.revalidada_en, http_status: l.diagnostico.http_status,
        contenido_sha256: l.diagnostico.contenido_sha256, hechos_hash: l.hechos_hash })),
      algoritmo_hechos_hash: l1.algoritmo_hechos_hash, hechos: structuredClone(l1.hechos), hechos_hash: l1.hechos_hash, evidencia: structuredClone(l1.evidencia) },
    ...alcance, requisitos: destino.requisitos.map(r => ({ _id: r._id, tipo: r.tipo, estado: r.estado }))
  };
  const sesion = c.conexion.getClient().startSession();
  try {
    await sesion.withTransaction(async () => {
      await db.collection('destinos').insertOne(destino, { session: sesion });
      await db.collection('altas_destino').insertOne(registro, { session: sesion });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (e) {
    // Otra corrida creó el destino (o su alta) primero: no se duplica ni se escribe nada.
    if (e?.code === 11000) return { ...((await existente()) ?? { ...base, resultado: 'ya_existe' }), lecturas, motivo: 'clave_duplicada' };
    throw e;
  } finally {
    await sesion.endSession();
  }
  // Relectura por mayoría: el alta queda confirmada solo si ambos documentos son visibles.
  const [d, a] = await Promise.all([db.collection('destinos').findOne({ _id: destino._id }, { readConcern: { level: 'majority' } }),
    db.collection('altas_destino').findOne({ alta_id: altaId }, { readConcern: { level: 'majority' } })]);
  if (!d || !a) return { ...vista, resultado: 'alta_no_confirmada', lecturas, alta_id: altaId, destino_id: destino._id.toHexString(), pendiente: { tipo: 'revision_humana' } };
  return { ...vista, resultado: 'creado', lecturas, alta_id: altaId, destino_id: destino._id.toHexString(), pendiente: null };
}

module.exports = { ErrorEntradaAltas, VERSION_ENTRADA, VERSION_ALTA, PERFILES_ALTA, INDICES_ALTA, clavePolitica, validarEntrada, construirDestino, ejecutarAlta, listadosIndices };
