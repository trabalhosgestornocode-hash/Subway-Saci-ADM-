// Inicializa o cliente Supabase (Auth) no navegador. A chave anon é pública por design.
let _clientePromise = null;

export function getSupabase() {
  if (!_clientePromise) {
    _clientePromise = fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) =>
        window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
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
