// Apoyo de las pruebas del panel: GIS y fetch falsos (sin red), espías sobre
// todo lugar donde el pase no debe aparecer, y render con react-dom/server.

import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { renderToString } from 'react-dom/server'
import type { ConfigPanel } from '../../src/panel/config.ts'
import type { ControladorPanel } from '../../src/panel/controlador.ts'
import { PanelApp } from '../../src/panel/PanelApp.tsx'
import type { HacerFetch } from '../../src/panel/sesion.ts'

export interface Prueba {
  nombre: string
  fn: () => Promise<void> | void
}

export const API = 'https://api-panel.example'
export const CONFIG: ConfigPanel = { apiOrigen: API, clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' }
export const REQUEST_ID = '0f1e2d3c-4b5a-4968-8776-655443322110'

// Pase con forma JWS y una firma única por ejecución: cualquier aparición
// (completa o solo la firma) cuenta como fuga.
const FIRMA = `FirmaFalsa_${crypto.randomUUID().replaceAll('-', '')}`
export const TOKEN = `eyJhbGciOiJSUzI1NiIsImtpZCI6ImZhbHNvIn0.eyJzdWIiOiJTRU5USU5FTEEifQ.${FIRMA}`
export const contieneToken = (texto: string) => texto.includes(TOKEN) || texto.includes(FIRMA)

export const esperar = () => new Promise<void>((r) => setTimeout(r, 0))

export async function hastaQue(condicion: () => boolean, intentos = 100) {
  for (let i = 0; i < intentos; i++) {
    if (condicion()) return
    await esperar()
  }
  assert.fail('la condición no se cumplió a tiempo')
}

// ---------------------------------------------------------------------------
// Espías: localStorage, sessionStorage, cookies, URL (location/history),
// indexedDB, consola y rechazos no manejados. Cualquier acceso queda
// registrado; las pruebas exigen que el registro termine vacío.
// ---------------------------------------------------------------------------
const GLOBALES = ['localStorage', 'sessionStorage', 'document', 'location', 'history', 'indexedDB'] as const
const METODOS_CONSOLA = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const

export interface Espias {
  registro: string[]
  restaurar(): void
}

export function instalarEspias(): Espias {
  const registro: string[] = []
  const anota = (texto: string) => registro.push(texto)
  const g = globalThis as unknown as Record<string, unknown>
  const previos = GLOBALES.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const)
  const consolaPrevia = METODOS_CONSOLA.map((m) => [m, console[m]] as const)

  const almacen = (nombre: string) => ({
    get length() {
      anota(`${nombre}.length`)
      return 0
    },
    getItem: (k: string) => (anota(`${nombre}.getItem(${k})`), null),
    setItem: (k: string, v: string) => anota(`${nombre}.setItem(${k}, ${v})`),
    removeItem: (k: string) => anota(`${nombre}.removeItem(${k})`),
    clear: () => anota(`${nombre}.clear()`),
    key: (i: number) => (anota(`${nombre}.key(${i})`), null),
  })
  const definir = (nombre: string, valor: unknown) => Object.defineProperty(globalThis, nombre, { value: valor, configurable: true, writable: true })

  definir('localStorage', almacen('localStorage'))
  definir('sessionStorage', almacen('sessionStorage'))
  definir('document', {
    get cookie() {
      anota('document.cookie (lectura)')
      return ''
    },
    set cookie(v: string) {
      anota(`document.cookie = ${v}`)
    },
  })
  definir('location', {
    get href() {
      return 'https://panel.example/panel.html'
    },
    set href(v: string) {
      anota(`location.href = ${v}`)
    },
    set hash(v: string) {
      anota(`location.hash = ${v}`)
    },
    set search(v: string) {
      anota(`location.search = ${v}`)
    },
    assign: (v: string) => anota(`location.assign(${v})`),
    replace: (v: string) => anota(`location.replace(${v})`),
  })
  definir('history', {
    pushState: (...a: unknown[]) => anota(`history.pushState(${inspect(a)})`),
    replaceState: (...a: unknown[]) => anota(`history.replaceState(${inspect(a)})`),
  })
  Object.defineProperty(globalThis, 'indexedDB', {
    get() {
      anota('indexedDB')
      return undefined
    },
    configurable: true,
  })
  for (const m of METODOS_CONSOLA) (console as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => anota(`console.${m}(${inspect(a)})`)
  const rechazo = (motivo: unknown) => anota(`unhandledRejection(${inspect(motivo)})`)
  process.on('unhandledRejection', rechazo)

  return {
    registro,
    restaurar() {
      for (const [m, f] of consolaPrevia) (console as unknown as Record<string, unknown>)[m] = f
      for (const [n, d] of previos) {
        if (d) Object.defineProperty(globalThis, n, d)
        else delete g[n]
      }
      process.off('unhandledRejection', rechazo)
    },
  }
}

// ---------------------------------------------------------------------------
// GIS falso: registra cada llamada; `entregar` simula el callback del botón.
// ---------------------------------------------------------------------------
export function crearGisFalso({ falla = false } = {}) {
  const llamadas = {
    cargas: 0,
    initialize: [] as Record<string, unknown>[],
    renderButton: [] as GisButtonConfiguration[],
    disableAutoSelect: 0,
    revoke: 0,
    prompt: 0,
  }
  let callback: ((r: GisCredentialResponse) => void) | null = null
  const id = {
    initialize(c: GisIdConfiguration) {
      llamadas.initialize.push({ ...c, callback: typeof c.callback })
      callback = c.callback
    },
    renderButton(_contenedor: HTMLElement, opciones: GisButtonConfiguration) {
      llamadas.renderButton.push(opciones)
    },
    disableAutoSelect() {
      llamadas.disableAutoSelect += 1
    },
    revoke() {
      llamadas.revoke += 1
    },
    prompt() {
      llamadas.prompt += 1
    },
  }
  return {
    llamadas,
    cargar: async (): Promise<GisAccountsId> => {
      llamadas.cargas += 1
      if (falla) throw new Error('gis_no_disponible')
      return id
    },
    entregar(respuesta: GisCredentialResponse) {
      assert.ok(callback, 'GIS no fue inicializado')
      callback(respuesta)
    },
  }
}

// ---------------------------------------------------------------------------
// fetch falso: registra URL e init de cada llamada.
// ---------------------------------------------------------------------------
export function crearFetchFalso(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const llamadas: { url: string; init: RequestInit }[] = []
  const hacerFetch: HacerFetch = async (url, init) => {
    llamadas.push({ url, init })
    return responder(url, init)
  }
  return { hacerFetch, llamadas }
}

export function respuestaJson(status: number, cuerpo: unknown, requestId: string | null = REQUEST_ID): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (requestId !== null) headers['X-Request-Id'] = requestId
  return new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), { status, headers })
}

