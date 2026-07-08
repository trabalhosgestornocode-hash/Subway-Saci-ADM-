-- =====================================================================
-- MIGRATION 001 — RLS lockdown (segurança)
-- Liga Row Level Security em TODAS as tabelas do schema public.
-- Efeito: a chave pública (anon) deixa de ler qualquer dado por padrão.
-- Não afeta o backend: a service_role IGNORA o RLS.
-- Rode no SQL Editor do Supabase.
-- =====================================================================

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Verificação: liste tabelas e se o RLS está ativo (rowsecurity = true)
-- select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;

-- =====================================================================
-- OBS: com RLS ligado e SEM policy permissiva, anon/authenticated não
-- leem nada (deny-by-default). Isso é o que queremos no MVP, pois o acesso
-- é 100% via backend (service_role). Quando o frontend for acessar o
-- Supabase diretamente com usuários logados, criaremos policies por
-- organização/unidade usando auth_organizacao_id().
-- =====================================================================
