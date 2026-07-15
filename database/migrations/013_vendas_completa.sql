-- =====================================================================
-- MIGRATION 013 — Vendas completa: arquivo original, observação,
-- combos por componentes e bucket de storage.
-- Rode no SQL Editor do Supabase.
-- =====================================================================

-- 1) Importações: guarda a observação do usuário e o caminho do arquivo
--    original no Supabase Storage (bucket vendas-relatorios).
alter table importacoes_vendas add column if not exists observacao text;
alter table importacoes_vendas add column if not exists arquivo_storage text;

-- 2) Combos por componentes: um código de combo do SW pode ser composto
--    por vários produtos do sistema (custo do combo = soma dos componentes).
--    Alternativa ao vínculo direto combo -> produto (que continua valendo
--    quando o combo tem produto/ficha próprios).
create table if not exists sw_combo_componentes (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  codigo_sw text not null,
  produto_id uuid not null references produtos(id) on delete cascade,
  quantidade numeric(10,3) not null default 1,
  created_at timestamptz not null default now(),
  unique (organizacao_id, codigo_sw, produto_id)
);
create index if not exists idx_swcombo_org_cod on sw_combo_componentes(organizacao_id, codigo_sw);

alter table sw_combo_componentes enable row level security;

-- 3) Bucket privado para os arquivos originais dos relatórios.
--    (o backend acessa com service_role; nenhuma policy pública)
insert into storage.buckets (id, name, public)
values ('vendas-relatorios', 'vendas-relatorios', false)
on conflict (id) do nothing;
