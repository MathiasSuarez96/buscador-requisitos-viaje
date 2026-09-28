/**
 * Comando administrativo para aprobar, rechazar o cancelar UNA propuesta
 * (services/propuestas/decidir-propuesta.js).
 *
 * MODO (se cambia a mano):
 *  - 'solo_lectura' (default): conecta, muestra la identidad resuelta, la
 *    propuesta completa (payload, payload_hash, versión, valor anterior y
 *    propuesto), si la operación está permitida, el filtro CAS y el evento
 *    que se usarían y el estado del gate de índices. NO escribe nada.
 *  - 'decision_real': lo mismo y, si todo está en orden, pide escribir los
 *    primeros 12 caracteres de payload_hash. Con la confirmación correcta
 *    llama al servicio con EXACTAMENTE los valores mostrados (sin releer):
 *    si la propuesta cambió mientras tanto, el CAS no coincide y no se
 *    escribe nada.
 *
 * Conexión: SOLO MONGODB_URI_DECISION (credencial personal del operador,
 * plan A). Es obligatoria y no hay fallback a MONGODB_URI; si es igual a
 * MONGODB_URI, aborta. Nunca se imprime ni se registra, ni parcialmente:
 * todo mensaje de error pasa por ocultarUri().
 *
 * La comparación con MONGODB_URI es DEFENSA EN PROFUNDIDAD, no la garantía
 * principal: dos URIs distintas (otro host del cluster, otras opciones,
 * otro orden de parámetros, otra codificación) pueden usar la misma
 * credencial del backend y pasarían este chequeo. Lo que realmente
 * garantiza que decide un operador personal es que connectionStatus
 * devuelva un único usuario autenticado incluido en
 * OPERADORES_AUTORIZADOS_JSON (resolverActor); el usuario del backend
 * nunca debe figurar en esa lista.
 *
 * La allowlist se lee de OPERADORES_AUTORIZADOS_JSON (.env local, fuera de
 * git); si falta o es inválida, aborta antes de conectar.
 *
 * La identidad es evidencia operativa (connectionStatus), no no repudio:
 * ver services/propuestas/operadores-autorizados.js.
 *
 * Uso: node scripts/decidir-propuesta.js
 * Pruebas offline: node scripts/test-decidir-propuesta.js
 */

const MODO = 'solo_lectura'; // 'solo_lectura' | 'decision_real'
const OPERACION = ''; // 'aprobacion' | 'rechazo' | 'cancelacion'
const PROPUESTA_ID = '';
const MOTIVO = ''; // obligatorio para rechazo y cancelacion

