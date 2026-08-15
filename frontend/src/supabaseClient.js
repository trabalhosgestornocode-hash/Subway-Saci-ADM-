// Inicializa o cliente Supabase (Auth) no navegador. A chave anon é pública por design.
let _clientePromise = null;

export function getSupabase() {
  if (!_clientePromise) {
    _clientePromise = fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) =>
        window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          // persistSession: true -> a sessão sobrevive a F5, fechar/reabrir a aba
          // e navegação entre rotas (fica em localStorage, gerido pelo próprio
          // supabase-js). Isso NÃO é sessão infinita: o token ainda expira e é
          // renovado sozinho enquanto válido (autoRefreshToken), e continua
          // exigindo login de novo quando a sessão expira/é revogada de verdade
          // — ver app:sessao-expirada (sessao.js/api.js) e logout() (sessao.js).
          // O CONTEXTO de empresa/unidade é outra coisa (guardarContextToken em
          // sessao.js) e continua em sessionStorage por design, revalidado no
          // servidor a cada boot via restaurarContexto() — nunca é restaurado só
          // por existir no storage.
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
