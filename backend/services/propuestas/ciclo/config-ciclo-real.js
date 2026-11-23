/**
 * Ejecución REAL del ciclo (tarea diaria). Define qué la habilita y cómo se registra la identidad
 * del proceso. No lee .env: el proceso recibe sus variables del entorno (secretos de GitHub Actions).
 *
 *  MONGODB_URI_CICLO            Credencial PROPIA del proceso: un usuario de Atlas del ciclo,
 *                               distinto del de la app (MONGODB_URI) y del operador de índices.
 *  OPERADORES_AUTORIZADOS_JSON  Allowlist de operadores-autorizados.js. Debe incluir al usuario
 *                               del proceso: connectionStatus lo identifica (no hay identidad
 *                               declarada a mano).
 *  CICLO_V2_AUTORIZACION_JSON   Habilita políticas automáticas. Un objeto (forma original) o una
 *                               LISTA de objetos, uno por política, cada uno exactamente:
 *                               { "politica": "checkmig-colombia-obligatoriedad@1",
 *                                 "autorizada_por": "<persona que la autoriza>",
 *                                 "autorizada_en": "<ISO UTC>", "vence_en": "<ISO UTC>" }
 *                               Vigencia de 90 días como máximo por entrada. Cada perfil usa
 *                               SOLO la entrada de su política: sin ella, o vencida, ese perfil
 *                               lee y compara, pero solo informa: no propone ni escribe.
 *
 * Identidades en la ejecución real:
 *  - Aplicación (H3.3): credencial comando_administrativo con los usuarios REALES de
 *    connectionStatus contra la allowlist; la auditoría guarda usuario_atlas y db.
 *  - Aprobación: el contrato exige un actor humano. Es la persona que autorizó la política
 *    (autorizada_por), con identidad_operador { metodo: 'politica_automatica', politica,
 *    autorizada_en, vence_en, proceso, usuario_atlas, db_autenticacion }: queda a la vista que no
 *    aprobó a mano esa propuesta, sino por la política vigente, y qué proceso la ejecutó.
 * Las identidades del piloto (piloto.local / piloto-local) se rechazan aquí: solo valen en el
 * Mongo efímero del piloto.
 */
const { cargarOperadoresAutorizados, resolverActor } = require('../operadores-autorizados');
const { esFechaIsoUtcExacta } = require('../canonicalizacion-propuestas');
const { verificarConjuntoIndices, INDICES_DECISION, INDICES_APLICACION } = require('../indices-propuestas');
const { INDICE_TRANSVERSAL } = require('../aplicar-propuesta-v2');
const { crearDepsAplicacion } = require('./ciclo-revalidacion-v2');
const { PERFILES, PERFIL_POR_DEFECTO, clavePolitica, perfilPorNombre } = require('./perfiles');
const { POLITICAS_ALTA } = require('../altas/perfiles-alta');

class ErrorConfiguracionCiclo extends Error {}
class ErrorObjetivoCiclo extends Error {}

// Política → perfiles que cubre (una política puede cubrir varios requisitos del mismo destino).
const POLITICAS = Object.freeze(PERFILES.reduce((m, p) => ({ ...m, [clavePolitica(p)]: [...(m[clavePolitica(p)] ?? []), p] }), {}));
const VIGENCIA_MAXIMA_MS = 90 * 24 * 60 * 60 * 1000;
const IDENTIDADES_PILOTO = ['piloto.local', 'piloto-local'];
const CLAVES_AUTORIZACION = ['autorizada_en', 'autorizada_por', 'politica', 'vence_en'];
const esTexto = v => typeof v === 'string' && v.trim() !== '' && v === v.trim() && v.length <= 120 && !/[\x00-\x1f]/.test(v);
const falla = m => { throw new ErrorConfiguracionCiclo(`ciclo real: ${m}`); };

