# Ventum · App (técnico)

Frontend del mesero digital con IA. React 19 + Vite 8 + TypeScript + Tailwind v4.
Documentación completa del proyecto en el [README raíz](../../README.md) y en [`docs/`](../../docs).

## Requisitos
- Node 18+ y npm.

## Scripts
```bash
npm install      # instala dependencias
npm run dev      # servidor de desarrollo (modo mock por defecto)
npm run build    # typecheck + build de producción
npm run lint     # ESLint
npm run preview  # sirve el build
```

## Modos de ejecución
- **Mock (por defecto en `npm run dev`):** sin variables de entorno. Usa `localStorage` + `BroadcastChannel` (sincroniza entre pestañas del mismo navegador). Todo funciona en la terminal.
- **Remoto (producción, `npm start`):** el servidor Express (`server.js`) sirve el frontend y expone una API REST de coordinación sobre **PostgreSQL** + realtime por **SSE** (`/api/events`). Sincroniza entre dispositivos (celular ↔ PC). Se activa con `DATABASE_URL`.
- **Sheila con IA real (opcional):** define `GEMINI_API_KEY` en el servidor. Sin esto, Sheila usa el motor local determinista. El proxy a Gemini vive en `/api/sheila` (la key nunca llega al navegador).

> Despliegue completo en [docs/DESPLIEGUE-RAILWAY.md](../../docs/DESPLIEGUE-RAILWAY.md). El menú, las mesas, el PIN y el inventario son estáticos del frontend; solo sesiones y pedidos viven en Postgres.

## Accesos de demo
- Cliente: escanear mesa → PIN de mesa (Mesa N = `100N`, p. ej. Mesa 1 = `1001`).
- Personal (`/login`): PIN único **2580** para mesero, cocina y admin.

## Estructura
```
src/
  context/AppContext.tsx        Estado global (sesión, carrito, rol)
  lib/supabase.ts               API unificada (mock / REST+SSE)
  services/
    mockData.ts                 Menú, inventario, recetas, pedidos, broadcast
    qrService.ts                QR reales (qrcode)
    shoppingListPdf.ts          Lista de mandado (jsPDF)
    notifications.ts            Sonidos + notificaciones
  features/
    ai/                         Sheila: dietEngine, waitForecast, sheilaClient, UI
    customer/pages/             QRLanding, CustomerMenu, Resumen, OrderStatus
    auth/pages/StaffLogin.tsx
    merchant/pages/             KitchenDashboard, WaiterDashboard, AdminDashboard
    merchant/components/SupplyBar.tsx
server.js                       Express: frontend + API REST (Postgres) + SSE + proxy Gemini
```

## Notas
- Las imágenes de los platos son placeholders de Unsplash (reemplazables).
- El inventario y el pronóstico de espera persisten en `localStorage` en modo mock.
