# Alta automática de destinos ausentes (v1)

Crea un destino que no está en el catálogo con requisitos respaldados por una fuente oficial, sin
duplicarlo al repetir la ejecución. Primer caso: **Alemania (DE)**, con la «Staatenliste zur
Visumpflicht» del Auswärtiges Amt.

## Por qué Alemania

- Ausente del catálogo: los 27 ISO de producción, consultados en solo lectura el 22/11/2026, no incluyen
  `DE`. Es un destino frecuente y no hay que borrar nada para demostrar el alta.
- La fuente oficial tiene una fila POSITIVA para el contexto del buscador: «Uruguay | Nein (1)», y la nota 1)
  fija las condiciones: titulares de pasaportes nacionales, hasta 90 días por período de 180, sin
  actividad remunerada. Solo cuenta esa fila. Que falte o se repita deja el caso en revisión humana:
  la ausencia de un país en la lista nunca se interpreta como visa requerida ni como exención.
- Condiciones de uso: el Impressum del Auswärtiges Amt declara los textos protegidos y pide enlazar en
  lugar de copiar. El alta publica solo el hecho, con una descripción de redacción propia y la URL
  oficial como fuente. La evidencia interna son fragmentos breves (≤ 240 caracteres) y el fixture del
  repositorio es un extracto mínimo (`scripts/fixtures/auswaertiges-amt/`), no la página completa.

## Entrada explícita

`config/altas-destinos.json` (`altas-destinos-v1`). Cada entrada elige un perfil de alta, y `codigo_iso` y `pais`
deben coincidir con el destino que cubre ese perfil (`services/propuestas/altas/perfil-alta-alemania.js`).
No se descubren destinos: lo que no está en la entrada no se crea.

## Qué se publica

| Requisito | Resultado del alta |
|---|---|
| `visa` | `obligatorio: "no"`, `estado: "confirmado"`, descripción con las condiciones de la fuente, `fuente` = URL oficial, `fecha_verificacion` = día de la lectura (Montevideo) |
| `formulario_digital`, `vacuna`, `validez_pasaporte`, `tasa_aeropuerto`, `documentacion_menor` | `obligatorio: "verificar"`, `estado: "verificar"`, sin fuente ni fecha: esta fuente no los cubre |

El documento se valida con el modelo `Destino` y cada requisito con el contrato 2.0, así el ciclo de
mantenimiento puede usarlo. El perfil `auswaertiges-amt-de-visa` (política `auswaertiges-amt-alemania-visa@1`)
mantiene después la visa de DE con el mismo adaptador.

## Garantías

- **Dos lecturas** con los mismos hechos antes de crear. Si una es ambigua o dan hechos distintos, revisión
  humana (exit 3). Si la fuente cae, reintentar (exit 4). Si el destino ya existe, no se consulta la fuente.
- **Duplicados, concurrencia y reintentos**: se reutilizan los índices únicos existentes `destinos.codigo_iso_1`
  y `destinos.pais_1`, y se agregan `altas_destino.alta_id_1` y `altas_destino.uniq_alta_por_codigo_iso`. El destino y
  su registro se insertan en una transacción (snapshot, majority). Si otra corrida gana la carrera, la
  inserción falla por clave duplicada y la corrida devuelve `ya_existe`. Un destino cargado a mano tampoco se
  duplica.
- **Procedencia** en `altas_destino`: proceso y usuario de Atlas, política y autorizante, fecha, URL, las dos
  lecturas (HTTP, hashes), hechos, evidencia, contexto del viajero, requisitos confirmados y a verificar, y
  resultado. Cada corrida imprime `REGISTRO_ALTA {json}` y una fila en el resumen del job.
- **Modo informe** sin autorización vigente: lee y construye, sin escribir. Cualquier comando que no sea de
  lectura invalida la corrida.

## Comandos

```
node scripts/alta-destinos-v1.js --simular [--html RUTA]   # sin base de datos
node scripts/alta-destinos-v1.js --ejecutar                # real; misma credencial que el ciclo
node scripts/crear-indices-altas.js --plan | --prechequeo | --crear
```

Credencial de la ejecución: `MONGODB_URI_CICLO` (usuario `buscador-backend-app`, `readWrite@buscador_requisitos`,
ya usado por el ciclo). Los índices nuevos se crean una sola vez con una credencial de operador
(`MONGODB_URI_INDICES`), no con la del proceso. No se amplían permisos ni la lista de acceso de red de Atlas.

## Activación pendiente (requiere autorización)

1. Push.
2. Crear los dos índices de `altas_destino` (cambio de estructura): `--prechequeo` y luego `--crear` con la
   credencial de operador.
3. Variable de repositorio `ALTAS_ACTIVAS=true` y una corrida `workflow_dispatch` con `solo_informe=true`.
   Esperado: `alta_aplicable` (exit 2), sin escrituras.
4. Política nueva `alta-auswaertiges-amt-alemania@1` en la lista de `CICLO_V2_AUTORIZACION_JSON` (primera alta real).
   Después, verificar DE en `GET /api/destinos`.
5. Mantenimiento de DE: agregar `auswaertiges-amt-de-visa` a `PERFILES_CICLO` y, si se quiere autoaplicar, la
   política `auswaertiges-amt-alemania-visa@1`.