// Pura. Conexión e identidad del proceso (comunes a ciclo y altas).
function cargarBaseCiclo(env) {
  const uri = env.MONGODB_URI_CICLO;
  if (typeof uri !== 'string' || !/^mongodb(\+srv)?:\/\//.test(uri)) falla('MONGODB_URI_CICLO ausente o sin esquema mongodb.');
  if (env.MONGODB_URI && uri === env.MONGODB_URI) falla('MONGODB_URI_CICLO debe ser una credencial propia del proceso, no la de la app.');
  let operadores;
  try { operadores = cargarOperadoresAutorizados(env.OPERADORES_AUTORIZADOS_JSON); }
  catch (e) { falla(`allowlist inválida (${e.message.replace(/^.*?: /, '')})`); }
  if (operadores.some(o => IDENTIDADES_PILOTO.includes(o.identificador) || IDENTIDADES_PILOTO.includes(o.usuario_atlas))) falla('la identidad del piloto solo vale en Mongo efímero.');
  return { uri, operadores };
}

/**
 * Pura. CICLO_V2_AUTORIZACION_JSON: un objeto (forma original, una política) o una lista de objetos
 * con políticas distintas. TODAS las entradas se validan aunque esta corrida use una sola; la
 * corrida toma únicamente la entrada de `clave`. Devuelve { autorizacion | null, motivo | null }.
 */
function leerAutorizacion(env, ahora, clave) {
  if (env.CICLO_V2_AUTORIZACION_JSON === undefined) return { autorizacion: null, motivo: 'CICLO_V2_AUTORIZACION_JSON ausente' };
  let crudo;
  try { crudo = JSON.parse(env.CICLO_V2_AUTORIZACION_JSON); } catch { falla('CICLO_V2_AUTORIZACION_JSON no es JSON.'); }
  const lista = Array.isArray(crudo) ? crudo : [crudo];
  if (lista.length === 0 || lista.length > 20) falla('la lista de autorizaciones debe tener entre 1 y 20 entradas.');
  for (const a of lista) {
    if (a === null || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join(',') !== CLAVES_AUTORIZACION.join(',')) falla(`la autorización debe tener exactamente ${CLAVES_AUTORIZACION.join(', ')}.`);
    // Las políticas de alta (scripts/alta-destinos-v1.js) conviven en la misma variable.
    if (!Object.hasOwn(POLITICAS, a.politica) && !POLITICAS_ALTA.includes(a.politica)) falla('política desconocida.');
    if (!esTexto(a.autorizada_por) || IDENTIDADES_PILOTO.includes(a.autorizada_por)) falla('autorizada_por inválido.');
    if (!esFechaIsoUtcExacta(a.autorizada_en) || !esFechaIsoUtcExacta(a.vence_en)) falla('autorizada_en y vence_en deben ser ISO UTC exactas.');
    const desde = Date.parse(a.autorizada_en), hasta = Date.parse(a.vence_en);
    if (!(hasta > desde) || hasta - desde > VIGENCIA_MAXIMA_MS) falla('la vigencia debe ser positiva y de 90 días como máximo.');
  }
  if (new Set(lista.map(a => a.politica)).size !== lista.length) falla('una política aparece más de una vez.');
  const a = lista.find(x => x.politica === clave);
  if (!a) return { autorizacion: null, motivo: `CICLO_V2_AUTORIZACION_JSON no incluye ${clave}` };
  const t = ahora.getTime();
  if (t < Date.parse(a.autorizada_en)) return { autorizacion: null, motivo: 'la autorización todavía no rige' };
  if (t >= Date.parse(a.vence_en)) return { autorizacion: null, motivo: 'la autorización venció' };
  return { autorizacion: Object.freeze({ ...a }), motivo: null };
}

// Pura. Los mensajes nunca repiten el contenido de las variables. Sin `perfil`, Colombia.
function cargarConfigCicloReal(env, ahora, { perfil: nombre = PERFIL_POR_DEFECTO } = {}) {
  const { uri, operadores } = cargarBaseCiclo(env);
  let perfil;
  try { perfil = perfilPorNombre(nombre); } catch (e) { falla(e.message); }
  const { autorizacion, motivo } = leerAutorizacion(env, ahora, clavePolitica(perfil));
  return Object.freeze({ uri, operadores, autorizacion, perfil, politica_habilitada: autorizacion !== null, motivo_sin_politica: motivo });
}

/**
 * Prechequeo y contexto de la corrida real. Solo lecturas: connectionStatus, listIndexes y el
 * destino. No crea índices ni colecciones. Lanza antes de leer la fuente si algo falta.
 */
async function prepararEjecucionReal(config, { conexion, usuariosAutenticados, fetch, ahora, uuid }) {
  const usuarios = await usuariosAutenticados();
  const proceso = resolverActor(usuarios, config.operadores);
  const especies = new Map([...INDICES_DECISION, ...INDICES_APLICACION, INDICE_TRANSVERSAL].map(s => [`${s.coleccion}/${s.nombre}`, s]));
  const colecciones = [...new Set([...especies.values()].map(s => s.coleccion))];
  const listados = async () => Object.fromEntries(await Promise.all(colecciones.map(async c => {
    try { return [c, await conexion.db.collection(c).indexes()]; } catch (e) { if (e?.code === 26) return [c, []]; throw e; }
  })));
  verificarConjuntoIndices([...especies.values()], await listados());

  const perfil = config.perfil;
  const destinos = await conexion.db.collection('destinos').find({ codigo_iso: perfil.destino.codigo_iso }).toArray();
  if (destinos.length !== 1) throw new ErrorObjetivoCiclo(`ciclo real: se esperaba un destino ${perfil.destino.codigo_iso} (hay ${destinos.length}).`);
  const candidatos = (destinos[0].requisitos ?? []).filter(r => r?.tipo === perfil.requisito.tipo && r?.nombre === perfil.requisito.nombre);
  if (candidatos.length !== 1 || !candidatos[0]._id) throw new ErrorObjetivoCiclo(`ciclo real: se esperaba un requisito ${perfil.requisito.nombre ?? perfil.requisito.tipo} con _id (hay ${candidatos.length}).`);

  const a = config.autorizacion;
  return {
    objetivo: { destinoId: destinos[0]._id, requisitoId: candidatos[0]._id },
    perfil,
    contexto: {
      conexion, fetch, ahora, uuid,
      politicaHabilitada: config.politica_habilitada,
      depsAplicacion: crearDepsAplicacion(conexion, { fetch, ahora, uuid, listados }),
      credencialAplicacion: { origen: 'comando_administrativo', usuarios_autenticados: usuarios, operadores_autorizados: config.operadores },
      identidadDecision: a ? {
        actor: { tipo: 'humano', identificador: a.autorizada_por },
        identidad_operador: { metodo: 'politica_automatica', politica: a.politica, autorizada_en: a.autorizada_en, vence_en: a.vence_en,
          proceso: proceso.actor.identificador, usuario_atlas: proceso.identidad_operador.usuario_atlas, db_autenticacion: proceso.identidad_operador.db_autenticacion },
        comando: { nombre: 'ciclo-checkmig-v2', version: '1' }
      } : null
    },
    proceso: { identificador: proceso.actor.identificador, usuario_atlas: proceso.identidad_operador.usuario_atlas }
  };
}

module.exports = { ErrorConfiguracionCiclo, ErrorObjetivoCiclo, POLITICAS, IDENTIDADES_PILOTO, cargarBaseCiclo, leerAutorizacion,
  cargarConfigCicloReal, prepararEjecucionReal };
