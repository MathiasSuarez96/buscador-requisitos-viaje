// Configuración del panel a partir de las variables de Vite. Solo producción:
// la API tiene que ser https y exactamente esquema://host[:puerto]. Si algo
// falta o no tiene la forma esperada, el panel no arranca (null).

export interface ConfigPanel {
  apiOrigen: string
  clientId: string
}

// Misma forma que valida el backend (services/panel/verificar-token-google.js).
// La comprobación del build (scripts/verificar-csp-panel.ts) usa esta misma.
export const CLIENT_ID_GOOGLE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/

export function leerConfigPanel(env: { VITE_API_URL?: unknown; VITE_GOOGLE_CLIENT_ID?: unknown }): ConfigPanel | null {
  const api = env.VITE_API_URL
  const clientId = env.VITE_GOOGLE_CLIENT_ID
  if (typeof clientId !== 'string' || !CLIENT_ID_GOOGLE.test(clientId)) return null
  if (typeof api !== 'string') return null
  let url: URL
  try {
    url = new URL(api)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.origin !== api) return null
  return { apiOrigen: url.origin, clientId }
}
