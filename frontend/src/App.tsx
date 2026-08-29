import { useState, useEffect } from 'react'
import logoToctoc from './assets/toctoc-logo.png'
import logoSantander from './assets/santander-logo.png'

interface Requisito {
  tipo: string
  nombre: string
  obligatorio: boolean
  descripcion: string
  fuente: string
  link?: string
  plazo_antes_del_vuelo?: string
  costo?: string
  fecha_verificacion: string
  estado: 'confirmado' | 'verificar'
}

interface Destino {
  _id: string
  pais: string
  codigo_iso: string
  requisitos: Requisito[]
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

function App() {
  const [destinos, setDestinos] = useState<Destino[]>([])
  const [busqueda, setBusqueda] = useState('')
  const [marca, setMarca] = useState<'toctoc' | 'santander'>('toctoc')
  const [destinoSeleccionado, setDestinoSeleccionado] = useState<Destino | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/destinos`)
      .then((response) => response.json())
      .then((data) => setDestinos(data))
      .catch(() => setError('No se pudo conectar con el servidor.'))
      .finally(() => setCargando(false))
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', marca)
  }, [marca])

  const destinosFiltrados = destinos.filter((destino) =>
    destino.pais.toLowerCase().includes(busqueda.toLowerCase())
  )

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
              {destinoSeleccionado.requisitos.map((req, index) => (
                <div
                  key={index}
                  className="bg-white rounded-xl shadow-sm p-4 border-l-4"
                  style={{
                    borderColor: req.estado === 'confirmado' ? '#22c55e' : '#f59e0b',
                  }}
                >
                  <div className="flex flex-col md:flex-row justify-between items-start gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">
                        {req.nombre || nombresPorTipo[req.tipo]}
                      </span>
                      {req.obligatorio && (
                        <span className="text-xs font-medium text-red-600">
                          Obligatorio
                        </span>
                      )}
                    </div>
                    <span
                      className="text-xs font-medium px-2 py-1 rounded-full"
                      style={{
                        backgroundColor: req.estado === 'confirmado' ? '#dcfce7' : '#fef3c7',
                        color: req.estado === 'confirmado' ? '#166534' : '#92400e',
                      }}
                    >
                      {req.estado === 'confirmado' ? 'Confirmado' : 'Verificar'}
                    </span>
                  </div>

                  <p className="text-sm text-gray-600 mb-2">{req.descripcion}</p>

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
                    {new Date(req.fecha_verificacion).toLocaleDateString('es-UY', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              ))}
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

            {cargando && (
              <p className="text-center text-gray-500">Cargando destinos...</p>
            )}

            {!cargando && error && (
              <p className="text-center text-red-600">{error}</p>
            )}

            {!cargando && !error && destinosFiltrados.length === 0 && (
              <p className="text-center text-gray-500">No se encontraron destinos.</p>
            )}

            {!cargando && !error && destinosFiltrados.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {destinosFiltrados.map((destino) => (
                  <div
                    key={destino._id}
                    onClick={() => setDestinoSeleccionado(destino)}
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
