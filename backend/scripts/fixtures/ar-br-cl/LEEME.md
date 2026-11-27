# Fixtures del lote AR/BR/CL (fuentes oficiales del destino)

Descargados el 2026-11-25 con el agente del proyecto. Los extractos HTML conservan el `<main>` real
completo; se quitaron cabecera, pie y scripts.

| Archivo | Origen | sha256 del original |
|---|---|---|
| `argentina-extranjeros-2026-11-25.html` | https://www.argentina.gob.ar/tema/extranjeros | 665664de9d6a5d4c100ca0e55a99addcba4c924185980e4798db35edf31c11f6 |
| `argentina-documentacion-turista-2026-11-25.html` | https://www.argentina.gob.ar/migraciones/documentacion-para-ingresar-al-pais-como-turista | 237fb66357a87e2ea0b4b40910db4081543f164bfddb3e4d8de7cd43ac32a0fd |
| `itamaraty-qgrv-pagina-2026-11-25.html` | https://www.gov.br/mre/pt-br/assuntos/portal-consular/vistos/quadro-geral-de-regime-de-vistos-para-entrada-de-estrangeiros-no-brasil (solo los dos enlaces al cuadro) | 357dbf22c980847ec9694c1231e13a02064ec399c6d897f62eb8515afc4da6cd |
| `qgrv-simples-port-07out26.pdf` | https://www.gov.br/mre/pt-br/assuntos/portal-consular/vistos/qgrv-simples-port-07out26.pdf (completo, sin cambios) | 132c0482c49c13aaf75f6bc6d49ef468e5070bae55ce6ad8080b7378a98f160e |
| `consulado-chile-info-visas-2026-11-25.json` | https://www.consulado.gob.cl/consulados/stat/info_visas/info_visas.json (completo, sin cambios) | 52c8edf493fff0003895dd834157ff473c487d1c78c534600f1632b6282c3cf1 |
| `consulado-chile-notas-visas-2026-11-26.json` | https://www.consulado.gob.cl/consulados/site/edic/base/port/notas_visas.json (completo, sin cambios; descargado 2026-11-27T02:01Z = 26/11 23:01 Uruguay) | fe76c6899b5f1310512f787d68b4f61bff15c52a55c1868becd1ef3c27dcd016 |
| `api-destinos-2026-11-25.json` | GET https://buscador-requisitos-viaje.onrender.com/api/destinos (28 destinos publicados) | 181ec1500ef69afdb8eb71964b85ae163cd3c2017691a7d248c373d1dc35fc18 |

La copia de la API se usa para sembrar el Mongo efímero con el estado publicado real: así la regresión
de los 13 perfiles activos corre sobre los datos de producción, no sobre registros armados a mano. En
Atlas las fechas son texto `AAAA-MM-DD` (o null); la API las serializa con hora y la prueba las recorta.

El script que carga los dos JSON de Chile (https://www.consulado.gob.cl/consulados/js-local/v1/ArancelesVisas.class.js,
sha256 645704e1883ab355a56cf8cc1dac6ef4eb39a82c6dbf26780f1bf200373120dd el 27/11 02:01Z) no se guarda: solo
confirma qué archivos usa la página. La tabla descargada ese día tenía las mismas 202 filas que la del
25/11; solo cambiaba el orden de las claves (el servidor lo varía entre consultas).
