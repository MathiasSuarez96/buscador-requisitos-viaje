/**
 * Pruebas de las decisiones del panel (POST /api/panel/propuestas/:id/
 * aprobacion y /rechazo) SIN Mongo: app real en 127.0.0.1, verificador
 * real de Google con claves propias y JWKS local, configuración real, el
 * módulo real de decisiones (services/panel/decisiones-propuestas.js) con
 * un `db` falso que solo implementa findOne y un decidirPropuesta falso
 * que registra lo que recibe. Una sección usa el decidirPropuesta REAL con
 * dependencias falsas para fijar el cableado de identidad y la detección
 * de "resultado incierto" contra el servicio verdadero.
 *
 * Cubre: permisos (ver + decidir), body por lista blanca, entrada exacta,
 * relectura previa (404/409/422), rechazo sin bloqueo por integridad,
 * reenvío idéntico (relectura previa y tras cas_no_coincide), traducción
 * de cada error del servicio y ausencia de datos privados.
 *
 * Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-panel-decisiones.js
 */

const assert = require('assert');

if (!globalThis.__SOLO_LOOPBACK__) {
  console.error('Falta --require ./scripts/preload-solo-loopback.js. Abortando sin levantar nada.');
  process.exit(1);
}

const { ObjectId } = require('bson');
const { crearApp } = require('../app');
const { crearVerificadorGoogle } = require('../services/panel/verificar-token-google');
const { cargarOperadoresPanel, resolverOperadorPanel } = require('../services/panel/operadores-panel');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { REQUISITO_ID_ETA } = require('../services/propuestas/fuentes/govuk-uk-eta');
const { ErrorPrecondicionIndices } = require('../services/propuestas/indices-propuestas');
const S = require('../services/propuestas/decidir-propuesta');
const D = require('../services/panel/decisiones-propuestas');
const { pedir } = require('./lib/http-prueba');
const { CLIENT_ID, crearEmisorPrueba } = require('./lib/tokens-prueba');

const ORIGEN = 'https://toctoc-requisitos.vercel.app';
const OPERADORES = [
  { proveedor: 'google', sub: '1000', email: 'operador@example.com', identificador: 'operador.panel', permisos: ['ver', 'decidir'] },
  { proveedor: 'google', sub: '2000', email: 'solo-decidir@example.com', identificador: 'solo.decidir', permisos: ['decidir'] },
  { proveedor: 'google', sub: '3000', email: 'solo-ver@example.com', identificador: 'solo.ver', permisos: ['ver'] },
  { proveedor: 'google', sub: '4000', email: 'segundo@example.com', identificador: 'segundo.operador', permisos: ['ver', 'decidir'] }
];
const ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, OPERADORES_PANEL_JSON: JSON.stringify(OPERADORES), PANEL_ORIGENES_PERMITIDOS: ORIGEN };
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROHIBIDOS = ['fragmento_html', '<', '>', 'usuario_atlas', '"sub"', '"email"', 'operador@example.com', 'segundo@example.com', 'mongodb://', 'eyJ', '"payload"', 'identidad_operador', 'detalle_interno'];

// Operador tal cual lo arma el middleware a partir de un token verificado.
const OPERADOR_PANEL = resolverOperadorPanel({ proveedor: 'google', sub: '1000', email: 'operador@example.com', email_verificado: true }, cargarOperadoresPanel(ENV.OPERADORES_PANEL_JSON));
const SEGUNDO = resolverOperadorPanel({ proveedor: 'google', sub: '4000', email: 'segundo@example.com', email_verificado: true }, cargarOperadoresPanel(ENV.OPERADORES_PANEL_JSON));

// ------------------------------------------------------------------
// Datos
// ------------------------------------------------------------------

const DESTINO = {
  gb: '6a87828da8282a4aa6ddfbda', // costo ausente
  conCosto: '6a87828da8282a4aa6ddfbdd', // costo '£16'
  otroNombre: '6a87828da8282a4aa6ddfbdc', // identidad semántica distinta
  inexistente: '6a87828da8282a4aa6ddfbff'
};
const oid = (hex) => ObjectId.createFromHexString(hex);
const requisito = (extra = {}) => ({ _id: oid(REQUISITO_ID_ETA), tipo: 'formulario_digital', nombre: 'UK ETA', obligatorio: 'si', estado: 'confirmado', ...extra });
const DESTINOS = [
  { _id: oid(DESTINO.gb), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [requisito()] },
  { _id: oid(DESTINO.conCosto), pais: 'Reino Unido (costo)', codigo_iso: 'G3', requisitos: [requisito({ costo: '£16' })] },
  { _id: oid(DESTINO.otroNombre), pais: 'Reino Unido (otro)', codigo_iso: 'G2', requisitos: [requisito({ nombre: 'UK ETA (nuevo)' })] }
];

let secuencia = 0;
function propuesta({ destino = DESTINO.gb, requisitoHex = REQUISITO_ID_ETA, alterarHash = false, extra = {} } = {}) {
  secuencia++;
  const propuestaId = `00000000-0000-4000-8000-${String(secuencia).padStart(12, '0')}`;
  const payload = {
    version_contrato: '1.0',
    tipo_propuesta: 'actualizacion_campo_requisito',
    fecha_propuesta: '2026-09-27T16:24:32.532Z',
    destino_id: destino,
    requisito_id: requisitoHex,
    campo: 'costo',
    run_id_origen: 'bfcf5b8e-bda9-4cc7-b3c3-ef28fb897835',
    propuesta_id: propuestaId,
    valor_anterior: { presente: false, valor: null },
    valor_propuesto: {
      valor: '£20',
      valor_normalizado: { importe: 20, moneda: 'GBP' },
      evidencia: { extraccion: { apply: { costo_extraido: 20, fragmento_html: '<p>£20</p>', moneda: 'GBP' } }, detalle_interno: { x: 1 } }
    },
    fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/api/content/eta', capturado_en: '2026-09-27T16:24:31.692Z' }
  };
  const hash = hashSobreCanonico(payload, 'toc-v1', 'sha256');
  if (alterarHash) payload.valor_propuesto.valor = '£2';
  return {
    _id: new ObjectId(),
    propuesta_id: propuestaId,
    destino_id: oid(destino),
    requisito_id: oid(requisitoHex),
    campo: 'costo',
    algoritmo_canonicalizacion: 'toc-v1',
    algoritmo_hash: 'sha256',
    payload,
    payload_hash: hash,
    estado: 'pendiente_aprobacion',
    version_coordinacion: 0,
    decision_aprobacion_id: null,
    ultimo_evento_id: null,
    createdAt: new Date('2026-09-27T16:24:32.600Z'),
    updatedAt: new Date('2026-09-27T16:24:32.600Z'),
    ...extra
  };
}

// Evento que el panel habría guardado para `p` (tipo y operador dados).
function eventoPanel(p, { tipo = 'aprobacion', operador = OPERADOR_PANEL, motivo, extra = {}, detalle } = {}) {
  const evento = {
    _id: new ObjectId(),
    evento_id: `eeeeeeee-0000-4000-8000-${String(++secuencia).padStart(12, '0')}`,
    propuesta_id: p.propuesta_id,
    tipo_evento: tipo,
    estado_anterior: 'pendiente_aprobacion',
    estado_nuevo: tipo === 'aprobacion' ? 'aprobada' : 'rechazada',
    hash_contenido_referenciado: p.payload_hash,
    version_coordinacion_nueva: p.version_coordinacion + 1,
    ocurrido_en: new Date('2026-10-04T20:00:00.000Z'),
    actor: { tipo: 'humano', identificador: operador.actor.identificador },
    detalle: detalle ?? { identidad_operador: { ...operador.identidad_operador }, comando: { nombre: 'panel-propuestas', version: '1' } },
    ...extra
  };
  if (motivo !== undefined) evento.motivo = motivo;
  return evento;
}

