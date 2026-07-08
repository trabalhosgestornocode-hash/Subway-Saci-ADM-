-- =====================================================================
-- MIGRATION 002 — Histórico de alterações de produto (auditoria)
-- Registra CADA alteração feita num produto pela tela Produtos/CMV:
-- qual campo mudou, valor anterior -> valor novo, QUEM alterou e QUANDO.
-- O backend grava aqui automaticamente ao salvar uma edição (best-effort:
-- se esta tabela não existir, o salvar continua funcionando normalmente).
-- Rode no SQL Editor do Supabase.
-- =====================================================================

create table if not exists produto_historico (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete cascade,
  alteracao_id uuid not null,        -- agrupa as mudanças de um mesmo "Salvar"
  campo text not null,               -- chave técnica: 'nome','tipo','tamanho','ativo','preco'
  rotulo text not null,              -- rótulo amigável: 'Nome', 'Preço · iFood (A)'
  valor_anterior text,               -- valor antes (null = não existia)
  valor_novo text,                   -- valor depois
  usuario_id uuid references perfis(id) on delete set null,
  usuario_nome text,                 -- snapshot do nome (sobrevive à exclusão do perfil)
  usuario_email text,                -- snapshot do e-mail
  created_at timestamptz not null default now()
);

create index if not exists idx_prod_hist_produto   on produto_historico(produto_id, created_at desc);
create index if not exists idx_prod_hist_alteracao on produto_historico(alteracao_id);
create index if not exists idx_prod_hist_org        on produto_historico(organizacao_id);

-- Segue o padrão de segurança do projeto: RLS ligado (o backend usa service_role
-- e ignora o RLS; o acesso do frontend é 100% via API autenticada).
alter table produto_historico enable row level security;

-- Verificação:
-- select rotulo, valor_anterior, valor_novo, usuario_nome, created_at
-- from produto_historico order by created_at desc limit 20;
