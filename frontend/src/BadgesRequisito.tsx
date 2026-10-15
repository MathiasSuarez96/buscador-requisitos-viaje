export type Obligatorio = 'si' | 'no' | 'verificar'
export type Recomendado = 'si' | 'no' | 'verificar'

interface Props {
  obligatorio: Obligatorio
  recomendado?: Recomendado
}

export function BadgesRequisito({ obligatorio, recomendado }: Props) {
  const etiquetas: string[] = []

  if (obligatorio === 'si') etiquetas.push('Obligatorio')
  else if (obligatorio === 'verificar') etiquetas.push('Obligatoriedad a verificar')
  else if (recomendado === 'si') etiquetas.push('Opcional · recomendado')

  if (obligatorio === 'no' && recomendado === 'verificar') {
    etiquetas.push('Recomendación a verificar')
  }

  if (etiquetas.length === 0) return null

  return (
    <div aria-label="Estado del requisito" className="flex flex-wrap items-center gap-2">
      {etiquetas.map((etiqueta) => (
        <span key={etiqueta} className="text-xs font-medium rounded-full bg-slate-100 text-slate-700 px-2 py-1">
          {etiqueta}
        </span>
      ))}
    </div>
  )
}
