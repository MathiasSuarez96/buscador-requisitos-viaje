// H2.1 — esquemas de auditoría versionados: documentos válidos e inválidos 1.0 y 2.0.
// Validación real con validate() (incluye hooks). Sin conexión a Mongo.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('bson');
const IntentoAplicacion = require('../models/propuestas/IntentoAplicacion.model');
const HistorialCambio = require('../models/propuestas/HistorialCambio.model');
const A1 = require('../services/propuestas/aplicar-propuesta');
const { crearPersistenciaV2 } = require('../services/propuestas/persistencia-aplicacion-v2');

const P = crearPersistenciaV2();
const uuid = () => crypto.randomUUID();
const T = new Date('2026-10-27T02:30:00.000Z');
const H = 'a'.repeat(64);
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const ausente = { presente: false, bson_tipo: 'ausente', valor: null };
const nulo = { presente: true, bson_tipo: 'null', valor: null };
const PROPUESTA = uuid(), DECISION = uuid(), HISTORIAL = uuid();
const REVS = [{ url: 'https://www.migracioncolombia.gov.co/checkmig', fuente_nombre: 'Migración Colombia', hechos_hash: 'b'.repeat(64), revalidada_en: T }];
const auditoria = { origen: 'panel', request_id: uuid(), operador: 'aplicador', identidad: { metodo: 'oidc_google', sub: 'sub-apl' }, comando: { nombre: 'panel-propuestas', version: '1' },
  instantanea: { propuesta_id: PROPUESTA, estado_esperado: 'aprobada', payload_hash_esperado: H, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: DECISION } };
const base = () => ({ intento_id: uuid(), version_contrato: '2.0', propuesta_id: PROPUESTA, operador: { tipo: 'humano', identificador: 'aplicador' },
  identidad_operador: { metodo: 'oidc_google', sub: 'sub-apl' }, auditoria: structuredClone(auditoria),
  aprobacion: { evento_id: DECISION, actor: { tipo: 'humano', identificador: 'aprobador' }, identidad_operador: { metodo: 'oidc_google', sub: 'sub-apr' }, ocurrido_en: T },
  proceso_aplicador: { nombre: 'aplicar-propuesta-v2', version: '1' }, adaptador: { nombre: 'migracion-colombia', version: '1' },
  hash_contenido_referenciado: H, version_coordinacion_esperada: 1, decision_aprobacion_id: DECISION, iniciado_en: T, finalizado_en: T });
