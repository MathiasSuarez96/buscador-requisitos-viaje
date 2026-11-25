# Fixture de la página ETIAS de la Comisión Europea

- `extracto-etias-2026-11-24.html`: extracto MÍNIMO, con el marcado real, de
  https://home-affairs.ec.europa.eu/policies/schengen/smart-borders/european-travel-information-authorisation-system_en
  (descargada el 2026-11-24; página completa: sha256 d6ed13b6e2b994b6de0457274e94df0f8a84d572c7989a8ce0da961683544f57).
  Se conserva el bloque «Important notice» completo (el div tal como aparece dentro de `<main>`);
  se quitaron la navegación, el banner, los scripts y el pie.
- El contenido de la Comisión se puede reutilizar citando la fuente (Decisión 2011/833/UE). Igual el
  buscador publica redacción propia y enlaza la página oficial.
- `registro-publicado-etias-2026-11-24.json`: copia de la API pública de los seis requisitos
  «ETIAS (Schengen)» (AT, HR, FI, FR, IT, PT).
