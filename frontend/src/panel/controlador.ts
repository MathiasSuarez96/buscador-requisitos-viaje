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
import { consultarDetalle, type Detalle, type FalloDetalle } from './detalle.ts'
import { enviarDecision, instantaneaDe, esMotivoValido, type AccionDecision, type ErrorDecision, type InstantaneaDecision, type ResultadoDecision } from './decisiones.ts'

export interface EstadoDetalle {
  propuestaId: string | null
  cargando: boolean
  datos: Detalle | null
  error: FalloDetalle | null
  requestId: string | null
}
const detalleInicial = (): EstadoDetalle => ({ propuestaId: null, cargando: false, datos: null, error: null, requestId: null })
export interface EstadoDecision {
  propuestaId: string | null
  accion: AccionDecision | null
  instantanea: InstantaneaDecision | null
  identidad: string | null
  motivo: string
  enviando: boolean
  requiereRecarga: boolean
  accionesBloqueadas: AccionDecision[]
  error: ErrorDecision | null
  registrada: Extract<ResultadoDecision, { tipo: 'ok' }>['decision'] | null
  requestId: string | null
}
const decisionInicial = (propuestaId: string | null = null): EstadoDecision => ({ propuestaId, accion: null, instantanea: null, identidad: null, motivo: '', enviando: false, requiereRecarga: false, accionesBloqueadas: [], error: null, registrada: null, requestId: null })

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
  obtenerDetalle(): EstadoDetalle
  volverAlListado(): void
  reintentarDetalle(): void
  obtenerDecision(): EstadoDecision
  prepararDecision(accion: AccionDecision): void
  fijarMotivoDecision(motivo: string): void
  cancelarDecision(): void
  confirmarDecision(): void
}

