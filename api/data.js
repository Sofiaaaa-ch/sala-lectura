import { get, put, del, BlobPreconditionFailedError } from '@vercel/blob';

const LEGACY_PATH = 'sala-lectura/state.json';
const META_PATH = 'sala-lectura/meta-v2.json';
const DASH_PREFIX = 'sala-lectura/dashboards/';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const META_RETRIES = 5;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function blobConfigured() {
  // Este proyecto fue configurado originalmente con token clásico.
  // @vercel/blob también puede usar OIDC en proyectos actualizados.
  return !!process.env.BLOB_READ_WRITE_TOKEN || !!process.env.VERCEL_OIDC_TOKEN;
}

function isAuthorized(request) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${expected}`;
}

function safeId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9._-]{1,180}$/.test(id)) return null;
  return id;
}

function dashboardPath(id) {
  return `${DASH_PREFIX}${id}.html`;
}

// Devuelve { text, etag }. null SOLO si el Blob no existe.
// Cualquier otro fallo (red, permisos, servicio) se propaga: antes se confundía
// con "no existe", lo que podía llevar a recrear el índice y perder datos.
async function readBlob(path) {
  const result = await get(path, { access: 'private', useCache: false });
  if (!result) return null;
  if (result.statusCode !== 200 || !result.stream) {
    throw new Error(`Lectura inesperada de ${path} (status ${result.statusCode}).`);
  }
  const text = await new Response(result.stream).text();
  return { text, etag: result.blob && result.blob.etag };
}

async function readJson(path) {
  const r = await readBlob(path);
  if (!r) return null;
  try {
    return { value: JSON.parse(r.text), etag: r.etag };
  } catch (e) {
    throw new Error(`${path} no es JSON válido: ${e.message}`);
  }
}

async function writeJson(path, value, etag) {
  const options = {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
  };
  if (etag) options.ifMatch = etag;
  await put(path, JSON.stringify(value), options);
}

function metadataOnly(d) {
  return {
    id: String(d.id || ''),
    title: String(d.title || ''),
    topic: String(d.topic || ''),
    date: String(d.date || ''),
  };
}

function validMeta(m) {
  return m && Array.isArray(m.topics) && Array.isArray(m.dashboards);
}

async function migrateLegacyState() {
  // Compatibilidad con la versión anterior: un único state.json que contenía
  // TODOS los HTML. Se migra una sola vez a un Blob por dashboard.
  const legacyRead = await readJson(LEGACY_PATH);
  const legacy = legacyRead && legacyRead.value;
  if (!validMeta(legacy)) return null;

  const dashboards = [];
  const writes = [];

  for (const d of legacy.dashboards) {
    const id = safeId(d && d.id);
    if (!id) continue;
    const html = typeof d.html === 'string' ? d.html : '';
    if (html) {
      writes.push(
        put(dashboardPath(id), html, {
          access: 'private',
          allowOverwrite: true,
          contentType: 'text/html; charset=utf-8',
          cacheControlMaxAge: 60,
        })
      );
    }
    dashboards.push(metadataOnly(d));
  }

  await Promise.all(writes);

  const meta = {
    version: 2,
    topics: legacy.topics,
    dashboards,
    migratedAt: new Date().toISOString(),
  };

  // Sin ifMatch no se puede exigir "crear solo si no existe"; releemos justo
  // antes para no pisar un meta creado por otra petición concurrente.
  const existing = await readJson(META_PATH);
  if (existing && validMeta(existing.value)) return { meta: existing.value, etag: existing.etag };

  await writeJson(META_PATH, meta);
  // LEGACY_PATH se conserva como copia de seguridad; no se elimina automáticamente.
  const fresh = await readJson(META_PATH);
  return { meta: fresh ? fresh.value : meta, etag: fresh && fresh.etag };
}

// Devuelve { meta, etag } o null si aún no existe ningún estado (instalación nueva).
async function loadMetaWithEtag() {
  const r = await readJson(META_PATH);
  if (r) {
    if (!validMeta(r.value)) throw new Error(`${META_PATH} existe pero tiene un formato inesperado.`);
    return { meta: r.value, etag: r.etag };
  }
  return await migrateLegacyState();
}

// Lee-modifica-escribe el índice con control de concurrencia optimista:
// si otra petición cambió el índice entretanto, se vuelve a leer y reaplicar.
async function updateMeta(mutator) {
  for (let attempt = 0; attempt < META_RETRIES; attempt++) {
    const loaded = await loadMetaWithEtag();
    const meta = loaded ? loaded.meta : { version: 2, topics: [], dashboards: [] };
    const etag = loaded ? loaded.etag : undefined;

    const result = mutator(meta, !loaded);
    meta.version = 2;
    meta.updatedAt = new Date().toISOString();

    try {
      await writeJson(META_PATH, meta, etag);
      return meta;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError && attempt < META_RETRIES - 1) continue;
      throw e;
    }
  }
  throw new Error('No se pudo actualizar el índice por conflictos de escritura simultánea.');
}

function describeError(error) {
  const name = (error && error.name) || 'Error';
  const message = (error && error.message) || String(error);
  return { name, message };
}

export async function GET(request) {
  if (!blobConfigured()) {
    return json({ configured: false, state: null });
  }

  const url = new URL(request.url);
  const requestedId = url.searchParams.get('dashboard');

  if (requestedId) {
    const id = safeId(requestedId);
    if (!id) return new Response('Dashboard inválido.', { status: 400 });

    try {
      // Asegura la migración antes de intentar leer el HTML individual.
      await loadMetaWithEtag();
      const blob = await readBlob(dashboardPath(id));
      let html = blob ? blob.text : null;

      // Fallback de seguridad por si la migración se interrumpió a mitad.
      if (html == null) {
        const legacyRead = await readJson(LEGACY_PATH);
        const legacy = legacyRead && legacyRead.value;
        const found = legacy && Array.isArray(legacy.dashboards)
          ? legacy.dashboards.find((d) => d && d.id === id)
          : null;
        html = found && typeof found.html === 'string' ? found.html : null;
      }

      if (html == null) return new Response('Dashboard no encontrado.', { status: 404 });
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      console.error('GET /api/data?dashboard=', id, error);
      return new Response('No se pudo leer el dashboard.', { status: 500 });
    }
  }

  try {
    const loaded = await loadMetaWithEtag();
    return json({ configured: true, state: loaded ? loaded.meta : null });
  } catch (error) {
    console.error('GET /api/data:', error);
    return json({
      configured: true,
      state: null,
      readError: true,
      error: 'No se pudo leer el almacenamiento.',
      detail: describeError(error),
    }, 500);
  }
}

export async function PUT(request) {
  if (!blobConfigured()) {
    return json({ error: 'Vercel Blob todavía no está conectado al proyecto.', code: 'blob_not_configured' }, 503);
  }
  if (!process.env.ADMIN_PASSWORD) {
    return json({ error: 'Falta configurar ADMIN_PASSWORD en Vercel.', code: 'missing_admin_password' }, 503);
  }
  if (!isAuthorized(request)) {
    return json({ error: 'Clave de edición incorrecta.', code: 'unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: 'JSON inválido.', code: 'bad_json' }, 400);
  }

  const action = payload && payload.action;

  try {
    if (action === 'upsert-dashboard') {
      const d = payload.dashboard || {};
      const id = safeId(d.id);
      const html = payload.html;

      if (!id || typeof html !== 'string' || !html.trim()) {
        return json({ error: 'Dashboard o HTML inválido.', code: 'bad_dashboard' }, 400);
      }

      // Dejamos margen frente al límite de 4.5 MB de Vercel Functions.
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
        return json({ error: 'Este dashboard individual supera 4 MB. Debe subirse con carga directa a Blob.', code: 'too_large' }, 413);
      }

      // 1) El HTML va a su propio Blob (nunca se toca el de otros dashboards).
      await put(dashboardPath(id), html, {
        access: 'private',
        allowOverwrite: true,
        contentType: 'text/html; charset=utf-8',
        cacheControlMaxAge: 60,
      });

      // 2) Se actualiza solo la entrada de este dashboard en el índice.
      //    Las categorías del servidor NO se sobrescriben con las del cliente,
      //    salvo en una instalación nueva donde todavía no existe índice.
      const item = metadataOnly(d);
      const meta = await updateMeta((m, isNew) => {
        if (isNew && Array.isArray(payload.topics)) m.topics = payload.topics;
        const pos = m.dashboards.findIndex((x) => x && x.id === id);
        if (pos >= 0) m.dashboards[pos] = item;
        else m.dashboards.push(item);
      });
      return json({ ok: true, state: meta });
    }

    if (action === 'save-topics') {
      if (!Array.isArray(payload.topics) || payload.topics.length > 200) {
        return json({ error: 'Formato de categorías inválido.', code: 'bad_topics' }, 400);
      }
      const meta = await updateMeta((m) => { m.topics = payload.topics; });
      return json({ ok: true, state: meta });
    }

    if (action === 'delete-dashboard') {
      const id = safeId(payload.id);
      if (!id) return json({ error: 'Dashboard inválido.', code: 'bad_dashboard' }, 400);

      const loaded = await loadMetaWithEtag();
      if (!loaded) return json({ ok: true, state: null });

      const meta = await updateMeta((m) => {
        m.dashboards = m.dashboards.filter((x) => x && x.id !== id);
      });
      // Si el borrado del Blob falla, el índice ya no lo muestra; no es un error para el usuario.
      try { await del(dashboardPath(id)); }
      catch (e) { console.error('del', dashboardPath(id), e); }
      return json({ ok: true, state: meta });
    }

    return json({ error: 'Acción no soportada.', code: 'bad_action' }, 400);
  } catch (error) {
    console.error('PUT /api/data', action, error);
    return json({
      error: 'No se pudo guardar en Vercel Blob.',
      code: 'blob_error',
      detail: describeError(error),
    }, 500);
  }
}
