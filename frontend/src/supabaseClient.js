// Inicializa o cliente Supabase (Auth) no navegador. A chave anon é pública por design.
let _clientePromise = null;

export function getSupabase() {
  if (!_clientePromise) {
    _clientePromise = fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) =>
        window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          // persistSession: false -> login sempre exigido ao reabrir o site (nada
          // fica salvo entre sessões do navegador). autoRefreshToken continua
          // ligado só para não derrubar quem está com a aba aberta e em uso.
          auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
        })
      );
  }
  return _clientePromise;
}

// Token de acesso (JWT) da sessão atual, ou null.
export async function tokenAtual() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token ?? null;
}
