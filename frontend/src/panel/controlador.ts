// Estado del panel, independiente de React. El pase de Google vive solo en
// la variable `token` de este cierre: nunca va al estado observable, al
// almacenamiento del navegador, a la URL ni a la consola.
//
// Dependencias inyectables (con las reales por defecto): el cargador de GIS
// y fetch. Primera versión: botón de Google → GET /api/panel/sesion.

import type { ConfigPanel } from './config.ts'
import { crearCargadorGis, type CargadorGis } from './cargar-gis.ts'
import { consultarSesion, type HacerFetch, type SesionPanel } from './sesion.ts'

export type TipoError = 'configuracion' | 'gis_no_disponible' | 'sin_conexion' | 'credencial_invalida' | 'servidor'

export interface ErrorPanel {
  tipo: TipoError
  codigo: string | null
  requestId: string | null
}

export type EstadoPanel =
  | { fase: 'cargando_gis' }
  | { fase: 'sin_sesion'; aviso: 'sesion_vencida' | null }
  | { fase: 'verificando' }
  | { fase: 'autorizado'; sesion: SesionPanel }
  | { fase: 'no_autorizado'; sesion: SesionPanel }
  | { fase: 'error'; error: ErrorPanel }

export interface ControladorPanel {
  obtenerEstado(): EstadoPanel
  suscribir(oyente: () => void): () => void
  iniciar(): void
  mostrarBoton(contenedor: HTMLElement): void
  cerrarSesion(): void
  volverAlInicio(): void
  tieneToken(): boolean
}

export interface DependenciasPanel {
  config: ConfigPanel | null
  cargarGis?: CargadorGis
  hacerFetch?: HacerFetch
}

// Forma JWS compacta y el mismo tope que el backend (LARGO_MAXIMO_TOKEN).
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const LARGO_MAXIMO_TOKEN = 4096

const BOTON: GisButtonConfiguration = { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', locale: 'es' }

const error = (tipo: TipoError, codigo: string | null = null, requestId: string | null = null): EstadoPanel => ({
  fase: 'error',
  error: { tipo, codigo, requestId },
})

export function crearControladorPanel({
  config,
  cargarGis = crearCargadorGis(),
  hacerFetch = (url, init) => fetch(url, init),
}: DependenciasPanel): ControladorPanel {
  let estado: EstadoPanel = config ? { fase: 'cargando_gis' } : error('configuracion')
  let token: string | null = null
  let gis: GisAccountsId | null = null
  let iniciado = false
  // Cada inicio o cierre de sesión invalida las respuestas anteriores.
  let consulta = 0
  const oyentes = new Set<() => void>()

  const fijar = (nuevo: EstadoPanel) => {
    estado = nuevo
    for (const oyente of oyentes) oyente()
  }

  async function recibirCredencial(respuesta: GisCredentialResponse | undefined) {
    if (!config) return
    consulta += 1
    const mia = consulta
    token = null
    const credencial = respuesta?.credential
    if (typeof credencial !== 'string' || credencial.length > LARGO_MAXIMO_TOKEN || !JWT.test(credencial)) {
      fijar(error('credencial_invalida'))
      return
    }
    token = credencial
    fijar({ fase: 'verificando' })
    const resultado = await consultarSesion(config.apiOrigen, credencial, hacerFetch)
    if (mia !== consulta) return
    switch (resultado.tipo) {
      case 'ok':
        fijar(resultado.sesion.autorizado ? { fase: 'autorizado', sesion: resultado.sesion } : { fase: 'no_autorizado', sesion: resultado.sesion })
        return
      case 'no_autenticado':
        token = null
        fijar({ fase: 'sin_sesion', aviso: 'sesion_vencida' })
        return
      case 'sin_conexion':
        token = null
        fijar(error('sin_conexion'))
        return
      case 'error':
        token = null
        fijar(error('servidor', resultado.codigo, resultado.requestId))
        return
    }
  }

  async function cargar(cfg: ConfigPanel) {
    try {
      const id = await cargarGis()
      id.initialize({
        client_id: cfg.clientId,
        callback: (respuesta) => {
          void recibirCredencial(respuesta)
        },
        auto_select: false,
        ux_mode: 'popup',
      })
      gis = id
      fijar({ fase: 'sin_sesion', aviso: null })
    } catch {
      fijar(error('gis_no_disponible'))
    }
  }

  return {
    obtenerEstado: () => estado,
    suscribir(oyente) {
      oyentes.add(oyente)
      return () => {
        oyentes.delete(oyente)
      }
    },
    // Idempotente: StrictMode ejecuta los efectos dos veces en desarrollo.
    iniciar() {
      if (iniciado || !config) return
      iniciado = true
      void cargar(config)
    },
    mostrarBoton(contenedor) {
      if (!gis) return
      try {
        contenedor.replaceChildren()
        gis.renderButton(contenedor, BOTON)
      } catch {
        fijar(error('gis_no_disponible'))
      }
    },
    cerrarSesion() {
      consulta += 1
      token = null
      try {
        gis?.disableAutoSelect()
      } catch {
        // Sin efecto en el estado: la sesión del panel ya quedó cerrada.
      }
      fijar(gis ? { fase: 'sin_sesion', aviso: null } : error('gis_no_disponible'))
    },
    volverAlInicio() {
      consulta += 1
      token = null
      if (gis) fijar({ fase: 'sin_sesion', aviso: null })
    },
    tieneToken: () => token !== null,
  }
}
