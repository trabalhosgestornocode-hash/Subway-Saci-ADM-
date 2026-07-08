import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { config } from "./env.js";

// Node < 22 não tem WebSocket global; o supabase-js (realtime) exige. Polyfill:
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

// Cliente com service_role: IGNORA RLS. Só no backend, nunca no frontend.
// O isolamento por organização/unidade é feito na camada de aplicação (requireAuth + filtros por organizacao_id).
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
