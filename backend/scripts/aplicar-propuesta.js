/**
 * Comando administrativo para APLICAR una propuesta aprobada
 * (services/propuestas/aplicar-propuesta.js).
 *
 * MODO (se cambia a mano):
 *  - 'solo_lectura' (default): conecta y muestra la identidad resuelta, la
 *    propuesta completa, el evento de aprobación, el requisito actual del
 *    destino, los filtros CAS exactos que usaría la aplicación, el gate de
 *    índices (INDICES_APLICACION) y una revalidación NUEVA contra la fuente
 *    (GOV.UK), con el resultado que se prevé. NO escribe nada. Si fallan
 *    las precondiciones de la propuesta, NO consulta la fuente (igual que
 *    el servicio): "revalidación omitida por propuesta no aplicable".
 *  - 'aplicacion_real': lo mismo y pide escribir los primeros 12
 *    caracteres de payload_hash. Con la confirmación correcta llama al
 *    servicio con EXACTAMENTE los valores mostrados (propuesta_id,
 *    payload_hash, version_coordinacion; sin releer).
 *
 * Un resultado OPERATIVO previsto distinto de exito (propuesta no
 * aplicable, fuente no disponible, extracción ambigua, cambio de fuente,
 * identidad del requisito o valor actual distintos) NO aborta: se muestra,
 * se pide la misma confirmación y el servicio registra el intento y su
 * transición. Lo mismo vale para lo que solo el servicio puede ver
 * (revalidación vencida, carreras). El código de salida es 1 siempre que
 * el resultado final no sea exito (codigoSalida).
 *
 * La revalidación mostrada es solo informativa y NO se reutiliza: el
 * servicio vuelve a revalidar por su cuenta (y toma su propio instante t
 * para la ventana), así que una aplicación viable consulta la fuente dos
 * veces. La previsión puede no coincidir con lo que registre el servicio
 * si la fuente, el destino o la propuesta cambian entre ambas.
 *
 * Solo ABORTAN (sin escribir nada) los errores de configuración o
 * integridad: URI, identidad del operador, base, gate de índices (estos
 * dos últimos solo se informan en solo_lectura, como en decidir), y en
 * ambos modos propuesta inexistente, hash corrupto, ids inválidos, campo
 * no aplicable o sin adaptador único.
 *
 * Conexión: SOLO MONGODB_URI_DECISION, igual que decidir-propuesta.js (ver
 * ahí por qué la comparación con MONGODB_URI es defensa en profundidad y
 * la garantía real es resolverActor sobre connectionStatus). Toda línea
 * impresa pasa por ocultarUri(); los mensajes de error, además, por el
 * saneo del servicio (sanearMensaje) y la evidencia de la fuente por
 * sanearTextosError().
 *
 * Uso: node scripts/aplicar-propuesta.js
 * Pruebas offline: node scripts/test-aplicar-propuesta.js
 */

const MODO = 'solo_lectura'; // 'solo_lectura' | 'aplicacion_real'
const PROPUESTA_ID = '';

