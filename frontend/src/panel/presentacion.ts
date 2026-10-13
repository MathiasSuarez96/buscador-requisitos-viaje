import type { EstadoPropuesta } from './propuestas.ts'
import type { ValorPresente } from './detalle.ts'

export const NOMBRES: Record<EstadoPropuesta, string> = { pendiente_aprobacion: 'Pendiente de aprobación', aprobada: 'Aprobada', rechazada: 'Rechazada', obsoleta: 'Obsoleta', revision_requerida: 'Revisión requerida', conflicto: 'Conflicto', cancelada: 'Cancelada', aplicada: 'Aplicada' }
export const textoValor = (v: string | number | boolean | null | undefined): string => v === undefined ? 'Ausente' : v === null ? 'Null (sin dato)' : v === '' ? 'Cadena vacía ("")' : typeof v === 'boolean' ? v ? 'Sí' : 'No' : String(v)
export const textoPresencia = (v: ValorPresente): string => v === null ? 'No evaluable' : !v.presente ? 'Ausente' : textoValor(v.valor)
