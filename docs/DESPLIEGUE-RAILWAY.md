# Despliegue en Railway (todo en una plataforma)

Esta guía publica Ventum con:
- **Frontend + API + Realtime** en un servicio Express (`SGP/SGP/server.js`).
- **PostgreSQL** de Railway para el estado vivo (sesiones y pedidos) → el
  celular y el PC se sincronizan en tiempo real.
- **Sheila con Google Gemini** real (proxy seguro server-side).

## Arquitectura
- El **menú, las mesas, el PIN y el inventario** son contenido estático del
  frontend (idéntico en todo dispositivo) → no necesitan base de datos.
- **PostgreSQL** guarda solo lo que debe compartirse entre dispositivos:
  `table_sessions`, `orders`, `order_items` (el esquema se crea solo al
  arrancar el servidor).
- El **realtime** se hace con **SSE** (`GET /api/events`): el servidor empuja
  los eventos (pedido nuevo, cambio de estado, cuenta pagada) a todos los
  dispositivos conectados. No depende de WebSockets externos.
- Si falta `DATABASE_URL`, la app cae a modo mock (localStorage por
  dispositivo). Si falta `GEMINI_API_KEY`, Sheila usa su motor local.

## Paso 1 — Servicio de la app (ya lo tienes)
- Railway → tu servicio → **Settings → Source → Root Directory** = `SGP/SGP`
- **Settings → Deploy → Custom Start Command** = `npm start` (respaldo)
- Builder: Railpack por defecto (Node 22). `railway.json` ya lo fija.

## Paso 2 — Agregar PostgreSQL
1. En tu proyecto de Railway: **+ New → Database → Add PostgreSQL**.
2. Railway crea el servicio de Postgres y la variable `DATABASE_URL`.
3. Conecta esa variable a tu app:
   - Ve a tu **servicio de la app → Variables → New Variable → Add Reference**
   - Elige el Postgres y la variable **`DATABASE_URL`**.
   - (Equivale a poner `DATABASE_URL = ${{Postgres.DATABASE_URL}}`.)
4. No tienes que crear tablas: el servidor las crea solo al iniciar.

> Conexión interna de Railway → no requiere SSL. Si usaras una URL pública de
> Postgres que exija SSL, agrega la variable `PGSSL=true`.

## Paso 3 — Variables de Gemini (Sheila con IA real)
1. API key gratis en https://aistudio.google.com/apikey (empieza por `AIza...`).
2. En el servicio de la app → **Variables**:
   - `GEMINI_API_KEY` = tu key
   - `GEMINI_MODEL` = `gemini-2.0-flash` (opcional)

## Paso 4 — Dominio público
- **Settings → Networking → Generate Domain** → URL `…up.railway.app`.

## Paso 5 — Verificar
Abre `https://TU-DOMINIO.up.railway.app/api/health`. Debe responder:
```json
{ "db": true, "gemini": true, "model": "gemini-2.0-flash" }
```
- `db: true` → Postgres conectado (sincronización entre dispositivos OK).
- `gemini: true` → Sheila con IA real OK.

En los **Deploy Logs** al arrancar verás:
```
Ventum escuchando en puerto 3000
Base de datos: configurada (Postgres)
Sheila IA (Gemini): ACTIVA · gemini-2.0-flash
```

## Probar la sincronización (la demo)
1. **PC:** abre la URL → `/login` (PIN `2580`) → Cocina en una pestaña y
   Mesero/Admin en otras.
2. **Celular:** entra como admin → pestaña **QR** → escanea el QR de la Mesa 1
   (apunta a la URL pública). Pide algo y "Enviar a cocina".
3. En el **PC**, la cocina ve el pedido aparecer al instante (SSE). Cambia a
   "En preparación" → "Listo"; el celular ve el avance del estado en vivo.
4. Mesero entrega y cobra; el celular ve la cuenta pagada con el conteo de 15m.

## Prueba local con Postgres (opcional)
```bash
cd SGP/SGP
npm install
npm run build
# Linux/macOS:
DATABASE_URL=postgres://user:pass@host:5432/db GEMINI_API_KEY=AIza... npm start
# Windows PowerShell:
$env:DATABASE_URL="postgres://user:pass@host:5432/db"; $env:GEMINI_API_KEY="AIza..."; npm start
```
Abre http://localhost:3000

## Modos resumen
| Variable | Si está | Si falta |
|---|---|---|
| `DATABASE_URL` | Sesiones/pedidos en Postgres + realtime entre dispositivos | Modo mock (localStorage por dispositivo) |
| `GEMINI_API_KEY` | Sheila responde con IA generativa | Sheila usa motor local determinista |