const mongoose = require('mongoose');
const readline = require('readline');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const EventoPropuesta = require('../models/propuestas/EventoPropuesta.model');
const Destino = require('../models/Destino.model');
const { canonicalizarValor, hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { cargarOperadoresAutorizados, resolverActor } = require('../services/propuestas/operadores-autorizados');
const { usuariosAutenticadosDe } = require('../services/propuestas/decidir-propuesta');
const { elegirAdaptador } = require('../services/propuestas/adaptadores');
const { clasificarIdentidadRequisito } = require('../services/propuestas/identidad-requisito');
const {
  CAMPOS_APLICABLES,
  ErrorPropuestaNoSoportada,
  sanearMensaje,
  sanearTextosError,
  convertirIdsDestino,
  verificarPrecondicionesPropuesta,
  clasificarRevalidacion,
  filtroCasPropuesta,
  updateCasPropuesta,
  filtroLecturaDestino,
  filtroDestino,
  updateDestino,
  observarValor,
  mismoValorConPresencia,
  aplicarPropuesta,
  verificarIndices,
  crearDependenciasMongoose: crearDependenciasServicio
} = require('../services/propuestas/aplicar-propuesta');
const { ocultarUri } = require('./decidir-propuesta');

const DB_ESPERADA = 'buscador_requisitos';
const MODOS = ['solo_lectura', 'aplicacion_real'];
const LARGO_CONFIRMACION = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVALIDACION_VISTA = '<solo-vista>';
const PREVISION_INDETERMINADA = 'indeterminado (la revalidación de la vista lanzó un error)';

// Pura. Lo que registraría el servicio: la primera etapa que falla, en su
// orden (precondiciones → revalidación → identidad/valor del destino).
function previsionDe({ precondiciones, revalidacion, destino }) {
  return precondiciones ?? revalidacion ?? destino ?? 'exito';
}

// Pura. Entrada del servicio armada SOLO con la vista mostrada. La
// revalidación de la vista no viaja: el servicio no la acepta.
function construirEntradaDesdeVista(propuesta) {
  return {
    propuesta_id: propuesta.propuesta_id,
    payload_hash_esperado: propuesta.payload_hash,
    version_coordinacion_esperada: propuesta.version_coordinacion
  };
}

// Pura. Para mostrar filtros y documentos: un ObjectId de BSON se imprime
// como ObjectId("hex") para que se vea que NO es un string.
function paraMostrar(v) {
  if (v != null && v._bsontype === 'ObjectId') return `ObjectId("${v.toHexString()}")`;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(paraMostrar);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, paraMostrar(x)]));
  return v;
}

const json = (v) => JSON.stringify(paraMostrar(v), null, 2);

// Pura. Mensaje de un error apto para la consola: saneo del servicio
// (URIs de Mongo, userinfo, password=) y además la URI/contraseña exactas.
function mensajeDeError(err, uri) {
  const base = ocultarUri(sanearMensaje(err?.message ?? err), uri);
  return err?.intento_id ? `${base} [intento_id ${err.intento_id}]` : base;
}

function mostrarPropuesta(p, log) {
  const { payload } = p;
  log('=== PROPUESTA ===');
  log(`propuesta_id:           ${p.propuesta_id}`);
  log(`estado:                 ${p.estado}`);
  log(`version_coordinacion:   ${p.version_coordinacion}`);
  log(`decision_aprobacion_id: ${p.decision_aprobacion_id ?? null}`);
  log(`ultimo_evento_id:       ${p.ultimo_evento_id ?? null}`);
  log(`payload_hash:           ${p.payload_hash}`);
  log(`  primeros ${LARGO_CONFIRMACION}:          ${p.payload_hash.slice(0, LARGO_CONFIRMACION)}`);
  log(`destino_id / requisito_id / campo: ${payload.destino_id} / ${payload.requisito_id} / ${payload.campo}`);
  log(`valor_anterior:         ${JSON.stringify(payload.valor_anterior)}`);
  log(`valor_propuesto.valor:  ${JSON.stringify(payload.valor_propuesto?.valor)}`);
  log(`valor_propuesto.valor_normalizado: ${JSON.stringify(payload.valor_propuesto?.valor_normalizado)}`);
  log(`fuente:                 ${JSON.stringify(payload.fuente)}`);
  log('payload canónico completo:');
  log(json(canonicalizarValor(payload)));
}

