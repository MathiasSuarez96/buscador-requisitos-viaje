// Flujo completo del panel con GIS y fetch falsos: estados, a dónde viaja el
// pase y que no aparezca en ningún otro lugar.

import assert from 'node:assert/strict'
import { crearControladorPanel, type ControladorPanel } from '../../src/panel/controlador.ts'
import { MENSAJES } from '../../src/panel/mensajes.ts'
import {
  API,
  CONFIG,
  REQUEST_ID,
  SESION_AUTORIZADA,
  SESION_NO_AUTORIZADA,
  TOKEN,
  comprobarSinFugas,
  crearFetchFalso,
  crearGisFalso,
  esperar,
  hastaQue,
  instalarEspias,
  renderizar,
  respuestaJson,
  type Prueba,
} from './apoyo.tsx'

type Responder = Parameters<typeof crearFetchFalso>[0]

// Arranca el panel, entrega una credencial y espera a que termine la consulta.
async function escenario(responder: Responder, prueba: (ctx: Contexto) => Promise<void> | void, credencial: GisCredentialResponse = { credential: TOKEN, select_by: 'btn' }) {
  const espias = instalarEspias()
  try {
    const gis = crearGisFalso()
    const red = crearFetchFalso(responder)
    const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
    controlador.iniciar()
    await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
    gis.entregar(credencial)
    await hastaQue(() => controlador.obtenerEstado().fase !== 'verificando')
    const ctx = { espias, gis, red, controlador }
    await prueba(ctx)
    comprobarSinFugas(ctx)
  } finally {
    espias.restaurar()
  }
}
type Contexto = { espias: ReturnType<typeof instalarEspias>; gis: ReturnType<typeof crearGisFalso>; red: ReturnType<typeof crearFetchFalso>; controlador: ControladorPanel }

function esperarError(ctx: Contexto, tipo: string, codigo: string | null, requestId: string | null) {
  const estado = ctx.controlador.obtenerEstado()
  assert.equal(estado.fase, 'error')
  assert.deepEqual(estado.fase === 'error' && estado.error, { tipo, codigo, requestId })
  assert.equal(ctx.controlador.tieneToken(), false, 'tras un error el pase se descarta')
}

const SIN_CONEXION = (ctx: Contexto) => {
  esperarError(ctx, 'sin_conexion', null, null)
  assert.match(renderizar(ctx.controlador), /No se pudo contactar al servidor o el panel no está disponible\./)
}

// Cuerpo de 200 que no cumple el contrato → error fijo respuesta_invalida.
const cuerpoInvalido = (nombre: string, cuerpo: unknown): Prueba => ({
  nombre: `200 con cuerpo inesperado (${nombre}) → respuesta_invalida, sin fugas`,
  fn: () =>
    escenario(
      () => respuestaJson(200, cuerpo),
      (ctx) => {
        esperarError(ctx, 'servidor', 'respuesta_invalida', REQUEST_ID)
        const html = renderizar(ctx.controlador)
        assert.match(html, /El servidor respondió con un error\./)
        assert.match(html, /respuesta_invalida/)
        assert.match(html, new RegExp(REQUEST_ID))
      },
    ),
})

