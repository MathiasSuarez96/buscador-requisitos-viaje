// GET /api/panel/sesion con el pase de Google. Nunca lanza: cualquier falla
// se traduce a un resultado con datos fijos. El pase solo viaja en el header
// Authorization, a la URL de la API; no aparece en el resultado ni se registra.

export type HacerFetch = (url: string, init: RequestInit) => Promise<Response>

export interface SesionPanel {
  identidad: { proveedor: 'google'; sub: string; email: string; email_verificado: boolean }
  autorizado: boolean
  identificador: string | null
  permisos: string[]
}

export type ResultadoSesion =
  | { tipo: 'ok'; sesion: SesionPanel }
  | { tipo: 'no_autenticado' }
  | { tipo: 'error'; codigo: string; requestId: string | null }
  | { tipo: 'sin_conexion' }

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CODIGO = /^[a-z_]{1,40}$/
const PERMISOS = ['ver', 'decidir']
const LARGO_MAXIMO_CUERPO = 16 * 1024

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const esTexto = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

function leerRequestId(respuesta: Response): string | null {
  try {
    const valor = respuesta.headers.get('X-Request-Id')
    return valor !== null && REQUEST_ID.test(valor) ? valor : null
  } catch {
    return null
  }
}

// null si el cuerpo no es JSON, es demasiado grande o contiene el pase.
async function leerCuerpo(respuesta: Response, token: string): Promise<unknown> {
  try {
    const texto = await respuesta.text()
    if (texto.length > LARGO_MAXIMO_CUERPO || texto.includes(token)) return null
    return JSON.parse(texto)
  } catch {
    return null
  }
}

// Lista blanca: arma un objeto nuevo solo con los campos esperados.
function validarSesion(cuerpo: unknown): SesionPanel | null {
  if (!esObjeto(cuerpo) || !esObjeto(cuerpo.identidad)) return null
  const { proveedor, sub, email, email_verificado: verificado } = cuerpo.identidad
  const { autorizado, identificador, permisos } = cuerpo
  if (proveedor !== 'google' || !esTexto(sub, 255) || !esTexto(email, 320) || typeof verificado !== 'boolean') return null
  if (typeof autorizado !== 'boolean' || !Array.isArray(permisos)) return null
  if (!permisos.every((p) => typeof p === 'string' && PERMISOS.includes(p)) || new Set(permisos).size !== permisos.length) return null
  if (autorizado ? !esTexto(identificador, 200) : identificador !== null || permisos.length > 0) return null
  return {
    identidad: { proveedor: 'google', sub, email, email_verificado: verificado },
    autorizado,
    identificador: autorizado ? (identificador as string) : null,
    permisos: [...(permisos as string[])],
  }
}

function leerCodigo(cuerpo: unknown): string | null {
  if (!esObjeto(cuerpo) || !esObjeto(cuerpo.error)) return null
  const { codigo } = cuerpo.error
  return typeof codigo === 'string' && CODIGO.test(codigo) ? codigo : null
}

export async function consultarSesion(apiOrigen: string, token: string, hacerFetch: HacerFetch): Promise<ResultadoSesion> {
  let respuesta: Response
  try {
    respuesta = await hacerFetch(`${apiOrigen}/api/panel/sesion`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    // Red caída, CORS rechazado o panel deshabilitado (su 503 no lleva CORS).
    return { tipo: 'sin_conexion' }
  }
  try {
    const requestId = leerRequestId(respuesta)
    const cuerpo = await leerCuerpo(respuesta, token)
    if (respuesta.status === 401) return { tipo: 'no_autenticado' }
    if (respuesta.status === 200) {
      const sesion = validarSesion(cuerpo)
      return sesion ? { tipo: 'ok', sesion } : { tipo: 'error', codigo: 'respuesta_invalida', requestId }
    }
    return { tipo: 'error', codigo: leerCodigo(cuerpo) ?? 'respuesta_invalida', requestId }
  } catch {
    return { tipo: 'error', codigo: 'respuesta_invalida', requestId: null }
  }
}
