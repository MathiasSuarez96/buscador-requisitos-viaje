// Estado del panel, independiente de React. El pase de Google vive solo en
// la variable `token` de este cierre: nunca va al estado observable, al
// almacenamiento del navegador, a la URL ni a la consola.
//
// Dependencias inyectables (con las reales por defecto): el cargador de GIS
// y fetch. Primera versión: botón de Google → GET /api/panel/sesion.

import type { ConfigPanel } from './config.ts'
import { crearCargadorGis, type CargadorGis } from './cargar-gis.ts'
import { consultarSesion, type HacerFetch, type SesionPanel } from './sesion.ts'
import { consultarPropuestas, filtroValido, unirPropuestas, type Filtro, type Propuesta, type FalloListado } from './propuestas.ts'

export interface EstadoListado {
  filtro: Filtro
  propuestas: Propuesta[]
  cargando: boolean
  cargado: boolean
  error: FalloListado | null
  requestId: string | null
  cursor: string | null
  seleccion: string | null
}
const listadoInicial = (): EstadoListado => ({ filtro: { estados: ['pendiente_aprobacion'], limite: 20 }, propuestas: [], cargando: false, cargado: false, error: null, requestId: null, cursor: null, seleccion: null })

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
  obtenerListado(): EstadoListado
  filtrar(filtro: Filtro): void
  cargarMas(): void
  recargar(): void
  seleccionar(id: string): void
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
  let listado = listadoInicial()
  let lectura = 0
  let abortar: AbortController | null = null
  let identidadAnterior: string | null = null
  const cursores = new Set<string>()
  const oyentes = new Set<() => void>()

  const fijar = (nuevo: EstadoPanel) => {
    estado = nuevo
    for (const oyente of oyentes) oyente()
  }

  const fijarListado = (nuevo: EstadoListado) => {
    listado = nuevo
    for (const oyente of oyentes) oyente()
  }
  function invalidarLectura() {
    lectura += 1
    abortar?.abort()
    abortar = null
  }
  function limpiarListado() {
    invalidarLectura()
    identidadAnterior = null
    cursores.clear()
    fijarListado(listadoInicial())
  }
  async function cargarListado(mas: boolean) {
    if (!config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('ver') || listado.cargando) return
    const cursor = mas ? listado.cursor : null
    if (mas && (!cursor || cursores.has(cursor))) return
    invalidarLectura()
    const mia = lectura
    const sesionMia = consulta
    abortar = new AbortController()
    fijarListado({ ...listado, cargando: true, error: null, requestId: null })
    const r = await consultarPropuestas(config.apiOrigen, token, listado.filtro, cursor, hacerFetch, abortar.signal)
    if (mia !== lectura || sesionMia !== consulta) return
    if (r.tipo === 'error') {
      fijarListado({ ...listado, cargando: false, error: r.fallo, requestId: r.requestId })
      if (r.fallo === 'sesion') {
        token = null
        fijar({ fase: 'sin_sesion', aviso: 'sesion_vencida' })
      }
      return
    }
    const siguiente = r.pagina.siguiente_cursor
    if (siguiente !== null && (siguiente === cursor || (mas && cursores.has(siguiente)))) {
      fijarListado({ ...listado, cargando: false, error: 'respuesta', requestId: r.requestId, cursor: null })
      return
    }
    if (!mas) cursores.clear()
    if (cursor) cursores.add(cursor)
    fijarListado({ ...listado, propuestas: unirPropuestas(mas ? listado.propuestas : [], r.pagina.propuestas), cargando: false, cargado: true, cursor: siguiente, error: null, requestId: r.requestId })
  }

  async function recibirCredencial(respuesta: GisCredentialResponse | undefined) {
    if (!config) return
    consulta += 1
    invalidarLectura()
    if (listado.cargando) fijarListado({ ...listado, cargando: false })
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
        if (identidadAnterior !== null && identidadAnterior !== resultado.sesion.identidad.sub) limpiarListado()
        identidadAnterior = resultado.sesion.identidad.sub
        if (!resultado.sesion.autorizado) limpiarListado()
        fijar(resultado.sesion.autorizado ? { fase: 'autorizado', sesion: resultado.sesion } : { fase: 'no_autorizado', sesion: resultado.sesion })
        if (resultado.sesion.autorizado) {
          if (resultado.sesion.permisos.includes('ver')) void cargarListado(false)
          else fijarListado({ ...listadoInicial(), error: 'permiso' })
        }
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
      limpiarListado()
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
    obtenerListado: () => listado,
    filtrar(filtro) {
      if (!filtroValido(filtro) || estado.fase !== 'autorizado') return
      invalidarLectura()
      cursores.clear()
      fijarListado({ ...listadoInicial(), filtro: { estados: [...filtro.estados], limite: filtro.limite } })
      void cargarListado(false)
    },
    cargarMas() { void cargarListado(true) },
    recargar() { void cargarListado(false) },
    seleccionar(id) {
      if (listado.propuestas.some(p => p.propuesta_id === id)) fijarListado({ ...listado, seleccion: id })
    },
  }
}
