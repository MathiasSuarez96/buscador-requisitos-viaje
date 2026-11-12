// H3.3: flujo interno de aplicación 2.0 con el adaptador de CheckMig, contra Mongo efímero
// (replica set) y con la ficha simulada (fetch inyectado). Nada toca Atlas ni la red.
// El proceso solo sale con 0 después de la última aserción (exitCode = 1 por defecto).
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const crypto = require('node:crypto');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');
const Destino = require('../models/Destino.model');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const O = require('../services/propuestas/orquestar-aplicacion-v2');
const { crearPersistenciaV2 } = require('../services/propuestas/persistencia-aplicacion-v2');
const D = require('../services/propuestas/decidir-propuesta');
const { ErrorActorNoAutorizado } = require('../services/propuestas/operadores-autorizados');
const { crearSobreRequisitoV2, hashHechos, ALGORITMO_HECHOS_HASH } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');

const T0 = new Date('2026-11-12T02:00:00.000Z').getTime();
const MIN = 60_000;
let reloj = T0;
const ahora = () => new Date(reloj);
const uuid = () => crypto.randomUUID();
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const fixture = n => readFileSync(path.join(__dirname, 'fixtures', 'checkmig', n), 'utf8').replace(/\r\n/g, '\n');
const VALIDA = fixture('valida.html'), CAMBIO = fixture('cambio.html'), AMBIGUA = fixture('ambigua.html');
// Mismos hechos que cambio.html con otro HTML (el hash del HTML es solo diagnóstico).
const CAMBIO_OTRO_HTML = CAMBIO.replace('class="frame-inner"', 'class="frame-inner otro"').replace('</main>', '\n\n</main>');
const CAMBIO_OTROS_HECHOS = CAMBIO.replace('48 horas', '24 horas');
const html200 = cuerpo => new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const HECHOS_FICHA = { esquema: 'checkmig-hechos-v1', obligatoriedad: 'no_obligatorio',
  alcance: { viajeros: ['extranjeros', 'nacionales'], sentidos: ['ingreso', 'salida'] }, ventana_horas_antes: { maximo_horas_antes: 72, minimo_horas_antes: 1 } };
const HASH_FICHA = hashHechos(HECHOS_FICHA);
const HASH_CAMBIO = '99c64dfa4ddffc9c93d77e0f0fd4376928227f9f4016f41bdf004d770f568014';
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
// Piloto SINTÉTICO: la fuente es la ficha informativa (URL exacta); el link del requisito sigue
// siendo el formulario que abre el viajero.
const LINK_FORMULARIO = 'https://apps.migracioncolombia.gov.co/check-mig/';
const FUENTE_FICHA = { nombre: 'Migración Colombia', url: URL_FICHA, capturado_en: '2026-11-12T01:37:02.406Z',
  hechos: HECHOS_FICHA, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: HASH_FICHA };
const checkmig = id => ({ _id: id, tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'si', descripcion: 'Formulario previo al viaje',
  fuente: 'Migración Colombia', link: LINK_FORMULARIO, estado: 'confirmado', fecha_verificacion: '2026-08-18' });

