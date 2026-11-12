// Piloto CheckMig 2.0 (scripts/piloto-checkmig-v2.js): el mismo recorrido que el comando, con
// Mongo efímero, la ficha simulada y la API pública en 127.0.0.1. Nada toca Atlas ni la red.
// El proceso solo sale con 0 después de la última aserción (exitCode = 1 por defecto).
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const { ObjectId } = require('mongodb');
const piloto = require('./piloto-checkmig-v2');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');

(async () => {
  let e;
  try {
    // La política es la del perfil compartido (sus casos están en test-ciclo-checkmig-v2.js).
    assert.equal(piloto.PERFIL.politica.nombre, 'checkmig-colombia-obligatoriedad');

    // ---- Recorrido completo, igual que el comando ----
    e = await piloto.crearEntorno();
    const s = await piloto.demostrar(e);
    const lineas = [];
    piloto.imprimir(s, l => lineas.push(l));
    const col = n => e.conexion.db.collection(n);
    const api = (v, codigo) => v.destinos.find(d => d.codigo_iso === codigo);
    const [ambigua, fallida, cambio, segunda, revision, revisionOtraVez] = s.ciclos;

    assert.equal(s.api_antes.status, 200);
    assert.deepEqual([api(s.api_antes, 'CO').obligatorio, api(s.api_antes, 'CX').obligatorio], ['si', 'si'], 'antes: CheckMig guardado como obligatorio');

    // Lectura ambigua o fallida: destino intacto, sin propuesta y con el pendiente indicado.
    assert.equal(ambigua.motivo, 'lectura_ambigua');
    assert.deepEqual([ambigua.resultado, ambigua.destino_escrito, ambigua.propuestas_nuevas, ambigua.pendiente.tipo], ['revision_humana', false, 0, 'revision_humana']);
    assert.deepEqual(ambigua.pendiente.campos.map(c => [c.campo, c.motivo]), [['obligatoriedad', 'no_atribuible'], ['alcance', 'sin_evidencia'], ['ventana_horas_antes', 'sin_evidencia']]);
    assert.equal(ambigua.pendiente.campos[0].evidencia.length, 2, 'evidencia para revisar la ficha');
    assert.deepEqual([fallida.resultado, fallida.destino_escrito, fallida.propuestas_nuevas, fallida.pendiente], ['fuente_no_disponible', false, 0, { tipo: 'reintentar', motivo: 'http_503' }]);
    assert.equal(api(s.api_tras_pendientes, 'CO').obligatorio, 'si', 'tras las lecturas pendientes: sin cambio en la API');

    // Cambio confirmado: propuesta, decisión, aplicación H3.3 y dato nuevo en /api/destinos.
    assert.deepEqual([cambio.resultado, cambio.estado_propuesta, cambio.valor_aplicado, cambio.lecturas, cambio.destino_escrito, cambio.propuestas_nuevas, cambio.historial_nuevo],
      ['exito', 'aplicada', 'no', 2, true, 1, 1]);
    const co = api(s.api_tras_cambio, 'CO');
    assert.equal(co.obligatorio, 'no', 'GET /api/destinos devuelve el dato corregido');
    assert.equal(co.link, 'https://apps.migracioncolombia.gov.co/check-mig/', 'el link al formulario no cambia');
    assert.equal(api(s.api_tras_cambio, 'CX').obligatorio, 'si', 'el otro destino no cambia');
    const decision = await col('eventos_propuesta').findOne({ evento_id: cambio.decision_evento_id });
    assert.deepEqual([decision.tipo_evento, decision.actor.identificador, decision.detalle.identidad_operador.metodo, decision.detalle.identidad_operador.politica],
      ['aprobacion', 'piloto.local', 'politica_piloto_local', 'piloto-checkmig-obligatoriedad-v1'], 'la decisión queda registrada bajo la política');
    const intento = await col('intentos_aplicacion').findOne({ intento_id: cambio.intento_id });
    assert.deepEqual([intento.version_contrato, intento.resultado, intento.auditoria.origen, intento.adaptador.nombre], ['2.0', 'exito', 'comando_administrativo', 'migracion-colombia-checkmig']);
    assert.deepEqual(intento.revalidaciones.map(r => r.url), [URL_FICHA], 'H3.3 revalidó la ficha');
    assert.equal(await col('inicios_intento_aplicacion').countDocuments({ intento_id: cambio.intento_id }), 1, 'inicio durable de H3.3');
    const eventos = (await col('eventos_propuesta').find({ propuesta_id: cambio.propuesta_id }).toArray()).map(x => x.tipo_evento).sort();
    assert.deepEqual(eventos, ['aplicacion', 'aprobacion']);

    // Segunda ejecución con los mismos datos: sin propuesta nueva ni escritura.
    assert.deepEqual([segunda.resultado, segunda.destino_escrito, segunda.propuestas_nuevas, segunda.historial_nuevo, segunda.lecturas], ['sin_cambio', false, 0, 0, 1]);
    const coId = (await col('destinos').findOne({ codigo_iso: 'CO' }))._id;
    assert.equal(await col('propuestas_cambio').countDocuments({ destino_id: coId }), 1, 'una sola propuesta para el cambio');
    assert.equal(await col('intentos_aplicacion').countDocuments({ propuesta_id: cambio.propuesta_id }), 1, 'una sola aplicación');

    // Revalidación ambigua en la aplicación: revisión humana, destino intacto, sin duplicar después.
    assert.deepEqual([revision.resultado, revision.estado_propuesta, revision.destino_escrito, revision.historial_nuevo, revision.pendiente.tipo],
      ['extraccion_ambigua', 'revision_requerida', false, 0, 'revision_humana']);
    assert.deepEqual(revision.pendiente.campos.map(c => c.campo), ['obligatoriedad', 'alcance', 'ventana_horas_antes']);
    assert.deepEqual([revisionOtraVez.resultado, revisionOtraVez.propuesta_id, revisionOtraVez.lecturas, revisionOtraVez.propuestas_nuevas, revisionOtraVez.destino_escrito],
      ['propuesta_activa_existente', revision.propuesta_id, 0, 0, false]);
    assert.deepEqual([api(s.api_despues, 'CO').obligatorio, api(s.api_despues, 'CX').obligatorio], ['no', 'si'], 'después');

    // Todas las consultas fueron a la ficha simulada: 1 + 1 + 2 + 1 + 2 + 0 (la revisión pendiente no consulta).
    assert.ok(e.consultas.length === 7 &&e.consultas.every(u => u === URL_FICHA), `consultas: ${e.consultas.length}`);

    // Requisito fuera de la política: se lee la ficha pero no se propone nada.
    const destinoId = new ObjectId(), requisitoId = new ObjectId();
    await col('destinos').insertOne({ _id: destinoId, pais: 'Prueba (fuera de política)', codigo_iso: 'ZZ', requisitos: [{ _id: requisitoId, tipo: 'visa', nombre: 'Visa de turismo',
      obligatorio: 'si', descripcion: 'Visa', fuente: 'Cancillería', estado: 'confirmado', fecha_verificacion: '2026-08-01' }] });
    e.programar([() => new Response(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'checkmig', 'valida.html'), 'utf8'),
      { status: 200, headers: { 'content-type': 'text/html' } })]);
    const fuera = await piloto.ejecutarCiclo({ destinoId, requisitoId }, e);
    assert.deepEqual([fuera.resultado, fuera.motivo], ['revision_humana', 'requisito_fuera_de_perfil']);
    assert.equal(await col('propuestas_cambio').countDocuments({ destino_id: destinoId }), 0);

    // Salida de texto del comando.
    const texto = lineas.join('\n');
    for (const esperado of ['CO  Colombia (piloto local)  Check-Mig.obligatorio="si"', 'resultado=revision_humana (lectura_ambigua)', 'pendiente: reintentar (http_503)',
      'resultado=exito  lecturas=2  destino_escrito=sí', 'CO  Colombia (piloto local)  Check-Mig.obligatorio="no"', 'resultado=sin_cambio  lecturas=1  destino_escrito=no  propuestas_nuevas=0',
      'resultado=propuesta_activa_existente  lecturas=0']) assert.ok(texto.includes(esperado), `salida: ${esperado}`);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Piloto CheckMig 2.0: política, ambigua y fallida sin escribir, cambio confirmado en /api/destinos, segunda ejecución sin duplicar y revisión pendiente: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (e) await e.cerrar();
  }
})();
