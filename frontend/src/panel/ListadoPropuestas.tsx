import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ControladorPanel } from './controlador.ts'
import { ESTADOS, type EstadoPropuesta, type FalloListado } from './propuestas.ts'

const NOMBRES: Record<EstadoPropuesta, string> = { pendiente_aprobacion: 'Pendiente de aprobación', aprobada: 'Aprobada', rechazada: 'Rechazada', obsoleta: 'Obsoleta', revision_requerida: 'Revisión requerida', conflicto: 'Conflicto', cancelada: 'Cancelada', aplicada: 'Aplicada' }
const ERRORES: Record<FalloListado, string> = {
  sesion: 'Tu sesión venció. Iniciá sesión nuevamente para continuar. Conservamos la vista del listado.',
  permiso: 'No tenés permiso para consultar propuestas (403).',
  servidor: 'El servidor no pudo completar la consulta (500). Podés intentar nuevamente.',
  no_disponible: 'El panel no está disponible temporalmente (503). Intentá más tarde.',
  conexion: 'No se pudo conectar. Puede ser un problema de red o de acceso CORS. Intentá nuevamente.',
  respuesta: 'No pudimos leer una respuesta válida y completa. Recargá el listado para intentar nuevamente.',
}
const ALERTAS: Record<string, string> = { hash_no_coincide: 'El contenido no coincide con su huella registrada.', datos_inconsistentes: 'La propuesta contiene datos inconsistentes.' }
const fechaVisible = (fecha: string | null) => fecha === null ? 'Fecha no disponible' : new Intl.DateTimeFormat('es-UY', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Montevideo' }).format(new Date(fecha))

export function ListadoPropuestas({ controlador, habilitado, copiar }: { controlador: ControladorPanel; habilitado: boolean; copiar: (texto: string) => Promise<void> }) {
  const vista = useSyncExternalStore(controlador.suscribir, controlador.obtenerListado, controlador.obtenerListado)
  const [estados, setEstados] = useState<EstadoPropuesta[]>(vista.filtro.estados)
  const [limite, setLimite] = useState(vista.filtro.limite)
  const [copia, setCopia] = useState<string | null>(null)
  const anuncio = useRef<HTMLParagraphElement>(null)
  const enfocarAlTerminar = useRef(false)
  useEffect(() => {
    if (!vista.cargando && enfocarAlTerminar.current) {
      enfocarAlTerminar.current = false
      anuncio.current?.focus()
    }
  }, [vista.cargando])
  const aplicar = () => controlador.filtrar({ estados, limite })
  return <section aria-labelledby="titulo-propuestas" className="mt-8 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="titulo-propuestas" className="text-xl font-semibold">Propuestas de cambio</h2>
      <button type="button" disabled={!habilitado || vista.cargando} onClick={controlador.recargar} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm">Recargar listado</button>
    </div>
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <fieldset disabled={!habilitado}>
        <legend className="mb-3 font-medium">Filtrar por estado</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ESTADOS.map(e => <label key={e} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={estados.includes(e)} onChange={() => setEstados(prev => ESTADOS.filter(x => x === e ? !prev.includes(x) : prev.includes(x)))} />{NOMBRES[e]}
          </label>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="limite-propuestas" className="text-sm">Propuestas por página (1–50)</label>
          <input id="limite-propuestas" type="number" min="1" max="50" step="1" value={Number.isNaN(limite) ? '' : limite} onChange={e => setLimite(e.currentTarget.valueAsNumber)} className="w-20 rounded border border-slate-300 px-2 py-2" />
          <button type="button" onClick={aplicar} disabled={estados.length === 0 || !Number.isInteger(limite) || limite < 1 || limite > 50} className="rounded-lg bg-slate-800 px-4 py-2 text-white hover:bg-slate-700">Aplicar filtros</button>
          {estados.length === 0 && <p role="status" className="text-sm text-amber-800">Seleccioná al menos un estado.</p>}
        </div>
      </fieldset>
      <p className="mt-3 text-sm text-slate-600">Filtro aplicado: {vista.filtro.estados.map(e => NOMBRES[e]).join(', ')} · {vista.filtro.limite} por página.</p>
    </div>
    {vista.error && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4">{ERRORES[vista.error]}</div>}
    <p ref={anuncio} tabIndex={-1} role="status" aria-live="polite" className="text-sm text-slate-700">{vista.cargando ? 'Cargando propuestas…' : vista.cargado ? `${vista.propuestas.length} propuestas cargadas.` : 'El listado aún no se ha cargado.'}</p>
    {vista.cargado && !vista.cargando && !vista.error && vista.propuestas.length === 0 && <p className="rounded-xl border border-slate-200 bg-white p-6">No hay propuestas para los estados seleccionados.</p>}
    <ul aria-busy={vista.cargando} aria-label="Propuestas" className="grid gap-4 md:grid-cols-2">
      {vista.propuestas.map(p => <li key={p.propuesta_id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="break-words text-lg font-semibold">{p.destino?.pais || (p.destino === null ? 'Destino no disponible' : 'País no disponible')}</h3>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium">{p.estado ? NOMBRES[p.estado] : 'Estado no disponible'}</span>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div><dt className="inline font-medium">Código ISO: </dt><dd className="inline">{p.destino?.codigo_iso ?? 'No disponible'}</dd></div>
          <div><dt className="inline font-medium">Campo afectado: </dt><dd className="inline break-words">{p.campo === 'costo' ? 'Costo' : p.campo ?? 'No disponible'}</dd></div>
          <div><dt className="inline font-medium">Creada: </dt><dd className="inline">{p.creada_en ? <time dateTime={p.creada_en}>{fechaVisible(p.creada_en)}</time> : 'Fecha no disponible'} (Montevideo)</dd></div>
          <div><dt className="font-medium">Requisito</dt><dd className="break-all font-mono text-xs">{p.requisito_id ?? 'Identificador no disponible'}</dd></div>
          <div><dt className="font-medium">Propuesta</dt><dd className="break-all font-mono text-xs">{p.propuesta_id}</dd></div>
        </dl>
        {p.destino === null && <p className="mt-3 text-sm text-amber-800">No se pudo identificar el destino de esta propuesta.</p>}
        {p.alertas.length > 0 && <ul aria-label="Alertas" className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800">{p.alertas.map((a, i) => <li key={`${a}-${i}`}>{ALERTAS[a] ?? `Alerta de integridad: ${a}`}</li>)}</ul>}
        <button type="button" aria-pressed={vista.seleccion === p.propuesta_id} onClick={() => controlador.seleccionar(p.propuesta_id)} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100">{vista.seleccion === p.propuesta_id ? 'Propuesta seleccionada' : 'Seleccionar propuesta'}</button>
        {vista.seleccion === p.propuesta_id && <p role="status" className="mt-2 text-sm text-slate-600">El detalle y las decisiones estarán disponibles en un próximo bloque.</p>}
      </li>)}
    </ul>
    {vista.cursor && <button type="button" disabled={!habilitado || vista.cargando || vista.error === 'permiso'} onClick={() => { enfocarAlTerminar.current = true; controlador.cargarMas() }} className="rounded-lg bg-slate-800 px-5 py-3 text-white hover:bg-slate-700">Cargar más</button>}
    {vista.requestId && <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <span>Request ID: <code className="break-all">{vista.requestId}</code></span>
      <button type="button" className="rounded border border-slate-300 px-2 py-1" onClick={() => { const id = vista.requestId!; void Promise.resolve().then(() => copiar(id)).then(() => setCopia(`Copiado: ${id}`), () => setCopia('No se pudo copiar. Seleccioná el identificador para copiarlo manualmente.')) }}>Copiar request ID</button>
      {copia && <span role="status">{copia}</span>}
    </div>}
  </section>
}
