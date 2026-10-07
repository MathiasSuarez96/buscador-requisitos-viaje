import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ControladorPanel, ErrorPanel } from './controlador.ts'
import { MENSAJES, mensajeError } from './mensajes.ts'
import type { SesionPanel } from './sesion.ts'

const copiarAlPortapapeles = (texto: string) => navigator.clipboard.writeText(texto)

interface Props {
  controlador: ControladorPanel
  copiar?: (texto: string) => Promise<void>
}

export function PanelApp({ controlador, copiar = copiarAlPortapapeles }: Props) {
  const estado = useSyncExternalStore(controlador.suscribir, controlador.obtenerEstado, controlador.obtenerEstado)

  useEffect(() => {
    controlador.iniciar()
  }, [controlador])

  return (
    <main className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="mx-auto max-w-xl px-4 py-12">
        <h1 className="mb-6 text-2xl font-semibold">Panel de propuestas</h1>
        {estado.fase === 'cargando_gis' && <p role="status">{MENSAJES.cargando}</p>}
        {estado.fase === 'sin_sesion' && (
          <section className="space-y-4">
            {estado.aviso === 'sesion_vencida' && (
              <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3">
                {MENSAJES.sesionVencida}
              </p>
            )}
            <p>Iniciá sesión con tu cuenta de Google para continuar.</p>
            <BotonGoogle controlador={controlador} />
          </section>
        )}
        {estado.fase === 'verificando' && <p role="status">{MENSAJES.verificando}</p>}
        {(estado.fase === 'autorizado' || estado.fase === 'no_autorizado') && (
          <DatosSesion sesion={estado.sesion} copiar={copiar} onCerrar={controlador.cerrarSesion} />
        )}
        {estado.fase === 'error' && <VistaError error={estado.error} onVolver={controlador.volverAlInicio} />}
      </div>
    </main>
  )
}

function BotonGoogle({ controlador }: { controlador: ControladorPanel }) {
  const contenedor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (contenedor.current) controlador.mostrarBoton(contenedor.current)
  }, [controlador])
  return <div ref={contenedor} data-boton-google="" />
}

function DatosSesion({ sesion, copiar, onCerrar }: { sesion: SesionPanel; copiar: (texto: string) => Promise<void>; onCerrar: () => void }) {
  const [copia, setCopia] = useState<'copiado' | 'fallo' | null>(null)
  const { identidad } = sesion

  const copiarSub = () => {
    copiar(identidad.sub).then(
      () => setCopia('copiado'),
      () => setCopia('fallo'),
    )
  }

  return (
    <section className="space-y-4">
      <p role="status" className={`rounded border p-3 ${sesion.autorizado ? 'border-green-300 bg-green-50' : 'border-amber-300 bg-amber-50'}`}>
        {sesion.autorizado ? `Autorizado como ${sesion.identificador}` : MENSAJES.noAutorizado}
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
        <dt className="font-medium">Email</dt>
        <dd>
          {identidad.email} {identidad.email_verificado ? '(verificado)' : '(no verificado)'}
        </dd>
        <dt className="font-medium">Sub</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <code className="break-all">{identidad.sub}</code>
          <button type="button" onClick={copiarSub} className="rounded border border-slate-300 px-2 py-0.5 text-sm hover:bg-slate-100">
            Copiar
          </button>
          {copia === 'copiado' && <span className="text-sm text-green-700">Copiado</span>}
          {copia === 'fallo' && <span className="text-sm text-red-700">No se pudo copiar</span>}
        </dd>
        <dt className="font-medium">Proveedor</dt>
        <dd>{identidad.proveedor}</dd>
        <dt className="font-medium">Autorizado</dt>
        <dd>{sesion.autorizado ? 'Sí' : 'No'}</dd>
        <dt className="font-medium">Permisos</dt>
        <dd>{sesion.permisos.length > 0 ? sesion.permisos.join(', ') : 'ninguno'}</dd>
      </dl>
      <button type="button" onClick={onCerrar} className="rounded bg-slate-800 px-4 py-2 text-white hover:bg-slate-700">
        Cerrar sesión
      </button>
    </section>
  )
}

function VistaError({ error, onVolver }: { error: ErrorPanel; onVolver: () => void }) {
  const puedeVolver = error.tipo !== 'configuracion' && error.tipo !== 'gis_no_disponible'
  return (
    <section className="space-y-3">
      <p role="alert" className="rounded border border-red-300 bg-red-50 p-3">
        {mensajeError(error)}
      </p>
      {(error.codigo !== null || error.requestId !== null) && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 text-sm text-slate-700">
          {error.codigo !== null && (
            <>
              <dt>Código</dt>
              <dd>
                <code>{error.codigo}</code>
              </dd>
            </>
          )}
          {error.requestId !== null && (
            <>
              <dt>X-Request-Id</dt>
              <dd>
                <code>{error.requestId}</code>
              </dd>
            </>
          )}
        </dl>
      )}
      {puedeVolver && (
        <button type="button" onClick={onVolver} className="rounded border border-slate-300 px-4 py-2 hover:bg-slate-100">
          Volver al inicio
        </button>
      )}
    </section>
  )
}
