# Resultado que falta completar

Objetivo del usuario: el agente debe poder investigar, proponer altas y cambios
de destinos y requisitos, presentarlos para decisión humana y aplicar lo aprobado
con evidencia oficial, fecha y auditoría. Tener destinos cargados no equivale a
tener un agente capaz de mantenerlos.

## Implementado y publicado hasta 32321dc

- Buscador público, panel autenticado y permisos.
- Ciclo de costo 1.0 probado con UK ETA; Reino Unido sigue siendo el primer piloto completado.
- Contrato 2.0, evidencia, hash, identidad y decisión humana para cambios de varios campos.
- Registro y aplicación 2.0 todavía cerrados.

## En preparación local

- 159c407: índice transversal, prechequeo y simulación en Mongo efímero; pendiente revisión y operación autorizada en Atlas.
- Núcleo puro del aplicador: CAS de identidad y captura completa, $set/$unset declarados,
  comparación de hechos frescos y fecha YYYY-MM-DD en America/Montevideo.
  No es aún un aplicador operativo ni una autorización para abrir el registro.

## Trabajo restante, en orden

1. Revisar preparación del índice, leer Atlas con autorización y crear el índice con plan confirmado.
2. Completar aplicador 2.0 transaccional y auditable, relectura de resultados inciertos,
   modelos de historial/intento con revalidaciones[], adaptadores y panel. Mantener 1.0 compatible.
3. Adaptador Colombia y piloto de solo lectura; usar la corrección de Check-Mig acordada.
4. Abrir 2.0 solo cuando índice, servicio, parser y panel estén desplegados y probados.
5. Completar el ciclo Check-Mig real y comprobar el resultado público.
6. Contratos de alta de requisito y destino, identidad, validación, aprobación y aplicación atómica.
7. Investigación con fuentes oficiales y reglas de aplicabilidad (nacionalidad, documento,
   residencia, tránsito y fechas cuando correspondan). No inventar certeza: marcar verificar.
8. Cobertura progresiva de todos los destinos, detector de cambios, cola de revisión,
   operación programada, gestión de fallos y respaldos.

Las pruebas locales y el desarrollo continúan sin pedir autorización por cada archivo.
Los accesos/operaciones sobre Atlas y los despliegues se autorizan por separado.
El agente propone; una decisión humana autoriza toda aplicación al buscador.

Pendientes paralelos: vulnerabilidad de producción en body-parser; runner único
de suites; B6 como sobreviviente conocido de impacto bajo, no equivalente estricto.
