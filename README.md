# Sala de Lectura

Biblioteca de dashboards HTML autocontenidos, desplegada en Vercel.

**Flujo de despliegue:** GitHub (`main`) → Vercel Production. Cada push a `main` genera el deployment.

## Almacenamiento (Vercel Blob privado)

- `sala-lectura/meta-v2.json`: solo categorías y metadatos pequeños (`id`, `title`, `topic`, `date`).
- `sala-lectura/dashboards/<id>.html`: un Blob por dashboard, con el HTML intacto.
- `sala-lectura/state.json`: formato antiguo monolítico; se conserva solo como respaldo y nunca se borra.

Guardar un dashboard envía únicamente ese HTML. Nunca se reenvían los demás (evita el 413 `FUNCTION_PAYLOAD_TOO_LARGE`).

## API `/api/data`

- `GET` → índice (categorías + metadatos).
- `GET ?dashboard=<id>` → HTML del dashboard.
- `PUT` (`Authorization: Bearer <ADMIN_PASSWORD>`) → acciones `upsert-dashboard`, `save-topics`, `delete-dashboard`.

### Protecciones de datos
- Si falla la lectura del Blob (red, permisos, servicio) se devuelve error; **no** se interpreta como "no existe", así que nunca se recrea el índice vacío o desde el respaldo antiguo.
- El índice se actualiza con escritura condicional (ETag / `ifMatch`) y reintentos: dos personas guardando a la vez no se pisan.
- `upsert-dashboard` no sobrescribe las categorías del servidor con las del navegador.
- El frontend no escribe nada si no pudo leer el estado compartido.
- Migración automática del `state.json` antiguo al primer acceso, sin borrar el original.

### Errores
Las respuestas de error incluyen `code` y, en fallos de Blob, `detail`. El navegador registra en consola el status HTTP y la respuesta real, y muestra un mensaje amigable.

## Límites
- 4 MB por dashboard (límite de Vercel Functions: 4,5 MB por petición). Más allá se necesitaría carga directa a Blob.

## Variables de entorno en Vercel
- `ADMIN_PASSWORD`
- `BLOB_READ_WRITE_TOKEN` (o OIDC, según el store)

## Estructura
- `index.html`: interfaz y lógica del frontend.
- `api/data.js`: API.
- `package.json`: depende de `@vercel/blob`.
