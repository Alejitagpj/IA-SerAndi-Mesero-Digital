// ============================================================================
// API unificada del cliente
// ----------------------------------------------------------------------------
// - Menú, mesas, PIN y tienda: contenido ESTÁTICO (mockData), idéntico en todo
//   dispositivo, no requiere base de datos.
// - Sesiones, pedidos y realtime: van al backend (Express + Postgres en Railway)
//   vía REST + SSE cuando está disponible; si no, caen al modo mock local.
// ============================================================================
import * as mockDb from '../services/mockData';
import { productById, mockTables } from '../services/mockData';
import { estimateWaitMinutes, recordCookDuration } from '../features/ai/waitForecast';
import type { Order, OrderStatus, TableSession } from '../types';

// Base del API: en producción (frontend servido por el mismo Express) es el
// mismo origen (''). Se puede sobreescribir con VITE_API_URL (útil en dev).
const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const REMOTE_BASE: string | undefined = API_URL ?? (import.meta.env.PROD ? '' : undefined);

// Hay backend disponible → no es modo mock.
export const isMockMode = REMOTE_BASE === undefined;

console.log(`[SGP API] Running in ${isMockMode ? 'MOCK' : 'REMOTE (Postgres + SSE)'} Mode`);

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${REMOTE_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* texto plano */ }
    throw new Error(msg);
  }
  return res.status === 204 ? (null as T) : res.json();
}