export const SESION_AUTORIZADA = {
  identidad: { proveedor: 'google', sub: '109876543210987654321', email: 'operador@example.com', email_verificado: true },
  autorizado: true,
  identificador: 'operador.panel',
  permisos: ['ver', 'decidir'],
}

export const SESION_NO_AUTORIZADA = {
  identidad: { proveedor: 'google', sub: '111111111111111111111', email: 'otra@example.com', email_verificado: true },
  autorizado: false,
  identificador: null,
  permisos: [],
}

export const renderizar = (controlador: ControladorPanel) => renderToString(<PanelApp controlador={controlador} copiar={async () => {}} />)

// Sin fugas en ningún lugar observable: espías, estado, HTML, llamadas a
// GIS y a la red (fuera del header Authorization).
export function comprobarSinFugas(ctx: { espias: Espias; controlador: ControladorPanel; gis: ReturnType<typeof crearGisFalso>; red: ReturnType<typeof crearFetchFalso> }) {
  assert.deepEqual(ctx.espias.registro, [], 'acceso a almacenamiento, cookies, URL, consola o rechazo no manejado')
  assert.ok(!contieneToken(JSON.stringify(ctx.controlador.obtenerEstado())), 'el pase está en el estado observable')
  assert.ok(!contieneToken(renderizar(ctx.controlador)), 'el pase está en el HTML')
  assert.ok(!contieneToken(JSON.stringify(ctx.gis.llamadas)), 'el pase llegó a GIS')
  for (const { url, init } of ctx.red.llamadas) {
    assert.ok(!contieneToken(url), 'el pase está en la URL')
    const { headers, ...resto } = init
    assert.ok(!contieneToken(JSON.stringify(resto)), 'el pase está en el init de fetch fuera de los headers')
    for (const [nombre, valor] of new Headers(headers)) {
      if (nombre === 'authorization') assert.equal(valor, `Bearer ${TOKEN}`)
      else assert.ok(!contieneToken(valor), `el pase está en el header ${nombre}`)
    }
  }
  assert.deepEqual(ctx.espias.registro, [], 'el render o las comprobaciones tocaron algo observable')
}
