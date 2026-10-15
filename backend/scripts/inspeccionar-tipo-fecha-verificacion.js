/**
 * Inspección de solo lectura del tipo BSON real de fecha_verificacion.
 *
 * Usa el driver nativo y exactamente un find sobre destinos, con una
 * proyección cerrada. No importa modelos Mongoose para evitar casts.
 * La URI se toma únicamente de MONGODB_URI_AUDITORIA y nunca se imprime.
 */

const { MongoClient } = require('mongodb');

const BASE_ESPERADA = 'buscador_requisitos';
const COLECCION = 'destinos';
const VARIABLE_URI = 'MONGODB_URI_AUDITORIA';
const COMANDOS_PERMITIDOS = new Set(['find', 'getMore', 'killCursors', 'endSessions']);
const PROYECCION = {
  _id: 0,
  pais: 1,
  codigo_iso: 1,
  'requisitos._id': 1,
  'requisitos.tipo': 1,
  'requisitos.nombre': 1,
  'requisitos.fecha_verificacion': 1
};

function tipoBsonDeserializado(valor, presente) {
  if (!presente) return 'ausente';
  if (valor === null) return 'null';
  if (valor instanceof Date) return 'date';
  if (typeof valor === 'string') return 'string';
  return `otro:${valor?._bsontype || typeof valor}`;
}

function valorFechaSeguro(valor, presente) {
  if (!presente || valor === null) return valor ?? null;
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? 'fecha_invalida' : valor.toISOString();
  if (typeof valor === 'string') {
    if (valor.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(valor)) {
      throw new Error('fecha_verificacion de texto tiene una forma insegura o inesperada.');
    }
    return valor;
  }
  return String(valor);
}

function resumirDocumentos(documentos, { incluirValores = false } = {}) {
  if (!Array.isArray(documentos)) throw new Error('La respuesta de destinos no es una lista.');
  const filas = [];
  for (const destino of documentos) {
    if (destino == null || typeof destino !== 'object') throw new Error('Destino con forma inválida.');
    if (destino.requisitos !== undefined && !Array.isArray(destino.requisitos)) {
      throw new Error(`requisitos no es una lista en ${destino.codigo_iso ?? 'destino sin código'}.`);
    }
    for (const requisito of destino.requisitos || []) {
      if (requisito == null || typeof requisito !== 'object') {
        throw new Error(`Requisito con forma inválida en ${destino.codigo_iso ?? 'destino sin código'}.`);
      }
      const presente = Object.prototype.hasOwnProperty.call(requisito, 'fecha_verificacion');
      const fila = {
        codigo_iso: destino.codigo_iso,
        pais: destino.pais,
        requisito_id: requisito._id == null ? null : String(requisito._id),
        tipo_requisito: requisito.tipo ?? null,
        nombre: requisito.nombre ?? null,
        tipo_bson: tipoBsonDeserializado(requisito.fecha_verificacion, presente)
      };
      if (incluirValores) fila.valor_fecha_verificacion = valorFechaSeguro(requisito.fecha_verificacion, presente);
      filas.push(fila);
    }
  }

  filas.sort((a, b) =>
    String(a.codigo_iso).localeCompare(String(b.codigo_iso)) ||
    String(a.requisito_id).localeCompare(String(b.requisito_id))
  );

  const conteos = {};
  for (const fila of filas) conteos[fila.tipo_bson] = (conteos[fila.tipo_bson] || 0) + 1;
  return {
    destinos: documentos.length,
    requisitos: filas.length,
    tipos: Object.fromEntries(Object.entries(conteos).sort(([a], [b]) => a.localeCompare(b))),
    tipos_mezclados: Object.keys(conteos).length > 1,
    foco: filas.filter((fila) => ['CO', 'CW'].includes(fila.codigo_iso)),
    filas
  };
}

function vigilarComandos(cliente) {
  const observados = [];
  cliente.on('commandStarted', (evento) => {
    observados.push(evento.commandName);
  });
  return {
    observados,
    verificar() {
      const noPermitido = observados.find((nombre) => !COMANDOS_PERMITIDOS.has(nombre));
      if (noPermitido) throw new Error(`Comando no permitido observado: ${noPermitido}`);
      if (observados.filter((nombre) => nombre === 'find').length !== 1) {
        throw new Error(`Se esperaba exactamente un find; observados: ${observados.join(', ')}`);
      }
    }
  };
}

function mensajeSeguro(error, uri) {
  let mensaje = String(error?.message ?? error);
  if (typeof uri === 'string' && uri !== '') mensaje = mensaje.split(uri).join('[URI oculta]');
  return mensaje.replace(/\/\/[^\s/@]*:[^\s/@]*@/gu, '//[credenciales ocultas]@');
}

async function inspeccionar({
  uri,
  incluirValores = false,
  crearCliente = (valor) => new MongoClient(valor, { monitorCommands: true })
}) {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error(`${VARIABLE_URI} ausente. No se usa MONGODB_URI como alternativa.`);
  }

  const cliente = crearCliente(uri);
  const vigilancia = vigilarComandos(cliente);
  let resultado;
  try {
    await cliente.connect();
    const base = cliente.db();
    if (base.databaseName !== BASE_ESPERADA) {
      throw new Error(`Base inesperada: ${base.databaseName}; se esperaba ${BASE_ESPERADA}.`);
    }
    const documentos = await base.collection(COLECCION)
      .find({}, { projection: PROYECCION })
      .sort({ codigo_iso: 1, _id: 1 })
      .toArray();
    resultado = resumirDocumentos(documentos, { incluirValores });
  } finally {
    await cliente.close();
  }
  vigilancia.verificar();
  return { ...resultado, comandos: [...vigilancia.observados] };
}

async function main() {
  require('dotenv').config({ quiet: true });
  const uri = process.env[VARIABLE_URI];
  try {
    const incluirValores = process.argv.slice(2).includes('--incluir-valores');
    const resultado = await inspeccionar({ uri, incluirValores });
    console.log(JSON.stringify(resultado, null, 2));
    console.error('Inspección terminada: solo se ejecutó find; Atlas no fue modificado.');
  } catch (error) {
    throw new Error(mensajeSeguro(error, uri));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error en la inspección: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASE_ESPERADA,
  COLECCION,
  COMANDOS_PERMITIDOS,
  PROYECCION,
  VARIABLE_URI,
  inspeccionar,
  mensajeSeguro,
  resumirDocumentos,
  tipoBsonDeserializado,
  valorFechaSeguro,
  vigilarComandos
};
