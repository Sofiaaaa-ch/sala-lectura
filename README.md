# Sala de Lectura — Vercel (FIX 413)

Esta versión corrige el error **413 FUNCTION_PAYLOAD_TOO_LARGE**.

## Qué cambió

La versión anterior guardaba `topics + dashboards + TODOS los HTML` en un único `state.json` y reenviaba todo el estado en cada edición. Al crecer la sala, el `PUT /api/data` superó el límite de payload de Vercel Functions.

La versión 2 guarda:

- `sala-lectura/meta-v2.json`: solo categorías y metadatos pequeños.
- `sala-lectura/dashboards/<id>.html`: un Blob privado por dashboard.
- `sala-lectura/state.json`: se conserva únicamente como respaldo de la versión antigua.

## Migración automática

En el primer acceso después del despliegue, `/api/data` detecta el `state.json` antiguo y migra automáticamente cada dashboard a su propio Blob. El archivo antiguo NO se borra.

## Despliegue

Conserva en Vercel las variables actuales:

- `ADMIN_PASSWORD`
- `BLOB_READ_WRITE_TOKEN` (si tu store usa token clásico)

Reemplaza el proyecto por estos archivos y vuelve a desplegar. No necesitas borrar el Blob ni los dashboards actuales.

## Estructura

- `index.html`
- `api/data.js`
- `package.json`
- `.gitignore`

`@vercel/blob` se actualizó a `^2.6.1`.
