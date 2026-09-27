// Pruebas offline (sin conexión a Mongo, sin red) para los 6 schemas de
// backend/models/propuestas/. Usa document.validate() (Promise), NO
// validateSync(): en Mongoose 9.9.4 validateSync() no dispara los
// hooks pre('validate') personalizados.
//
// Uso: node scripts/test-modelos-propuestas.js

const assert = require('assert');
const mongoose = require('mongoose');
const crypto = require('crypto');

const EjecucionLectura = require('../models/propuestas/EjecucionLectura.model.js');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model.js');
const EventoPropuesta = require('../models/propuestas/EventoPropuesta.model.js');
const IntentoAplicacion = require('../models/propuestas/IntentoAplicacion.model.js');
const HistorialCambio = require('../models/propuestas/HistorialCambio.model.js');
const InicioIntentoAplicacion = require('../models/propuestas/InicioIntentoAplicacion.model.js');
const {
  ESTADOS_PROPUESTA,
  ESTADOS_ACTIVOS,
  TIPOS_EVENTO,
  TIPOS_ACTOR,
  TRANSICIONES,
  RESULTADOS_INTENTO,
  TRANSICION_POR_RESULTADO,
  RESULTADOS_CON_TRANSICION,
  TIPOS_EVENTO_CON_INTENTO,
  ETAPAS_INTENTO,
  ETAPAS_POR_RESULTADO,
  VENTANA_REVALIDACION_MS,
  motivoTransicionInvalida
} = require('../services/propuestas/contrato-propuestas');
const { CONJUNTOS_INDICES } = require('../services/propuestas/indices-propuestas');

