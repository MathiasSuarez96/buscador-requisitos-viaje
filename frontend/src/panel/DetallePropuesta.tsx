import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { ControladorPanel } from './controlador.ts'
import { urlHttpsSegura, type Detalle, type FalloDetalle } from './detalle.ts'
import { NOMBRES, textoValor, textoPresencia } from './presentacion.ts'
import { esMotivoValido, type AccionDecision } from './decisiones.ts'

const ERRORES: Record<FalloDetalle, string> = {
  sesion: 'Tu sesión venció (401). Iniciá sesión nuevamente y reintentá manualmente. Conservamos el listado y la selección.',
  permiso: 'No tenés permiso para consultar este detalle (403).',
  no_encontrado: 'La propuesta no fue encontrada (404). Podés volver al listado.',
  servidor: 'El servidor no pudo completar la consulta del detalle (500).',
  no_disponible: 'El detalle no está disponible temporalmente (503).',
  conexion: 'No se pudo conectar. Puede ser un problema de red o de acceso CORS.',
  respuesta: 'No pudimos leer una respuesta válida y completa. Puede ser inválida o superar el límite de 512 KiB.',
}
const MOTIVOS: Record<string, string> = {
  payload_hash_invalido: 'La huella del contenido no es válida.',
  version_coordinacion_invalida: 'La versión de coordinación no es válida.',
  decision_previa_existente: 'Ya existe una decisión previa.',
  hash_no_coincide: 'La huella del contenido no coincide.',
  datos_inconsistentes: 'Los datos de la propuesta son inconsistentes.',
  requisito_no_coincide: 'El requisito actual no coincide.',
  valor_actual_cambio: 'El valor actual cambió o no se pudo comparar.',
  estado_no_permite_decision: 'El estado no permite tomar una decisión.',
  sin_permiso_decidir: 'No tenés permiso para decidir.',
  payload_2_invalido: 'El contenido de la propuesta 2.0 no es válido.',
  resumen_2_incompleto: 'El panel no pudo mostrar todos los cambios de la propuesta 2.0.',
  contrato_2_no_aplicable: 'La aplicación de propuestas 2.0 todavía no está habilitada.',
}
const ADVERTENCIAS: Record<string, string> = {
  quita_obligatoriedad: 'Este cambio quita la condición de obligatorio.',
  degrada_estado_verificacion: 'Este cambio reduce el nivel de confirmación del requisito.',
  cambia_dominio_link: 'Este cambio modifica el dominio del enlace oficial.',
}
const REQUISITO: Record<Detalle['requisito_actual']['estado'], string> = {
  coincide: 'Coincide', destino_no_encontrado: 'Destino no encontrado', requisito_id_no_encontrado: 'Requisito no encontrado',
  requisito_id_duplicado: 'Identificador de requisito duplicado', identidad_semantica_no_coincide: 'La identidad semántica no coincide',
  identidad_no_verificable: 'Identidad no verificable', no_evaluable: 'No evaluable',
}
const ERRORES_DECISION: Record<string, string> = {
  permiso: 'El servidor rechazó la acción por falta de autorización o permiso.',
  no_encontrado: 'La propuesta ya no existe.',
  cambio: 'La propuesta cambió desde que se mostró esta instantánea. Compará lo visto con el estado actual y recargá antes de decidir.',
  no_decidible: 'El servidor no permite esta acción con el estado e integridad actuales.',
  solicitud: 'El servidor no aceptó la solicitud. Revisá el motivo y la instantánea antes de confirmarla otra vez.',
  no_disponible: 'El servicio no está disponible temporalmente. No se repitió la decisión.',
  incierto: 'No se pudo confirmar el resultado de la decisión. No la repitas. Recargá la propuesta explícitamente antes de habilitar otra acción.',
}
const MOTIVOS_DECISION: Record<string, string> = {
  payload_hash_invalido: 'La huella de la propuesta no es válida.', version_coordinacion_invalida: 'La versión de coordinación no es válida.',
  decision_previa_existente: 'Existe una decisión previa.', hash_no_coincide: 'La huella no coincide.', datos_inconsistentes: 'Hay datos inconsistentes.',
  requisito_no_coincide: 'El requisito actual no coincide.', valor_actual_cambio: 'El valor actual cambió o no pudo compararse.',
  estado_no_permite_decision: 'El estado no permite decidir.', sin_permiso_decidir: 'Falta el permiso para decidir.',
  estado_no_permite_aplicar: 'El estado no permite aplicar.', sin_permiso_aplicar: 'Falta el permiso para aplicar.', decision_aprobacion_invalida: 'La aprobación asociada no es válida.',
  propuesta_no_decidible: 'La propuesta no es decidible.', solicitud_invalida: 'La solicitud no es válida.',
  payload_2_invalido: 'El contenido de la propuesta 2.0 no es válido.',
}

