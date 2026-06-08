// ============================================================================
// Ventum — Servidor de producción (Railway)
// ----------------------------------------------------------------------------
// Una sola plataforma (Railway) sirve TODO:
//   1. Frontend compilado (carpeta dist/).
//   2. Proxy seguro a Google Gemini en POST /api/sheila (key solo en servidor).
//   3. API REST de coordinación (sesiones y pedidos) sobre PostgreSQL.
//   4. Realtime entre dispositivos vía SSE en GET /api/events.
//
// El menú, las mesas, el PIN y el inventario son contenido ESTÁTICO del
// frontend (idéntico en cada dispositivo), así que NO viven en la base de
// datos: solo se guarda el estado vivo compartido (sesiones y pedidos).
//
// Si no hay DATABASE_URL, los endpoints de datos responden 503 y el frontend
// cae a su modo mock (localStorage). Si no hay GEMINI_API_KEY, Sheila usa su
// motor local determinista.
// ============================================================================
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------
let pool = null;
let dbReady = false;

if (DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  initDb().then(() => { dbReady = true; }).catch((e) => {
    console.error('[DB] Error inicializando:', e.message);
  });
}

async function initDb() {
  await pool.query('create extension if not exists pgcrypto');
  await pool.query(`
    create table if not exists table_sessions (
      id uuid primary key default gen_random_uuid(),
      store_id text not null,
      table_id text not null,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      paid_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists orders (
      id uuid primary key default gen_random_uuid(),
      store_id text not null,
      table_session_id uuid not null references table_sessions(id) on delete cascade,
      table_name text,
      status text not null default 'pending',
      total_amount numeric not null default 0,
      notes text,
      eta_minutes int,
      created_at timestamptz not null default now(),
      preparing_at timestamptz,
      ready_at timestamptz
    );
  `);
  await pool.query(`
    create table if not exists order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references orders(id) on delete cascade,
      product_id text not null,
      product_name text not null,
      quantity int not null,
      unit_price numeric not null,
      notes text
    );
  `);
  console.log('[DB] Esquema listo');
}

function requireDb(_req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  next();
}

// Convierte numéricos de Postgres (string) a number
function hydrateOrder(row) {
  return {
    ...row,
    total_amount: Number(row.total_amount),
    eta_minutes: row.eta_minutes == null ? null : Number(row.eta_minutes),
    items: (row.items || []).map((i) => ({ ...i, unit_price: Number(i.unit_price), quantity: Number(i.quantity) })),
  };
}

const ORDER_SELECT = `
  select o.*, ts.table_id, coalesce(
    json_agg(json_build_object(
      'id', i.id, 'order_id', i.order_id, 'product_id', i.product_id,
      'product_name', i.product_name, 'quantity', i.quantity,
      'unit_price', i.unit_price, 'notes', i.notes
    )) filter (where i.id is not null), '[]'
  ) as items
  from orders o
  left join table_sessions ts on ts.id = o.table_session_id
  left join order_items i on i.order_id = o.id
`;

// ---------------------------------------------------------------------------
// Realtime — Server-Sent Events
// ---------------------------------------------------------------------------
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function broadcast(event, payload) {
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const c of sseClients) {
    try { c.write(data); } catch { /* cliente caído */ }
  }
}