const mongoose = require('mongoose');
const readline = require('readline');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const { canonicalizarValor, hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { TRANSICIONES, TIPOS_QUE_REQUIEREN_MOTIVO, motivoTransicionInvalida } = require('../services/propuestas/contrato-propuestas');
const { cargarOperadoresAutorizados, resolverActor } = require('../services/propuestas/operadores-autorizados');
const {
  TIPOS_DECISION,
  construirFiltroCas,
  construirUpdateCas,
  decidirPropuesta,
  verificarIndices,
  usuariosAutenticadosDe,
  crearDependenciasMongoose: crearDependenciasServicio
} = require('../services/propuestas/decidir-propuesta');

const DB_ESPERADA = 'buscador_requisitos';
const MODOS = ['solo_lectura', 'decision_real'];
const LARGO_CONFIRMACION = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Oculta la URI completa, la contraseña (cruda y decodificada) y
// cualquier cadena con forma de URI de Mongo.
function ocultarUri(texto, uri) {
  let s = String(texto);
  if (typeof uri === 'string' && uri !== '') {
    s = s.split(uri).join('[MONGODB_URI_DECISION oculta]');
    try {
      const { password } = new URL(uri);
      for (const secreto of new Set([password, decodeURIComponent(password)])) {
        if (secreto) s = s.split(secreto).join('***');
      }
    } catch {
      // URI no parseable: igual se aplica el reemplazo por patrón.
    }
  }
  return s.replace(/mongodb(\+srv)?:\/\/[^\s"'<>]+/gi, '[uri mongo oculta]');
}

// Pura. Entrada del servicio armada SOLO con la vista mostrada.
function construirEntradaDesdeVista(operacion, propuesta, motivo) {
  const entrada = {
    tipo_evento: operacion,
    propuesta_id: propuesta.propuesta_id,
    estado_esperado: propuesta.estado,
    payload_hash_esperado: propuesta.payload_hash,
    version_coordinacion_esperada: propuesta.version_coordinacion,
    decision_aprobacion_id_esperado: propuesta.decision_aprobacion_id ?? null
  };
  if (motivo.trim() !== '') entrada.motivo = motivo;
  return entrada;
}

const json = (v) => JSON.stringify(v, null, 2);

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
  log(`run_id_origen:          ${payload.run_id_origen}`);
  log(`fecha_propuesta:        ${payload.fecha_propuesta}`);
  log(`valor_anterior:         ${JSON.stringify(payload.valor_anterior)}`);
  log(`valor_propuesto.valor:  ${JSON.stringify(payload.valor_propuesto?.valor)}`);
  log(`valor_propuesto.valor_normalizado: ${JSON.stringify(payload.valor_propuesto?.valor_normalizado)}`);
  log(`fuente:                 ${JSON.stringify(payload.fuente)}`);
  log('payload canónico completo:');
  log(json(canonicalizarValor(payload)));
}

// deps: { uriDecision(), uriBackend(), operadoresJson(), conectar(uri) -> databaseName,
//         usuariosAutenticados(), verificarIndices(), leerPropuesta(id), preguntar(texto),
//         decidir(entrada, operadoresJson) }
async function ejecutar(config, deps, log = console.log) {
  const { modo, operacion, propuesta_id: propuestaId, motivo = '' } = config;
  if (!MODOS.includes(modo)) throw new Error(`Modo desconocido "${modo}". Válidos: ${MODOS.join(', ')}.`);
  if (!TIPOS_DECISION.includes(operacion)) throw new Error(`OPERACION debe ser ${TIPOS_DECISION.join(' | ')} (recibido "${operacion}").`);
  if (typeof propuestaId !== 'string' || !UUID.test(propuestaId)) throw new Error('PROPUESTA_ID vacío o no es un UUID.');
  const faltaMotivo = TIPOS_QUE_REQUIEREN_MOTIVO.includes(operacion) && motivo.trim() === '';
  if (faltaMotivo && modo === 'decision_real') throw new Error(`"${operacion}" exige MOTIVO. No se conectó a Mongo.`);

  const uri = deps.uriDecision();
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('MONGODB_URI_DECISION ausente. No se usa MONGODB_URI como alternativa. No se conectó a Mongo.');
  }
  // Defensa en profundidad (ver cabecera): la garantía es resolverActor.
  if (uri === deps.uriBackend()) {
    throw new Error('MONGODB_URI_DECISION es igual a MONGODB_URI: tiene que ser la credencial personal del operador. No se conectó a Mongo.');
  }
  const operadoresJson = deps.operadoresJson();
  const operadores = cargarOperadoresAutorizados(operadoresJson); // aborta antes de conectar

  log(`Modo: ${modo} — operación: ${operacion}\n`);
  let dbName;
  try {
    dbName = await deps.conectar(uri);
  } catch (err) {
    throw new Error(`No se pudo conectar con MONGODB_URI_DECISION: ${ocultarUri(err?.message ?? err, uri)}`);
  }
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando.`);
  log(`Conectado a "${dbName}"`);

  let resolucion = null;
  try {
    resolucion = resolverActor(await deps.usuariosAutenticados(), operadores);
    log(`Operador: ${resolucion.actor.identificador} (usuario Atlas "${resolucion.identidad_operador.usuario_atlas}", evidencia operativa, no no repudio)\n`);
  } catch (err) {
    if (modo === 'decision_real') throw err;
    log(`Identidad RECHAZADA (una decisión real abortaría): ${err.message}\n`);
  }

  const propuesta = await deps.leerPropuesta(propuestaId);
  if (!propuesta) throw new Error(`No existe la propuesta ${propuestaId}.`);

  const hashRecalculado = hashSobreCanonico(propuesta.payload, propuesta.algoritmo_canonicalizacion, propuesta.algoritmo_hash);
  if (hashRecalculado !== propuesta.payload_hash) {
    throw new Error(`payload_hash guardado (${propuesta.payload_hash}) ≠ hash recalculado (${hashRecalculado}). Abortando sin decidir.`);
  }
  mostrarPropuesta(propuesta, log);
  log('hash recalculado: coincide\n');

  const regla = TRANSICIONES[operacion];
  const motivoInvalida = motivoTransicionInvalida(operacion, propuesta.estado, regla.hacia, 'humano');
  const sinDecisionPrevia = operacion === 'cancelacion' && propuesta.decision_aprobacion_id == null;
  if (motivoInvalida || sinDecisionPrevia) {
    const razon = motivoInvalida ?? `"${propuesta.estado}" sin decision_aprobacion_id: inconsistencia.`;
    if (modo === 'decision_real') throw new Error(`Operación no permitida: ${razon} No se escribió nada.`);
    log(`Operación NO permitida (una decisión real abortaría): ${razon}`);
  } else {
    const entrada = construirEntradaDesdeVista(operacion, propuesta, motivo);
    log(`Transición: ${propuesta.estado} -> ${regla.hacia}`);
    log('Filtro CAS que se usaría:');
    log(json(construirFiltroCas(entrada)));
    log('Update (evento_id y ocurrido_en se generan al decidir):');
    log(json(construirUpdateCas(entrada, '<evento_id>', '<ocurrido_en>')));
    if (faltaMotivo) log(`Falta MOTIVO: "${operacion}" lo exige.`);
  }

  let gateOk = true;
  try {
    await deps.verificarIndices();
    log('\nGate de índices (INDICES_DECISION): OK');
  } catch (err) {
    gateOk = false;
    if (modo === 'decision_real') throw err;
    log(`\nGate de índices FALLARÍA (una decisión real abortaría): ${err.message}`);
  }

  if (modo === 'solo_lectura') {
    log('\nModo solo_lectura: no se escribió nada.');
    return { modo, escrito: false, gate_ok: gateOk, identidad_ok: resolucion !== null };
  }

  const entrada = construirEntradaDesdeVista(operacion, propuesta, motivo);
  const respuesta = await deps.preguntar(`\nEscribí los primeros ${LARGO_CONFIRMACION} caracteres de payload_hash para confirmar: `);
  if (String(respuesta).trim() !== propuesta.payload_hash.slice(0, LARGO_CONFIRMACION)) {
    throw new Error('La confirmación no coincide con payload_hash. No se escribió nada.');
  }

  const resultado = await deps.decidir(entrada, operadoresJson);
  log('\n=== RESULTADO ===');
  log(json(resultado));
  return { modo, escrito: resultado.resultado === 'decision_registrada', resultado };
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
    preguntar: preguntarPorConsola,
    decidir: (entrada, operadoresJson) =>
      decidirPropuesta(entrada, crearDependenciasServicio(mongoose.connection, { operadoresJson }))
  };
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const uri = process.env.MONGODB_URI_DECISION;
  ejecutar({ modo: MODO, operacion: OPERACION, propuesta_id: PROPUESTA_ID, motivo: MOTIVO }, crearDependenciasComando(), console.log)
    .then(({ modo, escrito }) => {
      if (modo === 'decision_real' && !escrito) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Error:', ocultarUri(err?.message ?? err, uri));
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
  ocultarUri,
  construirEntradaDesdeVista,
  ejecutar,
  crearDependenciasComando
};