// deps: { uriDecision(), uriBackend(), operadoresJson(), conectar(uri) -> databaseName,
//         usuariosAutenticados(), verificarIndices(), leerPropuesta(id), leerEvento(id),
//         leerDestino(filtro), elegirAdaptador(propuesta), ahora(), preguntar(texto),
//         aplicar(entrada, operadoresJson) }
async function ejecutar(config, deps, logCrudo = console.log) {
  const { modo, propuesta_id: propuestaId } = config;
  if (!MODOS.includes(modo)) throw new Error(`Modo desconocido "${modo}". Válidos: ${MODOS.join(', ')}.`);
  if (typeof propuestaId !== 'string' || !UUID.test(propuestaId)) throw new Error('PROPUESTA_ID vacío o no es un UUID.');
  const real = modo === 'aplicacion_real';

  const uri = deps.uriDecision();
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('MONGODB_URI_DECISION ausente. No se usa MONGODB_URI como alternativa. No se conectó a Mongo.');
  }
  // Defensa en profundidad (ver decidir-propuesta.js): la garantía es resolverActor.
  if (uri === deps.uriBackend()) {
    throw new Error('MONGODB_URI_DECISION es igual a MONGODB_URI: tiene que ser la credencial personal del operador. No se conectó a Mongo.');
  }
  const operadoresJson = deps.operadoresJson();
  const operadores = cargarOperadoresAutorizados(operadoresJson); // aborta antes de conectar

  // Desde acá toda línea impresa pasa por ocultarUri.
  const log = (linea) => logCrudo(ocultarUri(linea, uri));
  const error = (err) => mensajeDeError(err, uri);

  log(`Modo: ${modo}\n`);
  let dbName;
  try {
    dbName = await deps.conectar(uri);
  } catch (err) {
    throw new Error(`No se pudo conectar con MONGODB_URI_DECISION: ${error(err)}`);
  }
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando.`);
  log(`Conectado a "${dbName}"`);

  let resolucion = null;
  try {
    resolucion = resolverActor(await deps.usuariosAutenticados(), operadores);
    log(`Operador: ${resolucion.actor.identificador} (usuario Atlas "${resolucion.identidad_operador.usuario_atlas}", evidencia operativa, no no repudio)\n`);
  } catch (err) {
    if (real) throw err;
    log(`Identidad RECHAZADA (una aplicación real abortaría): ${error(err)}\n`);
  }

  // ---- Propuesta: lo que el servicio rechazaría sin persistir aborta en ambos modos ----
  const propuesta = await deps.leerPropuesta(propuestaId);
  if (!propuesta) throw new Error(`No existe la propuesta ${propuestaId}.`);
  const hashRecalculado = hashSobreCanonico(propuesta.payload, propuesta.algoritmo_canonicalizacion, propuesta.algoritmo_hash);
  if (hashRecalculado !== propuesta.payload_hash) {
    throw new Error(`payload_hash guardado (${propuesta.payload_hash}) ≠ hash recalculado (${hashRecalculado}). Abortando sin aplicar.`);
  }
  const ids = convertirIdsDestino(propuesta);
  if (!CAMPOS_APLICABLES.includes(propuesta.campo) || propuesta.payload.campo !== propuesta.campo) {
    throw new ErrorPropuestaNoSoportada(`Campo ${JSON.stringify(propuesta.campo)} no aplicable. Abortando sin aplicar.`);
  }
  const adaptador = deps.elegirAdaptador(propuesta);
  mostrarPropuesta(propuesta, log);
  log('hash recalculado: coincide');
  log(`adaptador: ${adaptador.nombre} v${adaptador.version}\n`);

  // Resultado que la aplicación registraría, por etapa, en el orden del
  // servicio: precondiciones → revalidación → destino (identidad, valor).
  const previsto = { precondiciones: null, revalidacion: null, destino: null };

  const entrada = construirEntradaDesdeVista(propuesta);
  const decision = typeof propuesta.decision_aprobacion_id === 'string' ? propuesta.decision_aprobacion_id : null;
  const eventoAprobacion = decision ? await deps.leerEvento(decision) : null;
  log('=== EVENTO DE APROBACIÓN ===');
  log(eventoAprobacion ? json(eventoAprobacion) : `(no existe${decision ? ` el evento ${decision}` : ': la propuesta no tiene decision_aprobacion_id'})`);
  const fallas = verificarPrecondicionesPropuesta(entrada, propuesta, eventoAprobacion);
  if (fallas.length > 0) {
    previsto.precondiciones = 'propuesta_no_aplicable';
    log(`Precondiciones de la propuesta: NO se cumplen (${fallas.map((f) => f.codigo).join(', ')})`);
    log(json(fallas));
  } else {
    log('Precondiciones de la propuesta: OK (aprobada, hash, versión y evento de aprobación coinciden)');
  }

  // ---- Destino ----
  log('\n=== REQUISITO ACTUAL DEL DESTINO ===');
  const destino = await deps.leerDestino(filtroLecturaDestino(ids));
  const identidad = clasificarIdentidadRequisito(destino, ids.requisito_hex, adaptador.validarIdentidad);
  if (!identidad.ok) {
    previsto.destino = 'identidad_requisito_cambio';
    log(`Identidad del requisito: NO coincide (${identidad.categoria})`);
    log(json(identidad.detalle));
  } else {
    log(json(identidad.requisito));
    const observado = observarValor(identidad.requisito, propuesta.campo);
    const esperado = propuesta.payload.valor_anterior;
    if (!mismoValorConPresencia(observado, esperado)) {
      previsto.destino = 'valor_actual_cambio';
      log(`Valor actual de ${propuesta.campo}: ${JSON.stringify(observado)} ≠ valor_anterior ${JSON.stringify(esperado)}`);
    } else {
      log(`Valor actual de ${propuesta.campo}: ${JSON.stringify(observado)} = valor_anterior`);
    }
  }

  // ---- Filtros CAS ----
  const ctxCas = {
    propuesta_id: entrada.propuesta_id,
    hash_esperado: entrada.payload_hash_esperado,
    version_esperada: entrada.version_coordinacion_esperada,
    decision_aprobacion_id: decision
  };
  log('\n=== FILTROS CAS QUE SE USARÍAN ===');
  log('propuestas_cambio.updateOne filtro:');
  log(json(filtroCasPropuesta(ctxCas)));
  log('update (evento_id y t se generan al aplicar):');
  log(json(updateCasPropuesta('aplicacion', '<evento_id>', '<t>')));
  log('destinos.updateOne filtro (driver nativo, ids como ObjectId):');
  log(json(filtroDestino(ids, propuesta.campo, propuesta.payload.valor_anterior)));
  log('update:');
  log(json(updateDestino(propuesta.campo, propuesta.payload.valor_propuesto?.valor, '<t>')));

  // ---- Gate ----
  let gateOk = true;
  try {
    await deps.verificarIndices();
    log('\nGate de índices (INDICES_APLICACION): OK');
  } catch (err) {
    gateOk = false;
    if (real) throw err;
    log(`\nGate de índices FALLARÍA (una aplicación real abortaría): ${error(err)}`);
  }

  // ---- Revalidación nueva, solo para mostrar ----
  log('\n=== REVALIDACIÓN NUEVA (solo vista; el servicio revalida otra vez) ===');
  if (previsto.precondiciones) {
    // Igual que el servicio: sin precondiciones no se consulta la fuente.
    log('revalidación omitida por propuesta no aplicable');
  } else {
    try {
      const respuesta = await adaptador.revalidar(propuesta, { ahora: deps.ahora });
      const clasificacion = clasificarRevalidacion(propuesta, respuesta, REVALIDACION_VISTA);
      log(`tipo: ${respuesta.tipo}`);
      if (respuesta.valor) log(`valor: ${JSON.stringify(respuesta.valor)}`);
      if (respuesta.revalidada_en) log(`revalidada_en: ${respuesta.revalidada_en.toISOString()}`);
      if (respuesta.url) log(`fuente: ${respuesta.fuente_nombre} ${respuesta.url}`);
      log('evidencia (saneada como se persistiría):');
      log(json(sanearTextosError(respuesta.evidencia ?? null)));
      if (clasificacion.resultado === 'continuar') {
        log('Coincide con valor_propuesto.');
      } else {
        previsto.revalidacion = clasificacion.resultado;
        log(`NO permite aplicar: ${clasificacion.resultado} (${sanearMensaje(clasificacion.motivo)})`);
      }
    } catch (err) {
      previsto.revalidacion = PREVISION_INDETERMINADA;
      log(`La revalidación de la vista lanzó un error: ${error(err)}`);
    }
  }

  const prevision = previsionDe(previsto);
  log(`\nResultado previsto: ${prevision}`);
  const otros = [previsto.revalidacion, previsto.destino].filter((r) => r && r !== prevision);
  if (otros.length > 0) log(`Otros problemas detectados (el servicio registra solo el primero): ${otros.join(', ')}`);

  if (!real) {
    log('\nModo solo_lectura: no se escribió nada.');
    return { modo, escrito: false, gate_ok: gateOk, identidad_ok: resolucion !== null, prevision };
  }
  if (prevision !== 'exito') {
    log(`\nATENCIÓN: la vista prevé ${prevision}. Si confirmás, el servicio revalida por su cuenta y registra el intento y su transición; el comando terminará con código 1.`);
  }

  const respuesta = await deps.preguntar(`\nEscribí los primeros ${LARGO_CONFIRMACION} caracteres de payload_hash para confirmar: `);
  if (String(respuesta).trim() !== propuesta.payload_hash.slice(0, LARGO_CONFIRMACION)) {
    throw new Error('La confirmación no coincide con payload_hash. No se escribió nada.');
  }

  const resultado = await deps.aplicar(entrada, operadoresJson);
  log('\n=== RESULTADO ===');
  log(json(resultado));
  return { modo, aplicado: resultado.resultado === 'exito', prevision, resultado };
}

// Pura. 0 solo si una aplicación real terminó en exito (solo_lectura: 0).
function codigoSalida({ modo, aplicado }) {
  return modo === 'aplicacion_real' && aplicado !== true ? 1 : 0;
}

function preguntarPorConsola(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(texto, (respuesta) => {
      rl.close();
      resolve(respuesta);
    })
  );
}

// No conecta al construirse: solo conectar() abre la conexión.
function crearDependenciasComando(env = process.env) {
  return {
    uriDecision: () => env.MONGODB_URI_DECISION,
    uriBackend: () => env.MONGODB_URI, // solo para comparar; nunca se usa para conectar
    operadoresJson: () => env.OPERADORES_AUTORIZADOS_JSON,
    conectar: async (uri) => {
      await mongoose.connect(uri);
      return mongoose.connection.db.databaseName;
    },
    usuariosAutenticados: () => usuariosAutenticadosDe(mongoose.connection),
    verificarIndices,
    leerPropuesta: (propuestaId) => PropuestaCambio.findOne({ propuesta_id: propuestaId }).lean(),
    leerEvento: (eventoId) => EventoPropuesta.findOne({ evento_id: eventoId }).lean(),
    // Driver nativo, igual que el servicio: el filtro lleva ObjectId de BSON.
    leerDestino: (filtro) => Destino.collection.findOne(filtro),
    elegirAdaptador: (propuesta) => elegirAdaptador(propuesta),
    ahora: () => new Date(),
    preguntar: preguntarPorConsola,
    aplicar: (entrada, operadoresJson) =>
      aplicarPropuesta(entrada, crearDependenciasServicio(mongoose.connection, { operadoresJson }))
  };
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const uri = process.env.MONGODB_URI_DECISION;
  ejecutar({ modo: MODO, propuesta_id: PROPUESTA_ID }, crearDependenciasComando(), console.log)
    .then((r) => {
      process.exitCode = codigoSalida(r);
    })
    .catch((err) => {
      console.error('Error:', mensajeDeError(err, uri));
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}

module.exports = {
  MODOS,
  DB_ESPERADA,
  LARGO_CONFIRMACION,
  construirEntradaDesdeVista,
  previsionDe,
  codigoSalida,
  paraMostrar,
  mensajeDeError,
  ejecutar,
  crearDependenciasComando
};