// ---------------------------------------------------------------------------
// API — Sesiones de mesa
// ---------------------------------------------------------------------------
app.post('/api/session', requireDb, async (req, res) => {
  try {
    const { tableId, storeId } = req.body ?? {};
    const found = await pool.query(
      `select * from table_sessions where table_id=$1 and status='active' limit 1`, [tableId]
    );
    if (found.rows[0]) return res.json(found.rows[0]);
    const created = await pool.query(
      `insert into table_sessions (store_id, table_id, status) values ($1,$2,'active') returning *`,
      [storeId, tableId]
    );
    res.json(created.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/sessions', requireDb, async (req, res) => {
  try {
    const { storeId } = req.query;
    const r = await pool.query(
      `select * from table_sessions where store_id=$1 and status in ('active','paid')`, [storeId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/session/:id', requireDb, async (req, res) => {
  try {
    const r = await pool.query(`select * from table_sessions where id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/session/:id/pay', requireDb, async (req, res) => {
  try {
    const r = await pool.query(
      `update table_sessions set status='paid', paid_at=now() where id=$1 returning *`, [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
    broadcast('session_closed', { sessionId: req.params.id, paid_at: r.rows[0].paid_at });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------------------------------------------------------------------------
// API — Pedidos
// ---------------------------------------------------------------------------
app.post('/api/order', requireDb, async (req, res) => {
  const client = await pool.connect();
  try {
    const { storeId, tableSessionId, tableName, items, notes, etaMinutes } = req.body ?? {};

    const sess = await client.query(`select status from table_sessions where id=$1`, [tableSessionId]);
    if (!sess.rows[0]) return res.status(404).json({ error: 'Sesión no encontrada' });
    if (sess.rows[0].status === 'paid') return res.status(400).json({ error: 'No se pueden agregar pedidos a una cuenta pagada' });

    const cnt = await client.query(
      `select count(*)::int as n from orders where table_session_id=$1 and status <> 'cancelled'`, [tableSessionId]
    );
    if (cnt.rows[0].n >= 2) {
      return res.status(400).json({ error: 'Límite excedido: máximo 2 órdenes por mesa simultáneamente.' });
    }

    const total = (items || []).reduce((s, i) => s + i.unitPrice * i.quantity, 0);

    await client.query('begin');
    const ord = await client.query(
      `insert into orders (store_id, table_session_id, table_name, status, total_amount, notes, eta_minutes)
       values ($1,$2,$3,'pending',$4,$5,$6) returning *`,
      [storeId, tableSessionId, tableName ?? null, Math.round(total), notes || null, etaMinutes ?? null]
    );
    const order = ord.rows[0];
    for (const it of items || []) {
      await client.query(
        `insert into order_items (order_id, product_id, product_name, quantity, unit_price, notes)
         values ($1,$2,$3,$4,$5,$6)`,
        [order.id, it.productId, it.productName, it.quantity, it.unitPrice, it.notes || null]
      );
    }
    await client.query('commit');

    const full = await pool.query(`${ORDER_SELECT} where o.id=$1 group by o.id, ts.table_id`, [order.id]);
    const hydrated = hydrateOrder(full.rows[0]);
    broadcast('order_created', hydrated);
    res.json(hydrated);
  } catch (e) {
    await client.query('rollback').catch(() => {});
    res.status(500).json({ error: String(e) });
  } finally {
    client.release();
  }
});

app.patch('/api/order/:id/status', requireDb, async (req, res) => {
  try {
    const { status } = req.body ?? {};
    const sets = ['status=$2'];
    if (status === 'preparing') sets.push('preparing_at=coalesce(preparing_at, now())');
    if (status === 'ready') sets.push('ready_at=coalesce(ready_at, now())');
    const upd = await pool.query(
      `update orders set ${sets.join(', ')} where id=$1 returning id`, [req.params.id, status]
    );
    if (!upd.rows[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const full = await pool.query(`${ORDER_SELECT} where o.id=$1 group by o.id, ts.table_id`, [req.params.id]);
    const hydrated = hydrateOrder(full.rows[0]);
    broadcast('status_changed', hydrated);
    res.json(hydrated);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/order/session/:sessionId', requireDb, async (req, res) => {
  try {
    const r = await pool.query(
      `${ORDER_SELECT} where o.table_session_id=$1 group by o.id, ts.table_id order by o.created_at`, [req.params.sessionId]
    );
    res.json(r.rows.map(hydrateOrder));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/orders/active', requireDb, async (req, res) => {
  try {
    const { storeId } = req.query;
    const r = await pool.query(
      `${ORDER_SELECT}
       where o.store_id=$1 and o.status <> 'cancelled'
       and o.table_session_id in (select id from table_sessions where store_id=$1 and status='active')
       group by o.id, ts.table_id order by o.created_at`, [storeId]
    );
    res.json(r.rows.map(hydrateOrder));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/orders/all', requireDb, async (req, res) => {
  try {
    const { storeId } = req.query;
    const r = await pool.query(
      `${ORDER_SELECT} where o.store_id=$1 group by o.id, ts.table_id order by o.created_at`, [storeId]
    );
    res.json(r.rows.map(hydrateOrder));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------------------------------------------------------------------------
// API — Sheila IA (proxy seguro a Gemini)
// ---------------------------------------------------------------------------
app.post('/api/sheila', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY no configurada' });

  try {
    const { message, menu, orders } = req.body ?? {};
    const ahora = new Date().toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const system = [
      '# ROL',
      'Eres "Sheila", la mesera virtual atenta, ultra-empática, profesional y carismática del restaurante colombiano Ventum. Tu objetivo es guiar al comensal, cuidar su salud y asegurar una experiencia fluida antes de derivar la atención al equipo físico.',
      '',
      '# CONTEXTO Y HORARIOS',
      `Fecha y hora actual (Colombia): ${ahora}.`,
      'Horarios del restaurante:',
      '- Martes a Jueves: 12:00 a 22:00.',
      '- Viernes y Sábado: 12:00 a 23:30.',
      '- Domingo: 10:00 a 20:00.',
      '- Lunes: Cerrado.',
      '',
      '# TAREA',
      'Gestiona la conversación (bienvenida, toma de pedido, dudas y soporte) aplicando de forma invisible pero estricta las reglas de negocio. Usa EXCLUSIVAMENTE el menú y los pedidos que te entrego como contexto; no inventes platos, precios ni horarios.',
      '',
      '# REGLAS DE NEGOCIO',
      '## 1. Alergias y Dietas (Prioridad Máxima)',
      'Conoces los ingredientes de cada plato. Si el cliente menciona una alergia o restricción, sugiere SOLO alternativas seguras y compatibles, y NUNCA recomiendes algo incompatible.',
      'En la nota interna para cocina, incluye SIEMPRE una aclaración y un asterisco * en el plato de la persona con la restricción. Ejemplo: [Orden: Hamburguesa Clásica, *Ajiaco (Cliente alérgico al gluten)].',
      'Añade siempre el aviso de confirmar alergias graves con el personal.',
      '## 2. Flujo del Pedido y Pagos',
      'El cliente puede hacer una segunda orden si olvidó pedir algo. Los pagos se realizan ÚNICAMENTE al terminar de comer (nunca por adelantado). Si quiere cancelar o retirar un plato ya enviado a cocina, indícale amablemente que llame al mesero físico para el cambio en el sistema.',
      '## 3. Derivación a Humano',
      'Para organización de Eventos: sí es posible, pero debe comunicarse directamente con el mesero físico para gestionarlo de forma personalizada.',
      '## 4. Tiempo y Contingencias',
      'A los 15 minutos de la orden, envía un seguimiento proactivo cálido (idea base: "estamos preparando con esmero una comida deliciosa"), parafraseado de forma creativa cada vez. Si se queja por la demora, cálmalo con empatía: su elección es un plato fuerte y el chef se asegura de que quede en su punto exacto, solo unos minutos más.',
      '## 5. Disponibilidad de Productos',
      'Si el cliente pide algo que no está en el menú o no está disponible, NUNCA respondas con un "no" seco. Responde siempre en positivo, ofreciendo una alternativa que sí tengamos del menú. Ejemplo: Cliente: "¿Tienen jugo de mango?" → Sheila: "¡Claro que tenemos jugos naturales! Hoy contamos con limonada de hierbabuena y jugo de lulo, ¿te animo con alguno?".',
      '',
      '# RESTRICCIONES',
      'PROHIBIDO sonar robótica: varía saludos, mensajes de espera y despedidas en cada interacción; lenguaje natural, fresco y humano. No inventes horarios fuera de la lista. No proceses cancelaciones de platos tú misma: deriva siempre al mesero físico.',
      '',
      '# TONO',
      'Altamente empático, servicial, cálido y educado. Lenguaje cercano ("¡Por supuesto!", "Excelente elección", "Cuidaremos cada detalle"). Emojis con moderación. Sé breve.',
      '',
      '# FORMATO',
      'Al confirmar una orden, muéstrala en lista limpia y añade al final, entre corchetes, la nota interna para cocina si aplica (con el asterisco de alergia).',
      'Cuando sugieras platos del menú, incluye al final una línea EXACTA: SUGERENCIAS: id1,id2 (usando los ids del menú).',
      '',
      `MENÚ: ${JSON.stringify(menu ?? [])}`,
      `PEDIDOS DEL CLIENTE: ${JSON.stringify(orders ?? [])}`,
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const gemRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: String(message ?? '') }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 500 },
      }),
    });

    if (!gemRes.ok) {
      const detail = await gemRes.text();
      console.error('[Sheila] Gemini error:', gemRes.status, detail);
      return res.status(502).json({ error: 'Gemini no disponible' });
    }

    const data = await gemRes.json();
    const raw = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    let text = raw;
    let suggestionIds;
    const m = raw.match(/SUGERENCIAS:\s*([a-z0-9,\-\s]+)/i);
    if (m) {
      suggestionIds = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      text = raw.replace(m[0], '').trim();
    }
    res.json({ text, suggestionIds });
  } catch (err) {
    console.error('[Sheila] error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Estado del backend (para depurar la demo)
app.get('/api/health', (_req, res) => {
  res.json({ db: dbReady, gemini: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL });
});

// ---------------------------------------------------------------------------
// Frontend compilado + SPA fallback
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ventum escuchando en puerto ${PORT}`);
  console.log(`Base de datos: ${DATABASE_URL ? 'configurada (Postgres)' : 'no configurada (modo mock en el cliente)'}`);
  console.log(`Sheila IA (Gemini): ${GEMINI_API_KEY ? 'ACTIVA · ' + GEMINI_MODEL : 'inactiva (motor local)'}`);
});