export const pruebas: Prueba[] = [
  {
    nombre: 'sesión autorizada: datos visibles; un solo fetch a VITE_API_URL/api/panel/sesion con el pase solo en Authorization',
    fn: () =>
      escenario(
        () => respuestaJson(200, SESION_AUTORIZADA),
        ({ controlador, red, gis }) => {
          const estado = controlador.obtenerEstado()
          assert.equal(estado.fase, 'autorizado')
          assert.equal(controlador.tieneToken(), true, 'el pase queda en memoria mientras dura la sesión')
          assert.equal(red.llamadas.length, 1)
          const [{ url, init }] = red.llamadas
          assert.equal(url, `${API}/api/panel/sesion`)
          assert.equal(init.method, 'GET')
          assert.equal(init.credentials, 'omit', 'sin credentials: include')
          assert.equal(init.redirect, 'error', 'no sigue redirecciones con el pase')
          assert.equal(init.body, undefined)
          assert.deepEqual([...new Headers(init.headers)], [['authorization', `Bearer ${TOKEN}`]])
          // GIS: botón con popup y sin selección automática; sin One Tap ni revoke.
          assert.deepEqual(gis.llamadas.initialize, [{ client_id: CONFIG.clientId, callback: 'function', auto_select: false, ux_mode: 'popup' }])
          assert.equal(gis.llamadas.prompt, 0)
          assert.equal(gis.llamadas.revoke, 0)
          const html = renderizar(controlador)
          for (const texto of ['Autorizado como operador.panel', 'operador@example.com', '(verificado)', '109876543210987654321', 'Copiar', 'google', 'ver, decidir', 'Cerrar sesión']) {
            assert.ok(html.includes(texto), `falta "${texto}" en la vista`)
          }
        },
      ),
  },
  {
    nombre: 'sesión no autorizada: muestra identidad, "No" y permisos "ninguno"',
    fn: () =>
      escenario(
        () => respuestaJson(200, SESION_NO_AUTORIZADA),
        ({ controlador }) => {
          assert.equal(controlador.obtenerEstado().fase, 'no_autorizado')
          const html = renderizar(controlador)
          for (const texto of [MENSAJES.noAutorizado, 'otra@example.com', '111111111111111111111', 'Copiar', 'ninguno']) {
            assert.ok(html.includes(texto), `falta "${texto}" en la vista`)
          }
        },
      ),
  },
  {
    nombre: '401 borra el pase y vuelve al botón con aviso de sesión vencida',
    fn: () =>
      escenario(
        () => respuestaJson(401, { error: { codigo: 'no_autenticado', mensaje: 'Se requiere un token válido.', request_id: REQUEST_ID } }),
        ({ controlador, gis }) => {
          assert.deepEqual(controlador.obtenerEstado(), { fase: 'sin_sesion', aviso: 'sesion_vencida' })
          assert.equal(controlador.tieneToken(), false)
          const html = renderizar(controlador)
          assert.ok(html.includes(MENSAJES.sesionVencida))
          assert.ok(html.includes('data-boton-google'), 'vuelve el contenedor del botón')
          // Al montarse el contenedor, el botón oficial se dibuja de nuevo.
          let limpiado = 0
          controlador.mostrarBoton({ replaceChildren: () => (limpiado += 1) } as unknown as HTMLElement)
          assert.equal(limpiado, 1)
          assert.equal(gis.llamadas.renderButton.length, 1)
          assert.deepEqual(gis.llamadas.renderButton[0], { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', locale: 'es' })
        },
      ),
  },
  {
    nombre: 'falla de red (TypeError "Failed to fetch") → mensaje fijo de conexión',
    fn: () =>
      escenario(() => {
        throw new TypeError('Failed to fetch')
      }, SIN_CONEXION),
  },
  {
    nombre: 'fetch lanza un error cuyo mensaje contiene el pase → mensaje fijo, sin fugas',
    fn: () =>
      escenario(() => {
        throw new TypeError(`Failed to fetch ${TOKEN}`)
      }, SIN_CONEXION),
  },
  {
    nombre: 'fetch lanza un valor que no es Error (objeto con el pase) → mensaje fijo, sin fugas',
    fn: () =>
      escenario(() => {
        throw { token: TOKEN, toString: () => TOKEN }
      }, SIN_CONEXION),
  },
  {
    nombre: 'CORS rechazado / panel deshabilitado (503 sin Access-Control-Allow-Origin) → mismo mensaje fijo',
    fn: () => escenario(() => Promise.reject(new TypeError('NetworkError when attempting to fetch resource.')), SIN_CONEXION),
  },
  {
    nombre: 'respuesta cuyo text() lanza con el pase en el mensaje → respuesta_invalida, sin fugas',
    fn: () =>
      escenario(
        () =>
          ({
            status: 200,
            headers: new Headers({ 'X-Request-Id': REQUEST_ID }),
            text: async () => {
              throw new Error(TOKEN)
            },
          }) as unknown as Response,
        (ctx) => esperarError(ctx, 'servidor', 'respuesta_invalida', REQUEST_ID),
      ),
  },
  {
    nombre: 'respuesta cuyos headers lanzan → requestId null, sin fugas',
    fn: () =>
      escenario(
        () =>
          ({
            status: 500,
            headers: {
              get: () => {
                throw new Error(TOKEN)
              },
            },
            text: async () => JSON.stringify({ error: { codigo: 'error_interno' } }),
          }) as unknown as Response,
        (ctx) => esperarError(ctx, 'servidor', 'error_interno', null),
      ),
  },
  cuerpoInvalido('HTML', '<html><body>Bad gateway</body></html>'),
  cuerpoInvalido('array JSON', []),
  cuerpoInvalido('sin identidad', { autorizado: true, identificador: 'x', permisos: ['ver'] }),
  cuerpoInvalido('eco del pase en el email', { ...SESION_AUTORIZADA, identidad: { ...SESION_AUTORIZADA.identidad, email: TOKEN } }),
  cuerpoInvalido('campo extra con el pase', { ...SESION_AUTORIZADA, token: TOKEN }),
  cuerpoInvalido('proveedor desconocido', { ...SESION_AUTORIZADA, identidad: { ...SESION_AUTORIZADA.identidad, proveedor: 'github' } }),
  cuerpoInvalido('permiso desconocido', { ...SESION_AUTORIZADA, permisos: ['ver', 'admin'] }),
  cuerpoInvalido('autorizado sin identificador', { ...SESION_AUTORIZADA, identificador: null }),
  cuerpoInvalido('no autorizado con permisos', { ...SESION_NO_AUTORIZADA, permisos: ['ver'] }),
  cuerpoInvalido('cuerpo enorme', { ...SESION_AUTORIZADA, relleno: 'x'.repeat(20000) }),
  {
    nombre: '503 del panel con CORS → "El panel no está disponible." con código y X-Request-Id',
    fn: () =>
      escenario(
        () => respuestaJson(503, { error: { codigo: 'no_disponible', mensaje: 'El panel no está disponible.', request_id: REQUEST_ID } }),
        (ctx) => {
          esperarError(ctx, 'servidor', 'no_disponible', REQUEST_ID)
          const html = renderizar(ctx.controlador)
          assert.ok(html.includes(MENSAJES.no_disponible) && html.includes('no_disponible') && html.includes(REQUEST_ID))
        },
      ),
  },
  {
    nombre: 'código y X-Request-Id con forma inválida (contienen el pase) no se muestran',
    fn: () =>
      escenario(
        () => respuestaJson(500, { error: { codigo: `<b>${TOKEN}</b>`, mensaje: TOKEN } }, TOKEN),
        (ctx) => esperarError(ctx, 'servidor', 'respuesta_invalida', null),
      ),
  },
  {
    nombre: 'cerrar sesión: limpia pase e identidad, llama disableAutoSelect y no revoke',
    fn: () =>
      escenario(
        () => respuestaJson(200, SESION_AUTORIZADA),
        ({ controlador, gis }) => {
          controlador.cerrarSesion()
          assert.deepEqual(controlador.obtenerEstado(), { fase: 'sin_sesion', aviso: null })
          assert.equal(controlador.tieneToken(), false)
          assert.equal(gis.llamadas.disableAutoSelect, 1)
          assert.equal(gis.llamadas.revoke, 0)
          assert.ok(!renderizar(controlador).includes('operador@example.com'), 'la identidad ya no se muestra')
        },
      ),
  },
  {
    nombre: 'credencial ausente, sin forma JWS o demasiado larga → error fijo y ningún fetch',
    fn: async () => {
      for (const credencial of [{}, { credential: 'no-es-un-jwt' }, { credential: `a.b.${'c'.repeat(5000)}` }]) {
        await escenario(
          () => respuestaJson(200, SESION_AUTORIZADA),
          (ctx) => {
            esperarError(ctx, 'credencial_invalida', null, null)
            assert.equal(ctx.red.llamadas.length, 0)
          },
          credencial,
        )
      }
    },
  },
  {
    nombre: 'respuesta tardía después de cerrar sesión se ignora',
    fn: async () => {
      const espias = instalarEspias()
      try {
        let liberar: (r: Response) => void = () => {}
        const gis = crearGisFalso()
        const red = crearFetchFalso(() => new Promise<Response>((r) => (liberar = r)))
        const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
        controlador.iniciar()
        await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
        gis.entregar({ credential: TOKEN })
        assert.equal(controlador.obtenerEstado().fase, 'verificando')
        controlador.cerrarSesion()
        liberar(respuestaJson(200, SESION_AUTORIZADA))
        for (let i = 0; i < 5; i++) await esperar()
        assert.deepEqual(controlador.obtenerEstado(), { fase: 'sin_sesion', aviso: null })
        assert.equal(controlador.tieneToken(), false)
        comprobarSinFugas({ espias, gis, red, controlador })
      } finally {
        espias.restaurar()
      }
    },
  },
  {
    nombre: 'GIS no carga → error fijo, sin initialize ni fetch',
    fn: async () => {
      const espias = instalarEspias()
      try {
        const gis = crearGisFalso({ falla: true })
        const red = crearFetchFalso(() => respuestaJson(200, SESION_AUTORIZADA))
        const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
        assert.equal(controlador.obtenerEstado().fase, 'cargando_gis')
        assert.ok(renderizar(controlador).includes(MENSAJES.cargando))
        controlador.iniciar()
        await hastaQue(() => controlador.obtenerEstado().fase === 'error')
        assert.deepEqual(controlador.obtenerEstado(), { fase: 'error', error: { tipo: 'gis_no_disponible', codigo: null, requestId: null } })
        assert.equal(gis.llamadas.initialize.length, 0)
        assert.equal(red.llamadas.length, 0)
        assert.ok(renderizar(controlador).includes(MENSAJES.gis_no_disponible))
        comprobarSinFugas({ espias, gis, red, controlador })
      } finally {
        espias.restaurar()
      }
    },
  },
  {
    nombre: 'sin configuración válida → error de configuración y GIS no se carga',
    fn: () => {
      const gis = crearGisFalso()
      const controlador = crearControladorPanel({ config: null, cargarGis: gis.cargar, hacerFetch: async () => assert.fail('no debe llamar a fetch') })
      controlador.iniciar()
      assert.equal(gis.llamadas.cargas, 0)
      assert.deepEqual(controlador.obtenerEstado(), { fase: 'error', error: { tipo: 'configuracion', codigo: null, requestId: null } })
      assert.ok(renderizar(controlador).includes(MENSAJES.configuracion))
    },
  },
  {
    nombre: 'iniciar es idempotente (StrictMode): una sola carga e initialize',
    fn: async () => {
      const gis = crearGisFalso()
      const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: async () => assert.fail('no debe llamar a fetch') })
      controlador.iniciar()
      controlador.iniciar()
      await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
      assert.equal(gis.llamadas.cargas, 1)
      assert.equal(gis.llamadas.initialize.length, 1)
    },
  },
  {
    nombre: 'estado "verificando" se muestra mientras la consulta está en curso',
    fn: async () => {
      const gis = crearGisFalso()
      const red = crearFetchFalso(() => new Promise<Response>(() => {}))
      const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
      controlador.iniciar()
      await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
      gis.entregar({ credential: TOKEN })
      assert.equal(controlador.obtenerEstado().fase, 'verificando')
      assert.ok(renderizar(controlador).includes(MENSAJES.verificando))
    },
  },
]
