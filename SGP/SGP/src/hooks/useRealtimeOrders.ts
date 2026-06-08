import { useEffect, useRef, useState } from 'react';
import sgpApi, { isMockMode } from '../lib/supabase';
import type { Order } from '../types';

export function useRealtimeOrders(storeId?: string, activeSessionId?: string) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  // Fetch de pedidos. `silent` evita el spinner en refrescos de fondo (polling).
  const refreshOrders = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      if (activeSessionId) {
        // Lado cliente
        const { data, error: err } = await sgpApi.getSessionOrders(activeSessionId);
        if (err) throw new Error(typeof err === 'string' ? err : 'Error');
        setOrders(data || []);
      } else if (storeId) {
        // Lado comercio
        const { data, error: err } = await sgpApi.getActiveStoreOrders(storeId);
        if (err) throw new Error(typeof err === 'string' ? err : 'Error');
        setOrders(data || []);
      }
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    firstLoad.current = true;
    refreshOrders();

    // Realtime instantáneo (SSE en remoto / BroadcastChannel en mock)
    const unsubscribe = sgpApi.subscribeToBroadcast((event, payload) => {
      if (event === 'order_created') {
        const newOrder = payload as Order;
        if (storeId && newOrder.store_id === storeId) {
          setOrders(prev => (prev.some(o => o.id === newOrder.id) ? prev : [newOrder, ...prev]));
        } else if (activeSessionId && newOrder.table_session_id === activeSessionId) {
          setOrders(prev => (prev.some(o => o.id === newOrder.id) ? prev : [...prev, newOrder]));
        }
      }

      if (event === 'status_changed') {
        const updated = payload as Order;
        setOrders(prev => {
          // Si ya lo tenemos, actualizamos su estado; si no y nos corresponde, lo añadimos.
          if (prev.some(o => o.id === updated.id)) {
            return prev.map(o => (o.id === updated.id ? { ...o, ...updated } : o));
          }
          const belongs = (storeId && updated.store_id === storeId) ||
            (activeSessionId && updated.table_session_id === activeSessionId);
          return belongs ? [...prev, updated] : prev;
        });
      }

      if (event === 'session_closed') {
        const { sessionId } = payload;
        if (activeSessionId && sessionId === activeSessionId) {
          refreshOrders(true);
        } else if (storeId) {
          setOrders(prev => prev.filter(o => o.table_session_id !== sessionId));
        }
      }
    });

    // Respaldo por polling en modo remoto (garantiza actualización aunque el
    // SSE se corte detrás de un proxy). Silencioso para no parpadear la UI.
    let poll: ReturnType<typeof setInterval> | null = null;
    if (!isMockMode && (storeId || activeSessionId)) {
      poll = setInterval(() => refreshOrders(true), 4000);
    }

    return () => {
      unsubscribe();
      if (poll) clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, activeSessionId]);

  return { orders, loading, error, refreshOrders };
}

export default useRealtimeOrders;
