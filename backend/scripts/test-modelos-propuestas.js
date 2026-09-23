// Pruebas offline (sin conexión a Mongo, sin red) para los 5 schemas de
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

// Módulo COMPARTIDO (ya no duplicado): mismo código que usa
// PropuestaCambio.model.js para validar payload_hash, y que deberá usar
// el futuro servicio de creación de propuestas para calcularlo.
const { canonicalizarValor, hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');

function construirPayloadPropuesta({ destinoId, requisitoId, campo, runId, propuestaId, valorAnterior, valorPropuesto, fuente }) {
  return {
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
  // 8) EventoPropuesta: transición obligatoria + hash referenciado +
  //    actor humano para aprobación + append-only
  // ============================================================
  {
    const hashDummy = crypto.createHash('sha256').update('x').digest('hex');

    const okAprobacion = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'aprobacion',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'aprobada',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'humano', identificador: 'matisuar1899@gmail.com' }
    });
    await okAprobacion.validate();

    const aprobacionPorSistema = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'aprobacion',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'aprobada',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'sistema', identificador: 'cron-nocturno' }
    });
    await assertValidationError(aprobacionPorSistema, 'actor.tipo', 'aprobacion-requiere-humano');

    const rechazoSinMotivo = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'rechazo',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'rechazada',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'humano', identificador: 'x' }
    });
    await assertValidationError(rechazoSinMotivo, 'motivo', 'rechazo-requiere-motivo');

    const sinTransicion = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'entrada_revision',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'sistema', identificador: 'job' }
    });
    await assertValidationError(sinTransicion, 'estado_anterior', 'evento-sin-estado_anterior');

    const transicionNula = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'entrada_revision',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'pendiente_aprobacion',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'sistema', identificador: 'job' }
    });
    await assertValidationError(transicionNula, 'no representa una transición real', 'evento-sin-transicion-real');

    const existente = new EventoPropuesta({
      propuesta_id: crypto.randomUUID(),
      tipo_evento: 'entrada_revision',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'revision_requerida',
      hash_contenido_referenciado: hashDummy,
      ocurrido_en: new Date(),
      actor: { tipo: 'sistema', identificador: 'job' }
    });
    existente.isNew = false;
    await assertValidationError(existente, 'append-only', 'evento-append-only');

    console.log('8) EventoPropuesta: OK');
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
  // 10) IntentoAplicacion: campos condicionales por categoría de resultado
  // ============================================================
  {
    // exito: revalidacion (coincide:true) + precondicion + historial_id.
    const exitoso = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'exito',
      evidencia_fresca: { html: '<span>£20</span>' },
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true },
      precondicion: { presente: false, valor: null },
      historial_id: crypto.randomUUID()
    });
    await exitoso.validate();
    assert.ok(exitoso.revalidacion.revalidacion_id, 'revalidacion debe autogenerar su propio revalidacion_id');

    const exitosoSinHistorial = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'exito',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true },
      precondicion: { presente: false, valor: null }
    });
    await assertValidationError(exitosoSinHistorial, 'historial_id', 'intento-exito-requiere-historial');

    // fuente_temporalmente_no_disponible: SIN revalidacion, SIN
    // precondicion; evidencia_fresca parcial + error_mensaje.
    const fuenteNoDisponible = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'fuente_temporalmente_no_disponible',
      error_mensaje: 'timeout tras 3 reintentos',
      evidencia_fresca: { intentos: 3, ultimoStatus: 'ETIMEDOUT' }
    });
    await fuenteNoDisponible.validate(); // no debe tirar
    assert.strictEqual(fuenteNoDisponible.revalidacion, undefined, 'fuente_temporalmente_no_disponible no debe inventar una revalidacion');
    assert.strictEqual(fuenteNoDisponible.precondicion, undefined, 'fuente_temporalmente_no_disponible no debe exigir precondicion');

    // extraccion_ambigua: mismo patrón (sin revalidacion/precondicion).
    const ambigua = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'extraccion_ambigua',
      error_mensaje: 'la página devolvió dos montos distintos',
      evidencia_fresca: { html: '<span>£20</span><span>£25</span>' }
    });
    await ambigua.validate(); // no debe tirar

    // fuente_cambio: revalidacion requerida con coincide_con_propuesta:false.
    const fuenteCambio = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'fuente_cambio',
      error_mensaje: 'la fuente ya no coincide con la propuesta',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 25, coincide_con_propuesta: false }
    });
    await fuenteCambio.validate(); // no debe tirar
    assert.strictEqual(fuenteCambio.precondicion, undefined, 'fuente_cambio no debe exigir precondicion (se aborta antes de leer Mongo)');

    // fuente_cambio con coincide_con_propuesta:true -> inconsistente, rechazado.
    const fuenteCambioInconsistente = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'fuente_cambio',
      error_mensaje: 'x',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true }
    });
    await assertValidationError(fuenteCambioInconsistente, 'coincide_con_propuesta === false', 'fuente_cambio-exige-no-coincide');

    // valor_actual_cambio: revalidacion (coincide:true) + precondicion.
    const valorActualCambio = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'valor_actual_cambio',
      error_mensaje: 'el valor en Mongo cambió entre la lectura y el intento',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true },
      precondicion: { presente: true, valor: '£19' }
    });
    await valorActualCambio.validate(); // no debe tirar

    const valorActualCambioSinPrecondicion = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'valor_actual_cambio',
      error_mensaje: 'x',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true }
    });
    await assertValidationError(valorActualCambioSinPrecondicion, 'precondicion', 'valor_actual_cambio-requiere-precondicion');

    // identidad_requisito_cambio: revalidacion (coincide:true) + identidad_esperada_no_coincide.
    const identidadCambio = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'identidad_requisito_cambio',
      error_mensaje: 'el requisito_id ya no identifica el mismo requisito',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true },
      identidad_esperada_no_coincide: { categoria: 'requisito_id_no_encontrado' }
    });
    await identidadCambio.validate(); // no debe tirar
    assert.strictEqual(identidadCambio.precondicion, undefined, 'identidad_requisito_cambio no exige precondicion (falla por identidad, no por valor)');

    const identidadCambioSinIdentidad = new IntentoAplicacion({
      propuesta_id: crypto.randomUUID(),
      iniciado_en: new Date(),
      finalizado_en: new Date(),
      resultado: 'identidad_requisito_cambio',
      error_mensaje: 'x',
      evidencia_fresca: {},
      revalidacion: { fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', valor_revalidado: 20, coincide_con_propuesta: true }
    });
    await assertValidationError(identidadCambioSinIdentidad, 'identidad_esperada_no_coincide', 'identidad_requisito_cambio-requiere-identidad');

    console.log('10) IntentoAplicacion (bloques condicionales por resultado): OK');
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

  console.log('\nTodas las pruebas offline pasaron (sin conexión a Mongo).');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