const INTENTOS = {
  exito: () => ({ ...base(), resultado: 'exito', revalidaciones: structuredClone(REVS), historial_id: HISTORIAL, fecha_verificacion: '2026-10-26' }),
  valor_actual_cambio: () => ({ ...base(), resultado: 'valor_actual_cambio', etapa_fallo: 'escritura_aplicacion', revalidaciones: structuredClone(REVS),
    conflicto: { categoria: 'claves_desconocidas', detalle: { claves: ['notas'] } }, error_mensaje: 'conflicto' }),
  identidad_requisito_cambio: () => ({ ...base(), resultado: 'identidad_requisito_cambio', etapa_fallo: 'escritura_aplicacion', revalidaciones: structuredClone(REVS),
    conflicto: { categoria: 'requisito_id_duplicado', detalle: { cantidad: 2 } }, error_mensaje: 'conflicto' }),
  no_aplicable_etapa0: () => ({ ...base(), resultado: 'propuesta_no_aplicable', etapa_fallo: 'precondiciones_propuesta', aprobacion: null,
    precondiciones: [{ codigo: 'aprobacion_invalida', detalle: { diferencias: ['x'] } }], error_mensaje: 'no aplicable' }),
  no_aplicable_tx: () => ({ ...base(), resultado: 'propuesta_no_aplicable', etapa_fallo: 'escritura_aplicacion', revalidaciones: structuredClone(REVS), error_mensaje: 'cas perdido' }),
  abortada: () => ({ ...base(), resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', revalidaciones: structuredClone(REVS), error_externo: 'red', error_mensaje: 'abortada' }),
  abortada_conflicto: () => ({ ...base(), resultado: 'escritura_abortada', etapa_fallo: 'transicion_por_fallo', resultado_no_registrado: 'valor_actual_cambio',
    revalidaciones: structuredClone(REVS), conflicto: { categoria: 'instantanea_no_coincide', detalle: { campos: ['descripcion'] } }, error_externo: 'servidor', error_mensaje: 'abortada' })
};
const historial2 = () => ({ historial_id: HISTORIAL, version_contrato: '2.0', destino_id: String(new ObjectId()), requisito_id: String(new ObjectId()), campo: 'requisito',
  cambios: [{ campo: 'link', anterior: valor('https://www.migracioncolombia.gov.co/checkmig'), nuevo: structuredClone(ausente) }, { campo: 'obligatorio', anterior: valor('si'), nuevo: valor('no') }],
  fecha_verificacion: { anterior: valor('2026-08-18'), nueva: valor('2026-10-26') }, aplicado_en: T, propuesta_id: PROPUESTA, decision_aprobacion_id: DECISION, intento_aplicacion_id: uuid() });

// Documentos 1.0 hechos con los constructores del 1.0.
const ctx1 = { intento_id: uuid(), evento_id: uuid(), historial_id: uuid(), revalidacion_id: uuid(), propuesta_id: uuid(), operador: { tipo: 'humano', identificador: 'op' },
  identidad_operador: { metodo: 'connection_status', usuario_atlas: 'u', db_autenticacion: 'admin' },
  auditoria: { origen: 'comando_administrativo', operador: 'op', identidad: { metodo: 'connection_status', usuario_atlas: 'u', db_autenticacion: 'admin' }, comando: { nombre: 'aplicar-propuesta', version: '1' } },
  adaptador: { nombre: 'govuk-uk-eta', version: '1' }, hash_leido: H, hash_esperado: H, version_esperada: 1, decision_aprobacion_id_esperado: uuid(), iniciado_en: T,
  ids: { destino_hex: String(new ObjectId()), requisito_hex: String(new ObjectId()) }, campo: 'costo', valor_anterior: { presente: true, valor: '£16' }, valor_nuevo: '£20' };
const revalidacion1 = { revalidacion_id: ctx1.revalidacion_id, revalidada_en: T, fuente_nombre: 'GOV.UK', url: 'https://www.gov.uk/eta', valor_revalidado: { valor: '£20', valor_normalizado: { monto: 20 } }, coincide_con_propuesta: true };
const intento1 = () => A1.construirIntento(ctx1, { resultado: 'exito', finalizado_en: T, evidencia_fresca: { fuente: 'x' }, revalidacion: structuredClone(revalidacion1), precondicion: { presente: true, valor: '£16' }, historial_id: ctx1.historial_id });
const historial1 = () => A1.construirHistorial(ctx1, T);

const pasa = async (n, f) => { try { await f(); } catch (e) { assert.fail(`${n} debía validar: ${e.message}`); } };
// Solo cuenta un rechazo por regla: un TypeError/ReferenceError/RangeError es un fallo accidental del validador.
const falla = async (n, f) => assert.rejects(async () => f(), e => {
  assert.ok(!(e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError), `${n}: rechazo accidental ${e?.name}: ${e?.message}`);
  return true;
}, `${n} debía rechazarse`);
const conModelo = (M, d) => new M(d).validate();

(async () => {
  // ---- 2.0 válidos: pasan por el modelo y por la persistencia (sin descartes ni conversiones) ----
  for (const [n, f] of Object.entries(INTENTOS)) {
    await pasa(`intento 2.0 ${n}`, () => P.validarIntento(f()));
    await pasa(`intento 2.0 ${n} (modelo)`, () => conModelo(IntentoAplicacion, f()));
  }
  await pasa('historial 2.0', () => P.validarHistorial(historial2()));
  // Sin [] implícito: el rechazo temprano no gana revalidaciones, y el 1.0 no gana campos 2.0.
  assert.equal(Object.hasOwn(new IntentoAplicacion(INTENTOS.no_aplicable_etapa0()).toObject(), 'revalidaciones'), false, 'etapa 0 sin revalidaciones');
  const o1 = new IntentoAplicacion(intento1()).toObject(), h1 = new HistorialCambio(historial1()).toObject();
  for (const c of ['version_contrato', 'revalidaciones', 'precondiciones', 'aprobacion', 'conflicto', 'fecha_verificacion', 'error_externo']) assert.equal(Object.hasOwn(o1, c), false, `1.0 sin ${c}`);
  for (const c of ['version_contrato', 'cambios', 'fecha_verificacion']) assert.equal(Object.hasOwn(h1, c), false, `historial 1.0 sin ${c}`);
  // fecha string conservada tal cual (Mixed, sin convertir).
  assert.equal(new IntentoAplicacion(INTENTOS.exito()).fecha_verificacion, '2026-10-26');

  // ---- 1.0: válidos e históricos siguen pasando; reglas del 1.0 intactas ----
  await pasa('intento 1.0 éxito', () => conModelo(IntentoAplicacion, intento1()));
  await pasa('historial 1.0', () => conModelo(HistorialCambio, historial1()));
  { const { auditoria: _, ...historico } = A1.construirIntento(ctx1, { resultado: 'propuesta_no_aplicable', etapa_fallo: 'precondiciones_propuesta', finalizado_en: T, evidencia_fresca: {}, error_mensaje: 'x' });
    await pasa('intento 1.0 histórico sin auditoria', () => conModelo(IntentoAplicacion, historico)); }
  await falla('1.0 éxito sin revalidacion', () => { const d = intento1(); delete d.revalidacion; return conModelo(IntentoAplicacion, d); });
  await falla('1.0 éxito sin evidencia_fresca', () => { const d = intento1(); delete d.evidencia_fresca; return conModelo(IntentoAplicacion, d); });
  await falla('1.0 éxito sin precondicion', () => { const d = intento1(); delete d.precondicion; return conModelo(IntentoAplicacion, d); });
  await falla('historial 1.0 sin revalidacion_id', () => { const d = historial1(); delete d.revalidacion_id; return conModelo(HistorialCambio, d); });
  for (const [c, v] of [['revalidaciones', structuredClone(REVS)], ['conflicto', { categoria: 'claves_desconocidas' }], ['fecha_verificacion', '2026-10-26'], ['error_externo', 'red'], ['aprobacion', null]]) {
    await falla(`mezcla: 1.0 con ${c}`, () => conModelo(IntentoAplicacion, { ...intento1(), [c]: v }));
  }
  await falla('mezcla: historial 1.0 con cambios', () => conModelo(HistorialCambio, { ...historial1(), cambios: historial2().cambios }));
  for (const v of ['1.0', '3.0', '']) {
    await falla(`versión desconocida "${v}" en intento`, () => conModelo(IntentoAplicacion, { ...intento1(), version_contrato: v }));
    await falla(`versión desconocida "${v}" en historial`, () => conModelo(HistorialCambio, { ...historial1(), version_contrato: v }));
  }

  // ---- 2.0 inválidos: intento ----
  const inv = async (n, origen, cambiar) => falla(`intento 2.0: ${n}`, () => { const d = INTENTOS[origen](); cambiar(d); return P.validarIntento(d); });
  await inv('con evidencia_fresca (1.0)', 'exito', d => { d.evidencia_fresca = {}; });
  await inv('con revalidacion singular (1.0)', 'exito', d => { d.revalidacion = structuredClone(revalidacion1); });
  await inv('con precondicion (1.0)', 'exito', d => { d.precondicion = { presente: true, valor: 'x' }; });
  await inv('con valor_observado (1.0)', 'valor_actual_cambio', d => { d.valor_observado = { presente: true, valor: 'x' }; });
  await inv('con identidad_esperada_no_coincide (1.0)', 'identidad_requisito_cambio', d => { d.identidad_esperada_no_coincide = { categoria: 'requisito_id_duplicado' }; });
  await inv('resultado no admitido en 2.0', 'abortada', d => { d.resultado = 'fuente_cambio'; d.etapa_fallo = 'revalidacion_externa'; delete d.error_externo; });
  await inv('éxito sin revalidaciones', 'exito', d => { delete d.revalidaciones; });
  await inv('éxito con revalidaciones vacías', 'exito', d => { d.revalidaciones = []; });
  await inv('etapa 0 con revalidaciones', 'no_aplicable_etapa0', d => { d.revalidaciones = structuredClone(REVS); });
  await inv('etapa 0 con revalidaciones []', 'no_aplicable_etapa0', d => { d.revalidaciones = []; });
  await inv('etapa 0 sin precondiciones', 'no_aplicable_etapa0', d => { delete d.precondiciones; });
  await inv('precondiciones en éxito', 'exito', d => { d.precondiciones = [{ codigo: 'x', detalle: {} }]; });
  await inv('URL con credenciales', 'exito', d => { d.revalidaciones[0].url = 'https://u:clave@www.migracioncolombia.gov.co/checkmig'; });
  await inv('URL http', 'exito', d => { d.revalidaciones[0].url = 'http://www.migracioncolombia.gov.co/checkmig'; });
  await inv('URL repetida', 'exito', d => { d.revalidaciones.push(structuredClone(d.revalidaciones[0])); });
  await inv('hechos_hash inválido', 'exito', d => { d.revalidaciones[0].hechos_hash = 'xyz'; });
  await inv('fecha como Date', 'exito', d => { d.fecha_verificacion = new Date('2026-10-26T00:00:00Z'); });
  await inv('fecha inexistente', 'exito', d => { d.fecha_verificacion = '2026-02-30'; });
  // El modelo por sí solo (sin la comparación de la persistencia) no convierte la fecha a string.
  for (const [n, f] of [['objeto con toString', { toString: () => '2026-10-26' }], ['String objeto', new String('2026-10-26')], ['Date', new Date('2026-10-26T00:00:00Z')]]) {
    await falla(`intento 2.0: fecha ${n} (modelo)`, () => conModelo(IntentoAplicacion, { ...INTENTOS.exito(), fecha_verificacion: f }));
  }
  await inv('éxito sin fecha', 'exito', d => { delete d.fecha_verificacion; });
  await inv('fecha en conflicto', 'valor_actual_cambio', d => { d.fecha_verificacion = '2026-10-26'; });
  await inv('conflicto ausente', 'valor_actual_cambio', d => { delete d.conflicto; });
  await inv('categoría incoherente', 'valor_actual_cambio', d => { d.conflicto.categoria = 'requisito_id_duplicado'; });
  await inv('conflicto en éxito', 'exito', d => { d.conflicto = { categoria: 'claves_desconocidas' }; });
  await inv('abortada sin error_externo', 'abortada', d => { delete d.error_externo; });
  await inv('error_externo desconocido', 'abortada', d => { d.error_externo = 'mongodb://u:p@h'; });
  await inv('error_externo en éxito', 'exito', d => { d.error_externo = 'red'; });
  await inv('abortada de conflicto sin resultado_no_registrado', 'abortada_conflicto', d => { delete d.resultado_no_registrado; });
  await inv('abortada de conflicto sin conflicto', 'abortada_conflicto', d => { delete d.conflicto; });
  await inv('sin adaptador', 'exito', d => { delete d.adaptador; });
  await inv('adaptador con texto libre', 'exito', d => { d.adaptador.nombre = 'Adaptador con espacios'; });
  await inv('sin auditoría', 'exito', d => { delete d.auditoria; });
  await inv('operador distinto de la auditoría', 'exito', d => { d.operador.identificador = 'otro'; });
  await inv('identidad_operador distinta de la auditoría', 'exito', d => { d.identidad_operador.sub = 'otro'; });
  await inv('sin aprobación', 'exito', d => { d.aprobacion = null; });
  await inv('aprobación de otra decisión', 'exito', d => { d.aprobacion.evento_id = uuid(); });
  await inv('aprobación de sistema', 'exito', d => { d.aprobacion.actor.tipo = 'sistema'; });
  await inv('proceso aplicador 1.0', 'exito', d => { d.proceso_aplicador = { nombre: 'aplicar-propuesta', version: '1' }; });
  await inv('intento_id no UUID', 'exito', d => { d.intento_id = 'x'; });
  await inv('clave desconocida (StrictModeError)', 'exito', d => { d.intruso = 1; });
  await inv('clave anidada desconocida', 'exito', d => { d.revalidaciones[0].intruso = 1; });
  await inv('Date en path String (conversión)', 'abortada', d => { d.error_mensaje = new Date(); });
  // StrictModeError explícito en ambos niveles.
  await assert.rejects(async () => P.validarIntento({ ...INTENTOS.exito(), intruso: 1 }), e => e?.name === 'StrictModeError');
  await assert.rejects(async () => P.validarHistorial({ ...historial2(), cambios: [{ ...historial2().cambios[0], intruso: 1 }] }), e => e?.name === 'StrictModeError');
  // Conversiones silenciosas del esquema: las detecta la comparación tipada entrada/documento.
  for (const [n, origen, cambiar] of [
    ['ObjectId en path String', 'abortada', d => { d.error_mensaje = new ObjectId(); }],
    ['string ISO en path Date', 'abortada', d => { d.finalizado_en = T.toISOString(); }],
    ['string ISO en Date anidado', 'exito', d => { d.revalidaciones[0].revalidada_en = T.toISOString(); }],
    ['string en path Number', 'exito', d => { d.version_coordinacion_esperada = '1'; }],
    ['número en path String anidado', 'exito', d => { d.revalidaciones[0].fuente_nombre = 7; }],
    ['función descartada', 'abortada', d => { d.error_mensaje = { toString: () => 'abortada' }; }],
    ['BigInt en path Number', 'exito', d => { d.version_coordinacion_esperada = 1n; }]
  ]) {
    const d = INTENTOS[origen](); cambiar(d);
    await assert.rejects(async () => P.validarIntento(d), e => e?.name === 'StrictModeError', `conversión: ${n}`);
  }
  await assert.rejects(async () => P.validarHistorial({ ...historial2(), aplicado_en: T.toISOString() }), e => e?.name === 'StrictModeError', 'conversión: historial aplicado_en ISO');
  // Tipos legítimos: hex → ObjectId (como en el 1.0), ObjectId tal cual, Date y BSON dentro de Mixed, clave con punto en Mixed.
  await pasa('historial 2.0 con ObjectId reales', () => P.validarHistorial({ ...historial2(), destino_id: new ObjectId(), requisito_id: new ObjectId() }));
  await pasa('intento 2.0 con Date y ObjectId en Mixed', () => P.validarIntento({ ...INTENTOS.valor_actual_cambio(),
    conflicto: { categoria: 'claves_desconocidas', detalle: { visto_en: T, destino: new ObjectId(), 'a.b': 1, vacio: {}, lista: [] } } }));

  // ---- 2.0 inválidos: historial ----
  const invH = async (n, cambiar) => falla(`historial 2.0: ${n}`, () => { const d = historial2(); cambiar(d); return P.validarHistorial(d); });
  await invH('campo distinto de requisito', d => { d.campo = 'costo'; });
  await invH('cambios vacío', d => { d.cambios = []; });
  await invH('sin cambios', d => { delete d.cambios; });
  await invH('cambios desordenados', d => { d.cambios.reverse(); });
  await invH('campo repetido', d => { d.cambios[1].campo = 'link'; });
  await invH('campo no modificable', d => { d.cambios[0].campo = 'costo'; });
  await invH('cambio sin efecto', d => { d.cambios[1].nuevo = valor('si'); });
  await invH('valor capturado sin valor', d => { delete d.cambios[1].nuevo.valor; });
  await invH('bson_tipo incoherente', d => { d.cambios[1].nuevo = { presente: true, bson_tipo: 'null', valor: 'no' }; });
  await invH('presente como string', d => { d.cambios[1].nuevo.presente = 'true'; });
  await invH('ausente con valor', d => { d.cambios[0].nuevo = { presente: false, bson_tipo: 'ausente', valor: 'x' }; });
  await invH('fecha nueva como Date', d => { d.fecha_verificacion.nueva.valor = new Date('2026-10-26T00:00:00Z'); });
  await invH('fecha nueva inválida', d => { d.fecha_verificacion.nueva = valor('2026-13-01'); });
  await invH('fecha nueva ausente', d => { d.fecha_verificacion.nueva = structuredClone(ausente); });
  await invH('fecha anterior string inválida', d => { d.fecha_verificacion.anterior = valor('ayer'); });
  await invH('sin fecha_verificacion', d => { delete d.fecha_verificacion; });
  await invH('con valor_anterior (1.0)', d => { d.valor_anterior = { presente: true, valor: 'x' }; });
  await invH('con revalidacion_id (1.0)', d => { d.revalidacion_id = uuid(); });
  await invH('intento_aplicacion_id no UUID', d => { d.intento_aplicacion_id = 'x'; });
  // null frente a ausente: ambos valores capturados válidos y distintos.
  await pasa('fecha anterior null', () => P.validarHistorial({ ...historial2(), fecha_verificacion: { anterior: structuredClone(nulo), nueva: valor('2026-10-26') } }));
  await pasa('fecha anterior ausente', () => P.validarHistorial({ ...historial2(), fecha_verificacion: { anterior: structuredClone(ausente), nueva: valor('2026-10-26') } }));

  console.log('Modelos de auditoría 2.0: 1.0 e históricos intactos, versión explícita, reglas por resultado y etapa, mezclas, strict, fechas y valores capturados: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
