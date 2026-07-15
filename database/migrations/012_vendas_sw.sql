-- =====================================================================
-- MIGRATION 012 — Aba Vendas (consolidação de relatórios SW / PDV / iFood)
-- Recebe/processa/organiza dados vendidos. NÃO registra venda manual nem
-- faz fechamento de caixa. Destino da importação dos relatórios do SWFast.
--   "loja" = unidades. Reaproveita fn_custo_produto (ficha técnica) p/ CMV teórico.
-- Colunas de enum-leve usam text (idempotência); origem/canal em text.
-- Rode no SQL Editor do Supabase.
-- =====================================================================

-- 1) Mapa código do SW -> produto do sistema (escopo: organização, reaproveitável)
create table if not exists sw_mapeamento_produtos (
  id uuid primary key default gen_random_uuid(),
  organizacao_id uuid not null references organizacoes(id) on delete cascade,
  codigo_sw text not null,
  nome_sw text,
  tipo_item text not null default 'produto',      -- produto | etapa | taxa_desconto | combo | outro
  produto_id uuid references produtos(id) on delete set null,
  ignorar_no_cmv boolean not null default false,
  ignorar_no_estoque boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organizacao_id, codigo_sw)
);
create index if not exists idx_swmap_org on sw_mapeamento_produtos(organizacao_id);
create index if not exists idx_swmap_produto on sw_mapeamento_produtos(produto_id);

-- 2) Cabeçalho de cada importação (idempotência por hash do arquivo)
create table if not exists importacoes_vendas (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  origem text not null default 'manual',          -- manual | swfast | ifood
  canal text not null default 'balcao',           -- balcao | ifood
  data_movimento date,
  tipo_relatorio text not null,                   -- faturamento | produtos_grupo
  nome_arquivo text,
  hash_arquivo text,
  status text not null default 'concluida',        -- processando | concluida | erro | cancelada
  total_registros int not null default 0,
  valor_total numeric(14,2) not null default 0,
  mensagem_erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists idx_impv_unidade on importacoes_vendas(unidade_id);
create index if not exists idx_impv_data on importacoes_vendas(data_movimento);
-- proteção contra reimportação do mesmo arquivo
create unique index if not exists uq_impv_hash on importacoes_vendas(unidade_id, tipo_relatorio, hash_arquivo)
  where hash_arquivo is not null;

-- 3) Fechamento financeiro diário (relatório "Análise de Faturamento")
create table if not exists sw_faturamento_diario (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  importacao_id uuid references importacoes_vendas(id) on delete cascade,
  data_movimento date not null,
  produtos numeric(14,2) default 0,
  repiques numeric(14,2) default 0,
  servicos numeric(14,2) default 0,
  taxas_entrega numeric(14,2) default 0,
  creditos numeric(14,2) default 0,
  descontos numeric(14,2) default 0,
  combos numeric(14,2) default 0,
  especiais numeric(14,2) default 0,
  cortesias numeric(14,2) default 0,
  assinadas numeric(14,2) default 0,
  total numeric(14,2) default 0,
  faturamento numeric(14,2) default 0,
  diferenca numeric(14,2) default 0,
  origem text not null default 'manual',
  canal text not null default 'balcao',
  criado_em timestamptz not null default now(),
  unique (unidade_id, data_movimento, canal, origem)
);
create index if not exists idx_swfat_unidade on sw_faturamento_diario(unidade_id, data_movimento);

-- 4) Venda de produtos por grupo (relatório "Venda de Produtos por Grupo")
create table if not exists sw_produtos_vendidos (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  importacao_id uuid references importacoes_vendas(id) on delete cascade,
  data_movimento date not null,
  grupo text,
  codigo_sw text,
  nome_sw text,
  quantidade numeric(14,3) not null default 0,
  valor_total numeric(14,2) not null default 0,
  preco_medio numeric(14,4) default 0,
  tipo_item text not null default 'produto',       -- produto | etapa | taxa_desconto | combo
  produto_id uuid references produtos(id) on delete set null,
  custo_teorico numeric(14,4),                      -- quantidade × custo da ficha técnica
  ignorar_no_cmv boolean not null default false,
  ignorar_no_estoque boolean not null default false,
  origem text not null default 'manual',
  canal text not null default 'balcao',
  criado_em timestamptz not null default now()
);
create index if not exists idx_swpv_unidade on sw_produtos_vendidos(unidade_id, data_movimento);
create index if not exists idx_swpv_import on sw_produtos_vendidos(importacao_id);
create index if not exists idx_swpv_produto on sw_produtos_vendidos(produto_id);
create index if not exists idx_swpv_codigo on sw_produtos_vendidos(codigo_sw);

-- 5) Divergências detectadas nas importações
create table if not exists divergencias_vendas (
  id uuid primary key default gen_random_uuid(),
  unidade_id uuid not null references unidades(id) on delete cascade,
  importacao_id uuid references importacoes_vendas(id) on delete cascade,
  tipo text not null,                               -- ex: sem_vinculo, sem_ficha, datas_diferentes, valor_incompativel...
  nivel text not null default 'atencao',            -- info | atencao | critico
  titulo text not null,
  descricao text,
  resolvida boolean not null default false,
  criado_em timestamptz not null default now(),
  resolvida_em timestamptz
);
create index if not exists idx_divv_unidade on divergencias_vendas(unidade_id);
create index if not exists idx_divv_import on divergencias_vendas(importacao_id);
create index if not exists idx_divv_nivel on divergencias_vendas(nivel) where resolvida = false;

-- RLS (padrão do projeto: backend usa service_role e ignora; deny-by-default p/ anon)
alter table sw_mapeamento_produtos enable row level security;
alter table importacoes_vendas      enable row level security;
alter table sw_faturamento_diario   enable row level security;
alter table sw_produtos_vendidos    enable row level security;
alter table divergencias_vendas     enable row level security;

-- Semente de mapeamento: marca as ETAPAS de montagem conhecidas para IGNORAR
-- (tomate, cebola, alface, molhos, pães, temperos, "sem/não quero"...).
-- Reforço no backend por heurística de nome; aqui ficam os códigos que você já conhece.