export interface DependenciasPanel {
  config: ConfigPanel | null
  cargarGis?: CargadorGis
  hacerFetch?: HacerFetch
  tiempoDecisionMs?: number
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
  tiempoDecisionMs,
}: DependenciasPanel): ControladorPanel {
  let estado: EstadoPanel = config ? { fase: 'cargando_gis' } : error('configuracion')
  let token: string | null = null
  let gis: GisAccountsId | null = null
  let iniciado = false
  // Cada inicio o cierre de sesión invalida las respuestas anteriores.
  let consulta = 0
  let listado = listadoInicial()
  let detalle = detalleInicial()
  let decision = decisionInicial()
  const exigirRecarga = new Set<string>()
  const bloqueadas = new Map<string, Set<AccionDecision>>()
  const registradas = new Map<string, Extract<ResultadoDecision, { tipo: 'ok' }>['decision']>()
  const instantaneasRegistradas = new Map<string, InstantaneaDecision>()
  let envioActivo = false
  let solicitudDecision = 0
  let abortarDecision: AbortController | null = null
  let lecturaDetalle = 0
  let abortarDetalle: AbortController | null = null
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
  const fijarDetalle = (nuevo: EstadoDetalle) => {
    detalle = nuevo
    for (const oyente of oyentes) oyente()
  }
  const fijarDecision = (nuevo: EstadoDecision) => {
    decision = nuevo
    for (const oyente of oyentes) oyente()
  }
  function invalidarDetalle() {
    lecturaDetalle += 1
    abortarDetalle?.abort()
    abortarDetalle = null
  }
  function volverAlListado() {
    if (envioActivo) return
    invalidarDetalle()
    fijarDetalle(detalleInicial())
    fijarDecision(decisionInicial())
  }
  async function cargarDetalle(id: string, explicita = false) {
    if (!config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('ver')) return
    invalidarDetalle()
    const numeroDetalle = lecturaDetalle
    const sesionDetalle = consulta
    abortarDetalle = new AbortController()
    fijarDetalle({ propuestaId: id, cargando: true, datos: null, error: null, requestId: null })
    const resultado = await consultarDetalle(config.apiOrigen, token, id, hacerFetch, abortarDetalle.signal)
    if (numeroDetalle !== lecturaDetalle || sesionDetalle !== consulta) return
    if (resultado.tipo === 'ok') {
      fijarDetalle({ propuestaId: id, cargando: false, datos: resultado.detalle, error: null, requestId: resultado.requestId })
      if (explicita) {
        const instantaneaActual = instantaneaDe(resultado.detalle)
        const anterior = instantaneasRegistradas.get(id)
        exigirRecarga.delete(id)
        bloqueadas.delete(id)
        if (anterior && instantaneaActual && anterior.estado_esperado === instantaneaActual.estado_esperado && anterior.payload_hash_esperado === instantaneaActual.payload_hash_esperado && anterior.version_coordinacion_esperada === instantaneaActual.version_coordinacion_esperada) {
          exigirRecarga.add(id)
          bloqueadas.set(id, new Set(['aprobar', 'rechazar']))
        } else instantaneasRegistradas.delete(id)
        const registrada = registradas.get(id) ?? null
        fijarDecision({ ...decisionInicial(id), motivo: decision.propuestaId === id ? decision.motivo : '', registrada })
      }
    } else {
      if (resultado.fallo === 'sesion') {
        token = null
        invalidarLectura()
        if (listado.cargando) fijarListado({ ...listado, cargando: false })
        fijar({ fase: 'sin_sesion', aviso: 'sesion_vencida' })
      }
      fijarDetalle({ propuestaId: id, cargando: false, datos: null, error: resultado.fallo, requestId: resultado.requestId })
    }
  }
  function invalidarLectura() {
    lectura += 1
    abortar?.abort()
    abortar = null
  }
  function limpiarListado() {
    invalidarLectura()
    volverAlListado()
    identidadAnterior = null
    cursores.clear()
    fijarListado(listadoInicial())
  }
  async function cargarListado(mas: boolean) {
    if (envioActivo || !config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('ver') || listado.cargando) return
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
        invalidarDetalle()
        if (detalle.propuestaId) fijarDetalle({ ...detalle, cargando: false, datos: null, error: 'sesion' })
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
    if (envioActivo) {
      envioActivo = false
      solicitudDecision += 1
      abortarDecision?.abort()
      exigirRecarga.add(decision.propuestaId!)
      fijarDecision({ ...decision, enviando: false, accion: null, instantanea: null, identidad: null, requiereRecarga: true, error: { fallo: 'incierto', requestId: null, actual: null, motivos: [], autenticacionVencida: false } })
    }
    consulta += 1
    invalidarLectura()
    invalidarDetalle()
    if (detalle.cargando) fijarDetalle({ ...detalle, cargando: false })
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
        if (identidadAnterior !== null && identidadAnterior !== resultado.sesion.identidad.sub) {
          limpiarListado()
          bloqueadas.clear()
          registradas.clear()
          instantaneasRegistradas.clear()
        }
        identidadAnterior = resultado.sesion.identidad.sub
        if (!resultado.sesion.autorizado) limpiarListado()
        fijar(resultado.sesion.autorizado ? { fase: 'autorizado', sesion: resultado.sesion } : { fase: 'no_autorizado', sesion: resultado.sesion })
        if (resultado.sesion.autorizado) {
          if (resultado.sesion.permisos.includes('ver')) {
            if (!listado.cargado) void cargarListado(false)
          } else {
            volverAlListado()
            fijarListado({ ...listadoInicial(), error: 'permiso' })
          }
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
      if (envioActivo && decision.propuestaId) {
        exigirRecarga.add(decision.propuestaId)
        envioActivo = false
        solicitudDecision += 1
        abortarDecision?.abort()
      }
      registradas.clear()
      instantaneasRegistradas.clear()
      fijarDecision(decisionInicial())
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
      invalidarDetalle()
      if (detalle.cargando) fijarDetalle({ ...detalle, cargando: false })
      if (gis) fijar({ fase: 'sin_sesion', aviso: null })
    },
    tieneToken: () => token !== null,
    obtenerListado: () => listado,
    obtenerDetalle: () => detalle,
    obtenerDecision: () => decision,
    volverAlListado,
    reintentarDetalle() {
      if (!envioActivo && detalle.propuestaId && !detalle.cargando && token && estado.fase === 'autorizado') void cargarDetalle(detalle.propuestaId, true)
    },
    prepararDecision(accion) {
      const d = detalle.datos
      if (envioActivo || !d || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('decidir') || !d.acciones_permitidas.includes(accion) || exigirRecarga.has(d.propuesta.propuesta_id) || bloqueadas.get(d.propuesta.propuesta_id)?.has(accion)) return
      const instantanea = instantaneaDe(d)
      if (!instantanea) return
      const usuario = estado.sesion.identidad.sub
      fijarDecision({ ...decision, propuestaId: d.propuesta.propuesta_id, accion, instantanea, identidad: usuario, error: null, requestId: null })
    },
    fijarMotivoDecision(motivo) {
      if (!envioActivo) fijarDecision({ ...decision, motivo })
    },
    cancelarDecision() {
      if (!envioActivo) fijarDecision({ ...decision, accion: null, instantanea: null, identidad: null, error: null, requestId: null })
    },
    confirmarDecision() {
      // Esta asignación síncrona es la barrera contra doble clic y dos acciones simultáneas.
      if (envioActivo || !config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('decidir') || !decision.accion || !decision.instantanea || !decision.propuestaId || decision.identidad !== estado.sesion.identidad.sub || detalle.propuestaId !== decision.propuestaId || !detalle.datos || !detalle.datos.acciones_permitidas.includes(decision.accion) || exigirRecarga.has(decision.propuestaId) || bloqueadas.get(decision.propuestaId)?.has(decision.accion) || (decision.accion === 'rechazar' && !esMotivoValido(decision.motivo))) return
      const accion = decision.accion, id = decision.propuestaId, snapshot = decision.instantanea, motivo = decision.motivo, credencial = token, usuario = estado.sesion.identidad.sub
      envioActivo = true
      const mia = ++solicitudDecision
      abortarDecision = new AbortController()
      fijarDecision({ ...decision, enviando: true, error: null, requestId: null })
      void enviarDecision(config.apiOrigen, credencial, accion, id, snapshot, motivo, hacerFetch, abortarDecision.signal, tiempoDecisionMs).then(r => {
        if (!envioActivo || mia !== solicitudDecision || decision.identidad !== usuario) return
        envioActivo = false
        abortarDecision = null
        if (r.tipo === 'ok') {
          exigirRecarga.add(id)
          registradas.set(id, r.decision)
          instantaneasRegistradas.set(id, snapshot)
          fijarDecision({ ...decision, enviando: false, accion: null, instantanea: null, identidad: null, requiereRecarga: true, registrada: r.decision, error: null, requestId: r.requestId })
          return
        }
        const e = r.error
        if (e.autenticacionVencida) token = null
        const bloqueadasAccion = bloqueadas.get(id) ?? new Set<AccionDecision>()
        if ((e.fallo === 'permiso' && !e.autenticacionVencida) || e.fallo === 'no_encontrado' || e.fallo === 'no_decidible') bloqueadasAccion.add(accion)
        if (bloqueadasAccion.size) bloqueadas.set(id, bloqueadasAccion)
        const incierto = e.fallo === 'incierto' || e.fallo === 'cambio' || e.fallo === 'no_encontrado'
        if (incierto) exigirRecarga.add(id)
        fijarDecision({ ...decision, enviando: false, requiereRecarga: incierto, accionesBloqueadas: [...bloqueadasAccion], error: e, requestId: e.requestId })
        if (e.autenticacionVencida) fijar({ fase: 'sin_sesion', aviso: 'sesion_vencida' })
      }, () => {
        if (!envioActivo || mia !== solicitudDecision) return
        envioActivo = false
        exigirRecarga.add(id)
        fijarDecision({ ...decision, enviando: false, requiereRecarga: true, error: { fallo: 'incierto', requestId: null, actual: null, motivos: [], autenticacionVencida: false } })
      })
    },
    filtrar(filtro) {
      if (envioActivo || !filtroValido(filtro) || estado.fase !== 'autorizado') return
      volverAlListado()
      invalidarLectura()
      cursores.clear()
      fijarListado({ ...listadoInicial(), filtro: { estados: [...filtro.estados], limite: filtro.limite } })
      void cargarListado(false)
    },
    cargarMas() { void cargarListado(true) },
    recargar() { void cargarListado(false) },
    seleccionar(id) {
      if (envioActivo || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('ver') || !listado.propuestas.some(p => p.propuesta_id === id)) return
      if (detalle.propuestaId === id && detalle.cargando) return
      if (decision.propuestaId !== id) fijarDecision({ ...decisionInicial(id), registrada: registradas.get(id) ?? null, requiereRecarga: exigirRecarga.has(id) })
      fijarListado({ ...listado, seleccion: id })
      void cargarDetalle(id)
    },
  }
}
