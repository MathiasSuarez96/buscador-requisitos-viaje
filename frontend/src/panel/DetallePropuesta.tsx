import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { ControladorPanel } from './controlador.ts'
import { urlHttpsSegura, type Detalle, type FalloDetalle } from './detalle.ts'
import { NOMBRES, textoValor, textoPresencia } from './presentacion.ts'

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
}
const REQUISITO: Record<Detalle['requisito_actual']['estado'], string> = {
  coincide: 'Coincide', destino_no_encontrado: 'Destino no encontrado', requisito_id_no_encontrado: 'Requisito no encontrado',
  requisito_id_duplicado: 'Identificador de requisito duplicado', identidad_semantica_no_coincide: 'La identidad semántica no coincide',
  identidad_no_verificable: 'Identidad no verificable', no_evaluable: 'No evaluable',
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

export function DetallePropuesta({ controlador, habilitado }: { controlador: ControladorPanel; habilitado: boolean }) {
  const vista = useSyncExternalStore(controlador.suscribir, controlador.obtenerDetalle, controlador.obtenerDetalle)
  const titulo = useRef<HTMLHeadingElement>(null)
  useEffect(() => { titulo.current?.focus() }, [vista.propuestaId])
  return <article aria-labelledby="titulo-detalle" className="mt-8 space-y-5">
    <button type="button" onClick={controlador.volverAlListado} className="rounded-lg border border-slate-300 bg-white px-4 py-2">Volver al listado</button>
    <h2 id="titulo-detalle" ref={titulo} tabIndex={-1} className="text-2xl font-semibold">Detalle de propuesta</h2>
    <p className="break-all font-mono text-sm">{vista.propuestaId}</p>
    <p role="status" aria-live="polite">{vista.cargando ? 'Cargando detalle…' : vista.datos ? 'Detalle cargado.' : 'Detalle no disponible.'}</p>
    {vista.error && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4">{ERRORES[vista.error]}</p>}
    {!vista.cargando && !vista.datos && <button type="button" disabled={!habilitado} onClick={controlador.reintentarDetalle} className="rounded-lg bg-slate-800 px-4 py-2 text-white hover:bg-slate-700">Reintentar detalle</button>}
    {vista.requestId && <p className="text-sm">Request ID: <code className="break-all">{vista.requestId}</code></p>}
    <div aria-busy={vista.cargando} className="space-y-5">{vista.datos && <ContenidoDetalle detalle={vista.datos} />}</div>
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
        <Dato nombre="Estado del requisito">{REQUISITO[r.estado]}</Dato><Dato nombre="Comparación del valor">{r.valor === null ? 'No evaluable (null)' : r.valor === 'coincide' ? 'Coincide' : 'Cambió'}</Dato>
        <Dato nombre="Destino ID actual">{textoValor(r.destino?.destino_id ?? null)}</Dato>
      </Datos>
      {r.requisito === null ? <p>Requisito no disponible (null).</p> : <Datos><Dato nombre="Requisito ID actual">{textoValor(r.requisito.requisito_id)}</Dato><Dato nombre="Tipo">{textoValor(r.requisito.tipo)}</Dato><Dato nombre="Nombre">{textoValor(r.requisito.nombre)}</Dato></Datos>}
    </Seccion>
    <Seccion titulo="Acciones informadas por el servidor">
      <p className="text-sm text-slate-600">Vista de solo lectura. Las decisiones todavía no están habilitadas en este panel.</p>
      <h4 className="font-semibold">Acciones permitidas</h4><Textos valores={d.acciones_permitidas.map(a => a === 'aprobar' ? 'Aprobar' : 'Rechazar')} vacio="Ninguna acción permitida." />
      <div className="grid gap-4 sm:grid-cols-2">{(['aprobar', 'rechazar'] as const).map(a => <section key={a} className="space-y-2 rounded-lg bg-slate-50 p-4"><h4 className="font-semibold">{a === 'aprobar' ? 'Aprobar: bloqueos' : 'Rechazar: bloqueos'}</h4><Textos valores={d.acciones_bloqueadas[a].map(m => MOTIVOS[m] ? `${MOTIVOS[m]} (${m})` : m)} vacio="Sin motivos de bloqueo." /></section>)}</div>
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
