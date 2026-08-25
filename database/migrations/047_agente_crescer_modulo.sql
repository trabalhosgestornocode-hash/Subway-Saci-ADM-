-- =====================================================================
-- MIGRATION 047 — Agente Crescer (módulo no catálogo)
-- =====================================================================
-- OBJETIVO
--   Novo módulo "Agente Crescer" — assistente de IA (Claude) que consulta
--   dados já calculados pelo Crescer com Delivery e explica em linguagem
--   natural. Fase 1/MVP: 100% leitura (dashboard executivo + diagnóstico).
--
--   SEM tabela nova nesta migration: o backend reutiliza os services
--   existentes (dashboardExecutivo.service.js) para os dados, e o log de
--   uso (usuário, organização, unidade, tools usadas, duração, sucesso/erro)
--   vai para `plataforma_auditoria` — já existente e append-only desde a
--   migration 020. Nenhum schema novo é necessário para os dados em si.
--
--   Módulo novo no catálogo (`modulos`) SEM backfill em
--   `organizacao_modulos` — mesmo padrão da migration 037 (Parser Food
--   Delivery): começa FECHADO para todas as empresas; o SuperAdmin decide
--   quem ganha acesso pela tela de Acessos já existente (data-driven a
--   partir do catálogo).
--
-- PRÉ-REQUISITOS: migrations 014, 015, 016, 020, 030 aplicadas
--   (auth_organizacao_ids(), is_platform_superadmin(), tabela `modulos`).
-- IDEMPOTENTE: pode ser reexecutada com segurança.
-- COMO USAR: Supabase -> SQL Editor -> cole e execute este arquivo inteiro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. CATÁLOGO DE MÓDULOS — nova entrada, sem conceder a ninguém.
-- ---------------------------------------------------------------------
insert into modulos (id, nome, categoria, ordem) values
  ('agente_ia', 'Agente Crescer (IA)', 'operacao', 15)
on conflict (id) do update set nome = excluded.nome, categoria = excluded.categoria, ordem = excluded.ordem;

-- ---------------------------------------------------------------------
-- 1. VERIFICAÇÃO (rode separadamente para conferir)
-- ---------------------------------------------------------------------
--   select id, nome, categoria, ordem from modulos where id = 'agente_ia';
--   -- Esperado: 1 linha, e 0 linhas em organizacao_modulos para este módulo
--   -- (até o SuperAdmin liberar manualmente para alguma empresa):
--   select count(*) from organizacao_modulos where modulo_id = 'agente_ia';
-- =====================================================================
-- FIM
-- =====================================================================
