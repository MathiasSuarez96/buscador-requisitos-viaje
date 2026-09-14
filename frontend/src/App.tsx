import { useRef, useState, useEffect } from 'react'
import logoToctoc from './assets/toctoc-logo.png'
import logoSantander from './assets/santander-logo.png'

interface Requisito {
  tipo: string
  nombre: string
  obligatorio: 'si' | 'no' | 'verificar'
  descripcion: string
  fuente: string
  link?: string
  plazo_antes_del_vuelo?: string
  costo?: string
  fecha_verificacion: string
  estado: 'confirmado' | 'verificar'
}

interface ReglaGeneral {
  contenido: string
  fuente: string
  fecha_verificacion?: string
  estado: string
  pendiente_confirmar: string[]
}

interface Destino {
  _id: string
  pais: string
  codigo_iso: string
  requisitos: Requisito[]
  regla_general?: ReglaGeneral | null
}

const nombresPorTipo: Record<string, string> = {
  visa: 'Visa',
  formulario_digital: 'Formulario digital',
  vacuna: 'Vacuna',
  validez_pasaporte: 'Validez de pasaporte',
  documentacion_menor: 'Documentación de menor',
  tasa_aeropuerto: 'Tasa de aeropuerto',
  seguro_medico: 'Seguro médico',
}

const nombresPorPendiente: Record<string, string> = {
  cantidad_maxima_de_viajes: 'Cantidad máxima de viajes autorizados',
  via_consular: 'Si se puede tramitar en consulados en el exterior',
}

const formatearFechaReglaGeneral = (fecha?: string) => {
  if (!fecha) return 'Sin fecha de verificación'

  const fechaIso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(fecha)
  let fechaParseada: Date

  if (fechaIso) {
    if (fecha.includes('T') && Number.isNaN(new Date(fecha).getTime())) {
      return 'Sin fecha de verificación'
    }

    const [, anio, mes, dia] = fechaIso
    fechaParseada = new Date(
      Date.UTC(Number(anio), Number(mes) - 1, Number(dia), 12)
    )

    if (
      fechaParseada.getUTCFullYear() !== Number(anio) ||
      fechaParseada.getUTCMonth() !== Number(mes) - 1 ||
      fechaParseada.getUTCDate() !== Number(dia)
    ) {
      return 'Sin fecha de verificación'
    }
  } else {
    fechaParseada = new Date(fecha)
  }

  if (Number.isNaN(fechaParseada.getTime())) {
    return 'Sin fecha de verificación'
  }

  return fechaParseada.toLocaleDateString('es-UY', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Montevideo',
  })
}