// Propuesta ya decidida por `evento` (estado posterior coherente).
const decidida = (p, ev) => ({
  ...p,
  estado: ev.estado_nuevo,
  version_coordinacion: ev.version_coordinacion_nueva,
  ultimo_evento_id: ev.evento_id,
  decision_aprobacion_id: ev.tipo_evento === 'aprobacion' ? ev.evento_id : null,
  updatedAt: ev.ocurrido_en
});

// db falso: solo findOne sobre las tres colecciones; registra cada lectura.
function crearDb() {
  const datos = { propuestas_cambio: [], eventos_propuesta: [], destinos: DESTINOS };
  const lecturas = [];
  const db = {
    collection: (nombre) =>
      new Proxy(
        {
          async findOne(filtro) {
            lecturas.push({ coleccion: nombre, filtro });
            return (
              datos[nombre].find((d) =>
                Object.entries(filtro).every(([k, v]) => (v instanceof ObjectId ? v.equals(d[k]) : d[k] === v))
              ) ?? null
            );
          }
        },
        {
          get(o, k) {
            if (k in o) return o[k];
            if (k === 'then') return undefined;
            throw new Error(`db falso: método no permitido ${String(k)} en ${nombre}`);
          }
        }
      )
  };
  return {
    db,
    lecturas,
    poner(p, ...eventos) {
      datos.propuestas_cambio = datos.propuestas_cambio.filter((x) => x.propuesta_id !== p.propuesta_id).concat([p]);
      datos.eventos_propuesta.push(...eventos);
      return p;
    },
    quitar(propuestaId) {
      datos.propuestas_cambio = datos.propuestas_cambio.filter((x) => x.propuesta_id !== propuestaId);
    }
  };
}

const cuerpoDe = (p, extra = {}) => ({ estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: p.version_coordinacion, ...extra });

