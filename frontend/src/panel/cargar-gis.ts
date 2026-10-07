// Carga el script de Google Identity Services una sola vez y entrega
// google.accounts.id. Inyectable: el documento y la ventana se reciben por
// parámetro (las pruebas usan falsos, sin red).

export const URL_GIS = 'https://accounts.google.com/gsi/client'
const LIMITE_MS = 15000

export type CargadorGis = () => Promise<GisAccountsId>

interface OpcionesCargador {
  documento?: Pick<Document, 'createElement' | 'head'>
  ventana?: Pick<Window, 'google'>
  limiteMs?: number
}

export function crearCargadorGis({ documento = document, ventana = window, limiteMs = LIMITE_MS }: OpcionesCargador = {}): CargadorGis {
  let promesa: Promise<GisAccountsId> | null = null
  const disponible = () => ventana.google?.accounts?.id

  return () => {
    promesa ??= new Promise<GisAccountsId>((resolver, rechazar) => {
      const ya = disponible()
      if (ya) {
        resolver(ya)
        return
      }
      const script = documento.createElement('script')
      let temporizador: ReturnType<typeof setTimeout> | undefined
      const fallar = () => {
        clearTimeout(temporizador)
        script.remove()
        promesa = null
        rechazar(new Error('gis_no_disponible'))
      }
      script.src = URL_GIS
      script.async = true
      script.onload = () => {
        clearTimeout(temporizador)
        const id = disponible()
        if (id) resolver(id)
        else fallar()
      }
      script.onerror = fallar
      temporizador = setTimeout(fallar, limiteMs)
      documento.head.appendChild(script)
    })
    return promesa
  }
}