function App() {
  const [destinos, setDestinos] = useState<Destino[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [marca, setMarca] = useState<'toctoc' | 'santander'>('toctoc')
  const [destinoSeleccionado, setDestinoSeleccionado] = useState<Destino | null>(null)
  const [cargandoListado, setCargandoListado] = useState(true)
  const [errorListado, setErrorListado] = useState<string | null>(null)
  const [codigoDestinoCargando, setCodigoDestinoCargando] = useState<string | null>(null)
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null)
  const solicitudDetalleActual = useRef(0)

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/destinos`)
      .then((response) => response.json())
      .then((data) => setDestinos(data))
      .catch(() => setErrorListado('No se pudo conectar con el servidor.'))
      .finally(() => setCargandoListado(false))
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', marca)
  }, [marca])

  const destinosFiltrados = destinos.filter((destino) =>
    destino.pais.toLowerCase().includes(busqueda.toLowerCase())
  )

  const reglaGeneral = destinoSeleccionado?.regla_general
  const reglaConfirmada =
    reglaGeneral?.estado === 'confirmado' &&
    reglaGeneral.pendiente_confirmar.length === 0
  const requisitosMenores = destinoSeleccionado?.requisitos.filter(
    (req) => req.tipo === 'documentacion_menor'
  ) ?? []
  const requisitosOrdenados = [
    ...requisitosMenores,
    ...(destinoSeleccionado?.requisitos.filter(
      (req) => req.tipo !== 'documentacion_menor'
    ) ?? []),
  ]
  const avisoMenores =
    'Pendiente de verificar los requisitos específicos de menores para este destino.'

  const seleccionarDestino = async (destino: Destino) => {
    const solicitudActual = solicitudDetalleActual.current + 1
    solicitudDetalleActual.current = solicitudActual
    setErrorDetalle(null)
    setCodigoDestinoCargando(destino.codigo_iso)

    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL}/api/destinos/${destino.codigo_iso}`
      )

      if (!response.ok) {
        throw new Error()
      }

      const detalle: Destino = await response.json()

      if (solicitudDetalleActual.current === solicitudActual) {
        setDestinoSeleccionado(detalle)
      }
    } catch {
      if (solicitudDetalleActual.current === solicitudActual) {
        setErrorDetalle('No se pudo cargar el detalle del destino. Intentá nuevamente.')
      }
    } finally {
      if (solicitudDetalleActual.current === solicitudActual) {
        setCodigoDestinoCargando(null)
      }
    }
  }

  return (
    <div className="min-h-screen bg-[var(--color-fondo-suave)] py-10 px-4 font-sans">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
          <img
            src={marca === 'toctoc' ? logoToctoc : logoSantander}
            alt={marca === 'toctoc' ? 'TocToc Viajes' : 'Viajes Soy Santander'}
            className="h-10"
          />
          <button
            onClick={() => setMarca(marca === 'toctoc' ? 'santander' : 'toctoc')}
            className="bg-[var(--color-primario)] text-white px-4 py-2 rounded-lg font-medium hover:bg-[var(--color-primario-hover)] transition-colors"
          >
            Cambiar a {marca === 'toctoc' ? 'Soy Santander' : 'TocToc'}
          </button>
        </div>

        {destinoSeleccionado ? (
          <div>
            <button
              onClick={() => setDestinoSeleccionado(null)}
              className="mb-6 text-[var(--color-primario)] font-medium"
            >
              ← Volver
            </button>

            <div className="flex items-center gap-3 mb-6">
              <img
                src={`https://flagcdn.com/w40/${destinoSeleccionado.codigo_iso.toLowerCase()}.png`}
                alt={destinoSeleccionado.pais}
                className="w-10 h-7 object-cover rounded"
              />
              <h1 className="text-3xl font-bold text-gray-900">
                {destinoSeleccionado.pais}
              </h1>
            </div>

            <div className="space-y-3">
              {reglaGeneral && (
                <div
                  className="bg-white rounded-xl shadow-sm p-4 border-l-4"
                  style={{
                    borderColor: reglaConfirmada ? '#22c55e' : '#f59e0b',
                  }}
                >
                  <div className="flex flex-col md:flex-row justify-between items-start gap-2 mb-1">
                    <span className="font-semibold text-gray-800">
                      Salida de menores desde Uruguay
                    </span>
                    <span
                      className="text-xs font-medium px-2 py-1 rounded-full"
                      style={{
                        backgroundColor: reglaConfirmada ? '#dcfce7' : '#fef3c7',
                        color: reglaConfirmada ? '#166534' : '#92400e',
                      }}
                    >
                      {reglaConfirmada ? 'Confirmado' : 'Verificar'}
                    </span>
                  </div>

                  <p className="text-sm text-gray-600 mb-2">
                    {reglaGeneral.contenido}
                  </p>

                  {reglaGeneral.pendiente_confirmar.length > 0 && (
                    <ul className="text-sm text-gray-600 list-disc pl-5 mb-2">
                      {reglaGeneral.pendiente_confirmar.map((pendiente, pendienteIndex) => (
                        <li key={pendienteIndex}>
                          {nombresPorPendiente[pendiente] ?? pendiente}
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="text-xs text-gray-400">
                    Fuente:{' '}
                    <a
                      href={reglaGeneral.fuente}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-primario)] underline"
                    >
                      {reglaGeneral.fuente}
                    </a>
                    {' — '}Verificado:{' '}
                    {formatearFechaReglaGeneral(reglaGeneral.fecha_verificacion)}
                  </p>
                </div>
              )}

              {requisitosMenores.length === 0 && (
                <div className="bg-white rounded-xl shadow-sm p-4 border-l-4 border-amber-500">
                  <div className="flex flex-col md:flex-row justify-between items-start gap-2 mb-1">
                    <span className="font-semibold text-gray-800">
                      {nombresPorTipo.documentacion_menor}
                    </span>
                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-amber-100 text-amber-800">
                      Verificar
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2">{avisoMenores}</p>
                </div>
              )}

              {requisitosOrdenados.map((req, index) => {
                const menorPendiente = req.tipo === 'documentacion_menor' && (
                  (req.descripcion ?? '').trim().toLowerCase() === '' ||
                  (req.descripcion ?? '').trim().toLowerCase() === 'verificar'
                )
                const requisitoConfirmado = req.estado === 'confirmado' && !menorPendiente

                return (
                  <div
                    key={index}
                      className="bg-white rounded-xl shadow-sm p-4 border-l-4"
                      style={{
                        borderColor: requisitoConfirmado ? '#22c55e' : '#f59e0b',
                      }}
                    >
                  <div className="flex flex-col md:flex-row justify-between items-start gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">
                        {req.nombre || nombresPorTipo[req.tipo]}
                      </span>
                      {req.obligatorio === 'si' && (
                        <span className="text-xs font-medium text-red-600">
                          Obligatorio
                        </span>
                      )}
                      {req.obligatorio === 'verificar' && (
                        <span className="text-xs font-medium text-amber-600">
                          Obligatoriedad a verificar
                        </span>
                      )}
                    </div>
                    <span
                      className="text-xs font-medium px-2 py-1 rounded-full"
                      style={{
                        backgroundColor: requisitoConfirmado ? '#dcfce7' : '#fef3c7',
                        color: requisitoConfirmado ? '#166534' : '#92400e',
                      }}
                    >
                      {requisitoConfirmado ? 'Confirmado' : 'Verificar'}
                    </span>
                  </div>

                  <p className="text-sm text-gray-600 mb-2">{req.descripcion}</p>
                  {menorPendiente && (
                    <p className="text-sm text-gray-600 mb-2">{avisoMenores}</p>
                  )}

                  {req.link && (
                    <a
                      href={req.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[var(--color-primario)] underline block mb-2"
                    >
                      Ir al formulario →
                    </a>
                  )}

                  {(req.plazo_antes_del_vuelo || req.costo) && (
                    <p className="text-xs text-gray-500 mb-2">
                      {req.plazo_antes_del_vuelo && `Plazo: ${req.plazo_antes_del_vuelo}`}
                      {req.plazo_antes_del_vuelo && req.costo && ' — '}
                      {req.costo && `Costo: ${req.costo}`}
                    </p>
                  )}

                  <p className="text-xs text-gray-400">
                    Fuente: {req.fuente} — Verificado:{' '}
                    {formatearFechaReglaGeneral(req.fecha_verificacion)}
                  </p>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <>
            <h1 className="text-2xl md:text-3xl font-bold text-center text-gray-900 mb-6">
              Buscador de Requisitos de Viaje
            </h1>

            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar país..."
              className="w-full max-w-md mx-auto block border border-gray-300 rounded-lg px-4 py-2 mb-8 shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primario)]"
            />

            {cargandoListado && (
              <p className="text-center text-gray-500">Cargando destinos...</p>
            )}

            {!cargandoListado && errorListado && (
              <p className="text-center text-red-600">{errorListado}</p>
            )}

            {!cargandoListado && !errorListado && destinosFiltrados.length === 0 && (
              <p className="text-center text-gray-500">No se encontraron destinos.</p>
            )}

            {errorDetalle && (
              <p className="text-center text-red-600 mb-4">{errorDetalle}</p>
            )}

            {codigoDestinoCargando && (
              <p className="text-center text-gray-500 mb-4">
                Cargando detalle del destino...
              </p>
            )}

            {!cargandoListado && !errorListado && destinosFiltrados.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {destinosFiltrados.map((destino) => (
                  <div
                    key={destino._id}
                    onClick={() => seleccionarDestino(destino)}
                    className="bg-white rounded-xl shadow-sm p-4 flex items-center gap-3 hover:shadow-md transition-shadow border-t-4 border-[var(--color-primario)] cursor-pointer"
                  >
                    <img
                      src={`https://flagcdn.com/w40/${destino.codigo_iso.toLowerCase()}.png`}
                      alt={destino.pais}
                      className="w-10 h-7 object-cover rounded"
                    />
                    <span className="font-medium text-gray-800">{destino.pais}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default App
