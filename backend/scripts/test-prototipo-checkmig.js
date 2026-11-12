// Prototipo CheckMig (solo lectura): extracción con fixtures y consulta con fetch simulado. Sin red.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
// Falla por defecto: si una promesa quedara colgada sin temporizadores, el proceso saldría solo
// antes de la última aserción; así no da exit 0. Solo se pone en 0 después de la última aserción.
process.exitCode = 1;
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { URL_FICHA, extraer, consultar } = require('./prototipo-checkmig');

// Fin de línea normalizado: con core.autocrlf=true el checkout puede dejar CRLF.
const fixture = n => readFileSync(path.join(__dirname, 'fixtures', 'checkmig', n), 'utf8').replace(/\r\n/g, '\n');
const FUENTE = { url: URL_FICHA, consultado_en: '2026-11-10T12:00:00.000Z' };
const valores = r => Object.fromEntries(Object.entries(r.campos).map(([k, c]) => [k, c.estado === 'ok' ? (k === 'alcance' ? { viajeros: c.valor.viajeros, sentidos: c.valor.sentidos } : c.valor) : c.estado]));

(async () => {
  // 1. Válida: valores del contenido principal; lo de <head>, <nav>, <footer> y comentarios no cuenta.
  const r1 = extraer(fixture('valida.html'), FUENTE);
  assert.equal(r1.estado, 'ok', JSON.stringify(r1, null, 2));
  assert.deepEqual(valores(r1), {
    obligatoriedad: 'no_obligatorio',
    alcance: { viajeros: ['nacionales', 'extranjeros'], sentidos: ['ingreso', 'salida'] },
    ventana_horas_antes: { maximo_horas_antes: 72, minimo_horas_antes: 1 }
  });
  assert.equal(r1.campos.obligatoriedad.evidencia.length, 1, 'una sola evidencia: la del <main>');
  assert.match(r1.campos.obligatoriedad.evidencia[0], /^Servicio gratuito y en línea, de uso no obligatorio/, 'entidades decodificadas en la evidencia');
  assert.match(r1.campos.alcance.evidencia[0], /^Dirigido a: Viajeros nacionales y extranjeros/);
  assert.match(r1.campos.ventana_horas_antes.evidencia[0], /72 horas de anticipación, o hasta una hora antes/);
  for (const c of Object.values(r1.campos)) for (const e of c.evidencia) assert.ok(e.length <= 240, 'evidencia breve');
  assert.deepEqual([r1.fuente.url, r1.fuente.consultado_en], [URL_FICHA, FUENTE.consultado_en]);
  assert.match(r1.fuente.contenido_sha256, /^[0-9a-f]{64}$/);

  // 2. Cambio de valor: la salida refleja el contenido nuevo, no valores fijos.
  const r2 = extraer(fixture('cambio.html'), FUENTE);
  assert.equal(r2.estado, 'ok', JSON.stringify(r2, null, 2));
  assert.deepEqual(valores(r2), {
    obligatoriedad: 'obligatorio',
    alcance: { viajeros: ['extranjeros'], sentidos: ['ingreso'] },
    ventana_horas_antes: { maximo_horas_antes: 48, minimo_horas_antes: 2 }
  });
  assert.notEqual(r2.fuente.contenido_sha256, r1.fuente.contenido_sha256);

  // 3. Ambigua: «de uso no obligatorio» más «El registro es obligatorio…» (no atribuible al
  // prerregistro), sin «Dirigido a:» y sin horas → ambiguo por campo.
  const r3 = extraer(fixture('ambigua.html'), FUENTE);
  assert.equal(r3.estado, 'ambiguo');
  assert.deepEqual(Object.values(r3.campos).map(c => [c.estado, c.valor]), [['ambiguo', null], ['ambiguo', null], ['ambiguo', null]]);
  assert.match(r3.campos.obligatoriedad.motivo, /^no_atribuible/);
  assert.equal(r3.campos.obligatoriedad.evidencia.length, 2, 'la afirmación admitida y la no atribuible');
  assert.match(r3.campos.alcance.motivo, /^sin_evidencia/);
  assert.match(r3.campos.ventana_horas_antes.motivo, /^sin_evidencia/);

  // 4. Variantes ambiguas sobre la ficha válida (un solo campo cambia; los demás siguen ok).
  const v = fixture('valida.html');
  const conMain = extra => v.replace('</div>\n</main>', `${extra}\n  </div>\n</main>`);
  const casos = [
    ['ventanas contradictorias', conMain('<p>Puede registrarse hasta con 48 horas de anticipación.</p>'), 'ventana_horas_antes', /^contradiccion/],
    ['dos «Dirigido a:» distintos', conMain('<p><strong>Dirigido a:</strong> Viajeros extranjeros que ingresen a Colombia.</p>'), 'alcance', /^contradiccion/],
    ['obligatoriedad contradictoria', conMain('<p>CheckMig es obligatorio.</p>'), 'obligatoriedad', /^contradiccion/],
    ['mención no atribuible al prerregistro', conMain('<p>El registro es obligatorio.</p>'), 'obligatoriedad', /^no_atribuible/],
    ['mínimo no menor que el máximo', v.replace('hasta una hora antes', 'hasta 72 horas antes'), 'ventana_horas_antes', /^contradiccion/],
    ['entidad desconocida en la palabra clave', v.replace('de uso no obligatorio', 'de uso no obligatori&oacutx;o'), 'obligatoriedad', /^sin_evidencia/]
  ];
  for (const [nombre, html, campo, motivo] of casos) {
    const r = extraer(html, FUENTE);
    assert.equal(r.estado, 'ambiguo', nombre);
    assert.equal(r.campos[campo].estado, 'ambiguo', nombre);
    assert.match(r.campos[campo].motivo, motivo, nombre);
    for (const otro of Object.keys(r.campos).filter(k => k !== campo)) assert.equal(r.campos[otro].estado, 'ok', `${nombre}: ${otro} sigue ok`);
  }
  // Sin <main> o con dos: todo ambiguo, aunque el texto exista en otra parte de la página.
  for (const html of [v.replace(/<\/?main[^>]*>/g, ''), v.replace('</main>', '</main><main><p>Otro</p></main>')]) {
    const r = extraer(html, FUENTE);
    assert.deepEqual(Object.values(r.campos).map(c => c.estado), ['ambiguo', 'ambiguo', 'ambiguo']);
  }

  // 5b. Regresiones de la revisión de dc57067 (falsos positivos de extraer()).
  const sinObligatoriedad = v.replace('l&iacute;nea, de uso no obligatorio que permite', 'l&iacute;nea que permite');
  assert.notEqual(sinObligatoriedad, v);
  const dirigido = texto => v.replace(/(<strong>Dirigido a:<\/strong>)[^<]*/, `$1 ${texto}`);
  const regresiones = [
    // 6.1 Obligatoriedad distinta por grupo de viajeros: el formato solo admite un valor global.
    ['obligatoriedad por grupo (sola)', sinObligatoriedad.replace('</div>\n</main>', '<p>CheckMig no es obligatorio para nacionales, pero es obligatorio para extranjeros.</p>\n  </div>\n</main>'), 'obligatoriedad', /^condicionada/],
    ['obligatoriedad por grupo (junto a la ficha)', conMain('<p>CheckMig no es obligatorio para nacionales, pero es obligatorio para extranjeros.</p>'), 'obligatoriedad', /^condicionada/],
    // 6.2 «Dirigido a:» con una exclusión: nunca se infiere «salida».
    ['alcance con exclusión', dirigido('viajeros extranjeros que ingresen a Colombia, no para los que salgan.'), 'alcance', /^exclusion/],
    // 6.3 Obligatoriedad de otro documento: no es evidencia sobre CheckMig.
    ['obligatoriedad de otro documento', sinObligatoriedad.replace('</div>\n</main>', '<p>Es obligatorio presentar el pasaporte.</p>\n  </div>\n</main>'), 'obligatoriedad', /^sin_evidencia/]
  ];
  for (const [nombre, html, campo, motivo] of regresiones) {
    const r = extraer(html, FUENTE);
    assert.equal(r.campos[campo].estado, 'ambiguo', `${nombre}: ${JSON.stringify(r.campos[campo])}`);
    assert.equal(r.campos[campo].valor, null, nombre);
    assert.match(r.campos[campo].motivo, motivo, nombre);
    assert.equal(r.estado, 'ambiguo', nombre);
    for (const otro of Object.keys(r.campos).filter(k => k !== campo)) assert.equal(r.campos[otro].estado, 'ok', `${nombre}: ${otro} sigue ok`);
  }
  // La mención de otro documento se ignora: junto a la ficha no crea una contradicción.
  const conPasaporte = extraer(conMain('<p>Es obligatorio presentar el pasaporte.</p>'), FUENTE);
  assert.equal(conPasaporte.campos.obligatoriedad.valor, 'no_obligatorio', JSON.stringify(conPasaporte.campos.obligatoriedad));
  assert.equal(conPasaporte.campos.obligatoriedad.evidencia.length, 1);

  // 5c. Regresiones de la revisión de 4636bef: la obligación debe atribuirse al prerregistro.
  const solo = frase => sinObligatoriedad.replace('</div>\n</main>', `<p>${frase}</p>\n  </div>\n</main>`);
  const PASAPORTE = ['El pasaporte es obligatorio para usar CheckMig.', 'Para usar CheckMig es obligatorio el pasaporte.'];
  const OTRO_TRAMITE = 'Para solicitar la visa de turismo, el formulario es obligatorio.';
  const atribucion = [
    ...PASAPORTE.map(f => [`pasaporte (sola): ${f}`, solo(f), /^sin_evidencia/]),
    [`formulario de otro trámite (sola)`, solo(OTRO_TRAMITE), /^no_atribuible/],
    [`formulario de otro trámite (junto a la ficha)`, conMain(`<p>${OTRO_TRAMITE}</p>`), /^no_atribuible/],
    ['formulario sin sujeto (sola)', solo('El formulario es obligatorio.'), /^no_atribuible/],
    // La redacción cambia y ya no es la admitida: no se atribuye al prerregistro.
    ['redacción nueva («cuyo uso no es obligatorio»)', v.replace('de uso no obligatorio', 'cuyo uso no es obligatorio'), /^no_atribuible/],
    // «de uso no obligatorio» solo cuenta en la ficha de CheckMig (primer <h1> del <main>).
    ['«de uso» fuera de la ficha de CheckMig', v.replace('<span>CheckMig</span>', '<span>Visas</span>'), /^no_atribuible/]
  ];
  for (const [nombre, html, motivo] of atribucion) {
    const c = extraer(html, FUENTE).campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor], ['ambiguo', null], `${nombre}: ${JSON.stringify(c)}`);
    assert.match(c.motivo, motivo, nombre);
  }
  for (const f of PASAPORTE) {
    const c = extraer(conMain(`<p>${f}</p>`), FUENTE).campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor, c.evidencia.length], ['ok', 'no_obligatorio', 1], `pasaporte junto a la ficha: ${f}: ${JSON.stringify(c)}`);
  }
  // Cambio real a obligatorio con las redacciones admitidas (A en cambio.html, B y C).
  for (const [nombre, html] of [
    ['A: «de uso obligatorio» (cambio.html)', fixture('cambio.html')],
    ['B: «CheckMig es obligatorio»', solo('CheckMig es obligatorio.')],
    ['B: «El uso de CheckMig es obligatorio»', solo('El uso de CheckMig es obligatorio.')],
    ['C: «Es obligatorio diligenciar el formulario de CheckMig»', solo('Es obligatorio diligenciar el formulario de CheckMig.')]
  ]) {
    const c = extraer(html, FUENTE).campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor, c.evidencia.length], ['ok', 'obligatorio', 1], `${nombre}: ${JSON.stringify(c)}`);
  }
  for (const [nombre, frase] of [['B negativa', 'El prerregistro en CheckMig no es obligatorio.'], ['B opcional', 'CheckMig es opcional.']]) {
    const c = extraer(solo(frase), FUENTE).campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor], ['ok', 'no_obligatorio'], `${nombre}: ${JSON.stringify(c)}`);
  }

  // 5d. Regresiones de la revisión de 3235202: se valida la afirmación ENTERA. Una condición, una
  // fecha de vigencia u otro detalle antes o después de la redacción admitida → condicionada. El
  // esquema no representa condiciones ni vigencias.
  const condicionadas = [
    ['B + condición (Codex)', solo('CheckMig es obligatorio si el viaje es por vía aérea.')],
    ['B negativa + vigencia (Codex)', solo('CheckMig no es obligatorio desde el 1 de diciembre.')],
    ['B + vigencia antes', solo('Desde el 1 de diciembre, CheckMig es obligatorio.')],
    ['B + «cuando»', solo('CheckMig es obligatorio cuando el viajero ingresa por vía terrestre.')],
    ['B + fecha de fin', solo('CheckMig es obligatorio hasta el 31 de enero de 2027.')],
    ['B voluntario + temporada', solo('El uso de CheckMig es voluntario en temporada baja.')],
    ['C + condición antes', solo('Si el viaje es por vía aérea, es obligatorio diligenciar el formulario de CheckMig.')],
    ['C + vigencia después', solo('Es obligatorio diligenciar el formulario de CheckMig a partir de 2027.')],
    ['A + vigencia al final de la oración de la ficha', v.replace('hasta una hora antes del mismo.', 'hasta una hora antes del mismo, desde el 1 de diciembre.')],
    ['A + condición en medio de la oración de la ficha', v.replace('de uso no obligatorio que permite', 'de uso no obligatorio si se viaja por vía aérea, que permite')]
  ];
  for (const [nombre, html] of condicionadas) {
    const r = extraer(html, FUENTE);
    const c = r.campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor], ['ambiguo', null], `${nombre}: ${JSON.stringify(c)}`);
    assert.match(c.motivo, /^condicionada/, nombre);
    assert.equal(c.evidencia.length, 1, `${nombre}: la evidencia es la oración condicionada`);
    assert.equal(r.estado, 'ambiguo', nombre);
    for (const otro of ['alcance', 'ventana_horas_antes']) assert.equal(r.campos[otro].estado, 'ok', `${nombre}: ${otro} sigue ok`);
  }
  // Siguen siendo globales: la ficha observada (A), «para todos los viajeros» y la variante «de su viaje».
  for (const [nombre, html, valorEsperado] of [
    ['ficha observada (valida.html)', v, 'no_obligatorio'],
    ['B global «para todos los viajeros»', solo('CheckMig es obligatorio para todos los viajeros.'), 'obligatorio'],
    ['A «precargar la información de su viaje»', v.replace('relacionada con su viaje', 'de su viaje'), 'no_obligatorio']
  ]) {
    const c = extraer(html, FUENTE).campos.obligatoriedad;
    assert.deepEqual([c.estado, c.valor], ['ok', valorEsperado], `${nombre}: ${JSON.stringify(c)}`);
  }

  // 5. consultar() con fetch simulado: éxito y cada fallo como no_disponible, sin lanzar.
  // Respuestas reales (Response) para que el cuerpo se lea por partes como en producción.
  const respuesta = ({ status = 200, tipo = 'text/html; charset=utf-8', cuerpo = v, location } = {}) =>
    new Response(cuerpo, { status, headers: { 'content-type': tipo, ...(location ? { location } : {}) } });
  const ahora = () => new Date('2026-11-10T12:00:00.000Z');
  const llamadas = [];
  const ok = await consultar({ ahora, fetch: async (u, o) => { llamadas.push([u, o.redirect, o.headers['user-agent']]); return respuesta(); } });
  assert.equal(ok.estado, 'ok');
  assert.deepEqual([ok.fuente.url, ok.fuente.url_final, ok.fuente.http_status, ok.fuente.consultado_en], [URL_FICHA, URL_FICHA, 200, '2026-11-10T12:00:00.000Z']);
  assert.deepEqual(llamadas, [[URL_FICHA, 'manual', 'buscador-requisitos-viaje/adaptador-checkmig']], 'una sola consulta, sin datos del usuario');
  const fallos = [
    ['red', async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, /red:ENOTFOUND/],
    ['tiempo agotado', async () => { throw new DOMException('timeout', 'TimeoutError'); }, /tiempo_agotado/],
    ['HTTP 503', async () => respuesta({ status: 503 }), /http_503/],
    ['redirección a otro sitio', async () => respuesta({ status: 302, cuerpo: null, location: 'https://ejemplo.invalid/checkmig' }), /redireccion_fuera_del_sitio/],
    ['no es HTML', async () => respuesta({ tipo: 'application/json', cuerpo: '{}' }), /no_html/],
    ['cuerpo ilegible', async () => new Response(new ReadableStream({ pull(c) { c.error(new TypeError('terminated')); } }), { status: 200, headers: { 'content-type': 'text/html' } }), /cuerpo_ilegible/]
  ];
  for (const [nombre, f, motivo] of fallos) {
    const r = await consultar({ ahora, fetch: f });
    assert.equal(r.estado, 'no_disponible', nombre);
    for (const c of Object.values(r.campos)) { assert.deepEqual([c.estado, c.valor, c.evidencia], ['no_disponible', null, []], nombre); assert.match(c.motivo, motivo, nombre); }
    assert.equal(r.fuente.contenido_sha256, undefined, `${nombre}: sin contenido`);
  }
  assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión real');
  process.exitCode = 0;
  console.log('Prototipo CheckMig: válida, cambio de valor, ambiguos por campo, aislamiento del <main> y no_disponible: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
