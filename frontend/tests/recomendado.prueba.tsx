import assert from 'node:assert/strict'
import { BadgesRequisito } from '../src/BadgesRequisito'
import { renderizarElemento } from './panel/apoyo.tsx'
import type { Prueba } from './panel/apoyo.tsx'

const render = (obligatorio: 'si' | 'no' | 'verificar', recomendado?: 'si' | 'no' | 'verificar') =>
  renderizarElemento(<BadgesRequisito obligatorio={obligatorio} recomendado={recomendado} />)

export const pruebas: Prueba[] = [
  {
    nombre: 'reglas visuales: prioridad de obligatoriedad, recomendación opcional y estados sin badge',
    fn() {
      assert.match(render('si'), /Obligatorio/)
      assert.doesNotMatch(render('si'), /Recomendación|Opcional/)
      assert.match(render('verificar', 'si'), /Obligatoriedad a verificar/)
      assert.doesNotMatch(render('verificar', 'si'), /Opcional|Recomendación/)
      assert.match(render('verificar', 'verificar'), /Obligatoriedad a verificar/)
      assert.doesNotMatch(render('verificar', 'verificar'), /Recomendación/)
      assert.match(render('no', 'si'), /Opcional · recomendado/)
      assert.match(render('no', 'verificar'), /Recomendación a verificar/)
      assert.match(render('si', 'verificar'), /Obligatorio/)
      assert.doesNotMatch(render('si', 'verificar'), /Recomendación/)
      assert.equal(render('no', 'no'), '')
      assert.equal(render('no'), '')
    },
  },
  {
    nombre: 'badge de recomendación conserva texto accesible y distribución adaptable a móvil',
    fn() {
      const html = render('no', 'si')
      assert.match(html, /aria-label="Estado del requisito"/)
      assert.match(html, /class="[^"]*flex-wrap/)
      assert.match(html, />Opcional · recomendado<\/span>/)
    },
  },
  {
    nombre: 'los 27 destinos sin recomendado conservan salida sin etiquetas nuevas',
    fn() {
      const requisitosLegados = Array.from({ length: 27 }, () => ({ obligatorio: 'no' as const }))
      const etiquetas = requisitosLegados.map(({ obligatorio }) => render(obligatorio))
      assert.ok(etiquetas.every((html) => html === ''), 'los registros legados no deben adquirir datos ni etiquetas por defecto')
    },
  },
]
