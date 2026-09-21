import { get, put, del } from '@vercel/blob';

const LEGACY_PATH = 'sala-lectura/state.json';
const META_PATH = 'sala-lectura/meta-v2.json';
const DASH_PREFIX = 'sala-lectura/dashboards/';

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

async function readText(path) {
  try {
    const result = await get(path, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch (_) {
    return null;
  }
}

async function readJson(path) {
  const text = await readText(path);
  if (text == null) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function writeJson(path, value) {
  await put(path, JSON.stringify(value), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json; charset=utf-8',
    cacheControlMaxAge: 60,
  });
}

function metadataOnly(d) {
  return {
    id: String(d.id || ''),
    title: String(d.title || ''),
    topic: String(d.topic || ''),
    date: String(d.date || ''),
  };
}

async function migrateLegacyState() {
  // Si ya existe el formato v2, no tocamos nada.
  let meta = await readJson(META_PATH);
  if (meta && Array.isArray(meta.topics) && Array.isArray(meta.dashboards)) return meta;

  // Compatibilidad con la versión anterior: un único state.json que contenía
  // TODOS los HTML. Se migra una sola vez a un Blob por dashboard.
  const legacy = await readJson(LEGACY_PATH);
  if (!legacy || !Array.isArray(legacy.topics) || !Array.isArray(legacy.dashboards)) {
    return null;
  }

  const dashboards = [];
  const writes = [];

  for (const d of legacy.dashboards) {
    const id = safeId(d.id);
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

  // Son varios objetos pequeños/medianos, no una petición gigante desde el navegador.
  await Promise.all(writes);

  meta = {
    version: 2,
    topics: legacy.topics,
    dashboards,
    migratedAt: new Date().toISOString(),
  };
  await writeJson(META_PATH, meta);

  // LEGACY_PATH se conserva como copia de seguridad; no se elimina automáticamente.
  return meta;
}

async function loadMeta() {
  const meta = await readJson(META_PATH);
  if (meta && Array.isArray(meta.topics) && Array.isArray(meta.dashboards)) return meta;
  return await migrateLegacyState();
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

    // Asegura la migración antes de intentar leer el HTML individual.
    await loadMeta();
    let html = await readText(dashboardPath(id));

    // Fallback de seguridad por si la migración se interrumpió a mitad.
    if (html == null) {
      const legacy = await readJson(LEGACY_PATH);
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
  }

  try {
    const meta = await loadMeta();
    return json({ configured: true, state: meta });
  } catch (error) {
    console.error('GET /api/data:', error);
    return json({ configured: true, state: null, error: 'No se pudo leer el almacenamiento.' }, 500);
  }
}

export async function PUT(request) {
  if (!blobConfigured()) {
    return json({ error: 'Vercel Blob todavía no está conectado al proyecto.' }, 503);
  }
  if (!process.env.ADMIN_PASSWORD) {
    return json({ error: 'Falta configurar ADMIN_PASSWORD en Vercel.' }, 503);
  }
  if (!isAuthorized(request)) {
    return json({ error: 'Clave de edición incorrecta.' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: 'JSON inválido.' }, 400);
  }

  const action = payload && payload.action;

  try {
    if (action === 'upsert-dashboard') {
      const d = payload.dashboard || {};
      const id = safeId(d.id);
      const html = payload.html;

      if (!id || typeof html !== 'string' || !html.trim()) {
        return json({ error: 'Dashboard o HTML inválido.' }, 400);
      }

      // Dejamos margen frente al límite de 4.5 MB de Vercel Functions.
      if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) {
        return json({ error: 'Este dashboard individual supera 4 MB. Debe subirse con carga directa a Blob.' }, 413);
      }

      let meta = await loadMeta();
      if (!meta) {
        meta = {
          version: 2,
          topics: Array.isArray(payload.topics) ? payload.topics : [],
          dashboards: [],
        };
      }
      if (Array.isArray(payload.topics)) meta.topics = payload.topics;

      await put(dashboardPath(id), html, {
        access: 'private',
        allowOverwrite: true,
        contentType: 'text/html; charset=utf-8',
        cacheControlMaxAge: 60,
      });

      const item = metadataOnly(d);
      const pos = meta.dashboards.findIndex((x) => x && x.id === id);
      if (pos >= 0) meta.dashboards[pos] = item;
      else meta.dashboards.push(item);

      meta.version = 2;
      meta.updatedAt = new Date().toISOString();
      await writeJson(META_PATH, meta);
      return json({ ok: true, state: meta });
    }

    if (action === 'save-topics') {
      if (!Array.isArray(payload.topics) || payload.topics.length > 200) {
        return json({ error: 'Formato de categorías inválido.' }, 400);
      }
      let meta = await loadMeta();
      if (!meta) meta = { version: 2, topics: [], dashboards: [] };
      meta.topics = payload.topics;
      meta.updatedAt = new Date().toISOString();
      await writeJson(META_PATH, meta);
      return json({ ok: true, state: meta });
    }

    if (action === 'delete-dashboard') {
      const id = safeId(payload.id);
      if (!id) return json({ error: 'Dashboard inválido.' }, 400);
      let meta = await loadMeta();
      if (!meta) return json({ ok: true, state: null });

      meta.dashboards = meta.dashboards.filter((d) => d && d.id !== id);
      meta.updatedAt = new Date().toISOString();
      await writeJson(META_PATH, meta);
      await del(dashboardPath(id));
      return json({ ok: true, state: meta });
    }

    return json({ error: 'Acción no soportada.' }, 400);
  } catch (error) {
    console.error('PUT /api/data:', error);
    return json({ error: 'No se pudo guardar en Vercel Blob.' }, 500);
  }
}