export const sgpApi = {
  // --------------------------------------------------------------------------
  // 1. MENÚ / MESAS / PIN — siempre estático (mockData)
  // --------------------------------------------------------------------------
  async getCategories() {
    return { data: mockDb.mockCategories, error: null as unknown };
  },

  async getProducts() {
    return { data: mockDb.mockProducts, error: null as unknown };
  },

  async getTables() {
    return { data: mockDb.mockTables, error: null as unknown };
  },

  async validateStaffPin(pin: string): Promise<boolean> {
    return pin === mockDb.mockStore.pin_code;
  },

  async validateTablePasscode(tableId: string, passcode: string): Promise<boolean> {
    return mockDb.validateTablePasscode(tableId, passcode);
  },

  // --------------------------------------------------------------------------
  // 2. SESIONES — remoto (Postgres) o mock
  // --------------------------------------------------------------------------
  async getOrCreateActiveSession(tableId: string): Promise<{ data: TableSession | null; error: any }> {
    if (isMockMode) {
      try {
        return { data: mockDb.findOrCreateActiveSession(tableId), error: null };
      } catch (err: any) {
        return { data: null, error: err.message };
      }
    }
    try {
      const data = await api<TableSession>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ tableId, storeId: mockDb.mockStore.id }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async getActiveStoreSessions(storeId: string): Promise<{ data: TableSession[] | null; error: any }> {
    if (isMockMode) {
      mockDb.runCleanupCycle();
      const sessions = mockDb.getStoredSessions().filter((s) => s.store_id === storeId);
      return { data: sessions, error: null };
    }
    try {
      const data = await api<TableSession[]>(`/api/sessions?storeId=${encodeURIComponent(storeId)}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async getSessionStatus(sessionId: string): Promise<{ data: TableSession | null; error: any }> {
    if (isMockMode) {
      mockDb.runCleanupCycle();
      const session = mockDb.getStoredSessions().find((s) => s.id === sessionId);
      return { data: session || null, error: session ? null : 'Session not found' };
    }
    try {
      const data = await api<TableSession>(`/api/session/${sessionId}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async payAndCloseSession(sessionId: string): Promise<{ data: TableSession | null; error: any }> {
    if (isMockMode) {
      try {
        return { data: mockDb.payAndCloseSession(sessionId), error: null };
      } catch (err: any) {
        return { data: null, error: err.message };
      }
    }
    try {
      const data = await api<TableSession>(`/api/session/${sessionId}/pay`, { method: 'POST' });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  // --------------------------------------------------------------------------
  // 3. PEDIDOS — remoto (Postgres) o mock
  // --------------------------------------------------------------------------
  async placeOrder(
    storeId: string,
    tableSessionId: string,
    items: { productId: string; quantity: number; notes: string }[],
    notes: string,
    tableName?: string,
  ): Promise<{ data: Order | null; error: any }> {
    if (isMockMode) {
      try {
        return { data: mockDb.placeMockOrder(storeId, tableSessionId, items, notes), error: null };
      } catch (err: any) {
        return { data: null, error: err.message };
      }
    }
    try {
      // Enriquecemos con nombre/precio desde el menú estático y calculamos ETA.
      const enriched = items.map((i) => {
        const p = productById.get(i.productId);
        if (!p) throw new Error(`Producto ${i.productId} no encontrado`);
        return { productId: p.id, productName: p.name, unitPrice: p.price, quantity: i.quantity, notes: i.notes };
      });
      const totalUnits = enriched.reduce((s, i) => s + i.quantity, 0);
      const etaMinutes = estimateWaitMinutes(totalUnits, 0);

      const data = await api<Order>('/api/order', {
        method: 'POST',
        body: JSON.stringify({ storeId, tableSessionId, tableName, items: enriched, notes, etaMinutes }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<{ data: Order | null; error: any }> {
    if (isMockMode) {
      try {
        return { data: mockDb.updateMockOrderStatus(orderId, status), error: null };
      } catch (err: any) {
        return { data: null, error: err.message };
      }
    }
    try {
      const data = await api<Order>(`/api/order/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      // Registrar duración real para el pronóstico de la IA (local a este equipo).
      if (status === 'ready' && data?.created_at) {
        const mins = (Date.now() - new Date(data.created_at).getTime()) / 60000;
        recordCookDuration(mins, new Date(data.created_at));
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async getSessionOrders(sessionId: string): Promise<{ data: Order[] | null; error: any }> {
    if (isMockMode) {
      const orders = mockDb.getStoredOrders().filter((o) => o.table_session_id === sessionId);
      return { data: orders, error: null };
    }
    try {
      const data = await api<Order[]>(`/api/order/session/${sessionId}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async getActiveStoreOrders(storeId: string): Promise<{ data: Order[] | null; error: any }> {
    if (isMockMode) {
      mockDb.runCleanupCycle();
      const sessions = mockDb.getStoredSessions().filter((s) => s.status === 'active');
      const sessionIds = new Set(sessions.map((s) => s.id));
      const orders = mockDb.getStoredOrders().filter(
        (o) => o.store_id === storeId && sessionIds.has(o.table_session_id) && o.status !== 'cancelled'
      );
      const hydrated = orders.map((o) => {
        const session = sessions.find((s) => s.id === o.table_session_id);
        const table = mockDb.mockTables.find((t) => t.id === session?.table_id);
        return { ...o, table_name: table ? table.name : 'Mesa' };
      });
      return { data: hydrated, error: null };
    }
    try {
      const data = await api<Order[]>(`/api/orders/active?storeId=${encodeURIComponent(storeId)}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  async getAllStoreOrders(storeId: string): Promise<{ data: Order[] | null; error: any }> {
    if (isMockMode) {
      const orders = mockDb.getStoredOrders().filter((o) => o.store_id === storeId);
      return { data: orders, error: null };
    }
    try {
      const data = await api<Order[]>(`/api/orders/all?storeId=${encodeURIComponent(storeId)}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  },

  // --------------------------------------------------------------------------
  // 4. REALTIME — SSE (remoto) o BroadcastChannel (mock)
  // --------------------------------------------------------------------------
  async broadcastEvent(event: string, payload: any) {
    // En modo remoto, el servidor emite los eventos al escribir; el cliente no
    // necesita publicar nada. En mock, usamos el canal local.
    if (isMockMode) mockDb.triggerLocalBroadcast(event, payload);
  },

  subscribeToBroadcast(callback: (event: string, payload: any) => void) {
    if (isMockMode) {
      return mockDb.subscribeToLocalBroadcast(callback);
    }
    const es = new EventSource(`${REMOTE_BASE}/api/events`);
    es.onmessage = (e) => {
      try {
        const { event, payload } = JSON.parse(e.data);
        callback(event, payload);
      } catch { /* keepalive u otro */ }
    };
    return () => es.close();
  },
};

// Indica si la coordinación va por backend (para lógica de inventario, etc.)
export const usesRemoteBackend = !isMockMode;

// Compatibilidad: algunos módulos importaban `mockTables` por aquí.
export { mockTables };

export default sgpApi;