(async () => {
  let rs;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    const uri = rs.getUri('buscador_requisitos');
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    const indices = [...INDICES_APLICACION, V2.INDICE_TRANSVERSAL];
    for (const s of indices) await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
    const listados = async () => Object.fromEntries(await Promise.all([...new Set(indices.map(s => s.coleccion))].map(async c => [c, await col(c).indexes()])));
    const P = crearPersistenciaV2();

    // ---- Siembra: propuesta 2.0 aprobada con las funciones reales de la decisión ----
    async function sembrar({ fuentes = [FUENTE_FICHA] } = {}) {
      const destinoId = new ObjectId(), requisitoId = new ObjectId(), objetivo = checkmig(requisitoId);
      await col('destinos').insertOne({ _id: destinoId, pais: `Colombia-${destinoId}`, codigo_iso: String(destinoId).slice(-6), requisitos: [objetivo], updatedAt: new Date('2026-08-18T12:00:00Z') });
      const propuestaId = uuid();
      const sobre = crearSobreRequisitoV2({ fecha_propuesta: '2026-11-12T01:50:00.000Z', destino_id: String(destinoId), requisito_id: String(requisitoId),
        run_id_origen: uuid(), propuesta_id: propuestaId, ...capturarIdentidadEInstantanea(objetivo),
        cambios: [{ campo: 'obligatorio', propuesto: valor('no') }], fuentes, advertencias: ['quita_obligatoriedad'] });
      await col('propuestas_cambio').insertOne({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'requisito',
        algoritmo_canonicalizacion: sobre.algoritmo_canonicalizacion, algoritmo_hash: sobre.algoritmo_hash, payload: sobre.payload, payload_hash: sobre.payload_hash,
        run_id_origen: sobre.payload.run_id_origen, estado: 'pendiente_aprobacion', version_coordinacion: 0, decision_aprobacion_id: null, ultimo_evento_id: null });
      const e = D.validarEntrada({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: sobre.payload_hash,
        version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null, version_contrato_esperada: '2.0', advertencias_aceptadas: [...sobre.payload.advertencias] });
      const eventoId = uuid(), enAprobacion = new Date('2026-11-12T01:55:00.000Z');
      assert.equal((await col('propuestas_cambio').updateOne(D.construirFiltroCas(e), D.construirUpdateCas(e, eventoId, enAprobacion))).matchedCount, 1, 'aprobación real');
      await col('eventos_propuesta').insertOne(D.construirEvento(e, eventoId, enAprobacion, { actor: { tipo: 'humano', identificador: 'mathias-aprobador' },
        identidad_operador: { metodo: 'oidc_google', sub: 'sub-aprobador' }, comando: { nombre: 'panel-propuestas', version: '1' } }));
      const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: sobre.payload_hash, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: eventoId };
      return { destinoId, requisitoId, propuestaId, entrada, destinoAntes: JSON.stringify(await col('destinos').findOne({ _id: destinoId })) };
    }

    const PANEL = () => ({ origen: 'panel', request_id: uuid(), operador: { identificador: 'mathias-aplicador', permisos: ['ver', 'decidir', 'aplicar'],
      identidad_operador: { metodo: 'oidc_google', sub: 'sub-aplicador', email: 'aplicador@example.com' } } });
    const OPERADORES = Object.freeze([Object.freeze({ usuario_atlas: 'operador-local', db: 'admin', identificador: 'operador.local' })]);
    const COMANDO = (user = 'operador-local') => ({ origen: 'comando_administrativo', usuarios_autenticados: [{ user, db: 'admin' }], operadores_autorizados: OPERADORES });

    // Corre el flujo con una cola de respuestas de la ficha. Registra el orden inicio → consulta y
    // comprueba en cada consulta que el inicio ya está persistido.
    async function correr(c, respuestas, { credencial = PANEL(), alterar = () => ({}) } = {}) {
      const orden = [], llamadas = [];
      const cola = [...respuestas];
      const base = {
        ahora, uuid,
        verificarIndices: async () => V2.verificarIndicesV2(await listados()),
        ejecutarTransaccion: fn => conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
        leerPropuesta: (id, s) => col('propuestas_cambio').findOne({ propuesta_id: id }, s ? { session: s } : {}),
        leerEvento: (id, s) => col('eventos_propuesta').findOne({ evento_id: id }, s ? { session: s } : {}),
        ...P,
        insertarInicio: async doc => { orden.push('inicio'); await P.insertarInicio(doc); },
        ...V2.dependenciasDestino(Destino.collection),
        actualizarPropuestaCas: (f, u, s) => col('propuestas_cambio').updateOne(f, u, { session: s }),
        fetch: async (u, o) => {
          orden.push('consulta');
          llamadas.push({ u, inicioPersistido: (await col('inicios_intento_aplicacion').countDocuments({ propuesta_id: c.propuestaId })) === 1 });
          const siguiente = cola.shift();
          if (typeof siguiente === 'function') return siguiente(u, o);
          return siguiente;
        }
      };
      const deps = { ...base, ...alterar(base) };
      // Un rechazo se vuelve un resultado comparable: donde se espera un resultado, falla por aserción.
      try { return { r: await O.aplicarConRevalidacionV2(c.entrada, credencial, deps), error: null, orden, llamadas }; }
      catch (error) { return { r: { resultado: `rechazo:${error?.constructor?.name}`, mensaje: String(error?.message).slice(0, 200) }, error, orden, llamadas }; }
    }

    // Lo persistido para la propuesta: un inicio, un intento y (si hubo transición) un evento, con el mismo intento_id.
    async function persistido(c) {
      const inicios = await col('inicios_intento_aplicacion').find({ propuesta_id: c.propuestaId }).toArray();
      const intentos = await col('intentos_aplicacion').find({ propuesta_id: c.propuestaId }).toArray();
      const eventos = await col('eventos_propuesta').find({ propuesta_id: c.propuestaId, tipo_evento: { $ne: 'aprobacion' } }).toArray();
      const propuesta = await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId });
      const destino = JSON.stringify(await col('destinos').findOne({ _id: c.destinoId }));
      const historial = await col('historial_cambios').countDocuments({ propuesta_id: c.propuestaId });
      return { inicios, intentos, eventos, propuesta, destino, historial };
    }
    function mismoIntento(p, r) {
      assert.equal(p.inicios.length, 1, 'un inicio');
      assert.equal(p.intentos.length, 1, 'un intento terminado');
      const id = p.inicios[0].intento_id;
      assert.equal(p.intentos[0].intento_id, id, 'el intento cierra con el mismo intento_id');
      assert.equal(r.intento_id, id, 'el resultado informa el mismo intento_id');
      for (const ev of p.eventos) assert.equal(ev.intento_aplicacion_id, id, 'el evento referencia el mismo intento');
      assert.equal(p.intentos[0].iniciado_en.getTime(), p.inicios[0].iniciado_en.getTime(), 'mismo iniciado_en');
      return p.intentos[0];
    }
    const sinEscrituraEnDestino = (c, p, msg) => assert.equal(p.destino, c.destinoAntes, msg);
    const inicioAntesDeConsultar = (x, consultas) => {
      assert.deepEqual(x.orden, ['inicio', ...Array(consultas).fill('consulta')], 'orden inicio → consulta');
      assert.ok(x.llamadas.every(l => l.inicioPersistido && l.u === URL_FICHA), 'cada consulta, a la ficha y con el inicio ya persistido');
    };

    // ---- 1. Éxito con aprobación: los hechos vigentes coinciden con los aprobados ----
    {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(VALIDA)]);
      assert.equal(x.r.resultado, 'exito', JSON.stringify(x.r));
      inicioAntesDeConsultar(x, 1);
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      assert.equal(p.propuesta.estado, 'aplicada');
      assert.deepEqual(p.eventos.map(e => e.tipo_evento), ['aplicacion']);
      assert.equal(p.historial, 1);
      const req = JSON.parse(p.destino).requisitos[0];
      assert.equal(req.obligatorio, 'no', 'el núcleo escribió el destino');
      assert.equal(req.link, LINK_FORMULARIO, 'el link al formulario no cambia');
      assert.deepEqual(i.revalidaciones.map(r => [r.url, r.hechos_hash]), [[URL_FICHA, HASH_FICHA]]);
      assert.equal(i.lecturas_fuente, undefined, 'el éxito se resume en revalidaciones');
      assert.equal(x.r.lecturas, 1);
    }

    // ---- 2. Lectura ambigua: revisión humana, campos sin confirmar y evidencia ----
    {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(AMBIGUA)]);
      assert.equal(x.r.resultado, 'extraccion_ambigua', JSON.stringify(x.r));
      inicioAntesDeConsultar(x, 1);
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, 'ambigua: destino intacto');
      assert.equal(p.historial, 0);
      assert.equal(p.propuesta.estado, 'revision_requerida', 'la propuesta queda para revisión');
      assert.deepEqual(p.eventos.map(e => e.tipo_evento), ['entrada_revision']);
      assert.match(p.eventos[0].motivo, /obligatoriedad:no_atribuible/);
      assert.deepEqual([i.etapa_fallo, i.revalidaciones], ['revalidacion_externa', undefined]);
      const [l] = i.lecturas_fuente;
      assert.deepEqual(l.campos_sin_confirmar, [{ campo: 'obligatoriedad', motivo: 'no_atribuible' }, { campo: 'alcance', motivo: 'sin_evidencia' }, { campo: 'ventana_horas_antes', motivo: 'sin_evidencia' }]);
      assert.equal(l.evidencia.obligatoriedad.length, 2, 'evidencia breve para revisar la ficha');
      assert.ok(l.evidencia.obligatoriedad.every(t => t.length <= 240));
      assert.deepEqual([l.tipo, l.url, l.contenido_sha256, l.hechos_hash], ['ambiguo', URL_FICHA, sha256(AMBIGUA), undefined]);
      assert.equal(l.revalidada_en.getTime(), T0);
    }

    // ---- 3. Fuente no disponible: código cerrado, propuesta aprobada y sin escrituras ----
    for (const [nombre, respuesta, codigo, status, credencial] of [
      ['HTTP 503 (panel)', new Response('x', { status: 503, headers: { 'content-type': 'text/html' } }), 'http', 503, PANEL()],
      ['red (comando)', () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }, 'red', undefined, COMANDO()]
    ]) {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [respuesta], { credencial });
      assert.equal(x.r.resultado, 'fuente_temporalmente_no_disponible', `${nombre}: ${JSON.stringify(x.r)}`);
      inicioAntesDeConsultar(x, 1);
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, `${nombre}: destino intacto`);
      assert.deepEqual([p.propuesta.estado, p.propuesta.version_coordinacion, p.eventos.length], ['aprobada', 1, 0], `${nombre}: la propuesta se conserva aprobada`);
      const [l] = i.lecturas_fuente;
      assert.deepEqual([l.tipo, l.codigo_fallo, l.http_status, l.revalidada_en, l.evidencia], ['no_disponible', codigo, status, undefined, undefined], nombre);
      assert.equal(i.auditoria.origen, credencial.origen, `${nombre}: auditoría del aplicador`);
    }

    // ---- 4. Cambio confirmado por dos lecturas vigentes: fuente_cambio y obsoleta ----
    {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(CAMBIO), html200(CAMBIO_OTRO_HTML)]);
      assert.equal(x.r.resultado, 'fuente_cambio', JSON.stringify(x.r));
      inicioAntesDeConsultar(x, 2);
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, 'cambio: destino intacto');
      assert.equal(p.historial, 0);
      assert.equal(p.propuesta.estado, 'obsoleta');
      assert.deepEqual(p.eventos.map(e => e.tipo_evento), ['obsolescencia']);
      assert.deepEqual(i.lecturas_fuente.map(l => [l.orden, l.tipo, l.hechos_hash]), [[1, 'hechos', HASH_CAMBIO], [2, 'hechos', HASH_CAMBIO]]);
      // El hash del HTML difiere (solo diagnóstico): no decide nada.
      assert.deepEqual(i.lecturas_fuente.map(l => l.contenido_sha256), [sha256(CAMBIO), sha256(CAMBIO_OTRO_HTML)]);
      assert.deepEqual(i.revalidaciones.map(r => [r.url, r.hechos_hash]), [[URL_FICHA, HASH_CAMBIO]]);
      assert.equal(x.r.lecturas, 2);
    }

    // ---- 5. La segunda lectura no confirma: la propuesta se conserva para revisión ----
    for (const [nombre, segunda, resultado, estado, motivo] of [
      ['vuelve a los hechos aprobados', html200(VALIDA), 'extraccion_ambigua', 'revision_requerida', /^cambio_no_confirmado/],
      ['otros hechos nuevos', html200(CAMBIO_OTROS_HECHOS), 'extraccion_ambigua', 'revision_requerida', /^cambio_no_confirmado/],
      ['segunda lectura ambigua', html200(AMBIGUA), 'extraccion_ambigua', 'revision_requerida', /segunda lectura es ambigua/],
      ['segunda lectura falla', new Response('x', { status: 500, headers: { 'content-type': 'text/html' } }), 'fuente_temporalmente_no_disponible', 'aprobada', /segunda lectura falló/]
    ]) {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(CAMBIO), segunda]);
      assert.equal(x.r.resultado, resultado, `${nombre}: ${JSON.stringify(x.r)}`);
      inicioAntesDeConsultar(x, 2);
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, `${nombre}: destino intacto`);
      assert.equal(p.propuesta.estado, estado, `${nombre}: nunca obsoleta`);
      assert.match(i.error_mensaje, motivo, nombre);
      assert.equal(i.lecturas_fuente.length, 2, `${nombre}: las dos lecturas quedan registradas`);
      assert.equal(i.revalidaciones, undefined, `${nombre}: sin revalidación confirmada`);
    }
    // Las dos lecturas confirman el cambio pero la primera ya no está vigente al registrar.
    {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(CAMBIO), () => { reloj += 16 * MIN; return html200(CAMBIO); }]);
      assert.equal(x.r.resultado, 'revalidacion_vencida', JSON.stringify(x.r));
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, 'vencida: destino intacto');
      assert.deepEqual([p.propuesta.estado, p.eventos.length], ['aprobada', 0], 'una revalidación vencida no vuelve obsoleta la propuesta');
      assert.equal(i.lecturas_fuente.length, 2);
    }
    // La lectura coincide con lo aprobado, pero vence antes de que el núcleo escriba.
    {
      reloj = T0;
      const c = await sembrar();
      let saltar = false;
      const x = await correr(c, [() => { saltar = true; return html200(VALIDA); }], {
        alterar: b => ({ leerPropuesta: async (id, s) => { if (saltar && !s) { saltar = false; reloj += 16 * MIN; } return b.leerPropuesta(id, s); } })
      });
      assert.equal(x.r.resultado, 'revalidacion_vencida', JSON.stringify(x.r));
      const p = await persistido(c);
      mismoIntento(p, x.r);
      sinEscrituraEnDestino(c, p, 'vencida en el núcleo: destino intacto');
      assert.equal(p.propuesta.estado, 'aprobada');
    }

    // ---- 6. Incompatible: código cerrado, sin inicio, sin consulta y sin escrituras ----
    const hechosPagina = { visa: false };
    const otra = url => ({ nombre: 'Migración Colombia', url, capturado_en: '2026-10-15T20:29:00.000Z', hechos: hechosPagina, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechosPagina) });
    for (const [nombre, fuentes, codigo] of [
      ['dos fuentes', [otra('https://www.migracioncolombia.gov.co/pagina-a'), otra('https://www.migracioncolombia.gov.co/pagina-b')], 'varias_fuentes'],
      ['URL del formulario como fuente', [{ ...FUENTE_FICHA, url: LINK_FORMULARIO }], 'fuente_no_soportada']
    ]) {
      reloj = T0;
      const c = await sembrar({ fuentes });
      const x = await correr(c, [html200(VALIDA)]);
      assert.deepEqual([x.r.resultado, x.r.codigo, x.r.intento_id], ['adaptador_incompatible', codigo, null], nombre);
      assert.deepEqual([x.orden, x.llamadas.length], [[], 0], `${nombre}: sin inicio ni consulta`);
      const p = await persistido(c);
      assert.deepEqual([p.inicios.length, p.intentos.length, p.eventos.length, p.propuesta.estado], [0, 0, 0, 'aprobada'], `${nombre}: nada escrito`);
      sinEscrituraEnDestino(c, p, nombre);
    }

    // ---- 7. Permiso: sin permiso no se inicia, no se consulta ni se escribe ----
    for (const [nombre, credencial, esperado] of [
      ['panel sin permiso aplicar', { ...PANEL(), operador: { ...PANEL().operador, permisos: ['ver', 'decidir'] } }, e => e instanceof O.ErrorPermisoAplicacionV2 && e.codigo === 'permiso_ausente'],
      ['panel sin request_id', { ...PANEL(), request_id: 'no-uuid' }, e => e instanceof O.ErrorPermisoAplicacionV2 && e.codigo === 'identidad_incompleta'],
      ['comando fuera de la allowlist', COMANDO('otro-usuario'), e => e instanceof ErrorActorNoAutorizado],
      ['sin credencial', null, e => e instanceof O.ErrorPermisoAplicacionV2 && e.codigo === 'credencial_ausente']
    ]) {
      reloj = T0;
      const c = await sembrar();
      const orden = [];
      const x = await correr(c, [html200(VALIDA)], { credencial, alterar: b => ({ verificarIndices: async () => { orden.push('indices'); return b.verificarIndices(); } }) });
      assert.ok(x.error && esperado(x.error), `${nombre}: ${x.r.resultado}`);
      assert.deepEqual([x.orden, x.llamadas.length], [[], 0], `${nombre}: sin inicio ni consulta`);
      const p = await persistido(c);
      assert.deepEqual([orden.length, p.inicios.length, p.intentos.length, p.propuesta.estado], [0, 0, 0, 'aprobada'], `${nombre}: rechazo antes de leer nada`);
    }

    // ---- 8. Aprobación no vigente: el intento cierra como no aplicable, sin consultar ----
    {
      reloj = T0;
      const c = await sembrar();
      c.entrada = { ...c.entrada, version_coordinacion_esperada: 0 };
      const x = await correr(c, [html200(VALIDA)]);
      assert.equal(x.r.resultado, 'propuesta_no_aplicable', JSON.stringify(x.r));
      assert.deepEqual([x.orden, x.llamadas.length], [['inicio'], 0], 'inicio sí, consulta no');
      const p = await persistido(c);
      const i = mismoIntento(p, x.r);
      assert.equal(i.etapa_fallo, 'precondiciones_propuesta');
      sinEscrituraEnDestino(c, p, 'no aplicable: destino intacto');
    }

    // ---- 9. Inicio no confirmable: no se consulta la fuente ----
    {
      reloj = T0;
      const c = await sembrar();
      const x = await correr(c, [html200(VALIDA)], { alterar: () => ({
        insertarInicio: async () => { throw new Error('caída al insertar'); }, leerInicio: async () => { throw new Error('caída al releer'); } }) });
      assert.ok(x.error instanceof V2.ErrorInicioInciertoV2, x.r.resultado);
      assert.equal(x.llamadas.length, 0, 'sin inicio confirmado no se consulta la fuente');
      const p = await persistido(c);
      assert.deepEqual([p.inicios.length, p.intentos.length], [0, 0]);
      assert.equal(await col('propuestas_cambio').countDocuments({ propuesta_id: c.propuestaId, estado: 'aprobada' }), 1);
    }

    // ---- 10. Modelo: lecturas coherentes con el resultado ----
    const intentoDe = async resultado => { const { _id, __v, ...d } = await col('intentos_aplicacion').findOne({ resultado }); return d; };
    const rechaza = async (nombre, base, cambiar, motivo) => {
      const d = structuredClone(await intentoDe(base)); cambiar(d);
      await assert.rejects(P.validarIntento(d), e => motivo.test(String(e?.message)), `modelo: ${nombre}`);
    };
    for (const r of ['exito', 'extraccion_ambigua', 'fuente_temporalmente_no_disponible', 'fuente_cambio', 'revalidacion_vencida']) await P.validarIntento(await intentoDe(r));
    await rechaza('fuente_cambio con una lectura', 'fuente_cambio', d => { d.lecturas_fuente = d.lecturas_fuente.slice(0, 1); }, /dos lecturas con los mismos hechos/);
    await rechaza('fuente_cambio con hechos distintos', 'fuente_cambio', d => { d.lecturas_fuente[1].hechos_hash = 'a'.repeat(64); }, /dos lecturas con los mismos hechos/);
    await rechaza('fuente_cambio sin revalidaciones', 'fuente_cambio', d => { delete d.revalidaciones; }, /revalidaciones/);
    await rechaza('ambigua con revalidaciones', 'extraccion_ambigua', d => { d.revalidaciones = [{ url: URL_FICHA, fuente_nombre: 'Migración Colombia', hechos_hash: HASH_FICHA, revalidada_en: ahora() }]; }, /no admite revalidaciones/);
    await rechaza('ambigua sin campos sin confirmar', 'extraccion_ambigua', d => { delete d.lecturas_fuente[0].campos_sin_confirmar; }, /qué campo quedó sin confirmar/);
    await rechaza('ambigua con motivo fuera de lista', 'extraccion_ambigua', d => { d.lecturas_fuente[0].campos_sin_confirmar[0].motivo = 'otro'; }, /lista cerrada/);
    await rechaza('ambigua con evidencia larga', 'extraccion_ambigua', d => { d.lecturas_fuente[0].evidencia.obligatoriedad = ['x'.repeat(241)]; }, /lista breve de textos/);
    await rechaza('ambigua sin lecturas', 'extraccion_ambigua', d => { delete d.lecturas_fuente; }, /exige lecturas_fuente/);
    await rechaza('fallo con código abierto', 'fuente_temporalmente_no_disponible', d => { d.lecturas_fuente[d.lecturas_fuente.length - 1].codigo_fallo = 'ECONNRESET'; }, /código cerrado/);
    await rechaza('fallo con revalidada_en', 'fuente_temporalmente_no_disponible', d => { d.lecturas_fuente[d.lecturas_fuente.length - 1].revalidada_en = ahora(); }, /revalidada_en solo y siempre/);
    await rechaza('éxito con lecturas', 'exito', d => { d.lecturas_fuente = [{ orden: 1, tipo: 'hechos', url: URL_FICHA, fuente_nombre: 'Migración Colombia', consultado_en: ahora(), revalidada_en: ahora(), hechos_hash: HASH_FICHA, evidencia: {} }]; }, /no admite lecturas_fuente/);
    await rechaza('lectura con orden incorrecto', 'fuente_cambio', d => { d.lecturas_fuente[0].orden = 2; }, /orden debe ser 1/);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Orquestación 2.0 CheckMig: permiso, adaptador, inicio → consulta, éxito, ambigua, no disponible, cambio confirmado y no confirmado, vencida, incompatible y modelo: OK');
  } catch (e) {
    process.exitCode = 1;
    console.error(e);
  } finally {
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
