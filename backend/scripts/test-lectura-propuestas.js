// Pruebas offline del lector de propuestas del panel
// (services/panel/lectura-propuestas.js): validación de la consulta,
// cursor, consultas exactas enviadas al driver, hash, identidad y valor
// actual del requisito (ausente frente a null), acciones permitidas,
// resumen seguro de evidencia y eventos, y el destino saneado del
// listado y del detalle (una sola lectura de destinos por página).
// Usa un `db` falso que solo
// implementa find/findOne: cualquier otro método lanza.
//
// Uso: node scripts/test-lectura-propuestas.js (sin red ni Mongo)

const assert = require('assert');
const mongoose = require('mongoose');

// Higiene: cargar el lector no registra modelos de Mongoose.
const L = require('../services/panel/lectura-propuestas');
assert.deepStrictEqual(mongoose.modelNames(), [], 'lectura-propuestas no registra modelos');

const { ObjectId } = require('bson');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { ESTADOS_PROPUESTA } = require('../services/propuestas/contrato-propuestas');
const { REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');

const DESTINO_HEX = '6a87828da8282a4aa6ddfbda';
const PID = '054d03c8-e9ba-4352-8370-e4f88534f612';
const OP_DECIDE = Object.freeze({ identificador: 'operador.panel', permisos: Object.freeze(['ver', 'decidir']) });
const OP_SOLO_VER = Object.freeze({ identificador: 'solo.ver', permisos: Object.freeze(['ver']) });
const FRAGMENTO = '<p>It costs £20 to apply online or through the UK <abbr';

function payloadDe({ propuestaId = PID, valorAnterior = { presente: false, valor: null }, requisitoHex = REQUISITO_ID_ETA, destinoHex = DESTINO_HEX, avisos } = {}) {
  const evidencia = {
    comparacion_govuk: { coincide_entre_secciones: true, costo_extraido_consistente: 20, moneda: 'GBP' },
    extraccion: {
      apply: { costo_extraido: 20, fragmento_html: FRAGMENTO, moneda: 'GBP' },
      overview: { costo_extraido: 20, fragmento_html: ' travel authorisation">ETA</abbr> costs £20. <a href="/eta/apply">', moneda: 'GBP' }
    },
    fuente_govuk: {
      first_published_at: '2025-05-28T11:00:06+01:00',
      public_updated_at: '2025-05-28T11:00:06+01:00',
      updated_at: '2026-09-18T15:20:42+01:00',
      url: 'https://www.gov.uk/api/content/eta'
    },
    identificacion_requisito: { criterio: 'requisito_id', destino_codigo_iso: 'GB', nombre: 'UK ETA', tipo: 'formulario_digital' }
  };
  if (avisos) evidencia.avisos = avisos;
  return {
    version_contrato: '1.0',
    tipo_propuesta: 'actualizacion_campo_requisito',
    fecha_propuesta: '2026-09-27T16:24:32.532Z',
    destino_id: destinoHex,
    requisito_id: requisitoHex,
    campo: 'costo',
    run_id_origen: 'bfcf5b8e-bda9-4cc7-b3c3-ef28fb897835',
    propuesta_id: propuestaId,
    valor_anterior: valorAnterior,
    valor_propuesto: { valor: '£20', valor_normalizado: { importe: 20, moneda: 'GBP' }, evidencia },
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-27T16:24:31.692Z' }
  };
}

function propuestaDe(opciones = {}, extra = {}) {
  const payload = payloadDe(opciones);
  return {
    _id: new ObjectId(),
    propuesta_id: payload.propuesta_id,
    destino_id: ObjectId.createFromHexString(payload.destino_id),
    requisito_id: ObjectId.createFromHexString(payload.requisito_id),
    campo: 'costo',
    run_id_origen: payload.run_id_origen,
    algoritmo_canonicalizacion: 'toc-v1',
    algoritmo_hash: 'sha256',
    payload,
    payload_hash: hashSobreCanonico(payload, 'toc-v1', 'sha256'),
    estado: 'pendiente_aprobacion',
    version_coordinacion: 0,
    decision_aprobacion_id: null,
    ultimo_evento_id: null,
    createdAt: new Date('2026-09-27T16:24:32.600Z'),
    updatedAt: new Date('2026-09-27T16:24:32.600Z'),
    ...extra
  };
}

function requisitoEta(extra = {}) {
  return {
    _id: ObjectId.createFromHexString(REQUISITO_ID_ETA),
    tipo: 'formulario_digital',
    nombre: 'UK ETA',
    obligatorio: 'si',
    descripcion: 'Autorización electrónica de viaje obligatoria.',
    estado: 'confirmado',
    ...extra
  };
}
const destinoDe = (requisitos) => ({ _id: ObjectId.createFromHexString(DESTINO_HEX), pais: 'Reino Unido', codigo_iso: 'GB', requisitos });

// db falso: solo find/findOne. Registra cada llamada. find sobre destinos
// solo admite { _id: { $in: [ObjectId] } } (como Mongo, un string no
// coincide con un _id ObjectId) y devuelve el documento COMPLETO, sin
// aplicar la proyección. falloDestinos: error que lanza ese find.
function dbFalso({ propuestas = [], destinos = [], eventos = [], falloDestinos = null } = {}) {
  const llamadas = [];
  const datos = { propuestas_cambio: propuestas, destinos, eventos_propuesta: eventos };
  const coleccion = (nombre) =>
    new Proxy(
      {
        find(filtro, opciones) {
          llamadas.push({ coleccion: nombre, op: 'find', filtro, opciones });
          let docs = datos[nombre].slice();
          if (nombre === 'destinos') {
            if (falloDestinos) throw falloDestinos;
            assert.deepStrictEqual(Object.keys(filtro), ['_id'], 'destinos: solo filtro por _id');
            assert.deepStrictEqual(Object.keys(filtro._id), ['$in'], 'destinos: solo $in');
            docs = docs.filter((d) => filtro._id.$in.some((id) => id instanceof ObjectId && d._id instanceof ObjectId && d._id.equals(id)));
          } else if (nombre === 'propuestas_cambio') {
            docs = docs.filter((d) => filtro.estado.$in.includes(d.estado) && (!filtro._id || d._id.toHexString() < filtro._id.$lt.toHexString()));
            docs.sort((a, b) => (a._id.toHexString() < b._id.toHexString() ? 1 : -1));
          } else {
            docs = docs.filter((d) => d.propuesta_id === filtro.propuesta_id);
            docs.sort((a, b) => a.version_coordinacion_nueva - b.version_coordinacion_nueva);
          }
          return { toArray: async () => docs.slice(0, opciones.limit) };
        },
        async findOne(filtro, opciones) {
          llamadas.push({ coleccion: nombre, op: 'findOne', filtro, opciones });
          if (nombre === 'destinos') return datos.destinos.find((d) => d._id.equals(filtro._id)) ?? null;
          return datos[nombre].find((d) => d.propuesta_id === filtro.propuesta_id) ?? null;
        }
      },
      {
        get(objetivo, prop) {
          if (prop in objetivo) return objetivo[prop];
          if (prop === 'then') return undefined;
          throw new Error(`db falso: método no permitido ${String(prop)} en ${nombre}`);
        }
      }
    );
  return { db: { collection: coleccion }, llamadas };
}

const esConsultaInvalida = (motivo) => (err) => err instanceof L.ErrorConsultaInvalida && (motivo === undefined || err.message === motivo);
const PROHIBIDOS = ['fragmento_html', '<p>', '<abbr', '<a ', 'usuario_atlas', 'mathias-operador', 'otro@example.com', '"sub"', 'mongodb://', 'mongodb+srv', 'eyJ', '"payload"'];
const sinProhibidos = (obj, etiqueta) => {
  const s = JSON.stringify(obj);
  for (const p of PROHIBIDOS) assert.ok(!s.includes(p), `[${etiqueta}] contiene ${p}`);
};

(async () => {
  // ============================================================
  // 1) Consulta del listado: estado, límite, parámetros
  // ============================================================
  {
    assert.deepStrictEqual(L.validarConsultaListado({}), { estados: ['pendiente_aprobacion'], limite: 20, despuesDe: null });
    assert.deepStrictEqual(L.validarConsultaListado({ estado: 'aplicada,aprobada', limite: '50' }).estados, ['aprobada', 'aplicada'], 'orden canónico');
    assert.deepStrictEqual(L.validarConsultaListado({ estado: ESTADOS_PROPUESTA.join(',') }).estados, ESTADOS_PROPUESTA);
    assert.strictEqual(L.validarConsultaListado({ limite: '1' }).limite, 1);
    const invalidas = [
      [{ estado: '' }, 'estado'],
      [{ estado: 'borrada' }, 'estado_desconocido'],
      [{ estado: 'Aprobada' }, 'estado_desconocido'],
      [{ estado: 'aprobada,' }, 'estado_desconocido'],
      [{ estado: 'aprobada,aprobada' }, 'estado_repetido'],
      [{ estado: ['aprobada', 'rechazada'] }, 'estado'],
      [{ limite: '0' }, 'limite'],
      [{ limite: '51' }, 'limite'],
      [{ limite: '01' }, 'limite'],
      [{ limite: '1.5' }, 'limite'],
      [{ limite: '-1' }, 'limite'],
      [{ limite: 'diez' }, 'limite'],
      [{ limite: ['5', '6'] }, 'limite'],
      [{ limite: '1e1' }, 'limite'],
      [{ orden: 'asc' }, 'parametro_no_admitido'],
      [{ estado: 'aprobada', $where: '1' }, 'parametro_no_admitido'],
      [{ 'estado[$ne]': 'x' }, 'parametro_no_admitido']
    ];
    for (const [q, motivo] of invalidas) assert.throws(() => L.validarConsultaListado(q), esConsultaInvalida(motivo), JSON.stringify(q));
    for (const id of ['x', '054D03C8-E9BA-4352-8370-E4F88534F612', '054d03c8e9ba43528370e4f88534f612', `${PID} `, '00000000-0000-0000-0000-000000000000']) {
      assert.throws(() => L.validarPropuestaId(id), esConsultaInvalida('propuesta_id'), id);
    }
    assert.strictEqual(L.validarPropuestaId(PID), PID);
    console.log(`1) consulta: por defecto pendiente_aprobacion/20; estados canónicos; ${invalidas.length} consultas y 5 propuesta_id inválidos → ErrorConsultaInvalida: OK`);
  }

  // ============================================================
  // 2) Cursor: ida y vuelta, atado al filtro, manipulaciones rechazadas
  // ============================================================
  {
    const hex = '6abadc04b34191f2d3a161f9';
    const c = L.codificarCursor(hex, ['pendiente_aprobacion']);
    const q = L.validarConsultaListado({ cursor: c });
    assert.ok(q.despuesDe instanceof ObjectId && q.despuesDe.toHexString() === hex);
    assert.throws(() => L.validarConsultaListado({ cursor: c, estado: 'aprobada' }), esConsultaInvalida('cursor_de_otro_filtro'));
    assert.strictEqual(c, `v1.${hex}.01`, 'formato compacto: versión, _id, máscara');
    assert.ok(!c.startsWith('eyJ'), 'no se parece a un JWT');
    assert.strictEqual(L.codificarCursor(hex, ['aprobada', 'aplicada']), `v1.${hex}.82`);
    const malos = [
      'no-es-cursor!',
      '',
      'a'.repeat(600),
      `v2.${hex}.01`,
      `v1.zz.01`,
      `v1.${hex.toUpperCase()}.01`,
      `v1.${hex}.1`,
      `v1.${hex}.001`,
      `v1.${hex}.01.extra`,
      ` v1.${hex}.01`,
      `v1.${hex}.01
`,
      Buffer.from(JSON.stringify({ v: 1, despues_de: hex })).toString('base64url'),
      `v1x${hex}.01`, // los separadores son puntos literales
      `v1.${hex}x01`
    ];
    for (const m of malos) assert.throws(() => L.validarConsultaListado({ cursor: m }), esConsultaInvalida(), m.slice(0, 40));
    console.log(`2) cursor: ida y vuelta exacta, de otro filtro → cursor_de_otro_filtro, ${malos.length} cursores manipulados → 400: OK`);
  }

  // ============================================================
  // 3) Consultas exactas enviadas al driver (listado y detalle)
  // ============================================================
  {
    const despuesDe = ObjectId.createFromHexString('6abadc04b34191f2d3a161f9');
    const { filtro, opciones } = L.consultaListado({ estados: ['pendiente_aprobacion', 'aprobada'], limite: 3, despuesDe });
    assert.deepStrictEqual(filtro, { estado: { $in: ['pendiente_aprobacion', 'aprobada'] }, _id: { $lt: despuesDe } });
    assert.deepStrictEqual(opciones.sort, { _id: -1 });
    assert.strictEqual(opciones.limit, 4);
    assert.ok(!('evidencia' in opciones.projection) && Object.values(opciones.projection).every((v) => v === 1), 'proyección de inclusión');
    assert.deepStrictEqual(L.consultaListado({ estados: ['aprobada'], limite: 20, despuesDe: null }).filtro, { estado: { $in: ['aprobada'] } });

    const p = propuestaDe();
    const { db, llamadas } = dbFalso({ propuestas: [p], destinos: [destinoDe([requisitoEta()])] });
    const lector = L.crearLectorPropuestas({ obtenerDb: () => db });
    await lector.detalle(PID, OP_DECIDE);
    assert.deepStrictEqual(
      llamadas.map((l) => [l.coleccion, l.op]),
      [
        ['propuestas_cambio', 'findOne'],
        ['destinos', 'findOne'],
        ['eventos_propuesta', 'find']
      ]
    );
    assert.deepStrictEqual(llamadas[0].filtro, { propuesta_id: PID });
    assert.ok(llamadas[1].filtro._id instanceof ObjectId && llamadas[1].filtro._id.toHexString() === DESTINO_HEX, 'destino por ObjectId de BSON, no string');
    assert.deepStrictEqual(llamadas[1].opciones, { projection: { pais: 1, codigo_iso: 1, requisitos: 1 } });
    assert.deepStrictEqual(llamadas[2].filtro, { propuesta_id: PID });
    assert.deepStrictEqual(llamadas[2].opciones.sort, { version_coordinacion_nueva: 1, _id: 1 });
    assert.strictEqual(llamadas[2].opciones.limit, L.MAXIMO_EVENTOS + 1);
    // Proyección literal: de detalle solo comando.nombre e identidad_operador.metodo
    // (sub, email y usuario_atlas ni siquiera se leen).
    assert.deepStrictEqual(llamadas[2].opciones.projection, {
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

    // Inexistente: una sola lectura, null.
    const vacio = dbFalso();
    assert.strictEqual(await L.crearLectorPropuestas({ obtenerDb: () => vacio.db }).detalle(PID, OP_DECIDE), null);
    assert.deepStrictEqual(vacio.llamadas.map((l) => l.op), ['findOne']);

    // Sin conexión → ErrorLecturaNoDisponible, sin tocar nada.
    for (const sinDb of [() => null, () => undefined, () => ({})]) {
      await assert.rejects(L.crearLectorPropuestas({ obtenerDb: sinDb }).listar({ estados: ['aprobada'], limite: 1, despuesDe: null }), L.ErrorLecturaNoDisponible);
    }
    console.log('3) consultas exactas: listado {estado $in, _id $lt} orden {_id:-1} límite+1; detalle findOne propuesta → findOne destino por ObjectId → find eventos ordenados con proyección sin identidad; sin conexión → no disponible: OK');
  }

  // ============================================================
  // 4) Paginación: páginas disjuntas, orden total, último cursor null
  // ============================================================
  {
    const docs = Array.from({ length: 7 }, (_, i) => propuestaDe({ propuestaId: `00000000-0000-4000-8000-00000000000${i}` }));
    docs.push(propuestaDe({ propuestaId: '00000000-0000-4000-8000-0000000000aa' }, { estado: 'rechazada' }));
    const { db } = dbFalso({ propuestas: docs });
    const lector = L.crearLectorPropuestas({ obtenerDb: () => db });
    const vistos = [];
    let cursor;
    let paginas = 0;
    do {
      const r = await lector.listar(L.validarConsultaListado({ limite: '3', ...(cursor ? { cursor } : {}) }));
      paginas++;
      assert.ok(r.propuestas.length <= 3);
      vistos.push(...r.propuestas.map((x) => x.propuesta_id));
      cursor = r.siguiente_cursor;
    } while (cursor);
    const esperados = docs
      .filter((d) => d.estado === 'pendiente_aprobacion')
      .sort((a, b) => (a._id.toHexString() < b._id.toHexString() ? 1 : -1))
      .map((d) => d.propuesta_id);
    assert.deepStrictEqual(vistos, esperados, 'todas, una sola vez, en orden _id descendente');
    assert.strictEqual(paginas, 3);
    console.log(`4) paginación: 7 pendientes en ${paginas} páginas de 3, sin repetidos ni faltantes, orden _id desc, rechazada excluida: OK`);
  }

  // ============================================================
  // 5) Hash recalculado en el servidor
  // ============================================================
  {
    const p = propuestaDe();
    assert.deepStrictEqual(L.verificarHash(p), { coincide: true, declarado: p.payload_hash, recalculado: p.payload_hash });
    const alterado = propuestaDe();
    alterado.payload.valor_propuesto.valor = '£2';
    const h = L.verificarHash(alterado);
    assert.strictEqual(h.coincide, false);
    assert.notStrictEqual(h.recalculado, alterado.payload_hash);
    assert.deepStrictEqual(L.verificarHash({ ...p, algoritmo_hash: 'md5' }), { coincide: false, declarado: p.payload_hash, recalculado: null });
    assert.strictEqual(L.verificarHash({ ...p, payload_hash: 'ABC' }).coincide, false);
    assert.strictEqual(L.verificarHash({ ...p, payload: { ...p.payload, x: undefined } }).recalculado, null, 'undefined no canonicaliza');
    assert.deepStrictEqual(L.resumenListado(alterado).alertas, ['hash_no_coincide']);
    console.log('5) hash: correcto coincide; payload alterado, algoritmo no soportado, hash malformado o payload no canonicalizable → no coincide; alerta en el listado: OK');
  }

  // ============================================================
  // 6) Requisito actual: inexistente, identidad, valor; ausente ≠ null
  // ============================================================
  {
    const adaptador = require('../services/propuestas/adaptadores').ADAPTADORES[0];
    const p = propuestaDe();
    const casos = [
      ['coincide (ausente = ausente)', p, destinoDe([requisitoEta()]), 'coincide', 'coincide', { presente: false, valor: null }],
      ['destino inexistente', p, null, 'destino_no_encontrado', null, null],
      ['requisito inexistente', p, destinoDe([requisitoEta({ _id: new ObjectId() })]), 'requisito_id_no_encontrado', null, null],
      ['requisito duplicado', p, destinoDe([requisitoEta(), requisitoEta()]), 'requisito_id_duplicado', null, null],
      ['identidad cambiada', p, destinoDe([requisitoEta({ nombre: 'UK ETA (nuevo)' })]), 'identidad_semantica_no_coincide', 'coincide', { presente: false, valor: null }],
      ['valor cambiado', p, destinoDe([requisitoEta({ costo: '£16' })]), 'coincide', 'cambio', { presente: true, valor: '£16' }],
      ['ausente en propuesta, null en destino', p, destinoDe([requisitoEta({ costo: null })]), 'coincide', 'cambio', { presente: true, valor: null }],
      ['null en propuesta, null en destino', propuestaDe({ valorAnterior: { presente: true, valor: null } }), destinoDe([requisitoEta({ costo: null })]), 'coincide', 'coincide', { presente: true, valor: null }],
      ['null en propuesta, ausente en destino', propuestaDe({ valorAnterior: { presente: true, valor: null } }), destinoDe([requisitoEta()]), 'coincide', 'cambio', { presente: false, valor: null }]
    ];
    for (const [nombre, prop, destino, estado, valor, valorActual] of casos) {
      const r = L.evaluarRequisitoActual(prop, destino, adaptador);
      assert.strictEqual(r.estado, estado, `${nombre}: estado`);
      assert.strictEqual(r.valor, valor, `${nombre}: valor`);
      assert.deepStrictEqual(r.valor_actual, valorActual, `${nombre}: valor_actual`);
    }
    const sinAdaptador = L.evaluarRequisitoActual(p, destinoDe([requisitoEta()]), null);
    assert.strictEqual(sinAdaptador.estado, 'identidad_no_verificable');
    const r = L.evaluarRequisitoActual(p, destinoDe([requisitoEta({ descripcion: '<b>x</b>', fuente: 'https://iata', costo: '£16' })]), adaptador);
    assert.deepStrictEqual(Object.keys(r.requisito).sort(), ['nombre', 'requisito_id', 'tipo'], 'solo campos seguros del requisito');
    assert.deepStrictEqual(r.destino, { destino_id: DESTINO_HEX, pais: 'Reino Unido', codigo_iso: 'GB' });

    // Misma regla que el servicio de aplicación (sin divergir).
    const ap = require('../services/propuestas/aplicar-propuesta');
    for (const req of [requisitoEta(), requisitoEta({ costo: null }), requisitoEta({ costo: '£20' }), requisitoEta({ costo: undefined })]) {
      assert.deepStrictEqual(L.observarValor(req, 'costo'), ap.observarValor(req, 'costo'));
    }
    console.log(`6) requisito actual: ${casos.length} casos (inexistente, duplicado, identidad cambiada, valor cambiado, ausente ≠ null en ambos sentidos) + sin adaptador → no verificable; solo campos seguros; misma observación de valor que aplicar-propuesta: OK`);
  }

  // ============================================================
  // 7) acciones_permitidas y acciones_bloqueadas
  // ============================================================
  {
    const H = 'a'.repeat(64);
    const ok = { hash: { coincide: true, declarado: H }, problemas: [], requisitoActual: { estado: 'coincide', valor: 'coincide' }, estado: 'pendiente_aprobacion', operador: OP_DECIDE };
    const acciones = (aprobar, rechazar) => ({
      acciones_permitidas: ['aprobar', 'rechazar'].filter((a) => ({ aprobar, rechazar })[a].length === 0),
      acciones_bloqueadas: { aprobar, rechazar }
    });
    // a) pendiente e íntegra → aprobación y rechazo, nada bloqueado.
    assert.deepStrictEqual(L.calcularAcciones(ok), { acciones_permitidas: ['aprobar', 'rechazar'], acciones_bloqueadas: { aprobar: [], rechazar: [] } });
    assert.deepStrictEqual(L.motivosIntegridad(ok), []);

    // b) pendiente con problemas de integridad → solo rechazo; aprobar
    //    bloqueada con sus motivos específicos.
    const integridad = [
      [{ hash: { coincide: false, declarado: H } }, ['hash_no_coincide']],
      [{ problemas: ['campo_distinto'] }, ['datos_inconsistentes']],
      [{ requisitoActual: { estado: 'requisito_id_no_encontrado', valor: null } }, ['requisito_no_coincide', 'valor_actual_cambio']],
      [{ requisitoActual: { estado: 'identidad_semantica_no_coincide', valor: 'coincide' } }, ['requisito_no_coincide']],
      [{ requisitoActual: { estado: 'identidad_no_verificable', valor: 'coincide' } }, ['requisito_no_coincide']],
      [{ requisitoActual: { estado: 'coincide', valor: 'cambio' } }, ['valor_actual_cambio']],
      [{ hash: { coincide: false, declarado: H }, problemas: ['campo_distinto'], requisitoActual: { estado: 'no_evaluable', valor: null } }, ['hash_no_coincide', 'datos_inconsistentes', 'requisito_no_coincide', 'valor_actual_cambio']]
    ];
    for (const [cambio, motivos] of integridad) {
      assert.deepStrictEqual(L.calcularAcciones({ ...ok, ...cambio }), acciones(motivos, []), motivos.join());
      assert.deepStrictEqual(L.motivosIntegridad({ ...ok, ...cambio }), motivos, `motivosIntegridad: ${motivos.join()}`);
    }

    // c) payload_hash almacenado inválido → ninguna acción; ambas con
    //    payload_hash_invalido (reemplaza a hash_no_coincide).
    const invalido = { hash: { coincide: false, declarado: null } };
    assert.deepStrictEqual(L.calcularAcciones({ ...ok, ...invalido }), acciones(['payload_hash_invalido'], ['payload_hash_invalido']));
    assert.deepStrictEqual(
      L.calcularAcciones({ ...ok, ...invalido, requisitoActual: { estado: 'coincide', valor: 'cambio' } }),
      acciones(['payload_hash_invalido', 'valor_actual_cambio'], ['payload_hash_invalido'])
    );
    // verificarHash marca declarado null para cualquier forma no hex.
    for (const malo of ['XYZ', 'A'.repeat(64), 'a'.repeat(63), null, undefined, 42]) {
      const p = propuestaDe({}, { payload_hash: malo });
      const h = L.verificarHash(p);
      assert.strictEqual(h.declarado, null, `declarado de ${String(malo)}`);
      assert.deepStrictEqual(L.calcularAcciones({ ...ok, hash: h }).acciones_permitidas, [], `sin acciones con hash ${String(malo)}`);
    }

    // d) sin permiso o estado incompatible → ninguna acción; cada lista con
    //    sus motivos (integridad solo en aprobar; hash inválido en ambas).
    const bloqueos = [
      [{ operador: OP_SOLO_VER }, 'sin_permiso_decidir'],
      ...ESTADOS_PROPUESTA.filter((e) => e !== 'pendiente_aprobacion').map((e) => [{ estado: e }, 'estado_no_permite_decision'])
    ];
    let combinaciones = 0;
    for (const [bloqueo, motivo] of bloqueos) {
      for (const [problema, motivosInt] of [[{}, []], ...integridad, [invalido, ['payload_hash_invalido']]]) {
        const r = L.calcularAcciones({ ...ok, ...problema, ...bloqueo });
        const rechazo = problema === invalido ? ['payload_hash_invalido', motivo] : [motivo];
        assert.deepStrictEqual(r, acciones([...motivosInt, motivo], rechazo), `${motivo} + ${motivosInt.join() || 'íntegra'}`);
        combinaciones++;
      }
    }
    assert.deepStrictEqual(
      L.calcularAcciones({ ...ok, estado: 'aprobada', operador: OP_SOLO_VER }),
      acciones(['estado_no_permite_decision', 'sin_permiso_decidir'], ['estado_no_permite_decision', 'sin_permiso_decidir'])
    );
    console.log(`7) acciones: íntegra → [aprobar, rechazar] sin bloqueos; ${integridad.length} variantes de integridad → [rechazar] con aprobar bloqueada por sus motivos; payload_hash inválido (6 formas) → [] con ambas en payload_hash_invalido; ${combinaciones} combinaciones sin permiso / 7 estados → [] con los motivos de cada acción: OK`);
  }

  // ============================================================
  // 7c) Cierre de coordinación: versión inválida y decisión previa
  // ============================================================
  {
    const H = 'a'.repeat(64);
    const D = '4db810fc-d491-4166-82d1-8b88fe9b088d';
    const ok = { hash: { coincide: true, declarado: H }, problemas: [], requisitoActual: { estado: 'coincide', valor: 'coincide' }, estado: 'pendiente_aprobacion', operador: OP_DECIDE, version: 0, decisionAprobacionId: null };
    const acciones = (aprobar, rechazar) => ({
      acciones_permitidas: ['aprobar', 'rechazar'].filter((a) => ({ aprobar, rechazar })[a].length === 0),
      acciones_bloqueadas: { aprobar, rechazar }
    });
    const VI = 'version_coordinacion_invalida';
    const DP = 'decision_previa_existente';
    // Versiones válidas: no bloquean.
    for (const v of [0, 1, 7, Number.MAX_SAFE_INTEGER]) assert.deepStrictEqual(L.calcularAcciones({ ...ok, version: v }).acciones_permitidas, ['aprobar', 'rechazar'], `versión ${v}`);
    // Versiones inválidas: ninguna acción, ambas con version_coordinacion_invalida.
    const invalidas = ['0', 1.5, -1, null, 2 ** 53, NaN, Infinity, true, {}];
    for (const v of invalidas) assert.deepStrictEqual(L.calcularAcciones({ ...ok, version: v }), acciones([VI], [VI]), `versión ${String(v)}`);
    // Decisión previa en una pendiente: ninguna acción, ambas con decision_previa_existente.
    for (const d of [D, '', 'x', 0]) assert.deepStrictEqual(L.calcularAcciones({ ...ok, decisionAprobacionId: d }), acciones([DP], [DP]), `decisión ${JSON.stringify(d)}`);
    // Fuera de pendiente, la decisión previa es legítima: solo bloquea el estado.
    assert.deepStrictEqual(
      L.calcularAcciones({ ...ok, estado: 'aprobada', decisionAprobacionId: D, version: 1 }),
      acciones(['estado_no_permite_decision'], ['estado_no_permite_decision'])
    );
    // Combinados: coordinación primero, integridad solo en aprobar, luego estado/permiso.
    assert.deepStrictEqual(
      L.calcularAcciones({ ...ok, hash: { coincide: false, declarado: null }, version: 1.5, decisionAprobacionId: D, requisitoActual: { estado: 'coincide', valor: 'cambio' }, operador: OP_SOLO_VER }),
      acciones(['payload_hash_invalido', VI, DP, 'valor_actual_cambio', 'sin_permiso_decidir'], ['payload_hash_invalido', VI, DP, 'sin_permiso_decidir'])
    );
    assert.deepStrictEqual(L.motivosCoordinacion({ hash: { declarado: H }, version: 0, decisionAprobacionId: null, estado: 'pendiente_aprobacion' }), []);

    // Detalle con el documento: campo ausente frente a null.
    const destinos = [destinoDe([requisitoEta()])];
    const detalleDe = async (doc) => L.crearLectorPropuestas({ obtenerDb: () => dbFalso({ propuestas: [doc], destinos }).db }).detalle(PID, OP_DECIDE);
    const sinCampo = (doc, k) => Object.fromEntries(Object.entries(doc).filter(([x]) => x !== k));
    const casos = [
      ['versión "0"', propuestaDe({}, { version_coordinacion: '0' }), [VI]],
      ['versión 1.5', propuestaDe({}, { version_coordinacion: 1.5 }), [VI]],
      ['versión null', propuestaDe({}, { version_coordinacion: null }), [VI]],
      ['versión ausente', sinCampo(propuestaDe(), 'version_coordinacion'), [VI]],
      ['decisión previa', propuestaDe({}, { decision_aprobacion_id: D }), [DP]],
      ['decision_aprobacion_id ausente (= null para el CAS)', sinCampo(propuestaDe(), 'decision_aprobacion_id'), []],
      ['íntegra', propuestaDe(), []]
    ];
    for (const [etiqueta, doc, motivos] of casos) {
      const d = await detalleDe(doc);
      assert.deepStrictEqual({ acciones_permitidas: d.acciones_permitidas, acciones_bloqueadas: d.acciones_bloqueadas }, acciones(motivos, motivos), etiqueta);
    }
    console.log(`7c) coordinación: ${invalidas.length} versiones inválidas → [] con ${VI} en ambas; decisión previa en pendiente → [] con ${DP} en ambas (fuera de pendiente no aplica); orden coordinación → integridad → estado/permiso; detalle: versión "0"/1.5/null/ausente bloquean, decision_aprobacion_id ausente = null: OK`);
  }

  // ============================================================
  // 7b) evaluarIntegridad: única lectura de integridad (GET y POST)
  // ============================================================
  {
    const p = propuestaDe();
    const { db, llamadas } = dbFalso({ propuestas: [p], destinos: [destinoDe([requisitoEta({ costo: '£16' })])] });
    const r = await L.evaluarIntegridad(db, p);
    assert.deepStrictEqual(r.motivos, ['valor_actual_cambio']);
    assert.deepStrictEqual(Object.keys(r), ['hash', 'problemas', 'requisitoActual', 'motivos']);
    assert.deepStrictEqual(llamadas.map((l) => [l.coleccion, l.op]), [['destinos', 'findOne']], 'solo lee el destino');
    assert.deepStrictEqual(llamadas[0].opciones, { projection: { pais: 1, codigo_iso: 1, requisitos: 1 } });
    const base = propuestaDe();
    const sinDestino = await L.evaluarIntegridad(dbFalso().db, { ...base, payload: { ...base.payload, destino_id: 'no-hex' } });
    assert.deepStrictEqual(sinDestino.requisitoActual.estado, 'no_evaluable');
    // El detalle expone exactamente esa evaluación.
    const { db: db2 } = dbFalso({ propuestas: [p], destinos: [destinoDe([requisitoEta({ costo: '£16' })])] });
    const d = await L.crearLectorPropuestas({ obtenerDb: () => db2 }).detalle(PID, OP_DECIDE);
    assert.deepStrictEqual(d.acciones_bloqueadas.aprobar, r.motivos);
    assert.deepStrictEqual(d.requisito_actual, r.requisitoActual);
    console.log('7b) evaluarIntegridad: solo lee el destino (proyección exacta), destino_id inválido → no_evaluable; el detalle usa sus mismos motivos y requisito: OK');
  }

  // ============================================================
  // 8) Respuestas sin HTML ni datos privados
  // ============================================================
  {
    const avisos = ['overview con <b>HTML</b> raro', `token=${'x'.repeat(10)} y Bearer abc.def.ghi`, 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.firma', 42];
    const p = propuestaDe({ avisos }, { decision_aprobacion_id: '4db810fc-d491-4166-82d1-8b88fe9b088d', ultimo_evento_id: '4db810fc-d491-4166-82d1-8b88fe9b088d', estado: 'aprobada', version_coordinacion: 1 });
    const evento = (extra) => ({
      _id: new ObjectId(),
      evento_id: '4db810fc-d491-4166-82d1-8b88fe9b088d',
      propuesta_id: PID,
      tipo_evento: 'aprobacion',
      estado_anterior: 'pendiente_aprobacion',
      estado_nuevo: 'aprobada',
      hash_contenido_referenciado: p.payload_hash,
      version_coordinacion_nueva: 1,
      ocurrido_en: new Date('2026-09-28T21:28:36.695Z'),
      actor: { tipo: 'humano', identificador: 'mathias' },
      detalle: {
        identidad_operador: { metodo: 'connection_status', usuario_atlas: 'mathias-operador', db_autenticacion: 'admin', sub: '3000', email: 'otro@example.com' },
        comando: { nombre: 'decidir-propuesta', version: '1' }
      },
      ...extra
    });
    // El db falso devuelve el documento COMPLETO (sin aplicar la proyección):
    // aun así nada privado llega a la respuesta.
    const eventos = [evento({ version_coordinacion_nueva: 2, evento_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actor: { tipo: 'humano', identificador: 'otro@example.com' }, motivo: '<script>x</script> mongodb+srv://u:p@h/x' }), evento()];
    const { db } = dbFalso({ propuestas: [p], destinos: [destinoDe([requisitoEta()])], eventos });
    const d = await L.crearLectorPropuestas({ obtenerDb: () => db }).detalle(PID, OP_DECIDE);
    sinProhibidos(d, 'detalle');
    assert.ok(!JSON.stringify(d).includes('<'), 'ningún "<" en el detalle');
    assert.deepStrictEqual(d.propuesta.evidencia, {
      fuente: 'GOV.UK',
      url: 'https://www.gov.uk/api/content/eta',
      capturado_en: '2026-09-27T16:24:31.692Z',
      fuente_actualizada_en: '2025-05-28T11:00:06+01:00',
      valor_extraido: '£20',
      importe: 20,
      moneda: 'GBP',
      secciones: [
        { seccion: 'apply', costo_extraido: 20, moneda: 'GBP' },
        { seccion: 'overview', costo_extraido: 20, moneda: 'GBP' }
      ],
      coincide_entre_secciones: true,
      avisos: ['overview con HTML raro', 'token=redactado y Bearer redactado', 'jwt-redactado']
    });
    assert.deepStrictEqual(d.eventos[1].actor, { tipo: 'humano', identificador: '(oculto)' }, 'identificador con forma de email de otro operador → oculto');
    assert.deepStrictEqual(Object.keys(d.eventos[0]).sort(), [
      'actor',
      'estado_anterior',
      'estado_nuevo',
      'evento_id',
      'hash_contenido_referenciado',
      'intento_aplicacion_id',
      'metodo_identidad',
      'motivo',
      'ocurrido_en',
      'origen',
      'tipo_evento',
      'version_coordinacion_nueva'
    ]);
    assert.strictEqual(d.eventos[0].origen, 'decidir-propuesta');
    assert.strictEqual(d.eventos[0].metodo_identidad, 'connection_status');
    assert.strictEqual(d.eventos[1].motivo, 'x uri-mongodb-redactada');
    assert.deepStrictEqual(d.acciones_permitidas, []);
    assert.deepStrictEqual(d.acciones_bloqueadas, { aprobar: ['estado_no_permite_decision'], rechazar: ['estado_no_permite_decision'] });
    sinProhibidos(L.resumenListado(p), 'listado');
    console.log('8) detalle y listado: sin fragmento_html, HTML, payload, usuario_atlas, sub ni email de otros; avisos y motivos saneados; evidencia = lista blanca exacta: OK');
  }

  // ============================================================
  // 9) Consistencia documento ↔ payload
  // ============================================================
  {
    const p = propuestaDe();
    assert.deepStrictEqual(L.problemasConsistencia(p), []);
    const casos = [
      [{ propuesta_id: '11111111-1111-4111-8111-111111111111' }, 'propuesta_id_distinto'],
      [{ destino_id: new ObjectId() }, 'destino_id_distinto'],
      [{ requisito_id: new ObjectId() }, 'requisito_id_distinto'],
      [{ campo: 'nombre' }, 'campo_distinto'],
      [{ payload: { ...p.payload, valor_anterior: { presente: false, valor: '£1' } } }, 'valor_anterior_invalido'],
      [{ payload: null }, 'payload_invalido']
    ];
    for (const [cambio, codigo] of casos) assert.ok(L.problemasConsistencia({ ...p, ...cambio }).includes(codigo), codigo);
    console.log(`9) consistencia documento/payload: ${casos.length} divergencias detectadas: OK`);
  }

  // ============================================================
  // 10) destinoSeguro: el mismo saneamiento en listado y detalle
  // ============================================================
  {
    const oid = () => new ObjectId();
    const id = oid();
    const hex = id.toHexString();
    const conPais = (pais, codigo_iso = 'GB') => L.destinoSeguro({ _id: id, pais, codigo_iso });
    assert.deepStrictEqual(conPais('Reino Unido'), { destino_id: hex, pais: 'Reino Unido', codigo_iso: 'GB' });

    // Datos reales: ningún nombre ni código cambia.
    const reales = require('../../data/destinos.json');
    assert.ok(reales.length > 0);
    for (const d of reales) assert.deepStrictEqual(L.destinoSeguro({ ...d, _id: id }), { destino_id: hex, pais: d.pais, codigo_iso: d.codigo_iso }, d.pais);
    for (const pais of ['Países Bajos', 'Corea del Sur', "Côte d'Ivoire", 'São Tomé y Príncipe', 'Bosnia y Herzegovina', 'Guinea-Bisáu']) assert.strictEqual(conPais(pais).pais, pais, pais);

    // pais hostil o mal formado.
    const paises = [
      ['<b>Reino</b> Unido', 'Reino Unido'],
      ['<img src=x onerror=alert(1)>Francia', 'Francia'],
      ['<script>alert(1)</script>', 'alert(1)'],
      ['Reino > Unido <', 'Reino  Unido'],
      ['mongodb+srv://u:p@h/x', 'uri-mongodb-redactada'],
      ['a'.repeat(150), `${'a'.repeat(100)}…`],
      ['<b></b>', null],
      ['   ', null],
      ['', null],
      [42, null],
      [{ x: 1 }, null],
      [['Francia'], null],
      [null, null],
      [undefined, null],
      [true, null]
    ];
    for (const [pais, esperado] of paises) assert.strictEqual(conPais(pais).pais, esperado, `pais ${JSON.stringify(pais)}`);

    // Casos dudosos (reglas de paisSeguro):
    //  - cada tramo de controles o separadores de línea → UN espacio; los
    //    espacios comunes no se tocan; en los extremos desaparecen (trim);
    //  - un sustituto Unicode aislado → el pais entero es null;
    //  - vacío después de limpiar → null;
    //  - el recorte cuenta code points y nunca parte un par sustituto.
    const dudosos = [
      ['Reino\nUnido', 'Reino Unido'],
      ['Reino\tUnido', 'Reino Unido'],
      ['Reino\rUnido', 'Reino Unido'],
      ['Reino\r\n\tUnido', 'Reino Unido'],
      ['Reino \n Unido', 'Reino   Unido'],
      ['Reino Unido ', 'Reino Unido'],
      ['Reino\u0085Unido', 'Reino Unido'],
      ['Fran\u0000cia', 'Fran cia'],
      ['\u0007Francia\n', 'Francia'],
      ['<b>\n</b>', null],
      ['\n\t\r', null],
      ['\u0000', null],
      ['Fran\uD800cia', null],
      ['\uDC00', null],
      ['Reino Unido\uD83C', null],
      ['🇬🇧 Reino Unido', '🇬🇧 Reino Unido'],
      ['😀'.repeat(150), `${'😀'.repeat(100)}…`],
      [`${'a'.repeat(99)}😀😀`, `${'a'.repeat(99)}😀…`],
      ['a'.repeat(100), 'a'.repeat(100)]
    ];
    for (const [pais, esperado] of dudosos) {
      const r = L.paisSeguro(pais);
      assert.strictEqual(r, esperado, `paisSeguro(${JSON.stringify(pais)})`);
      assert.strictEqual(conPais(pais).pais, esperado, `destinoSeguro con ${JSON.stringify(pais)}`);
      if (r !== null) assert.ok(r.isWellFormed() && !/[\p{Cc}\p{Zl}\p{Zp}<>]/u.test(r), `salida limpia para ${JSON.stringify(pais)}`);
    }
    // codigo_iso: solo dos letras mayúsculas; no se corrige.
    for (const iso of ['gb', 'Gb', 'GBR', 'G', 'G B', ' GB', 'GB ', 'G1', '<b>GB</b>', 42, null, undefined, {}, ['GB'], '']) {
      assert.strictEqual(L.destinoSeguro({ _id: id, pais: 'Reino Unido', codigo_iso: iso }).codigo_iso, null, `iso ${JSON.stringify(iso)}`);
    }
    // Sin destino o con _id que no es ObjectId → null; nunca otros campos.
    for (const malo of [null, undefined, 'GB', [], 42, { pais: 'X', codigo_iso: 'GB' }, { _id: 'xyz', pais: 'X' }, { _id: 'A'.repeat(24), pais: 'X' }]) {
      assert.strictEqual(L.destinoSeguro(malo), null, JSON.stringify(malo));
    }
    const completo = L.destinoSeguro({ _id: id, pais: 'X', codigo_iso: 'XX', requisitos: [requisitoEta()], creado: new Date(), __v: 0 });
    assert.deepStrictEqual(Object.keys(completo), ['destino_id', 'pais', 'codigo_iso']);
    console.log(`10) destinoSeguro: ${reales.length} destinos de data/destinos.json y 6 nombres con acentos/apóstrofes sin cambios; ${paises.length} pais hostiles o mal formados; ${dudosos.length} casos dudosos (controles → un espacio, sustituto aislado → null, vacío → null, recorte por code points); 15 codigo_iso inválidos → null; sin destino o _id inválido → null; solo destino_id, pais y codigo_iso: OK`);
  }

  // ============================================================
  // 11) Destino en el listado: una sola lectura por página
  // ============================================================
  {
    const pid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const hexes = Array.from({ length: 60 }, () => new ObjectId().toHexString());
    const destinoN = (i, extra = {}) => ({ _id: ObjectId.createFromHexString(hexes[i]), pais: `Destino ${i}`, codigo_iso: 'ZZ', requisitos: [requisitoEta({ descripcion: '<p>no sale</p>' })], ...extra });
    const listarCon = async (docs, destinos, limite = '50', extraDb = {}) => {
      const f = dbFalso({ propuestas: docs, destinos, ...extraDb });
      const r = await L.crearLectorPropuestas({ obtenerDb: () => f.db }).listar(L.validarConsultaListado({ limite }));
      return { r, llamadas: f.llamadas };
    };
    const secuencia = (llamadas) => llamadas.map((l) => [l.coleccion, l.op]);
    const idsDe = (llamada) => llamada.filtro._id.$in.map((x) => {
      assert.ok(x instanceof ObjectId, 'ids como ObjectId, no string');
      return x.toHexString();
    });

    // a) 50 propuestas con destinos distintos → exactamente 2 lecturas.
    {
      const docs = Array.from({ length: 50 }, (_, i) => propuestaDe({ propuestaId: pid(i), destinoHex: hexes[i] }));
      const destinos = Array.from({ length: 50 }, (_, i) => destinoN(i));
      const { r, llamadas } = await listarCon(docs, destinos);
      assert.deepStrictEqual(secuencia(llamadas), [['propuestas_cambio', 'find'], ['destinos', 'find']]);
      assert.deepStrictEqual(idsDe(llamadas[1]), [...hexes.slice(0, 50)].sort(), 'ids únicos y ordenados');
      assert.deepStrictEqual(llamadas[1].opciones, { projection: { _id: 1, pais: 1, codigo_iso: 1 } }, 'proyección exacta');
      assert.strictEqual(r.propuestas.length, 50);
      for (const item of r.propuestas) {
        assert.deepStrictEqual(item.destino, { destino_id: item.destino_id, pais: `Destino ${hexes.indexOf(item.destino_id)}`, codigo_iso: 'ZZ' });
      }
      sinProhibidos(r, 'listado de 50');
      assert.ok(!JSON.stringify(r).includes('<'), 'ni requisitos ni HTML del destino');
    }

    // b) límite + 1: el documento extra no se consulta.
    {
      const docs = Array.from({ length: 4 }, (_, i) => propuestaDe({ propuestaId: pid(i), destinoHex: hexes[i] }));
      const { r, llamadas } = await listarCon(docs, docs.map((_, i) => destinoN(i)), '3');
      const pagina = r.propuestas.map((x) => x.destino_id);
      assert.strictEqual(pagina.length, 3);
      assert.ok(r.siguiente_cursor);
      assert.deepStrictEqual(idsDe(llamadas[1]), [...pagina].sort(), 'solo los destinos de la página');
    }

    // c) Repetidos, null, inválido, inexistente, distinto del payload.
    {
      const docs = [
        propuestaDe({ propuestaId: pid(1), destinoHex: hexes[1] }),
        propuestaDe({ propuestaId: pid(2), destinoHex: hexes[1] }),
        propuestaDe({ propuestaId: pid(3), destinoHex: hexes[1] }),
        propuestaDe({ propuestaId: pid(4) }, { destino_id: null }),
        propuestaDe({ propuestaId: pid(5) }, { destino_id: 'no-es-objectid' }),
        propuestaDe({ propuestaId: pid(6) }, { destino_id: 'A'.repeat(24) }),
        propuestaDe({ propuestaId: pid(7), destinoHex: hexes[7] }), // inexistente
        propuestaDe({ propuestaId: pid(8), destinoHex: hexes[1] }, { destino_id: ObjectId.createFromHexString(hexes[8]) }), // payload ≠ documento
        propuestaDe({ propuestaId: pid(9), destinoHex: hexes[1] }, { destino_id: hexes[9] }) // destino_id como string hex válido
      ];
      const { r, llamadas } = await listarCon(docs, [destinoN(1), destinoN(8), destinoN(9)]);
      assert.deepStrictEqual(idsDe(llamadas[1]), [hexes[1], hexes[7], hexes[8], hexes[9]].sort(), 'repetidos una vez; null e inválidos fuera');
      const por = Object.fromEntries(r.propuestas.map((x) => [x.propuesta_id, x]));
      for (const n of [1, 2, 3]) assert.deepStrictEqual(por[pid(n)].destino, { destino_id: hexes[1], pais: 'Destino 1', codigo_iso: 'ZZ' });
      assert.notStrictEqual(por[pid(1)].destino, por[pid(2)].destino, 'cada ítem con su propio objeto');
      for (const n of [4, 5, 6, 7]) assert.strictEqual(por[pid(n)].destino, null, `ítem ${n}`);
      assert.deepStrictEqual(por[pid(8)].destino, { destino_id: hexes[8], pais: 'Destino 8', codigo_iso: 'ZZ' }, 'sale del documento, no del payload');
      assert.deepStrictEqual(por[pid(9)].destino, { destino_id: hexes[9], pais: 'Destino 9', codigo_iso: 'ZZ' });
      // Ningún campo existente cambia; destino va justo después de destino_id.
      for (const doc of docs) {
        const item = por[doc.propuesta_id];
        const { destino, ...resto } = item;
        assert.deepStrictEqual(resto, L.resumenListado(doc), `${doc.propuesta_id}: campos existentes`);
        const claves = Object.keys(L.resumenListado(doc));
        claves.splice(claves.indexOf('destino_id') + 1, 0, 'destino');
        assert.deepStrictEqual(Object.keys(item), claves, 'orden de claves');
        assert.ok(destino === null || typeof destino === 'object');
      }
    }

    // d) Página vacía o sin ids válidos → una sola lectura.
    {
      for (const docs of [[], [propuestaDe({}, { destino_id: null }), propuestaDe({}, { destino_id: 'xyz' })]]) {
        const { r, llamadas } = await listarCon(docs, [destinoN(0)]);
        assert.deepStrictEqual(secuencia(llamadas), [['propuestas_cambio', 'find']], `${docs.length} propuestas sin ids`);
        assert.ok(r.propuestas.every((x) => x.destino === null));
      }
    }

    // e) Si falla la lectura de destinos, falla el listado con ese mismo error.
    {
      const boom = new Error('fallo de destinos');
      const f = dbFalso({ propuestas: [propuestaDe()], destinos: [destinoN(0)], falloDestinos: boom });
      await assert.rejects(L.crearLectorPropuestas({ obtenerDb: () => f.db }).listar(L.validarConsultaListado({})), (err) => err === boom);
    }

    // f) Listado y detalle: misma forma y mismo saneamiento.
    {
      const casos = [
        ['normal', { pais: 'Reino Unido', codigo_iso: 'GB' }],
        ['acentos y apóstrofe', { pais: "Côte d'Ivoire", codigo_iso: 'CI' }],
        ['pais con HTML', { pais: '<img src=x onerror=alert(1)>Países <b>Bajos</b>', codigo_iso: 'nl' }],
        ['pais largo', { pais: 'Ñ'.repeat(150), codigo_iso: 'GBR' }],
        ['tipos incorrectos', { pais: 42, codigo_iso: 7 }],
        ['solo etiquetas', { pais: '<i></i>', codigo_iso: ' GB' }]
      ];
      for (const [etiqueta, campos] of casos) {
        const destino = { _id: ObjectId.createFromHexString(DESTINO_HEX), ...campos, requisitos: [requisitoEta()] };
        const p = propuestaDe();
        const f = dbFalso({ propuestas: [p], destinos: [destino] });
        const lector = L.crearLectorPropuestas({ obtenerDb: () => f.db });
        const item = (await lector.listar(L.validarConsultaListado({}))).propuestas[0];
        const det = await lector.detalle(PID, OP_DECIDE);
        assert.deepStrictEqual(item.destino, det.requisito_actual.destino, `${etiqueta}: listado = detalle`);
        assert.deepStrictEqual(item.destino, L.destinoSeguro(destino), etiqueta);
        assert.ok(!JSON.stringify([item, det]).includes('<'), `${etiqueta}: sin "<"`);
      }
      // Destino inexistente: null en los dos.
      const f = dbFalso({ propuestas: [propuestaDe()] });
      const lector = L.crearLectorPropuestas({ obtenerDb: () => f.db });
      assert.strictEqual((await lector.listar(L.validarConsultaListado({}))).propuestas[0].destino, null);
      assert.strictEqual((await lector.detalle(PID, OP_DECIDE)).requisito_actual.destino, null);
    }

    // g) Consulta exacta (pura).
    {
      assert.strictEqual(L.consultaDestinosListado([]), null);
      assert.strictEqual(L.consultaDestinosListado([{ destino_id: null }, { destino_id: 'xyz' }, {}]), null);
      const q = L.consultaDestinosListado([{ destino_id: hexes[3] }, { destino_id: ObjectId.createFromHexString(hexes[2]) }, { destino_id: hexes[3] }, { destino_id: null }]);
      assert.deepStrictEqual(Object.keys(q.filtro), ['_id']);
      assert.deepStrictEqual(q.filtro._id.$in.map((x) => x.toHexString()), [hexes[2], hexes[3]].sort());
      assert.deepStrictEqual(q.opciones, { projection: { _id: 1, pais: 1, codigo_iso: 1 } });
    }
    console.log('11) destino en el listado: 50 propuestas → [find propuestas_cambio, find destinos] con ids únicos y ordenados (ObjectId) y proyección exacta; documento extra del límite + 1 fuera; repetidos una vez; null, inválido e inexistente → null; destino_id del documento (no del payload); campos existentes y orden intactos; página vacía o sin ids → 1 lectura; fallo de destinos → mismo error; listado = detalle en 6 casos hostiles y en inexistente: OK');
  }

  // ============================================================
  // 12) El saneamiento solo afecta lo que se muestra: un pais o
  //     codigo_iso hostil no cambia la integridad ni las acciones
  // ============================================================
  {
    const hostiles = [
      ['pais con HTML', { pais: '<img src=x onerror=alert(1)>Reino <b>Unido</b>' }],
      ['pais con controles', { pais: 'Reino\r\n\tUnido\u0000' }],
      ['pais con sustituto aislado', { pais: 'Reino\uD800Unido' }],
      ['pais de 500 caracteres', { pais: 'Ñ'.repeat(500) }],
      ['pais numérico', { pais: 42 }],
      ['pais objeto', { pais: { $gt: '' } }],
      ['sin pais', { pais: undefined }],
      ['solo etiquetas', { pais: '<i></i>' }],
      ['codigo_iso en minúsculas', { codigo_iso: 'gb' }],
      ['codigo_iso numérico', { codigo_iso: 7 }]
    ];
    const escenarios = [
      ['íntegra', requisitoEta(), ['aprobar', 'rechazar']],
      ['valor actual cambiado', requisitoEta({ costo: '£16' }), ['rechazar']]
    ];
    let comparados = 0;
    for (const [escenario, req, permitidas] of escenarios) {
      const p = propuestaDe();
      const destino = (campos = {}) => ({ _id: ObjectId.createFromHexString(DESTINO_HEX), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [req], ...campos });
      const leer = async (d) => {
        const f = dbFalso({ propuestas: [p], destinos: [d] });
        const det = await L.crearLectorPropuestas({ obtenerDb: () => f.db }).detalle(PID, OP_DECIDE);
        const integ = await L.evaluarIntegridad(dbFalso({ destinos: [d] }).db, p);
        return { det, integ };
      };
      const sinDestino = ({ destino: _d, ...resto }) => resto;
      const base = await leer(destino());
      assert.strictEqual(base.det.integridad.hash_coincide, true, `${escenario}: hash coincide`);
      assert.deepStrictEqual(base.det.acciones_permitidas, permitidas, `${escenario}: acciones de referencia`);
      for (const [etiqueta, campos] of hostiles) {
        const h = await leer(destino(campos));
        const nombre = `${escenario} + ${etiqueta}`;
        assert.deepStrictEqual(h.det.integridad, base.det.integridad, `${nombre}: integridad`);
        assert.deepStrictEqual(h.det.acciones_permitidas, base.det.acciones_permitidas, `${nombre}: acciones_permitidas`);
        assert.deepStrictEqual(h.det.acciones_bloqueadas, base.det.acciones_bloqueadas, `${nombre}: acciones_bloqueadas`);
        assert.deepStrictEqual(sinDestino(h.det.requisito_actual), sinDestino(base.det.requisito_actual), `${nombre}: requisito_actual (salvo destino)`);
        assert.deepStrictEqual(h.det.propuesta, base.det.propuesta, `${nombre}: propuesta`);
        // La aprobación POST usa evaluarIntegridad: mismos motivos y mismo hash.
        assert.deepStrictEqual(h.integ.motivos, base.integ.motivos, `${nombre}: motivos de la aprobación`);
        assert.deepStrictEqual(h.integ.hash, base.integ.hash, `${nombre}: hash`);
        // Lo único que cambia es lo que se muestra del destino.
        assert.deepStrictEqual(h.det.requisito_actual.destino, L.destinoSeguro(destino(campos)), `${nombre}: destino saneado`);
        comparados++;
      }
    }
    console.log(`12) integridad sobre el documento original: ${comparados} combinaciones (2 escenarios × ${hostiles.length} pais/codigo_iso hostiles) con la misma integridad, hash_coincide, acciones permitidas y bloqueadas, requisito_actual y motivos de la aprobación; solo cambia el destino mostrado: OK`);
  }

  console.log('\nTODAS LAS PRUEBAS DEL LECTOR DE PROPUESTAS OK');
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
