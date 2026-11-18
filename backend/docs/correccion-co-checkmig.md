# Corrección puntual: CO / Check-Mig

Estado: **preparada y probada en Mongo efímero. No aplicada.** Espera autorización.

- **Mecanismo:** `scripts/corregir-requisito.js`, reutilizable para otras correcciones puntuales.
- **Especificación:** `scripts/correcciones/co-checkmig.json`.
- **Plan versionado:** `scripts/correcciones/co-checkmig.plan.json`.

## Registro actual

Leído de la API pública el 17/11/2026 (hora de Montevideo; 2026-11-18T01:49Z) con sha256
`e861f684…`, el mismo del 12/11 y del respaldo local del 21/10. `--verificar --esperado antes`
coincide con el plan.

- Destino `6a87828da8282a4aa6ddfbd4` (Colombia, `CO`), `updatedAt` 2026-09-11T02:07:44.986Z.
  Tiene 6 requisitos y **uno solo** es Check-Mig: `6aaddd0e9f54309f9d82727b`.

| campo | antes | después |
|---|---|---|
| obligatorio | `si` | `no` |
| descripcion | Formulario migratorio digital obligatorio antes de cada vuelo de entrada y salida. | Prerregistro migratorio en línea para el ingreso y la salida de Colombia. Se puede completar entre 72 horas y una hora antes del viaje. |
| fuente | https://apps.migracioncolombia.gov.co/check-mig/ | https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig |
| link | https://apps.migracioncolombia.gov.co/check-mig/ | https://apps.migracioncolombia.gov.co/pre-registro/ |
| fecha_verificacion | `2026-08-18` (texto) | `2026-11-17` (texto) |
| tipo, nombre, estado | sin cambio | sin cambio |

## Fecha de verificación (decisión aparte)

**Se renueva a `2026-11-17`**, porque cada campo del registro corregido tiene evidencia del mismo
día:

- `obligatorio`: la ficha leída con el adaptador dice «de uso no obligatorio»
  (`hechos_hash f7becb92…`, HTTP 200).
- `descripcion`: los hechos de la ficha la respaldan. Son obligatoriedad, sentidos
  ingreso y salida, y la ventana de 72 h a 1 h. El plan se niega a prepararse si no coinciden.
- `fuente`: es la propia ficha leída.
- `link`: un GET a `/pre-registro/` respondió 200, título «Página de inicio | CheckMig». El link
  anterior, `/check-mig/`, responde **404**.

El plan del 12/11 venció el 15/11 sin aplicarse; este se regeneró el 17/11 y **vence a las 72 h**
(2026-11-21T01:49Z), porque la evidencia es del día. Si vence, se
vuelve a preparar y eso repite la lectura y el GET. La reversión no vence. Para corregir sin
renovar la fecha, la especificación tiene que pedirlo (`fecha_verificacion` con otro valor).

## Garantías de la escritura

- Driver nativo, sin modelos ni Mongoose, sin `.env`. Solo la conexión `MONGODB_URI_DECISION`
  del usuario `mathias-operador@admin`, comprobado con `connectionStatus`. No usa la URI de la app.
- Busca el destino por `_id` y `codigo_iso`, y exige **exactamente un** requisito con el `_id`.
- Lee el requisito y exige que sea **idéntico** al estado anterior: mismas claves y mismos
  valores de texto. Si no, aborta con las diferencias y no escribe.
- Antes del update guarda un respaldo del documento completo (EJSON canónico), en un archivo
  **nuevo** (`wx` + `fsync`).
- **CAS sobre el requisito completo:** el filtro del `updateOne` exige que el elemento con el
  `_id` sea único y que, como documento BSON, sea idéntico al leído: mismas claves, en el mismo
  orden, mismos valores y tipos (`$expr` con `$literal` del elemento leído). El `arrayFilters`
  usa la misma igualdad. Una clave agregada (`recomendado: "si"`), una quitada, un texto
  convertido en arreglo (`["si"]`) o en `Date` hacen `matched 0`: informa un cambio concurrente
  sin escribir. Además exige `matched 1 / modified 1`. (Hasta `73c8cdd` comparaba solo los campos
  del plan, con `$eq` + `$type: string`, y dejaba pasar los dos primeros casos.)
- Relee y comprueba que solo cambió ese requisito (y `updatedAt`).
- Solo envía estos comandos: `connectionStatus`, `find`, `update` y `endSessions`.
- **Reversión:** es la misma operación con los estados invertidos y su propia precondición.
  Solo escribe si el requisito está exactamente como lo dejó la corrección.
- **Supuesto:** en Atlas, `fecha_verificacion` es texto, como se observó el 21/10. Si fuera
  `Date`, la precondición falla y no se escribe nada.

## Pruebas (Mongo efímero, sin red)

En `scripts/test-corregir-requisito.js`:

- Plan y evidencia. Sin hechos, con el enlace caído o con el requisito duplicado, no hay plan.
- Solo cambia el requisito objetivo: los otros 5 requisitos y otro destino quedan intactos, y
  el respaldo es igual al documento anterior.
- Una segunda aplicación no escribe ni crea respaldo.
- Un cambio entre la lectura y la escritura lo rechaza el CAS, en la corrección y en la
  reversión: valor distinto, clave agregada o quitada, texto como arreglo y texto como `Date`.
- La reversión restaura exactamente, y se niega si alguien tocó el requisito corregido.
- Un `_id` duplicado o un operador distinto se rechazan.
- El registro corregido da `sin_cambio` en `ciclo-checkmig-v2.js --simular`.

## Comandos (requieren autorización; no ejecutados)

Desde `backend/`. El respaldo va en una ruta privada nueva, fuera del repo:

```
# 0. Revisar el plan (sin red ni base)
node scripts/corregir-requisito.js --mostrar scripts/correcciones/co-checkmig.plan.json

# 1. Aplicar
MONGODB_URI_DECISION='<uri de mathias-operador>' node scripts/corregir-requisito.js \
  --aplicar scripts/correcciones/co-checkmig.plan.json \
  --confirmo 0fb5e707a9d2d82e86fa8d70ab8394d7e0e9f613670ea5e7eb106afb111cd814 \
  --respaldo <ruta privada nueva>/co-checkmig-respaldo.json

# 2. Verificar vía GET (API pública)
node scripts/corregir-requisito.js --verificar scripts/correcciones/co-checkmig.plan.json --esperado despues
node scripts/ciclo-checkmig-v2.js --simular --registro <registro corregido>   # debe dar sin_cambio

# 3. Revertir (solo si hace falta)
MONGODB_URI_DECISION='<uri de mathias-operador>' node scripts/corregir-requisito.js \
  --revertir scripts/correcciones/co-checkmig.plan.json \
  --confirmo a32aa60713a3a9b7128683a97754f12096ec50d5de90759aa7a1c78968d57367 \
  --respaldo <ruta privada nueva>/co-checkmig-respaldo-reversion.json
node scripts/corregir-requisito.js --verificar scripts/correcciones/co-checkmig.plan.json --esperado antes
```

Si el plan venció, primero hay que volver a prepararlo. El hash nuevo reemplaza al de arriba:

```
node scripts/corregir-requisito.js --preparar scripts/correcciones/co-checkmig.json --salida <plan nuevo>.json
```

**Códigos de salida:** 0 aplicada o coincide · 3 estado distinto, cambio concurrente o no
coincide (nada escrito) · 1 error.

La API pública lee la base en cada pedido. Después de aplicar, no hace falta reiniciar Render.