function Dato({ nombre, children }: { nombre: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-sm font-medium text-slate-600">{nombre}</dt><dd className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</dd></div>
}
function Datos({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
}
function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-lg font-semibold">{titulo}</h3>{children}</section>
}
function Enlace({ url }: { url: string | null }) {
  const segura = urlHttpsSegura(url)
  return segura ? <a href={segura} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-blue-800 underline">{url} (abre otra pestaña)</a> : <>{textoValor(url)}</>
}
function Fecha({ fecha }: { fecha: string | null }) {
  return fecha === null ? <>{textoValor(fecha)}</> : <time dateTime={fecha}>{fecha}</time>
}
function Textos({ valores, vacio }: { valores: (string | null)[]; vacio: string }) {
  return valores.length === 0 ? <p>{vacio}</p> : <ul className="list-disc space-y-2 pl-5 [overflow-wrap:anywhere]">{valores.map((v, i) => <li key={i}>{textoValor(v)}</li>)}</ul>
}
function textoCapturado(v: { presente: boolean; bson_tipo: 'ausente' | 'null' | 'string'; valor: string | null }) {
  if (!v.presente || v.bson_tipo === 'ausente') return 'Ausente'
  if (v.bson_tipo === 'null') return 'Null (sin dato)'
  return v.valor === '' ? 'Cadena vacía' : v.valor ?? 'No evaluable'
}

export function DetallePropuesta({ controlador, habilitado, puedeDecidir, puedeAplicar }: { controlador: ControladorPanel; habilitado: boolean; puedeDecidir: boolean; puedeAplicar: boolean }) {
  const vista = useSyncExternalStore(controlador.suscribir, controlador.obtenerDetalle, controlador.obtenerDetalle)
  const decision = useSyncExternalStore(controlador.suscribir, controlador.obtenerDecision, controlador.obtenerDecision)
  const titulo = useRef<HTMLHeadingElement>(null)
  useEffect(() => { titulo.current?.focus() }, [vista.propuestaId])
  return <article aria-labelledby="titulo-detalle" className="mt-8 space-y-5">
    <button type="button" disabled={decision.enviando} onClick={controlador.volverAlListado} className="rounded-lg border border-slate-300 bg-white px-4 py-2">Volver al listado</button>
    <h2 id="titulo-detalle" ref={titulo} tabIndex={-1} className="text-2xl font-semibold">Detalle de propuesta</h2>
    <p className="break-all font-mono text-sm">{vista.propuestaId}</p>
    <p role="status" aria-live="polite">{vista.cargando ? 'Cargando detalle…' : vista.datos ? 'Detalle cargado.' : 'Detalle no disponible.'}</p>
    {vista.error && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4">{ERRORES[vista.error]}</p>}
    {!vista.cargando && !vista.datos && <button type="button" disabled={!habilitado || decision.enviando} onClick={controlador.reintentarDetalle} className="rounded-lg bg-slate-800 px-4 py-2 text-white hover:bg-slate-700">Reintentar detalle</button>}
    {vista.datos && <button type="button" disabled={!habilitado || decision.enviando} onClick={controlador.reintentarDetalle} className="rounded-lg border border-slate-300 bg-white px-4 py-2">Recargar propuesta</button>}
    {vista.requestId && <p className="text-sm">Request ID: <code className="break-all">{vista.requestId}</code></p>}
    <div aria-busy={vista.cargando} className="space-y-5">{vista.datos && <ContenidoDetalle detalle={vista.datos} />}</div>
    {vista.datos && <AccionesDecisiones controlador={controlador} detalle={vista.datos} puedeDecidir={puedeDecidir} />}
    {vista.datos && <AccionAplicar controlador={controlador} detalle={vista.datos} puedeAplicar={puedeAplicar} />}
  </article>
}

export function ContenidoDetalle({ detalle: d }: { detalle: Detalle }) {
  const p = d.propuesta, r = d.requisito_actual, e = p.evidencia
  return <>
    <Seccion titulo="Identificación">
      <Datos>
        <Dato nombre="País del requisito actual">{r.destino === null ? 'Destino no disponible (null)' : textoValor(r.destino.pais)}</Dato>
        <Dato nombre="Código ISO">{textoValor(r.destino?.codigo_iso ?? null)}</Dato>
        <Dato nombre="Estado">{p.estado === null ? textoValor(null) : NOMBRES[p.estado]}</Dato>
        <Dato nombre="Campo">{p.campo === 'costo' ? 'Costo' : textoValor(p.campo)}</Dato>
        <Dato nombre="Propuesta ID">{p.propuesta_id}</Dato>
        <Dato nombre="Destino ID de la propuesta">{textoValor(p.destino_id)}</Dato>
        <Dato nombre="Requisito ID de la propuesta">{textoValor(p.requisito_id)}</Dato>
        <Dato nombre="Creada"> <Fecha fecha={p.creada_en} /></Dato>
        <Dato nombre="Actualizada"> <Fecha fecha={p.actualizada_en} /></Dato>
      </Datos>
    </Seccion>
    <Seccion titulo="Valores del cambio">
      <div className="grid gap-4 lg:grid-cols-3">
        <dl className="rounded-lg bg-slate-50 p-4"><Dato nombre="Valor anterior">{textoPresencia(p.valor_anterior)}</Dato></dl>
        <dl className="rounded-lg bg-slate-50 p-4"><Dato nombre="Valor propuesto">{textoValor(p.valor_propuesto.valor)}</Dato></dl>
        <dl className="rounded-lg bg-slate-50 p-4"><Dato nombre="Valor actual">{textoPresencia(r.valor_actual)}</Dato></dl>
      </div>
      <Datos><Dato nombre="Importe propuesto">{textoValor(p.valor_propuesto.importe)}</Dato><Dato nombre="Moneda propuesta">{textoValor(p.valor_propuesto.moneda)}</Dato></Datos>
      <p className="text-sm text-slate-600">Ausente indica que el campo no existe; null es un valor explícito; cadena vacía es texto sin caracteres. No evaluable indica que no se pudo determinar el valor.</p>
    </Seccion>
    {p.version_contrato === '2.0' && p.requisito_v2 && <Seccion titulo="Cambios del requisito (contrato 2.0)">
      <p>Revisá cada campo y sus valores exactos antes de decidir.</p>
      {!p.requisito_v2.completo && <p role="alert">El resumen está incompleto. El servidor bloqueó la aprobación.</p>}
      {p.requisito_v2.cambios.length === 0 ? <p>No hay cambios legibles en esta respuesta.</p> : <ul className="space-y-3">{p.requisito_v2.cambios.map(c => <li key={c.campo} className="rounded-lg bg-slate-50 p-4"><h4 className="font-semibold">{c.campo}</h4><Datos><Dato nombre="Valor anterior">{textoCapturado(c.anterior)}</Dato><Dato nombre="Valor propuesto">{textoCapturado(c.propuesto)}</Dato></Datos></li>)}</ul>}
      <h4 className="font-semibold">Advertencias requeridas</h4>
      <Textos valores={p.requisito_v2.advertencias.map(a => `${ADVERTENCIAS[a] ?? 'Advertencia informada por el servidor'} (${a})`)} vacio="Esta propuesta no requiere advertencias adicionales." />
    </Seccion>}
    <Seccion titulo="Fuente de la propuesta">
      <Datos><Dato nombre="Nombre">{textoValor(p.fuente.nombre)}</Dato><Dato nombre="URL"><Enlace url={p.fuente.url} /></Dato><Dato nombre="Capturada"><Fecha fecha={p.fuente.capturado_en} /></Dato></Datos>
    </Seccion>
    <Seccion titulo="Evidencia">
      <Datos>
        <Dato nombre="Fuente">{textoValor(e.fuente)}</Dato><Dato nombre="URL de evidencia"><Enlace url={e.url} /></Dato>
        <Dato nombre="Capturada"><Fecha fecha={e.capturado_en} /></Dato><Dato nombre="Fuente actualizada"><Fecha fecha={e.fuente_actualizada_en} /></Dato>
        <Dato nombre="Valor extraído">{textoValor(e.valor_extraido)}</Dato><Dato nombre="Importe extraído">{textoValor(e.importe)}</Dato>
        <Dato nombre="Moneda">{textoValor(e.moneda)}</Dato><Dato nombre="Coincide entre secciones">{e.coincide_entre_secciones === null ? 'No evaluable (null)' : textoValor(e.coincide_entre_secciones)}</Dato>
      </Datos>
      <h4 className="font-semibold">Secciones de evidencia</h4>
      {e.secciones.length === 0 ? <p>Sin secciones de evidencia.</p> : <ul className="space-y-3">{e.secciones.map((s, i) => <li key={i} className="rounded-lg bg-slate-50 p-3"><Datos><Dato nombre="Sección">{s.seccion}</Dato><Dato nombre="Costo extraído">{textoValor(s.costo_extraido)}</Dato><Dato nombre="Moneda">{textoValor(s.moneda)}</Dato></Datos></li>)}</ul>}
      <h4 className="font-semibold">Avisos</h4><Textos valores={e.avisos} vacio="Sin avisos." />
    </Seccion>
    <Seccion titulo="Integridad">
      <Datos><Dato nombre="Hash coincide (hash_coincide)">{textoValor(d.integridad.hash_coincide)}</Dato><Dato nombre="Consistente">{textoValor(d.integridad.consistente)}</Dato><Dato nombre="Hash recalculado">{textoValor(d.integridad.hash_recalculado)}</Dato></Datos>
      <h4 className="font-semibold">Problemas</h4><Textos valores={d.integridad.problemas} vacio="Sin problemas informados." />
    </Seccion>
    <Seccion titulo="Requisito actual">
      <Datos>
        <Dato nombre="Estado del requisito">{REQUISITO[r.estado]}</Dato><Dato nombre="Comparación del valor">{r.valor === null ? 'No evaluable (null)' : r.valor === 'coincide' ? 'Coincide' : p.estado === 'aplicada' ? 'El valor actual difiere del valor anterior guardado en la propuesta; la propuesta figura aplicada.' : 'El valor actual difiere del valor anterior guardado en la propuesta.'}</Dato>
        <Dato nombre="Destino ID actual">{textoValor(r.destino?.destino_id ?? null)}</Dato>
      </Datos>
      {r.requisito === null ? <p>Requisito no disponible (null).</p> : <Datos><Dato nombre="Requisito ID actual">{textoValor(r.requisito.requisito_id)}</Dato><Dato nombre="Tipo">{textoValor(r.requisito.tipo)}</Dato><Dato nombre="Nombre">{textoValor(r.requisito.nombre)}</Dato></Datos>}
    </Seccion>
    <Seccion titulo="Acciones informadas por el servidor">
      <p className="text-sm text-slate-600">Acciones disponibles según el permiso y las condiciones que informó el servidor.</p>
      <h4 className="font-semibold">Acciones permitidas</h4><Textos valores={d.acciones_permitidas.map(a => a === 'aprobar' ? 'Aprobar' : a === 'rechazar' ? 'Rechazar' : 'Aplicar')} vacio="Ninguna acción permitida." />
      <div className="grid gap-4 sm:grid-cols-3">{(['aprobar', 'rechazar', 'aplicar'] as const).map(a => <section key={a} className="space-y-2 rounded-lg bg-slate-50 p-4"><h4 className="font-semibold">{a === 'aprobar' ? 'Aprobar: bloqueos' : a === 'rechazar' ? 'Rechazar: bloqueos' : 'Aplicar: bloqueos'}</h4><Textos valores={d.acciones_bloqueadas[a].map(m => MOTIVOS[m] ? `${MOTIVOS[m]} (${m})` : m)} vacio="Sin motivos de bloqueo." /></section>)}</div>
    </Seccion>
    <Seccion titulo="Coordinación para una futura decisión">
      <Datos><Dato nombre="Payload hash">{textoValor(p.payload_hash)}</Dato><Dato nombre="Versión de coordinación">{textoValor(p.version_coordinacion)}</Dato><Dato nombre="Decisión de aprobación ID">{textoValor(p.decision_aprobacion_id)}</Dato><Dato nombre="Último evento ID">{textoValor(p.ultimo_evento_id)}</Dato></Datos>
    </Seccion>
    <Seccion titulo="Historial de eventos">
      <p className="text-sm text-slate-600">Orden de coordinación entregado por el servidor. Las fechas se muestran con su zona horaria original.</p>
      {d.eventos_truncados && <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3">Historial truncado: existen más eventos que los incluidos en esta respuesta.</p>}
      {d.eventos.length === 0 ? <p>No hay eventos en esta respuesta.</p> : <ol className="space-y-4">{d.eventos.map((ev, i) => <li key={i} className="space-y-3 rounded-lg border border-slate-200 p-4">
        <h4 className="font-semibold [overflow-wrap:anywhere]">{i + 1}. {textoValor(ev.tipo_evento)}</h4>
        <Datos>
          <Dato nombre="Evento ID">{textoValor(ev.evento_id)}</Dato><Dato nombre="Ocurrido"><Fecha fecha={ev.ocurrido_en} /></Dato>
          <Dato nombre="Estado anterior">{ev.estado_anterior === null ? textoValor(null) : NOMBRES[ev.estado_anterior]}</Dato><Dato nombre="Estado nuevo">{ev.estado_nuevo === null ? textoValor(null) : NOMBRES[ev.estado_nuevo]}</Dato>
          <Dato nombre="Versión de coordinación nueva">{textoValor(ev.version_coordinacion_nueva)}</Dato><Dato nombre="Tipo de actor">{textoValor(ev.actor.tipo)}</Dato>
          <Dato nombre="Origen">{textoValor(ev.origen)}</Dato><Dato nombre="Método de identidad">{textoValor(ev.metodo_identidad)}</Dato>
          <Dato nombre="Motivo">{textoValor(ev.motivo)}</Dato><Dato nombre="Hash de contenido referenciado">{textoValor(ev.hash_contenido_referenciado)}</Dato><Dato nombre="Intento de aplicación ID">{textoValor(ev.intento_aplicacion_id)}</Dato>
        </Datos>
      </li>)}</ol>}
    </Seccion>
  </>
}

function AccionesDecisiones({ controlador, detalle, puedeDecidir }: { controlador: ControladorPanel; detalle: Detalle; puedeDecidir: boolean }) {
  const decision = useSyncExternalStore(controlador.suscribir, controlador.obtenerDecision, controlador.obtenerDecision)
  const id = detalle.propuesta.propuesta_id
  const bloqueada = decision.propuestaId === id && (decision.requiereRecarga || decision.enviando)
  const instantanea = decision.instantanea
  const motivoValido = esMotivoValido(decision.motivo)
  const estadoVisto = instantanea ? NOMBRES[instantanea.estado_esperado] : 'Pendiente de aprobación'
  const advertencias = detalle.propuesta.requisito_v2?.advertencias ?? []
  const advertenciasCompletas = advertencias.every(a => decision.advertenciasAceptadas.includes(a))
  const mostrarAccion = (accion: AccionDecision) => {
    if (!detalle.acciones_permitidas.includes(accion) || !puedeDecidir || decision.accionesBloqueadas.includes(accion)) return null
    return <button key={accion} type="button" disabled={bloqueada || (accion === 'aprobar' && detalle.propuesta.version_contrato === '2.0' && !advertenciasCompletas)} onClick={() => controlador.prepararDecision(accion)} className="rounded-lg bg-slate-800 px-4 py-2 font-medium text-white hover:bg-slate-700">{accion === 'aprobar' ? 'Aprobar' : 'Rechazar'}</button>
  }
  const error = decision.error
  return <section aria-labelledby="titulo-decision" className="space-y-4 rounded-xl border border-slate-300 bg-white p-5">
    <h3 id="titulo-decision" className="text-lg font-semibold">Decisiones</h3>
    {detalle.acciones_permitidas.length === 0 && <p role="status">El servidor no permite aprobar ni rechazar esta propuesta.</p>}
    {!puedeDecidir && <p role="status">Tu sesión tiene permiso de lectura, pero no permiso para decidir.</p>}
    {decision.requiereRecarga && <p role="alert">La instantánea está bloqueada. Recargá la propuesta y comprobá los datos nuevos antes de considerar otra decisión.</p>}
    {detalle.propuesta.version_contrato === '2.0' && advertencias.length > 0 && <fieldset disabled={bloqueada || decision.accion !== null} className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <legend className="px-1 font-semibold">Confirmación de advertencias</legend>
      {advertencias.map(a => <label key={a} className="flex items-start gap-3"><input type="checkbox" checked={decision.advertenciasAceptadas.includes(a)} onChange={e => controlador.fijarAdvertenciaDecision(a, e.currentTarget.checked)} /><span>{ADVERTENCIAS[a] ?? 'Acepto la advertencia informada por el servidor'} <code>({a})</code></span></label>)}
      <p className="text-sm">Tenés que aceptar todas las advertencias para habilitar la aprobación. El rechazo sigue disponible.</p>
    </fieldset>}
    <div className="flex flex-wrap gap-3">{mostrarAccion('aprobar')}{mostrarAccion('rechazar')}</div>
    {decision.registrada?.propuesta_id === id && <div role="status" className="space-y-2 rounded-lg border border-green-300 bg-green-50 p-4">
      <h4 className="font-semibold">Decisión registrada{decision.registrada.ya_registrada ? ' (ya estaba registrada)' : ''}</h4>
      <p>{decision.registrada.tipo_evento === 'aprobacion' ? 'Aprobación' : 'Rechazo'} registrada. El estado nuevo es {NOMBRES[decision.registrada.estado_nuevo as keyof typeof NOMBRES] ?? decision.registrada.estado_nuevo}.</p>
      <Datos><Dato nombre="Actor">{decision.registrada.actor.identificador}</Dato><Dato nombre="Evento ID">{decision.registrada.evento_id}</Dato><Dato nombre="Fecha"><Fecha fecha={decision.registrada.ocurrido_en} /></Dato><Dato nombre="Versión nueva">{decision.registrada.version_coordinacion_nueva}</Dato></Datos>
      <p>{decision.requiereRecarga ? 'Esta instantánea queda bloqueada. Recargá la propuesta para ver el estado actual.' : 'La propuesta se recargó; revisá la instantánea actual antes de decidir.'}</p>
    </div>}
    {error && <div role="alert" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p>{error.autenticacionVencida ? 'Tu sesión venció (401). Iniciá sesión otra vez; la instantánea y el borrador se conservaron y la decisión no se reenvió.' : ERRORES_DECISION[error.fallo]}</p>
      {error.fallo === 'no_encontrado' && <button type="button" disabled={decision.enviando} onClick={controlador.volverAlListado} className="rounded border border-slate-300 px-3 py-2">Volver al listado</button>}
      {error.fallo === 'cambio' && <Datos>
        <Dato nombre="Lo que vio el operador">Estado: {estadoVisto}; payload_hash: {instantanea?.payload_hash_esperado ?? 'No disponible'}; versión: {instantanea?.version_coordinacion_esperada ?? 'No disponible'}.</Dato>
        <Dato nombre="Estado actual devuelto por el servidor">{error.actual ? <>Estado: {error.actual.estado ?? 'Null'}; payload_hash: {error.actual.payload_hash ?? 'Null'}; versión: {error.actual.version_coordinacion ?? 'Null'}; último evento: {error.actual.ultimo_evento?.tipo_evento ?? 'No disponible'} (<Fecha fecha={error.actual.ultimo_evento?.ocurrido_en ?? null} />).</> : 'No se pudo validar el estado actual.'}</Dato>
      </Datos>}
      {error.fallo === 'no_decidible' && <><h4 className="font-medium">Motivos informados</h4><Textos valores={error.motivos.map(m => `${MOTIVOS_DECISION[m] ?? 'La propuesta no se puede decidir'} (${m})`)} vacio="El servidor no detalló los motivos." /></>}
      {error.requestId && <p>Request ID: <code className="break-all">{error.requestId}</code></p>}
    </div>}
    {decision.accion && instantanea && decision.propuestaId === id && <section aria-labelledby="titulo-confirmacion" className="space-y-4 rounded-lg border border-blue-300 bg-blue-50 p-4">
      <h4 id="titulo-confirmacion" className="font-semibold">Confirmar {decision.accion === 'aprobar' ? 'aprobación' : 'rechazo'}</h4>
      <p>Propuesta: <code className="break-all">{id}</code></p>
      <p>Instantánea exacta: estado {estadoVisto}; payload_hash <code className="break-all">{instantanea.payload_hash_esperado}</code>; versión de coordinación {instantanea.version_coordinacion_esperada}.</p>
      {decision.accion === 'aprobar' ? <p>Se registrará la aprobación, pero este panel todavía no aplica el cambio al destino.</p> : <>
        <label htmlFor="motivo-rechazo" className="block font-medium">Motivo obligatorio para rechazar (1–500 puntos de código)</label>
        <textarea id="motivo-rechazo" rows={4} value={decision.motivo} disabled={decision.enviando} onChange={e => controlador.fijarMotivoDecision(e.currentTarget.value)} aria-describedby="motivo-ayuda motivo-contador motivo-validacion" className="w-full rounded border border-slate-300 p-3" />
        <p id="motivo-ayuda" className="text-sm">Se permiten saltos de línea y tabulaciones; los demás caracteres de control no están permitidos.</p>
        <p id="motivo-contador" aria-live="polite" className="text-sm">{[...decision.motivo.trim()].length} / 500 puntos de código</p>
        <p id="motivo-validacion" role="status" className="text-sm">{motivoValido ? 'Motivo válido.' : 'Ingresá un motivo válido de 1 a 500 puntos de código, sin caracteres de control no permitidos.'}</p>
      </>}
      <p role="status" aria-live="polite">{decision.enviando ? 'Enviando decisión…' : 'La instantánea no se actualizará automáticamente.'}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={decision.enviando || decision.requiereRecarga || decision.accionesBloqueadas.includes(decision.accion) || (decision.accion === 'rechazar' && !motivoValido)} onClick={controlador.confirmarDecision} className="rounded-lg bg-blue-900 px-4 py-2 font-medium text-white">{decision.enviando ? 'Enviando…' : decision.accion === 'aprobar' ? 'Confirmar aprobación' : 'Confirmar rechazo'}</button>
        <button type="button" disabled={decision.enviando} onClick={controlador.cancelarDecision} className="rounded-lg border border-slate-400 px-4 py-2">Cancelar</button>
      </div>
    </section>}
  </section>
}

function AccionAplicar({ controlador, detalle, puedeAplicar }: { controlador: ControladorPanel; detalle: Detalle; puedeAplicar: boolean }) {
  const estado = useSyncExternalStore(controlador.suscribir, controlador.obtenerAplicacion, controlador.obtenerAplicacion)
  const encabezado = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (estado.confirmar) encabezado.current?.focus() }, [estado.confirmar])
  const id = detalle.propuesta.propuesta_id
  const error = estado.error
  const mensaje = error?.autenticacionVencida ? 'La sesión venció. Iniciá sesión nuevamente; no se reenviará la aplicación.' : error?.fallo === 'permiso' ? 'Falta autorización o permiso para aplicar.' : error?.fallo === 'no_encontrado' ? 'La propuesta ya no existe.' : error?.fallo === 'cambio' ? 'La instantánea cambió desde que la viste. Compará el estado actual y recargá.' : error?.fallo === 'no_aplica' ? 'El destino no cambió, pero la propuesta puede haber cambiado y necesita recarga.' : error?.fallo === 'solicitud' ? 'El servidor no aceptó la solicitud. No se repitió.' : error?.fallo === 'no_disponible' ? 'El servicio o la fuente no están disponibles. No se repitió la aplicación.' : error?.fallo === 'incierto' ? 'El resultado es incierto. No vuelvas a aplicar; recargá explícitamente la propuesta.' : null
  const bloqueada = estado.propuestaId === id && (estado.requiereRecarga || estado.enviando)
  const permiso = puedeAplicar && detalle.acciones_permitidas.includes('aplicar') && !bloqueada
  return <section aria-labelledby="titulo-aplicacion" className="space-y-4 rounded-xl border border-slate-300 bg-white p-5">
    <h3 id="titulo-aplicacion" className="text-lg font-semibold">Aplicación</h3>
    {!puedeAplicar && <p role="status">Tu sesión no tiene permiso para aplicar.</p>}
    {detalle.acciones_bloqueadas.aplicar.length > 0 && <><h4 className="font-medium">Aplicación bloqueada por el servidor</h4><Textos valores={detalle.acciones_bloqueadas.aplicar.map(m => MOTIVOS[m] ? `${MOTIVOS[m]} (${m})` : m)} vacio="Sin motivos informados." /></>}
    {detalle.acciones_permitidas.includes('aplicar') && puedeAplicar && !bloqueada && !estado.confirmar && estado.registrada?.propuesta_id !== id && <button type="button" onClick={controlador.prepararAplicacion} className="rounded-lg bg-slate-800 px-4 py-2 font-medium text-white hover:bg-slate-700">Aplicar desde el panel</button>}
    {bloqueada && <p role="alert">La aplicación está bloqueada hasta una recarga explícita exitosa del detalle.</p>}
    {estado.registrada?.propuesta_id === id && <div role="status" className="rounded-lg border border-green-300 bg-green-50 p-4"><h4 className="font-semibold">Aplicación registrada{estado.registrada.ya_aplicada ? ' (reenvío idéntico, ya aplicada)' : ''}</h4><p>Destino modificado; estado nuevo: Aplicada.</p><Datos><Dato nombre="Evento ID">{estado.registrada.evento_id}</Dato><Dato nombre="Intento ID">{estado.registrada.intento_id}</Dato><Dato nombre="Fecha"><Fecha fecha={estado.registrada.aplicado_en} /></Dato></Datos></div>}
    {error && <div role="alert" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4"><p>{mensaje}</p>{error.fallo === 'cambio' && <Datos><Dato nombre="Instantánea vista">Estado aprobada; payload_hash {estado.instantanea?.payload_hash_esperado ?? 'No disponible'}; versión {estado.instantanea?.version_coordinacion_esperada ?? 'No disponible'}; decisión {estado.instantanea?.decision_aprobacion_id_esperado ?? 'No disponible'}.</Dato><Dato nombre="Actual devuelto por el servidor">Estado {error.actual?.estado ?? 'No disponible'}; payload_hash {error.actual?.payload_hash ?? 'No disponible'}; versión {error.actual?.version_coordinacion ?? 'No disponible'}; decisión {error.actual?.decision_aprobacion_id ?? 'No disponible'}.</Dato></Datos>}{error.fallo === 'no_aplica' && <p>Resultado: {error.resultado ?? 'No disponible'}; estado conocido: {error.estadoNuevo ?? 'No disponible'}; intento: {error.intentoId ?? 'No disponible'}. El destino no cambió.</p>}{error.requestId && <p>Request ID: <code className="break-all">{error.requestId}</code></p>}{error.fallo !== 'permiso' && error.fallo !== 'no_encontrado' && <button type="button" disabled={estado.enviando} onClick={controlador.reintentarDetalle} className="rounded border border-slate-300 px-3 py-2">Recargar propuesta</button>}{error.fallo === 'no_encontrado' && <button type="button" disabled={estado.enviando} onClick={controlador.volverAlListado} className="rounded border border-slate-300 px-3 py-2">Volver al listado</button>}</div>}
    {estado.confirmar && estado.propuestaId === id && estado.instantanea && <section aria-labelledby="titulo-confirmar-aplicar" className="space-y-4 rounded-lg border border-red-300 bg-red-50 p-4">
      <h4 id="titulo-confirmar-aplicar" ref={encabezado} tabIndex={-1} className="font-semibold">Confirmar aplicación de la propuesta</h4>
      <p className="font-semibold text-red-900">Esto modificará el buscador público</p>
      <Datos><Dato nombre="País">{textoValor(detalle.requisito_actual.destino?.pais ?? null)}</Dato><Dato nombre="Requisito">{textoValor(detalle.requisito_actual.requisito?.nombre ?? null)}</Dato><Dato nombre="Campo">{textoValor(detalle.propuesta.campo)}</Dato><Dato nombre="Valor actual">{textoPresencia(detalle.requisito_actual.valor_actual)}</Dato><Dato nombre="Valor nuevo">{textoValor(detalle.propuesta.valor_propuesto.valor)}</Dato></Datos>
      <p>Instantánea que se enviará: estado aprobada; payload_hash <code className="break-all">{estado.instantanea.payload_hash_esperado}</code>; versión {estado.instantanea.version_coordinacion_esperada}; decisión <code className="break-all">{estado.instantanea.decision_aprobacion_id_esperado}</code>.</p>
      <p role="status" aria-live="polite">{estado.enviando ? 'Aplicando…' : 'La solicitud no se repetirá automáticamente.'}</p>
      <div className="flex flex-wrap gap-3"><button type="button" disabled={!permiso || estado.enviando} onClick={controlador.confirmarAplicacion} className="rounded-lg bg-red-800 px-4 py-2 font-medium text-white">{estado.enviando ? 'Aplicando…' : 'Confirmar aplicación'}</button><button type="button" disabled={estado.enviando} onClick={controlador.cancelarAplicacion} className="rounded-lg border border-slate-400 px-4 py-2">Cancelar</button></div>
    </section>}
  </section>
}