// Módulo COMPARTIDO (ya no duplicado): mismo código que usa
// PropuestaCambio.model.js para validar payload_hash, y que deberá usar
// el futuro servicio de creación de propuestas para calcularlo.
const { canonicalizarValor, hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');

function construirPayloadPropuesta({ destinoId, requisitoId, campo, runId, propuestaId, valorAnterior, valorPropuesto, fuente }) {
  return {
    version_contrato: '1.0',
    tipo_propuesta: 'actualizacion_campo_requisito',
    fecha_propuesta: '2026-09-24T12:00:00.000Z',
    destino_id: String(destinoId),
    requisito_id: String(requisitoId),
    campo,
    run_id_origen: runId,
    propuesta_id: propuestaId,
    valor_anterior: valorAnterior,
    valor_propuesto: valorPropuesto,
    fuente
  };
}

async function assertValidationError(doc, mensajeParcial, etiqueta) {
  let err;
  try {
    await doc.validate();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `[${etiqueta}] se esperaba un ValidationError conteniendo "${mensajeParcial}"`);
  assert.ok(String(err.message).includes(mensajeParcial), `[${etiqueta}] mensaje real: ${err.message}`);
}

(async () => {
  // ============================================================
  // 1) Canonicalización: ausencia de clave !== null; undefined rechazado
  // ============================================================
  {
    const conNullExplicito = { a: 1, b: null };
    const sinLaClave = { a: 1 };

    const canonNull = JSON.stringify(canonicalizarValor(conNullExplicito));
    const canonAusente = JSON.stringify(canonicalizarValor(sinLaClave));

    assert.strictEqual(canonNull, '{"a":1,"b":null}');
    assert.strictEqual(canonAusente, '{"a":1}');
    assert.notStrictEqual(canonNull, canonAusente, 'ausencia de clave debe canonicalizar distinto de {clave:null}');

    assert.throws(() => canonicalizarValor({ a: 1, b: undefined }), /undefined.*no está permitido/);
    assert.throws(() => canonicalizarValor(undefined), /undefined.*no está permitido/);

    console.log('1) ausencia !== null / undefined rechazado: OK');
  }

  // ============================================================
  // 2) Vector fijo: JSON canónico y hash SHA-256 esperados como
  //    LITERALES escritos a mano (no derivados llamando a
  //    canonicalizarValor/hashSobreCanonico) — si esta prueba solo
  //    comparara la salida del módulo contra sí misma, un bug en el
  //    algoritmo (ej. orden de claves, manejo de fechas) pasaría
  //    desapercibido porque el "esperado" tendría el mismo bug que el
  //    "obtenido". Acá el JSON y el hash esperados están escritos a
  //    mano con las claves ya en orden alfabético en cada nivel, y el
  //    hash esperado se recalcula con `crypto` directo sobre ESE string
  //    literal (no a través de hashSobreCanonico) antes de comparar
  //    contra el módulo real.
  // ============================================================
  {
    // Payload de entrada con claves deliberadamente en desorden y
    // valores que ejercitan varios niveles de anidamiento.
    const payloadVectorFijo = {
      run_id_origen: '11111111-1111-4111-8111-111111111111',
      campo: 'costo',
      destino_id: '000000000000000000000001',
      fuente: {
        url: 'https://www.gov.uk/api/content/eta',
        nombre: 'GOV.UK',
        capturado_en: '2026-01-01T00:00:00.000Z'
      },
      propuesta_id: '22222222-2222-4222-8222-222222222222',
      requisito_id: '000000000000000000000002',
      valor_propuesto: {
        valor_normalizado: { moneda: 'GBP', importe: 20 },
        evidencia: {},
        valor: 'GBP 20.00'
      },
      valor_anterior: { valor: null, presente: false }
    };

    // JSON canónico ESPERADO: escrito a mano, con las claves de cada
    // nivel ya en orden alfabético (campo < destino_id < fuente <
    // propuesta_id < requisito_id < run_id_origen < valor_anterior <
    // valor_propuesto; y dentro de cada subobjeto, ídem).
    const jsonCanonicoEsperado =
      '{"algoritmo_canonicalizacion":"toc-v1","algoritmo_hash":"sha256","payload":' +
      '{"campo":"costo","destino_id":"000000000000000000000001",' +
      '"fuente":{"capturado_en":"2026-01-01T00:00:00.000Z","nombre":"GOV.UK","url":"https://www.gov.uk/api/content/eta"},' +
      '"propuesta_id":"22222222-2222-4222-8222-222222222222",' +
      '"requisito_id":"000000000000000000000002",' +
      '"run_id_origen":"11111111-1111-4111-8111-111111111111",' +
      '"valor_anterior":{"presente":false,"valor":null},' +
      '"valor_propuesto":{"evidencia":{},"valor":"GBP 20.00","valor_normalizado":{"importe":20,"moneda":"GBP"}}}}';

    // Hash SHA-256 ESPERADO del string de arriba, recalculado con
    // `crypto` DIRECTO (sin pasar por hashSobreCanonico) para no
    // depender del módulo bajo prueba en ninguno de los dos lados.
    const hashEsperadoIndependiente = crypto.createHash('sha256').update(jsonCanonicoEsperado).digest('hex');
    // Y el mismo valor, pegado como literal, para detectar si alguien
    // cambia `jsonCanonicoEsperado` sin querer sin notar que el hash
    // ya no corresponde.
    const HASH_ESPERADO_LITERAL = '150883ce372f6464604a6d23bba05782d76944ac3a833c5a2aa38554cce60b2d';
    assert.strictEqual(hashEsperadoIndependiente, HASH_ESPERADO_LITERAL, 'el hash literal pegado en el test no corresponde al JSON literal pegado en el test (revisar el vector fijo)');

    // Recién acá se ejercita el módulo real bajo prueba, y se compara
    // contra los dos literales de arriba.
    const jsonCanonicoObtenido = JSON.stringify(
      canonicalizarValor({ algoritmo_canonicalizacion: 'toc-v1', algoritmo_hash: 'sha256', payload: payloadVectorFijo })
    );
    assert.strictEqual(jsonCanonicoObtenido, jsonCanonicoEsperado, 'canonicalizarValor no produjo el JSON canónico esperado para el vector fijo');

    const hashObtenido = hashSobreCanonico(payloadVectorFijo, 'toc-v1', 'sha256');
    assert.strictEqual(hashObtenido, HASH_ESPERADO_LITERAL, 'hashSobreCanonico no produjo el hash esperado para el vector fijo');

    console.log('2) vector fijo (JSON canónico + hash SHA-256 literales): OK');
  }

  // ============================================================
  // 3) hashSobreCanonico rechaza algoritmos desconocidos (en vez de
  //    hashear igual usando 'sha256' hardcodeado, que era el bug: el
  //    parámetro algoritmoHash no tenía ningún efecto real).
  // ============================================================
  {
    const payloadDeMuestra = { x: 1 };

    assert.throws(
      () => hashSobreCanonico(payloadDeMuestra, 'toc-v2', 'sha256'),
      /algoritmo_canonicalizacion "toc-v2" no soportado/,
      'un algoritmo_canonicalizacion desconocido debe rechazarse explícitamente'
    );

    assert.throws(
      () => hashSobreCanonico(payloadDeMuestra, 'toc-v1', 'md5'),
      /algoritmo_hash "md5" no soportado/,
      'un algoritmo_hash desconocido debe rechazarse explícitamente'
    );

    console.log('3) algoritmo_canonicalizacion/algoritmo_hash desconocidos rechazados: OK');
  }

  // ============================================================
  // 4) Hash sobre el SOBRE completo (no solo el payload)
  // ============================================================
  let docPropuestaValidaParaReusar;
  {
    const destinoId = new mongoose.Types.ObjectId();
    const requisitoId = new mongoose.Types.ObjectId();
    const runId = crypto.randomUUID();
    const propuestaId = crypto.randomUUID();

    const payload = construirPayloadPropuesta({
      destinoId,
      requisitoId,
      campo: 'costo',
      runId,
      propuestaId,
      valorAnterior: { presente: false, valor: null },
      valorPropuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' }, evidencia: {} },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: new Date().toISOString() }
    });

    const hashSobreCompleto = hashSobreCanonico(payload, 'toc-v1', 'sha256');
    const hashSoloPayload = crypto.createHash('sha256').update(JSON.stringify(canonicalizarValor(payload))).digest('hex');
    assert.notStrictEqual(hashSobreCompleto, hashSoloPayload, 'el hash del sobre completo debe ser distinto del hash calculado solo sobre el payload');

    const doc = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'costo',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hashSobreCompleto,
      run_id_origen: runId
    });
    await doc.validate(); // no debe tirar
    docPropuestaValidaParaReusar = doc;

    const docConHashViejo = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'costo',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hashSoloPayload,
      run_id_origen: runId
    });
    await assertValidationError(docConHashViejo, 'no coincide con el hash recalculado del sobre canónico completo', 'hash-solo-payload-rechazado');

    console.log('4) hash del sobre completo (algoritmo_canonicalizacion+algoritmo_hash+payload): OK');
  }

  // ============================================================
  // 5) Divergencia entre payload y campos externos (incluye
  //    valor_anterior/valor_propuesto/fuente, que ahora solo viven en
  //    el payload — se valida su shape a mano)
  // ============================================================
  {
    const destinoId = new mongoose.Types.ObjectId();
    const requisitoId = new mongoose.Types.ObjectId();
    const runIdReal = crypto.randomUUID();
    const runIdDistinto = crypto.randomUUID();
    const propuestaId = crypto.randomUUID();

    const payload = construirPayloadPropuesta({
      destinoId,
      requisitoId,
      campo: 'costo',
      runId: runIdReal,
      propuestaId,
      valorAnterior: { presente: false, valor: null },
      valorPropuesto: { valor: '£20', valor_normalizado: {}, evidencia: {} },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: new Date().toISOString() }
    });
    const hash = hashSobreCanonico(payload, 'toc-v1', 'sha256');

    const docDivergente = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'costo',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hash,
      run_id_origen: runIdDistinto // <- diverge de payload.run_id_origen
    });
    await assertValidationError(docDivergente, 'no coincide con el campo externo', 'divergencia-payload-run_id_origen');

    // valor_anterior/valor_propuesto/fuente ya NO son campos top-level:
    // Mongoose los ignora si se pasan afuera (schema strict) — el único
    // lugar válido es dentro de payload.
    const docSinCamposTopLevel = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'costo',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hash,
      run_id_origen: runIdReal,
      // pasados "a mano" para demostrar que no quedan como paths reales:
      valor_anterior: { presente: true, valor: 'NO_DEBERIA_GUARDARSE' },
      fuente: { nombre: 'OTRA_FUENTE' }
    });
    assert.strictEqual(PropuestaCambio.schema.path('valor_anterior'), undefined, 'no debe existir un path real "valor_anterior" fuera de payload (solo el virtual)');
    await docSinCamposTopLevel.validate();
    assert.deepStrictEqual(docSinCamposTopLevel.valor_anterior, payload.valor_anterior, 'el virtual "valor_anterior" debe leer desde payload, ignorando cualquier campo top-level pasado por error');
    assert.deepStrictEqual(docSinCamposTopLevel.fuente, payload.fuente, 'el virtual "fuente" debe leer siempre desde payload, no desde un campo top-level fantasma');

    // payload.valor_anterior con shape inválido -> rechazado a mano.
    const payloadValorAnteriorInvalido = construirPayloadPropuesta({
      destinoId,
      requisitoId,
      campo: 'costo',
      runId: runIdReal,
      propuestaId,
      valorAnterior: { valor: 'sin presente' }, // falta "presente"
      valorPropuesto: { valor: '£20', valor_normalizado: {}, evidencia: {} },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: new Date().toISOString() }
    });
    const hashInvalido = hashSobreCanonico(payloadValorAnteriorInvalido, 'toc-v1', 'sha256');
    const docShapeInvalido = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'costo',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload: payloadValorAnteriorInvalido,
      payload_hash: hashInvalido,
      run_id_origen: runIdReal
    });
    await assertValidationError(docShapeInvalido, 'valor_anterior.presente debe ser boolean', 'payload-valor_anterior-shape-invalido');

    console.log('5) divergencia payload/campos externos + shape de valor_anterior/valor_propuesto/fuente: OK');
  }

  // ============================================================
  // 6) Allowlist: MVP solo soporta 'costo'
  // ============================================================
  {
    const destinoId = new mongoose.Types.ObjectId();
    const requisitoId = new mongoose.Types.ObjectId();
    const runId = crypto.randomUUID();
    const propuestaId = crypto.randomUUID();
    const payload = construirPayloadPropuesta({
      destinoId,
      requisitoId,
      campo: 'nombre', // fuera de la allowlist
      runId,
      propuestaId,
      valorAnterior: { presente: false, valor: null },
      valorPropuesto: { valor: 'x', valor_normalizado: {}, evidencia: {} },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: new Date().toISOString() }
    });
    const hash = hashSobreCanonico(payload, 'toc-v1', 'sha256');

    const docCampoInvalido = new PropuestaCambio({
      destino_id: destinoId,
      requisito_id: requisitoId,
      campo: 'nombre',
      propuesta_id: propuestaId,
      algoritmo_canonicalizacion: 'toc-v1',
      algoritmo_hash: 'sha256',
      payload,
      payload_hash: hash,
      run_id_origen: runId
    });
    const err = await docCampoInvalido.validate().then(() => null).catch((e) => e);
    assert.ok(err, 'campo fuera de la allowlist (solo costo) debe rechazarse');
    assert.ok(err.errors && err.errors.campo, 'el error debe venir del path "campo" (enum)');

    console.log('6) campo fuera de costo rechazado: OK');
  }

  // ============================================================
  // 7) decision_aprobacion_id: primera asignación null -> UUID no debe
  //    bloquearse (se quitó la falsa garantía "immutable" funcional)
  // ============================================================
  {
    assert.strictEqual(docPropuestaValidaParaReusar.decision_aprobacion_id, null);

    // Simula un documento tal como vendría de Mongo (isNew=false, nada
    // modificado) con Model.hydrate(), en vez de forzar isNew a mano
    // sobre el objeto recién construido: eso arrastraría `payload` como
    // "modificado" desde la construcción y dispararía el guard de
    // inmutabilidad del payload, que es un problema distinto al que
    // esta prueba busca aislar.
    const comoSiVinieraDeMongo = PropuestaCambio.hydrate(docPropuestaValidaParaReusar.toObject({ virtuals: false }));
    assert.strictEqual(comoSiVinieraDeMongo.isNew, false);
    assert.strictEqual(comoSiVinieraDeMongo.isModified('payload'), false);

    comoSiVinieraDeMongo.decision_aprobacion_id = crypto.randomUUID();
    await comoSiVinieraDeMongo.validate(); // no debe tirar: sin "immutable" funcional, la primera asignación null->UUID no se bloquea

    const opcionesPath = PropuestaCambio.schema.path('decision_aprobacion_id').options;
    assert.ok(!opcionesPath.immutable, 'decision_aprobacion_id no debe tener una restricción "immutable" a nivel de schema');

    console.log('7) decision_aprobacion_id: primera asignación null->UUID permitida (sin falsa garantía "immutable"): OK');
  }

  // ============================================================
  // 8) EventoPropuesta: transición permitida por la matriz del contrato
  //    (humano decide, sistema aplica) + versión nueva + intento para
  //    eventos de aplicación/fallo + append-only
  // ============================================================
  {
    const hashDummy = crypto.createHash('sha256').update('x').digest('hex');
    const humano = { tipo: 'humano', identificador: 'operador-atlas' };
    const sistema = { tipo: 'sistema', identificador: 'aplicar-propuesta@1' };
    const evento = (extra) =>
      new EventoPropuesta({
        propuesta_id: crypto.randomUUID(),
        hash_contenido_referenciado: hashDummy,
        ocurrido_en: new Date(),
        version_coordinacion_nueva: 1,
        ...extra
      });
    const conIntento = { intento_aplicacion_id: crypto.randomUUID(), version_coordinacion_nueva: 2 };

    const validos = [
      { tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: humano },
      { tipo_evento: 'rechazo', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'rechazada', actor: humano, motivo: 'monto no confirmado' },
      { tipo_evento: 'cancelacion', estado_anterior: 'aprobada', estado_nuevo: 'cancelada', actor: humano, motivo: 'se retira', version_coordinacion_nueva: 2 },
      { tipo_evento: 'cancelacion', estado_anterior: 'revision_requerida', estado_nuevo: 'cancelada', actor: humano, motivo: 'fuente ambigua', version_coordinacion_nueva: 3 },
      { tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'aplicada', actor: sistema, ...conIntento },
      { tipo_evento: 'entrada_revision', estado_anterior: 'aprobada', estado_nuevo: 'revision_requerida', actor: sistema, ...conIntento },
      { tipo_evento: 'obsolescencia', estado_anterior: 'aprobada', estado_nuevo: 'obsoleta', actor: sistema, motivo: 'fuente_cambio', ...conIntento },
      { tipo_evento: 'conflicto', estado_anterior: 'aprobada', estado_nuevo: 'conflicto', actor: sistema, motivo: 'valor_actual_cambio', ...conIntento }
    ];
    for (const extra of validos) await evento(extra).validate();

    const casosInvalidos = [
      ['aprobacion-requiere-humano', { tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: sistema }, 'actor.tipo'],
      ['aplicacion-por-humano', { tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'aplicada', actor: humano, ...conIntento }, 'exige actor.tipo en [sistema]'],
      ['rechazo-requiere-motivo', { tipo_evento: 'rechazo', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'rechazada', actor: humano }, 'motivo'],
      ['rechazo-desde-aprobada', { tipo_evento: 'rechazo', estado_anterior: 'aprobada', estado_nuevo: 'rechazada', actor: humano, motivo: 'x' }, 'transición no permitida'],
      ['evento-sin-estado_anterior', { tipo_evento: 'entrada_revision', estado_nuevo: 'revision_requerida', actor: sistema, ...conIntento }, 'estado_anterior'],
      ['evento-sin-transicion-real', { tipo_evento: 'entrada_revision', estado_anterior: 'aprobada', estado_nuevo: 'aprobada', actor: sistema, ...conIntento }, 'no representa una transición real'],
      ['cancelacion-desde-pendiente', { tipo_evento: 'cancelacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'cancelada', actor: humano, motivo: 'x' }, 'transición no permitida'],
      ['cancelacion-por-sistema', { tipo_evento: 'cancelacion', estado_anterior: 'aprobada', estado_nuevo: 'cancelada', actor: sistema, motivo: 'x' }, 'exige actor.tipo en [humano]'],
      ['salida_revision-no-existe', { tipo_evento: 'salida_revision', estado_anterior: 'revision_requerida', estado_nuevo: 'aprobada', actor: humano }, 'no tiene ninguna transición permitida'],
      ['entrada_revision-por-humano', { tipo_evento: 'entrada_revision', estado_anterior: 'aprobada', estado_nuevo: 'revision_requerida', actor: humano, ...conIntento }, 'exige actor.tipo'],
      ['aplicacion-a-otro-estado', { tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'cancelada', actor: sistema, ...conIntento }, 'debe llegar a "aplicada"'],
      ['conflicto-sin-intento', { tipo_evento: 'conflicto', estado_anterior: 'aprobada', estado_nuevo: 'conflicto', actor: sistema, motivo: 'x' }, 'intento_aplicacion_id'],
      ['aplicacion-sin-intento', { tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'aplicada', actor: sistema }, 'intento_aplicacion_id'],
      ['sin-version', { tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: humano, version_coordinacion_nueva: undefined }, 'version_coordinacion_nueva'],
      ['version-cero', { tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: humano, version_coordinacion_nueva: 0 }, 'version_coordinacion_nueva'],
      ['version-no-entera', { tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: humano, version_coordinacion_nueva: 1.5 }, 'entero']
    ];
    for (const [etiqueta, extra, mensaje] of casosInvalidos) {
      await assertValidationError(evento(extra), mensaje, etiqueta);
    }

    const existente = evento({ tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', actor: humano });
    existente.isNew = false;
    await assertValidationError(existente, 'append-only', 'evento-append-only');

    console.log('8) EventoPropuesta (matriz de transiciones, versión, intento, append-only): OK');
  }

  // ============================================================
  // 9) EjecucionLectura: campos condicionales + run_id propio + append-only
  // ============================================================
  {
    const ok = new EjecucionLectura({
      estado_ejecucion: 'ok',
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      destino_id: new mongoose.Types.ObjectId(),
      requisito_id: new mongoose.Types.ObjectId(),
      campo: 'costo',
      fuente_nombre: 'GOV.UK',
      fuente_url: 'https://www.gov.uk/api/content/eta',
      evidencia: { overview: {}, apply: {} },
      resultado_comparacion: { categoria: 'COINCIDE', ambiguo: false },
      valor_previo_en_mongo: { presente: true, valor: '£20' }
    });
    await ok.validate();
    assert.ok(typeof ok.run_id === 'string' && ok.run_id.length > 0, 'run_id debe autogenerarse como UUID string');

    const fallo = new EjecucionLectura({
      estado_ejecucion: 'fallo',
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      campo: 'costo',
      fuente_nombre: 'GOV.UK',
      fuente_url: 'https://www.gov.uk/api/content/eta',
      evidencia: {}
    });
    await assertValidationError(fallo, 'etapa_fallo', 'ejecucion-fallo-requiere-etapa');

    const existente = new EjecucionLectura({
      estado_ejecucion: 'ok',
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      campo: 'costo',
      fuente_nombre: 'GOV.UK',
      fuente_url: 'https://www.gov.uk/api/content/eta',
      evidencia: {},
      resultado_comparacion: { categoria: 'COINCIDE', ambiguo: false },
      valor_previo_en_mongo: { presente: false, valor: null }
    });
    existente.isNew = false;
    await assertValidationError(existente, 'append-only', 'ejecucion-append-only');

    console.log('9) EjecucionLectura: OK');
  }

  // ============================================================
  // 10) IntentoAplicacion: roles separados, etapa_fallo, y campos
  //     condicionales según el resultado efectivo
  // ============================================================
  {
    const hashDummy = crypto.createHash('sha256').update('x').digest('hex');
    const revalidacion = (coincide, extra = {}) => ({
      revalidada_en: new Date(),
      fuente_nombre: 'GOV.UK',
      url: 'https://www.gov.uk/api/content/eta',
      valor_revalidado: coincide ? 20 : 25,
      coincide_con_propuesta: coincide,
      ...extra
    });
    const ausente = { presente: false, valor: null };
    const observado = { presente: true, valor: '£19' };
    const identidad = { categoria: 'requisito_id_no_encontrado' };
    const intento = (extra) =>
      new IntentoAplicacion({
        propuesta_id: crypto.randomUUID(),
        operador: { tipo: 'humano', identificador: 'operador-atlas' },
        proceso_aplicador: { nombre: 'aplicar-propuesta', version: '1' },
        adaptador: { nombre: 'govuk-uk-eta', version: '1' },
        hash_contenido_referenciado: hashDummy,
        version_coordinacion_esperada: 1,
        decision_aprobacion_id: crypto.randomUUID(),
        iniciado_en: new Date(),
        finalizado_en: new Date(),
        evidencia_fresca: {},
        ...extra
      });
    const abortadaTransicion = (resultadoNoRegistrado, extra = {}) => ({
      resultado: 'escritura_abortada',
      etapa_fallo: 'transicion_por_fallo',
      resultado_no_registrado: resultadoNoRegistrado,
      error_mensaje: 'WriteConflict al registrar la transición',
      ...extra
    });

    const exitoso = intento({ resultado: 'exito', revalidacion: revalidacion(true), precondicion: ausente, historial_id: crypto.randomUUID() });
    await exitoso.validate();
    assert.ok(exitoso.revalidacion.revalidacion_id, 'revalidacion debe autogenerar su propio revalidacion_id');

    const validos = [
      ['fuente_no_disponible', { resultado: 'fuente_temporalmente_no_disponible', etapa_fallo: 'revalidacion_externa', error_mensaje: 'timeout', evidencia_fresca: { ultimoStatus: 'ETIMEDOUT' } }],
      ['extraccion_ambigua', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'dos montos' }],
      ['fuente_cambio', { resultado: 'fuente_cambio', etapa_fallo: 'revalidacion_externa', error_mensaje: 'cambió', revalidacion: revalidacion(false) }],
      ['valor_actual_cambio', { resultado: 'valor_actual_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'costo presente', revalidacion: revalidacion(true), precondicion: ausente, valor_observado: observado }],
      ['identidad', { resultado: 'identidad_requisito_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'no encontrado', revalidacion: revalidacion(true), identidad_esperada_no_coincide: identidad }],
      ['no_aplicable-precondiciones', { resultado: 'propuesta_no_aplicable', etapa_fallo: 'precondiciones_propuesta', error_mensaje: 'no aprobada', decision_aprobacion_id: null }],
      ['no_aplicable-escritura', { resultado: 'propuesta_no_aplicable', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'versión distinta', revalidacion: revalidacion(true) }],
      ['revalidacion_vencida', { resultado: 'revalidacion_vencida', etapa_fallo: 'escritura_aplicacion', error_mensaje: '16 minutos', revalidacion: revalidacion(true) }],
      ['abortada-escritura', { resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'Transient agotado', revalidacion: revalidacion(true) }],
      ['abortada-transicion-ambigua', abortadaTransicion('extraccion_ambigua')],
      ['abortada-transicion-fuente_cambio', abortadaTransicion('fuente_cambio', { revalidacion: revalidacion(false) })],
      ['abortada-transicion-valor', abortadaTransicion('valor_actual_cambio', { revalidacion: revalidacion(true), precondicion: ausente, valor_observado: observado })],
      ['abortada-transicion-identidad', abortadaTransicion('identidad_requisito_cambio', { revalidacion: revalidacion(true), identidad_esperada_no_coincide: identidad })]
    ];
    for (const [etiqueta, extra] of validos) {
      const doc = intento(extra);
      try {
        await doc.validate();
      } catch (err) {
        throw new Error(`[${etiqueta}] debía ser válido: ${err.message}`);
      }
    }

    const casosInvalidos = [
      ['exito-sin-historial', { resultado: 'exito', revalidacion: revalidacion(true), precondicion: ausente }, 'historial_id'],
      ['exito-con-etapa', { resultado: 'exito', etapa_fallo: 'escritura_aplicacion', revalidacion: revalidacion(true), precondicion: ausente, historial_id: 'h' }, 'no admite etapa_fallo'],
      ['fallo-sin-etapa', { resultado: 'extraccion_ambigua', error_mensaje: 'x' }, 'etapa_fallo'],
      ['etapa-no-admitida', { resultado: 'fuente_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(false) }, 'admite etapa_fallo en [revalidacion_externa]'],
      ['etapa-desconocida', { resultado: 'extraccion_ambigua', etapa_fallo: 'otra', error_mensaje: 'x' }, 'admite etapa_fallo en'],
      // escritura_abortada: revalidacion solo si la revalidación externa terminó correctamente.
      ['abortada-escritura-sin-revalidacion', { resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x' }, 'revalidacion'],
      ['abortada-transicion-ambigua-con-revalidacion', abortadaTransicion('extraccion_ambigua', { revalidacion: revalidacion(true) }), 'no admite revalidacion'],
      ['abortada-transicion-fuente_cambio-sin-revalidacion', abortadaTransicion('fuente_cambio'), 'revalidacion'],
      ['abortada-transicion-fuente_cambio-coincide', abortadaTransicion('fuente_cambio', { revalidacion: revalidacion(true) }), 'coincide_con_propuesta === false'],
      ['abortada-transicion-valor-sin-observado', abortadaTransicion('valor_actual_cambio', { revalidacion: revalidacion(true), precondicion: ausente }), 'valor_observado'],
      ['abortada-transicion-sin-resultado_no_registrado', { resultado: 'escritura_abortada', etapa_fallo: 'transicion_por_fallo', error_mensaje: 'x' }, 'resultado_no_registrado'],
      ['abortada-transicion-resultado-sin-transicion', abortadaTransicion('revalidacion_vencida', { revalidacion: revalidacion(true) }), 'is not a valid enum value'],
      ['resultado_no_registrado-fuera-de-abortada', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', resultado_no_registrado: 'extraccion_ambigua' }, 'resultado_no_registrado solo se admite'],
      // revalidacion prohibida cuando la revalidación no terminó correctamente.
      ['fuente_no_disponible-con-revalidacion', { resultado: 'fuente_temporalmente_no_disponible', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', revalidacion: revalidacion(true) }, 'no admite revalidacion'],
      ['no_aplicable-precondiciones-con-revalidacion', { resultado: 'propuesta_no_aplicable', etapa_fallo: 'precondiciones_propuesta', error_mensaje: 'x', revalidacion: revalidacion(true) }, 'no admite revalidacion'],
      ['no_aplicable-escritura-sin-revalidacion', { resultado: 'propuesta_no_aplicable', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x' }, 'revalidacion'],
      ['fuente_cambio-exige-no-coincide', { resultado: 'fuente_cambio', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', revalidacion: revalidacion(true) }, 'coincide_con_propuesta === false'],
      ['valor_actual_cambio-sin-precondicion', { resultado: 'valor_actual_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(true), valor_observado: observado }, 'precondicion'],
      ['valor_actual_cambio-sin-observado', { resultado: 'valor_actual_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(true), precondicion: ausente }, 'valor_observado'],
      ['identidad-sin-identidad', { resultado: 'identidad_requisito_cambio', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(true) }, 'identidad_esperada_no_coincide'],
      ['revalidacion-sin-revalidada_en', { resultado: 'revalidacion_vencida', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(true, { revalidada_en: undefined }) }, 'revalidada_en'],
      ['fallo-con-historial', { resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', error_mensaje: 'x', revalidacion: revalidacion(true), historial_id: 'h' }, 'solo un intento "exito"'],
      ['exito-con-observado', { resultado: 'exito', revalidacion: revalidacion(true), precondicion: ausente, historial_id: 'h', valor_observado: observado }, 'no admite valor_observado'],
      ['fallo-sin-decision', { resultado: 'fuente_cambio', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', revalidacion: revalidacion(false), decision_aprobacion_id: null }, 'decision_aprobacion_id'],
      // roles separados.
      ['sin-operador', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', operador: undefined }, 'operador'],
      ['operador-sistema', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', operador: { tipo: 'sistema', identificador: 'cron' } }, 'operador.tipo'],
      ['sin-proceso_aplicador', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', proceso_aplicador: undefined }, 'proceso_aplicador'],
      ['sin-adaptador', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', adaptador: undefined }, 'adaptador'],
      ['hash-invalido', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', hash_contenido_referenciado: 'abc' }, 'hash_contenido_referenciado'],
      ['version-negativa', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa', error_mensaje: 'x', version_coordinacion_esperada: -1 }, 'version_coordinacion_esperada'],
      ['fallo-sin-error_mensaje', { resultado: 'extraccion_ambigua', etapa_fallo: 'revalidacion_externa' }, 'error_mensaje']
    ];
    for (const [etiqueta, extra, mensaje] of casosInvalidos) {
      await assertValidationError(intento(extra), mensaje, etiqueta);
    }

    exitoso.isNew = false;
    await assertValidationError(exitoso, 'append-only', 'intento-append-only');

    console.log(`10) IntentoAplicacion (${validos.length + 1} válidos, ${casosInvalidos.length} inválidos: roles, etapa_fallo, resultado efectivo): OK`);
  }

  // ============================================================
  // 11) HistorialCambio: sin campo `revalidacion` denormalizado, con
  //    revalidacion_id propio + append-only
  // ============================================================
  {
    const cambio = new HistorialCambio({
      destino_id: new mongoose.Types.ObjectId(),
      requisito_id: new mongoose.Types.ObjectId(),
      campo: 'costo',
      valor_anterior: { presente: false, valor: null },
      valor_nuevo: { presente: true, valor: '£20' },
      aplicado_en: new Date(),
      propuesta_id: crypto.randomUUID(),
      decision_aprobacion_id: crypto.randomUUID(),
      intento_aplicacion_id: crypto.randomUUID(),
      revalidacion_id: crypto.randomUUID()
    });
    await cambio.validate();
    assert.strictEqual(cambio.toObject().revalidacion, undefined, 'no debe existir un campo "revalidacion" denormalizado');

    const sinRevalidacionId = new HistorialCambio({
      destino_id: new mongoose.Types.ObjectId(),
      requisito_id: new mongoose.Types.ObjectId(),
      campo: 'costo',
      valor_anterior: { presente: false, valor: null },
      valor_nuevo: { presente: true, valor: '£20' },
      aplicado_en: new Date(),
      propuesta_id: crypto.randomUUID(),
      decision_aprobacion_id: crypto.randomUUID(),
      intento_aplicacion_id: crypto.randomUUID()
    });
    await assertValidationError(sinRevalidacionId, 'revalidacion_id', 'historial-requiere-revalidacion_id');

    cambio.isNew = false;
    await assertValidationError(cambio, 'append-only', 'historial-append-only');

    console.log('11) HistorialCambio: OK');
  }

  // ============================================================
  // 12) Contrato compartido: matriz de transiciones verificada contra
  //     una lista escrita a mano (no derivada de TRANSICIONES), etapas
  //     por resultado, y enums de los modelos idénticos a los del contrato.
  // ============================================================
  {
    const permitidasEsperadas = [
      'aprobacion|pendiente_aprobacion|aprobada|humano',
      'rechazo|pendiente_aprobacion|rechazada|humano',
      'cancelacion|aprobada|cancelada|humano',
      'cancelacion|revision_requerida|cancelada|humano',
      'aplicacion|aprobada|aplicada|sistema',
      'entrada_revision|aprobada|revision_requerida|sistema',
      'obsolescencia|aprobada|obsoleta|sistema',
      'conflicto|aprobada|conflicto|sistema'
    ];
    const permitidasReales = [];
    for (const tipo of TIPOS_EVENTO) {
      for (const anterior of ESTADOS_PROPUESTA) {
        for (const nuevo of ESTADOS_PROPUESTA) {
          for (const actor of TIPOS_ACTOR) {
            if (motivoTransicionInvalida(tipo, anterior, nuevo, actor) === null) {
              permitidasReales.push(`${tipo}|${anterior}|${nuevo}|${actor}`);
            }
          }
        }
      }
    }
    assert.deepStrictEqual(permitidasReales.sort(), [...permitidasEsperadas].sort(), 'matriz de transiciones');

    // Ningún tipo de evento del contrato resulta siempre inválido.
    assert.deepStrictEqual([...TIPOS_EVENTO].sort(), Object.keys(TRANSICIONES).sort());
    assert.ok(!TIPOS_EVENTO.includes('salida_revision'), 'salida_revision fuera del MVP');
    // revision_requerida tiene salida (cancelación humana).
    assert.ok(Object.values(TRANSICIONES).some((t) => t.desde.includes('revision_requerida')));

    assert.deepStrictEqual(TRANSICION_POR_RESULTADO, {
      extraccion_ambigua: 'entrada_revision',
      fuente_cambio: 'obsolescencia',
      valor_actual_cambio: 'conflicto',
      identidad_requisito_cambio: 'conflicto'
    });
    assert.deepStrictEqual(RESULTADOS_CON_TRANSICION, Object.keys(TRANSICION_POR_RESULTADO));
    const sinTransicion = RESULTADOS_INTENTO.filter((r) => !(r in TRANSICION_POR_RESULTADO)).sort();
    assert.deepStrictEqual(sinTransicion, [
      'escritura_abortada',
      'exito',
      'fuente_temporalmente_no_disponible',
      'propuesta_no_aplicable',
      'revalidacion_vencida'
    ]);
    for (const tipo of Object.values(TRANSICION_POR_RESULTADO)) {
      assert.deepStrictEqual(TRANSICIONES[tipo].actores, ['sistema'], `${tipo}: transición automática debe ser de sistema`);
      assert.deepStrictEqual(TRANSICIONES[tipo].desde, ['aprobada'], `${tipo}: solo desde aprobada`);
    }
    assert.deepStrictEqual([...TIPOS_EVENTO_CON_INTENTO].sort(), ['aplicacion', 'conflicto', 'entrada_revision', 'obsolescencia']);

    assert.deepStrictEqual(ETAPAS_INTENTO, ['precondiciones_propuesta', 'revalidacion_externa', 'escritura_aplicacion', 'transicion_por_fallo']);
    assert.deepStrictEqual(Object.keys(ETAPAS_POR_RESULTADO).sort(), RESULTADOS_INTENTO.filter((r) => r !== 'exito').sort());
    for (const etapas of Object.values(ETAPAS_POR_RESULTADO)) {
      for (const etapa of etapas) assert.ok(ETAPAS_INTENTO.includes(etapa), etapa);
    }
    assert.deepStrictEqual(ETAPAS_POR_RESULTADO.escritura_abortada, ['escritura_aplicacion', 'transicion_por_fallo']);
    assert.strictEqual(VENTANA_REVALIDACION_MS, 15 * 60 * 1000);

    assert.deepStrictEqual(PropuestaCambio.schema.path('estado').enumValues, ESTADOS_PROPUESTA);
    assert.ok(ESTADOS_PROPUESTA.includes('conflicto') && ESTADOS_PROPUESTA.includes('cancelada'));
    assert.deepStrictEqual(ESTADOS_ACTIVOS, ['pendiente_aprobacion', 'aprobada', 'revision_requerida']);
    assert.deepStrictEqual(EventoPropuesta.schema.path('estado_anterior').enumValues, ESTADOS_PROPUESTA);
    assert.deepStrictEqual(EventoPropuesta.schema.path('estado_nuevo').enumValues, ESTADOS_PROPUESTA);
    assert.deepStrictEqual(EventoPropuesta.schema.path('tipo_evento').enumValues, TIPOS_EVENTO);
    assert.deepStrictEqual(IntentoAplicacion.schema.path('resultado').enumValues, RESULTADOS_INTENTO);
    assert.deepStrictEqual(IntentoAplicacion.schema.path('etapa_fallo').enumValues, ETAPAS_INTENTO);
    assert.deepStrictEqual(IntentoAplicacion.schema.path('resultado_no_registrado').enumValues, RESULTADOS_CON_TRANSICION);

    console.log('12) contrato compartido: matriz, etapas por resultado y enums sincronizados: OK');
  }

  // ============================================================
  // 13) InicioIntentoAplicacion: roles separados y campos de contexto
  //     obligatorios, intento_id sin default, append-only
  // ============================================================
  {
    const inicio = (extra) =>
      new InicioIntentoAplicacion({
        intento_id: crypto.randomUUID(),
        propuesta_id: crypto.randomUUID(),
        hash_contenido_referenciado: crypto.createHash('sha256').update('x').digest('hex'),
        version_coordinacion_esperada: 1,
        operador: { tipo: 'humano', identificador: 'operador-atlas' },
        proceso_aplicador: { nombre: 'aplicar-propuesta', version: '1' },
        adaptador: { nombre: 'govuk-uk-eta', version: '1' },
        iniciado_en: new Date(),
        proceso: { host: 'h', pid: 1 },
        ...extra
      });
    const ok = inicio({});
    await ok.validate();

    await assertValidationError(inicio({ intento_id: undefined }), 'intento_id', 'inicio-sin-intento_id');
    await assertValidationError(inicio({ operador: undefined }), 'operador', 'inicio-sin-operador');
    await assertValidationError(inicio({ operador: { tipo: 'sistema', identificador: 'cron' } }), 'operador.tipo', 'inicio-operador-sistema');
    await assertValidationError(inicio({ proceso_aplicador: undefined }), 'proceso_aplicador', 'inicio-sin-proceso_aplicador');
    await assertValidationError(inicio({ adaptador: undefined }), 'adaptador', 'inicio-sin-adaptador');
    await assertValidationError(inicio({ hash_contenido_referenciado: 'abc' }), 'hash_contenido_referenciado', 'inicio-hash-invalido');
    ok.isNew = false;
    await assertValidationError(ok, 'append-only', 'inicio-append-only');

    console.log('13) InicioIntentoAplicacion: OK');
  }

  // ============================================================
  // 14) Índices de corrección (indices-propuestas.js) declarados en los
  //     schemas con la misma forma: nombre, clave en orden, unique y
  //     partialFilterExpression.
  // ============================================================
  {
    const modelos = [PropuestaCambio, EventoPropuesta, IntentoAplicacion, HistorialCambio, InicioIntentoAplicacion, EjecucionLectura];
    const porColeccion = Object.fromEntries(modelos.map((M) => [M.collection.collectionName, M]));
    const declarados = (M) =>
      M.schema.indexes().map(([key, opciones]) => ({
        name: opciones.name ?? Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_'),
        key,
        unique: opciones.unique === true,
        partialFilterExpression: opciones.partialFilterExpression ?? null
      }));

    const specs = new Map();
    for (const conjunto of Object.values(CONJUNTOS_INDICES)) {
      for (const spec of conjunto) specs.set(`${spec.coleccion}.${spec.nombre}`, spec);
    }
    for (const spec of specs.values()) {
      const M = porColeccion[spec.coleccion];
      assert.ok(M, `no hay modelo para la colección ${spec.coleccion}`);
      const decl = declarados(M).find((i) => i.name === spec.nombre);
      assert.ok(decl, `${spec.coleccion}.${spec.nombre} debe estar declarado en el schema`);
      assert.strictEqual(JSON.stringify(decl.key), JSON.stringify(spec.clave), `${spec.nombre}: clave`);
      assert.strictEqual(decl.unique, true, `${spec.nombre}: unique`);
      assert.deepStrictEqual(decl.partialFilterExpression, spec.partialFilterExpression, `${spec.nombre}: partialFilterExpression`);
    }
    assert.strictEqual(specs.size, 11, 'cantidad de índices de corrección distintos');

    // Ningún índice de rendimiento quedó como sparse sobre un campo con default null.
    for (const [key, opciones] of PropuestaCambio.schema.indexes()) {
      if ('decision_aprobacion_id' in key || 'ultimo_evento_id' in key) {
        assert.ok(!opciones.sparse, 'decision_aprobacion_id/ultimo_evento_id no deben ser sparse');
        assert.ok(opciones.partialFilterExpression, 'decision_aprobacion_id/ultimo_evento_id deben ser parciales por $type');
      }
    }
    // Sin índice único por (propuesta_id, tipo_evento) en eventos.
    for (const [key, opciones] of EventoPropuesta.schema.indexes()) {
      assert.ok(!(opciones.unique && 'tipo_evento' in key), 'no debe existir un índice único que incluya tipo_evento');
    }

    console.log('14) índices de corrección declarados en los schemas con forma exacta: OK');
  }

  console.log('\nTodas las pruebas offline pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
