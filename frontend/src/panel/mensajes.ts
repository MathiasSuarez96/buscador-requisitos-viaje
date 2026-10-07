import type { ErrorPanel } from './controlador.ts'

// Mensajes fijos: de la respuesta del servidor solo se muestran el código
// (validado) y el X-Request-Id.
export const MENSAJES = {
  cargando: 'Cargando el inicio de sesión de Google…',
  verificando: 'Verificando sesión…',
  sesionVencida: 'La sesión venció o no es válida. Iniciá sesión de nuevo.',
  configuracion: 'El panel no está configurado correctamente.',
  gis_no_disponible: 'No se pudo cargar el inicio de sesión de Google. Recargá la página para intentar de nuevo.',
  sin_conexion: 'No se pudo contactar al servidor o el panel no está disponible.',
  credencial_invalida: 'Google no devolvió una credencial válida. Intentá de nuevo.',
  no_disponible: 'El panel no está disponible.',
  autenticacion_no_disponible: 'No se pudo verificar la autenticación. Probá de nuevo más tarde.',
  servidor: 'El servidor respondió con un error.',
  noAutorizado: 'Tu cuenta no está autorizada para usar el panel. Pasale tu sub al administrador.',
} as const

export function mensajeError(error: ErrorPanel): string {
  if (error.tipo !== 'servidor') return MENSAJES[error.tipo]
  if (error.codigo === 'no_disponible') return MENSAJES.no_disponible
  if (error.codigo === 'autenticacion_no_disponible') return MENSAJES.autenticacion_no_disponible
  return MENSAJES.servidor
}