(async () => {
  const emisor = await crearEmisorPrueba();
  const verificador = crearVerificadorGoogle({ clientId: CLIENT_ID, jwks: emisor.localJWKSet });
  const REGISTROS = [];
  const RESPUESTAS = [];
  const fakeDb = crearDb();
  let conDb = true;

  // decidirPropuesta falso: cada prueba fija `comportamiento`.
  const LLAMADAS = [];
  let comportamiento = null;
  const BASE_DEPS = Object.freeze({ marca: 'dependencias-base', uuid: () => 'x' });
  const decidirFalso = async (entrada, deps) => {
    LLAMADAS.push({ entrada, deps });
    return comportamiento(entrada, deps);
  };
  // Por defecto: registra como lo haría el servicio.
  const registrarComoServicio = (entrada, deps) => {
    const r = deps.resolverIdentidad();
    return {
      resultado: 'decision_registrada',
      tipo_evento: entrada.tipo_evento,
      propuesta_id: entrada.propuesta_id,
      evento_id: '99999999-9999-4999-8999-999999999999',
      estado_anterior: entrada.estado_esperado,
      estado_nuevo: entrada.tipo_evento === 'aprobacion' ? 'aprobada' : 'rechazada',
      version_coordinacion_nueva: entrada.version_coordinacion_esperada + 1,
      ocurrido_en: new Date('2026-10-04T21:00:00.000Z'),
      actor: { ...r.actor },
      confirmada_por_relectura: false,
      causa_relectura: null
    };
  };

  let decisionesActivas = D.crearDecisionesPropuestas({ obtenerDb: () => (conDb ? fakeDb.db : null), decidir: decidirFalso, dependencias: () => BASE_DEPS });
  const decisiones = { decidir: (...a) => decisionesActivas.decidir(...a) };
  const app = crearApp({ panel: { env: ENV, verificador, registrar: (e) => REGISTROS.push(e), decisiones } });
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const puerto = servidor.address().port;

  const tokenDe = async (sub) => emisor.firmar({ sub, email: OPERADORES.find((o) => o.sub === sub)?.email ?? 'x@example.com' });
  const post = async (ruta, cuerpo, { sub = '1000', crudo, headers = {} } = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (sub) h.Authorization = `Bearer ${await tokenDe(sub)}`;
    const texto = crudo ?? (cuerpo === undefined ? '' : JSON.stringify(cuerpo));
    const r = await pedir(puerto, 'POST', ruta, h, texto);
    RESPUESTAS.push({ ruta, status: r.status, body: r.body });
    assert.strictEqual(r.headers['cache-control'], 'no-store', `${ruta}: no-store`);
    return { ...r, json: r.body ? JSON.parse(r.body) : null };
  };
  const ruta = (p, tipo) => `/api/panel/propuestas/${typeof p === 'string' ? p : p.propuesta_id}/${tipo}`;
  const error = (r, status, codigo, etiqueta) => {
    assert.strictEqual(r.status, status, `[${etiqueta}] status (${r.body})`);
    assert.strictEqual(r.json.error.codigo, codigo, `[${etiqueta}] codigo`);
    assert.strictEqual(r.json.error.request_id, r.headers['x-request-id'], `[${etiqueta}] request_id`);
    const extra = { 409: ['actual'], 422: ['motivos'] }[status] ?? [];
    assert.deepStrictEqual(Object.keys(r.json.error).sort(), ['codigo', 'mensaje', 'request_id', ...extra].sort(), `[${etiqueta}] forma`);
    return r.json.error;
  };
  const sinEfectos = (antesLlamadas, etiqueta) => assert.strictEqual(LLAMADAS.length, antesLlamadas, `[${etiqueta}] decidirPropuesta no se llama`);

  try {
    // ============================================================
    // 1) Permisos: ver + decidir, antes de leer nada
    // ============================================================
    {
      const p = fakeDb.poner(propuesta());
      comportamiento = registrarComoServicio;
      for (const tipo of ['aprobacion', 'rechazo']) {
        const cuerpo = cuerpoDe(p, tipo === 'rechazo' ? { motivo: 'x' } : {});
        error(await post(ruta(p, tipo), cuerpo, { sub: null }), 401, 'no_autenticado', `${tipo} sin token`);
        error(await post(ruta(p, tipo), cuerpo, { sub: '9999' }), 403, 'no_autorizado', `${tipo} fuera de la lista`);
        error(await post(ruta(p, tipo), cuerpo, { sub: '3000' }), 403, 'sin_permiso', `${tipo} solo ver`);
        error(await post(ruta(p, tipo), cuerpo, { sub: '2000' }), 403, 'sin_permiso', `${tipo} solo decidir (gate de ver)`);
      }
      assert.deepStrictEqual([LLAMADAS.length, fakeDb.lecturas.length], [0, 0], 'ningún rechazo de permisos llama al servicio ni lee');
      const motivos = REGISTROS.filter((e) => e.status === 403).map((e) => e.motivo);
      assert.deepStrictEqual(motivos, ['no_autorizado', 'sin_permiso_decidir', 'sin_permiso_ver', 'no_autorizado', 'sin_permiso_decidir', 'sin_permiso_ver']);
      const get = await pedir(puerto, 'GET', ruta(p, 'aprobacion'), { Authorization: `Bearer ${await tokenDe('1000')}` });
      assert.strictEqual(get.status, 404, 'GET sobre la ruta de decisión → 404');
      console.log('1) sin token 401; fuera de la lista 403; solo "ver" 403 sin_permiso_decidir; solo "decidir" 403 sin_permiso_ver; 0 llamadas y 0 lecturas: OK');
    }

    // ============================================================
    // 2) Body por lista blanca exacta → 400 sin leer ni llamar
    // ============================================================
    {
      const p = fakeDb.poner(propuesta());
      const ok = cuerpoDe(p);
      const okR = { ...ok, motivo: 'Fuente desactualizada' };
      const H = p.payload_hash;
      const sin = (o, k) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
      const invalidosAmbos = [
        ['array', null, '[]'],
        // express.json estricto (bloque 2) ya los corta como json_invalido.
        ['null', null, 'null', 'json_invalido'],
        ['string', null, '"x"', 'json_invalido'],
        ['número', null, '1', 'json_invalido'],
        ['__proto__ extra', null, (c) => JSON.stringify(c).replace(/^\{/, '{"__proto__":{"x":1},')],
        ['constructor extra', (c) => ({ ...c, constructor: {} })],
        ['prototype extra', (c) => ({ ...c, prototype: {} })],
        ['clave extra', (c) => ({ ...c, extra: 1 })],
        ['tipo_evento en el body', (c) => ({ ...c, tipo_evento: 'aprobacion' })],
        ['propuesta_id en el body', (c) => ({ ...c, propuesta_id: p.propuesta_id })],
        ['decision_aprobacion_id_esperado en el body', (c) => ({ ...c, decision_aprobacion_id_esperado: null })],
        ['actor en el body', (c) => ({ ...c, actor: { tipo: 'humano', identificador: 'otro' } })],
        ['sin estado', (c) => sin(c, 'estado_esperado')],
        ['sin hash', (c) => sin(c, 'payload_hash_esperado')],
        ['sin versión', (c) => sin(c, 'version_coordinacion_esperada')],
        ['estado aprobada', (c) => ({ ...c, estado_esperado: 'aprobada' })],
        ['estado en mayúsculas', (c) => ({ ...c, estado_esperado: 'PENDIENTE_APROBACION' })],
        ['estado null', (c) => ({ ...c, estado_esperado: null })],
        ['hash en mayúsculas', (c) => ({ ...c, payload_hash_esperado: H.toUpperCase() })],
        ['hash corto', (c) => ({ ...c, payload_hash_esperado: H.slice(1) })],
        ['hash con operador', (c) => ({ ...c, payload_hash_esperado: { $ne: null } })],
        ['versión "0"', (c) => ({ ...c, version_coordinacion_esperada: '0' })],
        ['versión 1.5', (c) => ({ ...c, version_coordinacion_esperada: 1.5 })],
        ['versión -1', (c) => ({ ...c, version_coordinacion_esperada: -1 })],
        ['versión 2^53', (c) => ({ ...c, version_coordinacion_esperada: 2 ** 53 })],
        ['versión null', (c) => ({ ...c, version_coordinacion_esperada: null })],
        ['versión true', (c) => ({ ...c, version_coordinacion_esperada: true })]
      ];
      const invalidosRechazo = [
        ['sin motivo', sin(okR, 'motivo')],
        ['motivo vacío', { ...ok, motivo: '' }],
        ['motivo solo espacios', { ...ok, motivo: ' \n\t ' }],
        ['motivo número', { ...ok, motivo: 5 }],
        ['motivo null', { ...ok, motivo: null }],
        ['motivo de 501 code points', { ...ok, motivo: '€'.repeat(501) }],
        ['motivo de 501 emoji (fuera del BMP)', { ...ok, motivo: '😀'.repeat(501) }],
        ['motivo con \\r', { ...ok, motivo: 'a\rb' }],
        ['motivo con NUL', { ...ok, motivo: 'a\u0000b' }],
        ['motivo con control C1', { ...ok, motivo: 'a\u0085b' }],
        ['motivo con surrogate suelto', { ...ok, motivo: 'a\ud800b' }]
      ];
      const invalidosAprobacion = [['motivo en aprobación', okR]];
      let casos = 0;
      for (const [tipo, base] of [
        ['aprobacion', ok],
        ['rechazo', okR]
      ]) {
        for (const [etiqueta, mut, crudo, codigo = 'solicitud_invalida'] of invalidosAmbos) {
          const r = crudo === undefined ? await post(ruta(p, tipo), mut(base)) : await post(ruta(p, tipo), undefined, { crudo: typeof crudo === 'function' ? crudo(base) : crudo });
          error(r, 400, codigo, `${tipo}: ${etiqueta}`);
          casos++;
        }
      }
      for (const [etiqueta, c] of invalidosRechazo) {
        error(await post(ruta(p, 'rechazo'), c), 400, 'solicitud_invalida', `rechazo: ${etiqueta}`);
        casos++;
      }
      for (const [etiqueta, c] of invalidosAprobacion) {
        error(await post(ruta(p, 'aprobacion'), c), 400, 'solicitud_invalida', etiqueta);
        casos++;
      }
      // id y query
      error(await post(ruta('no-es-uuid', 'aprobacion'), ok), 400, 'solicitud_invalida', 'id no UUID');
      error(await post(ruta('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'aprobacion'), ok), 400, 'solicitud_invalida', 'id en mayúsculas');
      error(await post(`${ruta(p, 'aprobacion')}?forzar=1`, ok), 400, 'solicitud_invalida', 'query');
      // Frontera HTTP ya existente: JSON roto, tipo, tamaño.
      error(await post(ruta(p, 'aprobacion'), undefined, { crudo: '{"estado_esperado":' }), 400, 'json_invalido', 'JSON roto');
      error(await post(ruta(p, 'aprobacion'), undefined, { crudo: '', headers: { 'Content-Type': 'text/plain' } }), 415, 'tipo_no_soportado', 'sin JSON');
      error(await post(ruta(p, 'rechazo'), { ...ok, motivo: 'x'.repeat(9000) }), 413, 'cuerpo_demasiado_grande', '> 8 KB');
      casos += 6;
      assert.deepStrictEqual([LLAMADAS.length, fakeDb.lecturas.length], [0, 0], 'ningún 400 llama al servicio ni lee');
      // Límite exacto: 500 code points (con espacios alrededor) sí pasa.
      comportamiento = registrarComoServicio;
      const borde = await post(ruta(p, 'rechazo'), { ...ok, motivo: `  ${'€'.repeat(500)}\n` });
      assert.strictEqual(borde.status, 200, `500 code points pasa (${borde.body})`);
      // 500 emoji = 1000 unidades UTF-16: el límite cuenta code points.
      const pe = fakeDb.poner(propuesta());
      const emoji = await post(ruta(pe, 'rechazo'), cuerpoDe(pe, { motivo: '😀'.repeat(500) }));
      assert.strictEqual(emoji.status, 200, `500 emoji pasa (${emoji.body})`);
      const pt = fakeDb.poner(propuesta());
      const tabs = await post(ruta(pt, 'rechazo'), cuerpoDe(pt, { motivo: 'línea 1\n\tlínea 2' }));
      assert.strictEqual(tabs.status, 200, `\\n y \\t admitidos (${tabs.body})`);
      LLAMADAS.length = 0;
      fakeDb.lecturas.length = 0;
      console.log(`2) ${casos} entradas inválidas → 400/413/415 (incluidos __proto__, constructor, "0", 1.5, 2^53, mayúsculas, motivo de 501, controles, surrogate, motivo en aprobación, query); 0 llamadas y 0 lecturas; 500 code points y \\n/\\t admitidos: OK`);
    }

    // ============================================================
    // 3) Entrada exacta, identidad inyectada y respuesta 200
    // ============================================================
    {
      comportamiento = registrarComoServicio;
      const pa = fakeDb.poner(propuesta());
      const ra = await post(ruta(pa, 'aprobacion'), cuerpoDe(pa));
      assert.strictEqual(ra.status, 200, ra.body);
      const { entrada, deps } = LLAMADAS.at(-1);
      assert.deepStrictEqual(entrada, {
        tipo_evento: 'aprobacion',
        propuesta_id: pa.propuesta_id,
        estado_esperado: 'pendiente_aprobacion',
        payload_hash_esperado: pa.payload_hash,
        version_coordinacion_esperada: 0,
        decision_aprobacion_id_esperado: null
      });
      assert.deepStrictEqual(Object.keys(entrada), ['tipo_evento', 'propuesta_id', 'estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada', 'decision_aprobacion_id_esperado']);
      // resolverIdentidad devuelve el operador del token, congelado y completo.
      const op = deps.resolverIdentidad();
      assert.deepStrictEqual(op, OPERADOR_PANEL);
      assert.ok(Object.isFrozen(op) && Object.isFrozen(op.actor) && Object.isFrozen(op.identidad_operador));
      assert.deepStrictEqual(S.validarResolucionIdentidad(op), { actor: OPERADOR_PANEL.actor, identidad_operador: OPERADOR_PANEL.identidad_operador, comando: { nombre: 'panel-propuestas', version: '1' } });
      assert.throws(() => deps.operadoresAutorizados(), /token OIDC/, 'la allowlist de la CLI no se usa');
      assert.throws(() => deps.usuariosAutenticados(), /token OIDC/, 'connectionStatus no se usa');
      assert.strictEqual(deps.marca, 'dependencias-base', 'el resto de las dependencias viene de la base');
      assert.deepStrictEqual(ra.json, {
        decision: {
          tipo_evento: 'aprobacion',
          propuesta_id: pa.propuesta_id,
          evento_id: '99999999-9999-4999-8999-999999999999',
          estado_anterior: 'pendiente_aprobacion',
          estado_nuevo: 'aprobada',
          version_coordinacion_nueva: 1,
          ocurrido_en: '2026-10-04T21:00:00.000Z',
          actor: { tipo: 'humano', identificador: 'operador.panel' },
          ya_registrada: false
        }
      });
      const reg = REGISTROS.at(-1);
      assert.deepStrictEqual(reg, {
        nivel: 'info',
        evento: 'panel_decision',
        request_id: ra.headers['x-request-id'],
        propuesta_id: pa.propuesta_id,
        evento_id: '99999999-9999-4999-8999-999999999999',
        tipo_evento: 'aprobacion',
        identificador: 'operador.panel',
        ya_registrada: false,
        confirmada_por_relectura: false,
        causa_relectura: null
      });

      const pr = fakeDb.poner(propuesta({ extra: { version_coordinacion: 3 } }));
      fakeDb.lecturas.length = 0;
      const rr = await post(ruta(pr, 'rechazo'), cuerpoDe(pr, { motivo: '  Fuente desactualizada \n' }));
      assert.strictEqual(rr.status, 200, rr.body);
      assert.deepStrictEqual(LLAMADAS.at(-1).entrada, {
        tipo_evento: 'rechazo',
        propuesta_id: pr.propuesta_id,
        estado_esperado: 'pendiente_aprobacion',
        payload_hash_esperado: pr.payload_hash,
        version_coordinacion_esperada: 3,
        decision_aprobacion_id_esperado: null,
        motivo: '  Fuente desactualizada \n'
      });
      assert.deepStrictEqual(fakeDb.lecturas.map((l) => l.coleccion), ['propuestas_cambio'], 'el rechazo solo lee la propuesta (ni destino ni eventos)');
      assert.strictEqual(rr.json.decision.estado_nuevo, 'rechazada');
      console.log('3) entrada exacta (tipo de la ruta, decision_aprobacion_id null del servidor, motivo crudo), resolverIdentidad = operador del token, allowlist CLI y connectionStatus anulados; 200 y panel_decision por lista blanca; el rechazo solo lee la propuesta: OK');
    }

    // ============================================================
    // 4) Relectura previa: 404 y 409 sin llamar al servicio
    // ============================================================
    {
      comportamiento = registrarComoServicio;
      const antes = LLAMADAS.length;
      error(await post(ruta('11111111-1111-4111-8111-111111111111', 'aprobacion'), cuerpoDe(propuesta())), 404, 'no_encontrado', 'inexistente');
      const p = fakeDb.poner(propuesta({ extra: { version_coordinacion: 2 } }));
      for (const tipo of ['aprobacion', 'rechazo']) {
        const extra = tipo === 'rechazo' ? { motivo: 'm' } : {};
        const casos = [
          ['versión vieja', cuerpoDe(p, { ...extra, version_coordinacion_esperada: 1 })],
          ['versión futura', cuerpoDe(p, { ...extra, version_coordinacion_esperada: 3 })],
          ['otro hash', cuerpoDe(p, { ...extra, payload_hash_esperado: 'a'.repeat(64) })]
        ];
        for (const [etiqueta, c] of casos) {
          const e = error(await post(ruta(p, tipo), c), 409, 'propuesta_cambio', `${tipo}: ${etiqueta}`);
          assert.deepStrictEqual(e.actual, { estado: 'pendiente_aprobacion', version_coordinacion: 2, payload_hash: p.payload_hash, ultimo_evento: null });
        }
      }
      // Ya aprobada por OTRO operador: 409 con el último evento, sin su actor.
      const base = propuesta();
      const ev = eventoPanel(base, { operador: SEGUNDO });
      const aprobada = fakeDb.poner(decidida(base, ev), ev);
      const e = error(await post(ruta(aprobada, 'aprobacion'), cuerpoDe(base)), 409, 'propuesta_cambio', 'aprobada por otro');
      assert.deepStrictEqual(e.actual, { estado: 'aprobada', version_coordinacion: 1, payload_hash: base.payload_hash, ultimo_evento: { tipo_evento: 'aprobacion', ocurrido_en: '2026-10-04T20:00:00.000Z' } });
      // payload_hash almacenado no hex: con ese valor el body es 400; con
      // cualquier hash válido la coordinación no coincide → 409.
      const invalido = fakeDb.poner(propuesta({ extra: { payload_hash: 'no-es-un-hash' } }));
      for (const [tipo, extra] of [['aprobacion', {}], ['rechazo', { motivo: 'm' }]]) {
        error(await post(ruta(invalido, tipo), cuerpoDe(invalido, extra)), 400, 'solicitud_invalida', `${tipo}: hash almacenado inválido`);
        const e409 = error(await post(ruta(invalido, tipo), cuerpoDe(invalido, { ...extra, payload_hash_esperado: 'a'.repeat(64) })), 409, 'propuesta_cambio', `${tipo}: hash válido contra almacenado inválido`);
        assert.strictEqual(e409.actual.payload_hash, null, 'el hash inválido no se expone');
      }
      // version_coordinacion almacenada inválida (comportamiento ACTUAL): con
      // ese valor el body es 400; con cualquier entero, 409 (no coincide).
      for (const [etiqueta, version, cuerpos] of [
        ['1.5', 1.5, [[1.5, 400], [1, 409], [2, 409]]],
        ['"0"', '0', [['0', 400], [0, 409]]],
        ['null', null, [[null, 400], [0, 409]]]
      ]) {
        const pv = fakeDb.poner(propuesta({ extra: { version_coordinacion: version } }));
        for (const [v, status] of cuerpos) {
          for (const [tipo, extra] of [['aprobacion', {}], ['rechazo', { motivo: 'm' }]]) {
            const r = await post(ruta(pv, tipo), cuerpoDe(pv, { ...extra, version_coordinacion_esperada: v }));
            const e = error(r, status, status === 400 ? 'solicitud_invalida' : 'propuesta_cambio', `${tipo}: versión almacenada ${etiqueta}, body ${JSON.stringify(v)}`);
            if (status === 409) assert.deepStrictEqual(e.actual, { estado: 'pendiente_aprobacion', version_coordinacion: null, payload_hash: pv.payload_hash, ultimo_evento: null });
          }
        }
      }
      sinEfectos(antes, '404/409 de la relectura previa');
      console.log('4) relectura previa: inexistente 404; versión vieja/futura y otro hash 409 en aprobación y rechazo; decidida por otro 409 con `actual` sin actor; payload_hash almacenado no hex → 400 con ese hash y 409 con otro (sin exponerlo); version_coordinacion almacenada 1.5/"0"/null → 400 con ese valor y 409 con un entero; 0 llamadas: OK');
    }

    // ============================================================
    // 4b) Decisión previa en una pendiente: 200 reenvío → 409 → 422
    // ============================================================
    {
      comportamiento = () => assert.fail('la decisión previa nunca llega al servicio');
      const antes = LLAMADAS.length;
      const D_ID = '4db810fc-d491-4166-82d1-8b88fe9b088d';
      const AMBOS = [['aprobacion', {}], ['rechazo', { motivo: 'm' }]];

      // a) Estado, hash y versión coinciden y hay decisión previa → 422.
      const previa = fakeDb.poner(propuesta({ extra: { decision_aprobacion_id: D_ID } }));
      for (const [tipo, extra] of AMBOS) {
        const e = error(await post(ruta(previa, tipo), cuerpoDe(previa, extra)), 422, 'propuesta_no_decidible', `${tipo}: decisión previa`);
        assert.deepStrictEqual(e.motivos, ['decision_previa_existente']);
        assert.deepStrictEqual(
          [REGISTROS.at(-1).status, REGISTROS.at(-1).motivo, REGISTROS.at(-1).nivel],
          [422, 'no_decidible_decision_previa_existente', 'aviso']
        );
      }

      // b) Lo visto difiere y además hay decisión previa → 409 (gana el 409).
      const v2 = fakeDb.poner(propuesta({ extra: { decision_aprobacion_id: D_ID, version_coordinacion: 2 } }));
      const fueraDePendiente = fakeDb.poner(propuesta({ extra: { decision_aprobacion_id: D_ID, estado: 'aprobada' } }));
      for (const [tipo, extra] of AMBOS) {
        error(await post(ruta(v2, tipo), cuerpoDe(v2, { ...extra, version_coordinacion_esperada: 1 })), 409, 'propuesta_cambio', `${tipo}: otra versión + decisión previa`);
        error(await post(ruta(v2, tipo), cuerpoDe(v2, { ...extra, payload_hash_esperado: 'b'.repeat(64) })), 409, 'propuesta_cambio', `${tipo}: otro hash + decisión previa`);
        // Misma versión y hash pero NO pendiente: el estado difiere → 409, nunca 422.
        const e = error(await post(ruta(fueraDePendiente, tipo), cuerpoDe(fueraDePendiente, extra)), 409, 'propuesta_cambio', `${tipo}: aprobada con misma versión y hash`);
        assert.strictEqual(e.actual.estado, 'aprobada');
      }

      // c) Pendiente con decisión previa cuyo último evento "parece" un
      //    reenvío (aprobación del mismo operador desde el panel, con
      //    decision_aprobacion_id y ultimo_evento_id apuntándolo). Una
      //    propuesta que sigue pendiente no puede tener un reenvío válido.
      const base = propuesta({ extra: { version_coordinacion: 1 } });
      const ev = eventoPanel({ ...base, version_coordinacion: 0 });
      const aparente = fakeDb.poner({ ...base, decision_aprobacion_id: ev.evento_id, ultimo_evento_id: ev.evento_id }, ev);
      //   - body con lo visto ahora (v1) → 422 (no 200).
      const e422 = error(await post(ruta(aparente, 'aprobacion'), cuerpoDe(aparente)), 422, 'propuesta_no_decidible', 'reenvío aparente, lo visto vigente');
      assert.deepStrictEqual(e422.motivos, ['decision_previa_existente']);
      //   - body que el operador habría mandado antes del evento (v0) → 409 (no 200).
      const cuerpoOriginal = cuerpoDe({ ...aparente, version_coordinacion: 0 });
      error(await post(ruta(aparente, 'aprobacion'), cuerpoOriginal), 409, 'propuesta_cambio', 'reenvío aparente, body original');
      //   - la regla pura lo rechaza solo por el estado de la propuesta:
      const entradaOriginal = D.construirEntrada('aprobacion', aparente.propuesta_id, cuerpoOriginal);
      assert.strictEqual(D.esReenvioIdentico(entradaOriginal, OPERADOR_PANEL, aparente, ev), false, 'pendiente: no es reenvío');
      assert.strictEqual(D.esReenvioIdentico(entradaOriginal, OPERADOR_PANEL, { ...aparente, estado: 'aprobada' }, ev), true, 'el mismo par con la propuesta aprobada sí lo sería');
      assert.ok(!RESPUESTAS.some((r) => r.ruta.includes(aparente.propuesta_id) && r.status === 200), 'ningún 200 ya_registrada');

      sinEfectos(antes, 'decisión previa');
      console.log('4b) decisión previa: lo visto vigente → 422 [decision_previa_existente] en aprobación y rechazo; otra versión/otro hash/estado aprobada con decisión → 409; último evento que parece reenvío en una pendiente → 422 (v1) o 409 (v0), nunca 200, porque esReenvioIdentico exige el estado posterior; 0 llamadas: OK');
    }

    // ============================================================
    // 5) Integridad: bloquea la aprobación (422), nunca el rechazo
    // ============================================================
    {
      comportamiento = registrarComoServicio;
      const casos = [
        ['hash alterado', propuesta({ alterarHash: true }), ['hash_no_coincide']],
        ['valor actual cambió', propuesta({ destino: DESTINO.conCosto }), ['valor_actual_cambio']],
        ['requisito inexistente', propuesta({ requisitoHex: '6aaddd0e9f54309f9d8272ff' }), ['requisito_no_coincide', 'valor_actual_cambio']],
        ['destino inexistente', propuesta({ destino: DESTINO.inexistente }), ['requisito_no_coincide', 'valor_actual_cambio']],
        ['identidad cambiada', propuesta({ destino: DESTINO.otroNombre }), ['requisito_no_coincide']],
        // Ningún adaptador soporta campo "nombre": identidad no verificable.
        ['datos inconsistentes', propuesta({ extra: { campo: 'nombre' } }), ['datos_inconsistentes', 'requisito_no_coincide']]
      ];
      for (const [etiqueta, p, motivos] of casos) {
        fakeDb.poner(p);
        const antes = LLAMADAS.length;
        const e = error(await post(ruta(p, 'aprobacion'), cuerpoDe(p)), 422, 'propuesta_no_decidible', `aprobación: ${etiqueta}`);
        assert.deepStrictEqual(e.motivos, motivos, `${etiqueta}: motivos`);
        sinEfectos(antes, `422 ${etiqueta}`);
        fakeDb.lecturas.length = 0;
        const r = await post(ruta(p, 'rechazo'), cuerpoDe(p, { motivo: 'Datos incorrectos' }));
        assert.strictEqual(r.status, 200, `rechazo con ${etiqueta} (${r.body})`);
        assert.strictEqual(LLAMADAS.length, antes + 1, `rechazo con ${etiqueta}: llama al servicio`);
        assert.ok(!fakeDb.lecturas.some((l) => l.coleccion === 'destinos'), `rechazo con ${etiqueta}: no lee destinos`);
      }
      // Íntegra: aprobación pasa (y sí lee el destino).
      const ok = fakeDb.poner(propuesta());
      fakeDb.lecturas.length = 0;
      assert.strictEqual((await post(ruta(ok, 'aprobacion'), cuerpoDe(ok))).status, 200);
      assert.deepStrictEqual(fakeDb.lecturas.map((l) => l.coleccion), ['propuestas_cambio', 'destinos']);
      // 409 antes que 422: coordinación distinta e integridad rota → 409.
      const ambas = fakeDb.poner(propuesta({ alterarHash: true, extra: { version_coordinacion: 5 } }));
      error(await post(ruta(ambas, 'aprobacion'), cuerpoDe(ambas, { version_coordinacion_esperada: 4 })), 409, 'propuesta_cambio', '409 antes que 422');
      console.log(`5) ${casos.length} problemas de integridad: aprobación 422 con los mismos códigos que el lector y 0 llamadas; rechazo 200 sin leer destinos; íntegra → 200; 409 precede a 422: OK`);
    }

    // ============================================================
    // 6) Reenvío idéntico en la relectura previa
    // ============================================================
    {
      comportamiento = () => assert.fail('un reenvío reconocido en la relectura previa no llama al servicio');
      const caso = (tipo, { motivo, evento = {}, operador = OPERADOR_PANEL, detalle } = {}) => {
        const base = propuesta();
        const ev = eventoPanel(base, { tipo, operador, motivo, extra: evento, detalle });
        return { base, ev, p: fakeDb.poner(decidida(base, ev), ev) };
      };
      // Reconocidos → 200 ya_registrada con los datos del evento guardado.
      const a = caso('aprobacion');
      const ra = await post(ruta(a.p, 'aprobacion'), cuerpoDe(a.base));
      assert.strictEqual(ra.status, 200, ra.body);
      assert.deepStrictEqual(ra.json.decision, {
        tipo_evento: 'aprobacion',
        propuesta_id: a.base.propuesta_id,
        evento_id: a.ev.evento_id,
        estado_anterior: 'pendiente_aprobacion',
        estado_nuevo: 'aprobada',
        version_coordinacion_nueva: 1,
        ocurrido_en: '2026-10-04T20:00:00.000Z',
        actor: { tipo: 'humano', identificador: 'operador.panel' },
        ya_registrada: true
      });
      assert.deepStrictEqual(
        [REGISTROS.at(-1).evento, REGISTROS.at(-1).ya_registrada, REGISTROS.at(-1).reenvio_detectado_en, REGISTROS.at(-1).evento_id],
        ['panel_decision', true, 'relectura_previa', a.ev.evento_id]
      );
      const r = caso('rechazo', { motivo: 'Fuente desactualizada' });
      const rr = await post(ruta(r.p, 'rechazo'), cuerpoDe(r.base, { motivo: '  Fuente desactualizada\n' }));
      assert.deepStrictEqual([rr.status, rr.json.decision?.ya_registrada, rr.json.decision?.evento_id], [200, true, r.ev.evento_id], 'rechazo: motivo recortado igual');

      // No reconocidos → 409.
      const otroIo = (cambio) => ({ identidad_operador: { ...OPERADOR_PANEL.identidad_operador, ...cambio }, comando: { nombre: 'panel-propuestas', version: '1' } });
      const variantes = [
        ['otro operador', caso('aprobacion', { operador: SEGUNDO }), 'aprobacion'],
        ['mismo identificador, otro sub', caso('aprobacion', { detalle: otroIo({ sub: '1001' }) }), 'aprobacion'],
        ['mismo sub, otro identificador', caso('aprobacion', { evento: { actor: { tipo: 'humano', identificador: 'otro.nombre' } } }), 'aprobacion'],
        ['mismo identificador, otro método', caso('aprobacion', { detalle: otroIo({ metodo: 'connection_status' }) }), 'aprobacion'],
        ['origen CLI', caso('aprobacion', { detalle: { identidad_operador: { metodo: 'oidc_google', sub: '1000' }, comando: { nombre: 'decidir-propuesta', version: '1' } } }), 'aprobacion'],
        ['actor sistema', caso('aprobacion', { evento: { actor: { tipo: 'sistema', identificador: 'operador.panel' } } }), 'aprobacion'],
        ['aprobado y se pide rechazo', caso('aprobacion'), 'rechazo'],
        ['rechazado y se pide aprobación', caso('rechazo', { motivo: 'm' }), 'aprobacion'],
        ['otro motivo', caso('rechazo', { motivo: 'Otro motivo' }), 'rechazo'],
        ['evento sin identidad', caso('aprobacion', { detalle: { comando: { nombre: 'panel-propuestas', version: '1' } } }), 'aprobacion']
      ];
      for (const [etiqueta, c, tipo] of variantes) {
        error(await post(ruta(c.p, tipo), cuerpoDe(c.base, tipo === 'rechazo' ? { motivo: 'Fuente desactualizada' } : {})), 409, 'propuesta_cambio', etiqueta);
      }
      // Evento que no es el último de la propuesta (ya aplicada después).
      const ap = caso('aprobacion');
      fakeDb.poner({ ...ap.p, estado: 'aplicada', version_coordinacion: 2, ultimo_evento_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      error(await post(ruta(ap.p, 'aprobacion'), cuerpoDe(ap.base)), 409, 'propuesta_cambio', 'aprobación propia ya superada');
      // Mismo evento pero el body pide otra versión u otro hash.
      const v = caso('aprobacion');
      error(await post(ruta(v.p, 'aprobacion'), cuerpoDe(v.base, { version_coordinacion_esperada: 1 })), 409, 'propuesta_cambio', 'otra versión');
      error(await post(ruta(v.p, 'aprobacion'), cuerpoDe(v.base, { payload_hash_esperado: 'b'.repeat(64) })), 409, 'propuesta_cambio', 'otro hash');
      console.log(`6) relectura previa: reenvío idéntico (aprobación; rechazo con motivo recortado) → 200 ya_registrada sin llamar al servicio; ${variantes.length + 3} variantes (otro operador, otro sub, otro método, origen CLI, actor sistema, otro tipo, otro motivo, sin identidad, superada, otra versión, otro hash) → 409: OK`);
    }

    // ============================================================
    // 7) Reenvío tras cas_no_coincide
    // ============================================================
    {
      const casCon = (alPerder) => (entrada) => {
        alPerder(entrada);
        return { resultado: 'cas_no_coincide', escrito: false, propuesta_id: entrada.propuesta_id, esperado: {}, actual: {} };
      };
      // Ganó otra pestaña del MISMO operador con la misma decisión.
      const base = propuesta();
      fakeDb.poner(base);
      const ev = eventoPanel(base);
      comportamiento = casCon(() => fakeDb.poner(decidida(base, ev), ev));
      const r = await post(ruta(base, 'aprobacion'), cuerpoDe(base));
      assert.deepStrictEqual([r.status, r.json.decision?.ya_registrada, r.json.decision?.evento_id], [200, true, ev.evento_id], r.body);
      assert.strictEqual(REGISTROS.at(-1).reenvio_detectado_en, 'cas_no_coincide');
      // Ganó otro operador / otro sub / otra decisión → 409 con el estado nuevo.
      for (const [etiqueta, armar, tipo] of [
        ['otro operador', (b) => eventoPanel(b, { operador: SEGUNDO }), 'aprobacion'],
        ['otro sub', (b) => eventoPanel(b, { detalle: { identidad_operador: { metodo: 'oidc_google', sub: '1001', email: 'operador@example.com' }, comando: { nombre: 'panel-propuestas', version: '1' } } }), 'aprobacion'],
        ['rechazo ganó a la aprobación', (b) => eventoPanel(b, { tipo: 'rechazo', motivo: 'm' }), 'aprobacion']
      ]) {
        const b = fakeDb.poner(propuesta());
        const e2 = armar(b);
        comportamiento = casCon(() => fakeDb.poner(decidida(b, e2), e2));
        const err = error(await post(ruta(b, tipo), cuerpoDe(b)), 409, 'propuesta_cambio', `cas: ${etiqueta}`);
        assert.strictEqual(err.actual.estado, e2.estado_nuevo);
      }
      // Tras el CAS, lo visto sigue vigente pero apareció una decisión previa → 422.
      const conPrevia = fakeDb.poner(propuesta());
      comportamiento = casCon(() => fakeDb.poner({ ...conPrevia, decision_aprobacion_id: '4db810fc-d491-4166-82d1-8b88fe9b088d' }));
      const e422 = error(await post(ruta(conPrevia, 'rechazo'), cuerpoDe(conPrevia, { motivo: 'm' })), 422, 'propuesta_no_decidible', 'cas: decisión previa');
      assert.deepStrictEqual(e422.motivos, ['decision_previa_existente']);
      // Tras el CAS todo coincide (cambió y volvió) → 409.
      const igual = fakeDb.poner(propuesta());
      comportamiento = casCon(() => {});
      error(await post(ruta(igual, 'aprobacion'), cuerpoDe(igual)), 409, 'propuesta_cambio', 'cas: todo coincide después');
      // La propuesta desapareció entre el CAS y la relectura → 404.
      const borrada = fakeDb.poner(propuesta());
      comportamiento = casCon(() => fakeDb.quitar(borrada.propuesta_id));
      error(await post(ruta(borrada, 'aprobacion'), cuerpoDe(borrada)), 404, 'no_encontrado', 'borrada tras el CAS');
      console.log('7) cas_no_coincide: misma decisión del mismo operador → 200 ya_registrada; otro operador, otro sub u otra decisión → 409 con el estado nuevo; decisión previa con lo visto vigente → 422; todo coincide después → 409; propuesta ausente → 404: OK');
    }

    // ============================================================
    // 8) Traducción de errores del servicio (fake)
    // ============================================================
    {
      const conEtiqueta = (nombre, etiqueta) => {
        const e = new Error(`${nombre} simulado`);
        e.name = nombre;
        e.hasErrorLabel = (l) => l === etiqueta;
        return e;
      };
      const casos = [
        ['ErrorPrecondicionIndices', () => new ErrorPrecondicionIndices('falta eventos_propuesta.evento_id_1'), 503, 'no_disponible', 'indices'],
        ['ErrorInconsistencia', () => new S.ErrorInconsistencia('rastro parcial'), 500, 'error_interno', 'error_interno'],
        ['ErrorEntradaInvalida', () => new S.ErrorEntradaInvalida('decidirPropuesta: campos no admitidos'), 500, 'error_interno', 'servicio_entrada_invalida'],
        ['ErrorTransicionInvalida', () => new S.ErrorTransicionInvalida('transición no permitida'), 500, 'error_interno', 'servicio_transicion_invalida'],
        ['TypeError de identidad', () => new TypeError('decidirPropuesta: resolución de identidad inválida'), 500, 'error_interno', 'error_interno'],
        ['transitorio revertido', () => conEtiqueta('MongoServerError', 'TransientTransactionError'), 503, 'no_disponible', 'transaccion_revertida'],
        ['commit desconocido revertido', () => conEtiqueta('MongoServerError', 'UnknownTransactionCommitResult'), 503, 'no_disponible', 'transaccion_revertida'],
        ['red', () => Object.assign(new Error('socket cerrado'), { name: 'MongoNetworkError' }), 503, 'no_disponible', 'transaccion_revertida'],
        ['incierto', () => new Error(`WriteConflict (falló también la relectura de confirmación (timeout); ${D.MARCA_INCIERTO}, verificar a mano el evento x)`), 500, 'resultado_incierto', 'resultado_incierto'],
        ['error con status 4xx', () => Object.assign(new Error('raro'), { status: 404 }), 400, 'solicitud_invalida', 'solicitud_invalida']
      ];
      for (const [etiqueta, crear, status, codigo, motivo] of casos) {
        const p = fakeDb.poner(propuesta());
        comportamiento = () => {
          throw crear();
        };
        error(await post(ruta(p, 'aprobacion'), cuerpoDe(p)), status, codigo, etiqueta);
        const reg = REGISTROS.at(-1);
        assert.deepStrictEqual([reg.status, reg.codigo, reg.motivo], [status, codigo, motivo], `${etiqueta}: registro`);
        if (status >= 500) {
          assert.strictEqual(reg.nivel, 'error', `${etiqueta}: registrado como error`);
          assert.match(reg.error, /simulado|rastro|campos no admitidos|transición|identidad|socket|INCIERTO|falta/, `${etiqueta}: el registro trae el error original`);
        }
      }
      const p = fakeDb.poner(propuesta());
      comportamiento = () => ({ resultado: 'otro' });
      error(await post(ruta(p, 'aprobacion'), cuerpoDe(p)), 500, 'error_interno', 'resultado desconocido');
      conDb = false;
      error(await post(ruta(p, 'aprobacion'), cuerpoDe(p)), 503, 'no_disponible', 'sin Mongo');
      conDb = true;
      console.log(`8) ${casos.length + 2} errores del servicio: índices/transitorio/red/sin Mongo → 503; inconsistencia, ErrorEntradaInvalida, ErrorTransicionInvalida, TypeError y resultado desconocido → 500 error_interno registrado con el error original; incierto → 500 resultado_incierto: OK`);
    }

    // ============================================================
    // 9) decidirPropuesta REAL con dependencias falsas
    // ============================================================
    {
      const INSERTADOS = [];
      let falla = null;
      const depsReales = () => ({
        ...S.crearDependenciasMongoose({ db: null }, { operadoresJson: null }),
        uuid: () => '77777777-7777-4777-8777-777777777777',
        ahora: () => new Date('2026-10-04T22:00:00.000Z'),
        verificarIndices: async () => {},
        ejecutarTransaccion: async (fn) => {
          if (falla) throw falla;
          return fn({ sesion: 'falsa' });
        },
        actualizarPropuestaCas: async () => ({ matchedCount: 1, modifiedCount: 1 }),
        insertarEvento: async (doc) => INSERTADOS.push(doc),
        leerPropuesta: async () => {
          throw new Error('relectura caída');
        },
        leerEvento: async () => null
      });
      decisionesActivas = D.crearDecisionesPropuestas({ obtenerDb: () => fakeDb.db, dependencias: depsReales });
      const p = fakeDb.poner(propuesta());
      const r = await post(ruta(p, 'rechazo'), cuerpoDe(p, { motivo: '  Duplicada  ' }));
      assert.strictEqual(r.status, 200, r.body);
      const ev = INSERTADOS[0];
      assert.deepStrictEqual(ev.actor, { tipo: 'humano', identificador: 'operador.panel' });
      assert.deepStrictEqual(ev.detalle, { identidad_operador: { metodo: 'oidc_google', sub: '1000', email: 'operador@example.com' }, comando: { nombre: 'panel-propuestas', version: '1' } });
      assert.strictEqual(ev.motivo, 'Duplicada');
      assert.ok(!r.body.includes('oidc_google') && !r.body.includes('"sub"'), 'la respuesta no trae identidad_operador');
      // Commit ambiguo + relectura caída → el servicio real marca INCIERTO → 500 resultado_incierto.
      falla = Object.assign(new Error('commit ambiguo'), { name: 'MongoServerError' });
      const p2 = fakeDb.poner(propuesta());
      error(await post(ruta(p2, 'aprobacion'), cuerpoDe(p2)), 500, 'resultado_incierto', 'servicio real: incierto');
      assert.match(REGISTROS.at(-1).error, /INCIERTO/);
      decisionesActivas = D.crearDecisionesPropuestas({ obtenerDb: () => fakeDb.db, decidir: decidirFalso, dependencias: () => BASE_DEPS });
      console.log('9) decidirPropuesta real: el evento lleva actor, identidad OIDC (metodo, sub, email) y comando panel-propuestas, motivo recortado; la respuesta no; commit ambiguo con relectura caída → 500 resultado_incierto: OK');
    }

    // ============================================================
    // 10) Ninguna respuesta con datos privados; registros saneados
    // ============================================================
    {
      for (const r of RESPUESTAS) for (const x of PROHIBIDOS) assert.ok(!r.body.includes(x), `${r.ruta} (${r.status}) contiene ${JSON.stringify(x)}`);
      for (const e of REGISTROS) assert.ok(!/eyJ|mongodb:\/\/|"sub"|operador@example/.test(JSON.stringify(e)), `registro sin tokens, URIs ni identidad: ${JSON.stringify(e).slice(0, 200)}`);
      const statuses = [...new Set(RESPUESTAS.map((r) => r.status))].sort();
      console.log(`10) ${RESPUESTAS.length} respuestas (${statuses.join(', ')}): sin sub, email, identidad_operador, payload, HTML, URIs ni tokens; ${REGISTROS.length} registros sin identidad privada: OK`);
    }

    // ============================================================
    // 11) esReenvioIdentico (pura): cada guarda por separado
    // ============================================================
    {
      const base = propuesta();
      const ev = eventoPanel(base);
      const p = decidida(base, ev);
      const entrada = D.construirEntrada('aprobacion', base.propuesta_id, cuerpoDe(base));
      assert.strictEqual(D.esReenvioIdentico(entrada, OPERADOR_PANEL, p, ev), true, 'caso base reconocido');
      const io = ev.detalle.identidad_operador;
      const perturbaciones = [
        ['evento que no es el último', { p: { ultimo_evento_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }],
        ['propuesta en otro estado', { p: { estado: 'aplicada' } }],
        ['propuesta en otra versión', { p: { version_coordinacion: 2 } }],
        ['propuesta con otro hash', { p: { payload_hash: 'c'.repeat(64) } }],
        ['propuesta con otra decisión', { p: { decision_aprobacion_id: null } }],
        ['evento de otra propuesta', { ev: { propuesta_id: '33333333-3333-4333-8333-333333333333' } }],
        ['otro tipo con la misma transición', { ev: { tipo_evento: 'rechazo' } }],
        ['otro estado anterior', { ev: { estado_anterior: 'revision_requerida' } }],
        ['otro estado nuevo', { ev: { estado_nuevo: 'rechazada' }, p: { estado: 'rechazada' } }],
        ['otro hash en el evento', { ev: { hash_contenido_referenciado: 'c'.repeat(64) }, p: { payload_hash: 'c'.repeat(64) } }],
        ['otra versión en el evento', { ev: { version_coordinacion_nueva: 2 }, p: { version_coordinacion: 2 } }],
        ['con motivo', { ev: { motivo: 'x' } }],
        ['actor sistema', { ev: { actor: { tipo: 'sistema', identificador: 'operador.panel' } } }],
        ['otro identificador', { ev: { actor: { tipo: 'humano', identificador: 'otro' } } }],
        ['origen CLI', { ev: { detalle: { ...ev.detalle, comando: { nombre: 'decidir-propuesta', version: '1' } } } }],
        ['otro método', { ev: { detalle: { ...ev.detalle, identidad_operador: { ...io, metodo: 'connection_status' } } } }],
        ['otro sub', { ev: { detalle: { ...ev.detalle, identidad_operador: { ...io, sub: '1001' } } } }],
        ['sin evento', { ev: null }],
        ['sin propuesta', { p: null }]
      ];
      for (const [etiqueta, cambio] of perturbaciones) {
        const p2 = cambio.p === null ? null : { ...p, ...(cambio.p ?? {}) };
        const ev2 = cambio.ev === null ? null : { ...ev, ...(cambio.ev ?? {}) };
        assert.strictEqual(D.esReenvioIdentico(entrada, OPERADOR_PANEL, p2, ev2), false, etiqueta);
      }
      // El email NO participa (puede cambiar en Google sin cambiar el sub).
      const otroEmail = { ...ev, detalle: { ...ev.detalle, identidad_operador: { ...io, email: 'nuevo@example.com' } } };
      assert.strictEqual(D.esReenvioIdentico(entrada, OPERADOR_PANEL, p, otroEmail), true, 'otro email, mismo sub');
      console.log(`11) esReenvioIdentico: caso base reconocido; ${perturbaciones.length} perturbaciones de una sola guarda → no reconocido; el email no participa: OK`);
    }

    console.log('\nTODAS LAS PRUEBAS DE DECISIONES DEL PANEL OK (sin Mongo, solo 127.0.0.1)');
  } finally {
    await new Promise((r) => servidor.close(r));
  }
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
