# Multi-perfil — Fase B (modelo definitivo + migration 060)

**Status:** migration escrita, testes estáticos passando (58/58). **Nenhuma migration aplicada em banco algum.**
**Data:** 2026-09-01
**Arquivos entregues:**
- `database/migrations/060_perfis_operacionais.sql` (DDL final)
- `backend/test/migration-060-perfis-operacionais.test.js` (validação estática + invariantes do backfill — pura, não toca banco)

---

## Determinação do ambiente (obrigatório antes de qualquer coisa)

| Fonte | Aponta para | Ação tomada |
|---|---|---|
| `backend/.env` (`SUPABASE_URL`) | **projeto principal / produção** (arquivo com credenciais reais) | **NÃO executei nada de escrita.** Os testes rodam com `--env-file-if-exists=.env` só porque `config/env.js` exige as chaves para carregar — **nenhum teste faz query** (mesmo padrão de `modulos.test.js` / `context-token.test.js`). |
| `backend/.env.test` (`TEST_SUPABASE_URL`) | `imtpcfpdnrzakjcbzocl` — projeto **descartável dedicado a testes** (o próprio `.env.test.example` diz "USE UM PROJETO SUPABASE DEDICADO A TESTES — NUNCA o de produção") | **NÃO apliquei 060 aqui tampouco.** O projeto de teste só tem, por documentação, as migrations 001–016/017 aplicadas — não tem `agente_conversas` (048), `sessoes_contexto.modulos` (030) nem as ~40 migrations seguintes. Aplicar 060 ali falharia no pré-requisito e não provaria nada útil. |

**Conclusão:** a Fase B foi feita 100% "no papel" + testes estáticos. A aplicação da 060 (mesmo em teste) fica para quando você tiver um projeto Supabase com o schema **na versão 059** para validar. Os pré-checks (seção E) e pós-checks (seção F) são as queries que **você** roda no SQL Editor do ambiente correto.

---

## A. Diagrama final

```
┌─────────────────────────────────────────────────────────────────────┐
│ auth.users (Supabase Auth)          CONTA DE ACESSO — e-mail + senha │
│   id ────────────────────────────────────────────┐   (1 por e-mail) │
└──────────────────────────────────────────────────┼──────────────────┘
                                                   │ 1:1  ON DELETE CASCADE
┌──────────────────────────────────────────────────▼──────────────────┐
│ perfis                              "espelho" da conta (NÃO renomear) │
│   id  = auth.users.id                                                │
│   nome, email, ativo, senha_provisoria, organizacao_id(LEGACY) …     │
└──────────────────────────────────────────────────┬──────────────────┘
                                                   │ 1:N  conta_id  ON DELETE CASCADE
┌──────────────────────────────────────────────────▼──────────────────┐
│ perfis_operacionais   ◄── NOVA (060)             PERFIL = a PESSOA   │
│   id            (backfill inicial: = perfis.id — UUID reaproveitado) │
│   conta_id ────► perfis(id)                                          │
│   nome, ativo                                                        │
│   pin_hash, pin_tentativas, pin_bloqueado_ate   (colunas p/ Fase H)  │
│   created_at, updated_at                                             │
│   RLS: SELECT where conta_id = auth.uid() or is_platform_superadmin()│
└───┬───────────────┬───────────────┬───────────────┬─────────────────┘
    │ perfil_id     │ perfil_id     │ perfil_id     │ perfil_id
    │ (NULLABLE)    │ (NULLABLE)    │ (NULLABLE)    │ (NULLABLE)
    │ CASCADE       │ CASCADE       │ CASCADE       │ SET NULL
    ▼               ▼               ▼               ▼
┌────────────┐ ┌────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ usuarios_  │ │ usuarios_  │ │ sessoes_contexto │ │ agente_conversas │
│ organiza-  │ │ unidades   │ │  perfil_id       │ │  perfil_id       │
│ coes       │ │            │ │  (Context Token  │ │  (ISOLAMENTO —    │
│ perfil_id  │ │ perfil_id  │ │   v2 = pid;      │ │   Fase A.1 —      │
│ + usuario_ │ │ + usuario_ │ │   Model Y: SEM   │ │   Fase D reescreve│
│ id (LEGACY)│ │ id (LEGACY)│ │   unique)        │ │   buscarConversa) │
└────────────┘ └────────────┘ └──────────────────┘ └──────────────────┘
       (autorização efetiva passa a ser por perfil_id — Fase C-E)

┌──────────────────────────────────────────────────────────────────────┐
│ plataforma_auditoria (append-only)                                    │
│   + perfil_id uuid   ◄── NOVA (060) — SEM FK, SEM backfill            │
│   (identidade histórica segue em ator_id + ator_email; perfil_id só   │
│    a partir da Fase I)                                                │
└──────────────────────────────────────────────────────────────────────┘

NÃO TOCADAS pela 060: as ~28 colunas de domínio `-> perfis(id)` (Cat. B/C da
Fase A.1). Ex.: lancamentos_financeiros_*, bonificacao_*, parser_fd_*,
martin_brower_*, ifood_*, produto_historico, insumo_preco_historico,
movimentacoes_estoque, insumos.created_by, ficha_tecnica.created_by, agente_uso.
```

---

## B. DDL final da migration 060

Arquivo completo: **`database/migrations/060_perfis_operacionais.sql`**.

Estrutura (7 seções + pré-check + pós-check + rollback, tudo num único arquivo transacional):

| Seção | O que faz |
|---|---|
| PRÉ-CHECK (comentado) | 11 queries read-only para rodar **antes** |
| 1 | `create table perfis_operacionais` + trigger `set_updated_at` + backfill (UUID reaproveitado) + RLS (1 policy, SELECT) + índice `(conta_id)` |
| 2 | `usuarios_organizacoes` + `perfil_id` (nullable), backfill `= usuario_id`, FK `uo_perfil_id_fk` CASCADE, índice `idx_uo_perfil`, `comment on` marcando LEGACY × CANÔNICA |
| 3 | `usuarios_unidades` — idem seção 2 (`uu_perfil_id_fk`) |
| 4 | `sessoes_contexto` + `perfil_id` (nullable), FK `sessoes_perfil_id_fk` CASCADE, backfill **só das não-impersonação**, índice parcial `idx_sessoes_perfil_vivas`, **revogação de todas as sessões vivas** (`motivo = 'migracao_060_multi_perfil'`) |
| 5 | `agente_conversas` + `perfil_id` (nullable), FK `agente_conversas_perfil_id_fk` **SET NULL**, backfill `= usuario_id`, índice composto `idx_agente_conversas_escopo_perfil` |
| 6 | `plataforma_auditoria` + `perfil_id` — **ADD COLUMN só** (sem FK, sem backfill; explica por quê) + índice `idx_audit_perfil` |
| 7 (comentário) | Registro do que foi **revisado e NÃO alterado** no RLS existente e por quê |
| PÓS-CHECK (comentado) | 7 blocos de validação para rodar **depois** |
| ROLLBACK (comentado) | Ordem exata de reversão |

**Transacional:** nenhum statement não-transacional (sem `alter type … add value`, sem `create index concurrently`). Se qualquer passo falhar (ex.: FK encontra órfão), a transação inteira faz rollback — nada é aplicado.

---

## C. Tabela de todas as alterações

| Tabela | Coluna / objeto | Antes | Depois | FK | ON DELETE | Índice | Motivo |
|---|---|---|---|---|---|---|---|
| **`perfis_operacionais`** *(nova)* | `id uuid pk` | — | `default gen_random_uuid()` (backfill: `= perfis.id`) | — | — | (PK) | Identidade do perfil (a pessoa). |
| | `conta_id uuid not null` | — | novo | → `perfis(id)` | **CASCADE** | `idx_perfis_op_conta (conta_id)` | Conta dona. CASCADE espelha `perfis.id → auth.users on delete cascade` — conta excluída ⇒ perfis somem; histórico protegido à parte. |
| | `nome text not null` | — | novo | — | — | — | Nome de exibição. **Sem UNIQUE** (item 13). |
| | `ativo boolean not null default true` | — | novo (backfill: `= perfis.ativo`) | — | — | — | Perfis se **desativam**, não se apagam (item 16). |
| | `pin_hash text` | — | novo, **nullable** | — | — | — | PIN individual (Fase H). NULL = sem PIN. |
| | `pin_tentativas integer not null default 0` | — | novo | — | — | — | Contador anti-brute-force (Fase H). |
| | `pin_bloqueado_ate timestamptz` | — | novo, nullable | — | — | — | Lockout temporário (Fase H). |
| | `created_at / updated_at timestamptz` | — | novo (backfill `created_at = perfis.created_at`) | — | — | — | Padrão de `perfis` (item 12); reusa `set_updated_at()`. |
| | trigger `trg_perfis_op_upd` | — | `before update … set_updated_at()` | — | — | — | `updated_at` automático. |
| | policy `rls_perfis_op_conta` | — | `for select to authenticated using (conta_id = auth.uid() or is_platform_superadmin())` | — | — | — | Defesa em profundidade. Escrita = só service_role. **NUNCA** `perfil_id = auth.uid()` (item 17). |
| **`usuarios_organizacoes`** | `perfil_id uuid` | não existia | **nullable** | → `perfis_operacionais(id)` `uo_perfil_id_fk` | **CASCADE** | `idx_uo_perfil (perfil_id)` | Canônica futura de autorização. CASCADE espelha o `usuario_id → auth.users` da própria tabela — vínculo é estado de acesso, não histórico. |
| | `usuario_id` | `not null → auth.users` CASCADE | **inalterado** | inalterado | inalterado | inalterado | **LEGACY/TRANSIÇÃO.** Mantido p/ rollback + compat com backend atual. |
| | `unique (usuario_id, organizacao_id)` | existe | **inalterada** | — | — | — | A UNIQUE `(perfil_id, organizacao_id)` vem junto do NOT NULL, na Fase C/E. |
| **`usuarios_unidades`** | `perfil_id uuid` | não existia | **nullable** | → `perfis_operacionais(id)` `uu_perfil_id_fk` | **CASCADE** | `idx_uu_perfil (perfil_id)` | Idem `usuarios_organizacoes`. |
| | `usuario_id` / `unique (usuario_id, unidade_id)` | — | **inalterados** | — | — | — | LEGACY/TRANSIÇÃO. |
| **`sessoes_contexto`** | `perfil_id uuid` | não existia | **nullable** | → `perfis_operacionais(id)` `sessoes_perfil_id_fk` | **CASCADE** | `idx_sessoes_perfil_vivas (perfil_id) where revogada_em is null` | Context Token v2 (`pid`). NULL legítimo só em impersonação. Índice parcial serve Model Y (revogar por `{perfilId,org}`) e "usuários online". |
| | `usuario_id` | `not null → auth.users` CASCADE | **inalterado** | — | — | — | LEGACY/TRANSIÇÃO. |
| | *(dados)* sessões vivas | `revogada_em IS NULL` | `revogada_em = now(), motivo_revogacao = 'migracao_060_multi_perfil'` | — | — | — | Mudança de contrato de sessão (Model Y + v2). Não-destrutivo; usuário re-seleciona contexto. |
| | *(dados)* `perfil_id` das sessões não-impersonação | NULL | `= usuario_id` | — | — | — | Coerência histórica. Impersonação fica com `perfil_id` NULL (contrato futuro). |
| | **CHECK** `perfil_id IS NOT NULL OR impersonado_por IS NOT NULL` | — | **NÃO adicionada** | — | — | — | Quebraria o `criarSessao` atual (insere sem `perfil_id`). Fase D. |
| **`agente_conversas`** | `perfil_id uuid` | não existia | **nullable** (espelha `usuario_id`, que já é nullable) | → `perfis_operacionais(id)` `agente_conversas_perfil_id_fk` | **SET NULL** | `idx_agente_conversas_escopo_perfil (perfil_id, organizacao_id, unidade_id)` | **Blocker de segurança (Fase A.1).** SET NULL espelha EXATAMENTE o `usuario_id → perfis(id)` desta tabela — conversa é histórico, perfil excluído não a apaga. Índice é o que a `buscarConversa` reescrita (Fase D) usa. |
| | `usuario_id` | `nullable → perfis(id)` SET NULL | **inalterado** | — | — | `idx_agente_conversas_escopo` inalterado | LEGACY/TRANSIÇÃO. |
| | *(dados)* `perfil_id` | NULL | `= usuario_id` (mantém NULL onde `usuario_id` é NULL) | — | — | — | Nenhuma conversa troca de dono. |
| **`plataforma_auditoria`** | `perfil_id uuid` | não existia | **nullable, SEM FK** | **nenhuma** | — | `idx_audit_perfil (perfil_id)` | Append-only: `ADD COLUMN` é DDL (não dispara os triggers `BEFORE UPDATE/DELETE/TRUNCATE`). Sem FK igual a `ator_id` — sobrevive à exclusão de perfil/conta. **Sem backfill** (o trigger recusa UPDATE inclusive p/ service_role). Histórico mantém identidade em `ator_id` + `ator_email`. |
| **RLS existente** | `rls_uo_self`, `rls_uu_self`, `auth_organizacao_ids()`, `auth_unidade_ids()`, `is_platform_superadmin()`, `rls_agente_conversas_tenant` | — | **INALTERADOS** | — | — | — | Nenhum referencia `perfil_id` ⇒ nada quebra. Análise na seção 7 da migration + seção K deste relatório. |
| **~28 colunas de domínio** | `lancamentos_*`, `bonificacao_*`, `parser_fd_*`, `martin_brower_*`, `ifood_*`, `produto_historico`, `insumo_preco_historico`, `insumos.created_by`, `ficha_tecnica.created_by`, `movimentacoes_estoque`, `agente_uso`, … | — | **INALTERADAS** (item 10) | — | — | — | Cat. B: já têm snapshot `_nome` → corrigem no write-site (Fase E). Cat. C: conta ok, pessoa via `plataforma_auditoria.perfil_id`. |

---

## D. Backfill — como funciona o reaproveitamento do UUID

### O problema

`usuarios_organizacoes.usuario_id`, `usuarios_unidades.usuario_id`, `agente_conversas.usuario_id`, `sessoes_contexto.usuario_id` e ~29 colunas de domínio guardam `auth.users.id` = `perfis.id`. Migrar isso para "id do perfil" pareceria exigir reescrever milhares de linhas.

### A solução

No backfill, o **primeiro** (e único, nesta fase) perfil de cada conta nasce com:

```
perfis_operacionais.id       = perfis.id      (o MESMO UUID da conta)
perfis_operacionais.conta_id = perfis.id
```

```sql
insert into perfis_operacionais (id, conta_id, nome, ativo, created_at, updated_at)
select
  p.id,                                     -- id do perfil == id da conta
  p.id,                                     -- conta_id
  coalesce(nullif(btrim(p.nome), ''),
           split_part(coalesce(p.email,''), '@', 1),
           'Usuário'),                      -- nome sempre preenchido
  coalesce(p.ativo, true),                  -- conta inativa -> perfil inativo
  coalesce(p.created_at, now()),
  now()
from perfis p
on conflict (id) do nothing;                -- idempotente
```

### Consequência

- `update usuarios_organizacoes set perfil_id = usuario_id` — os valores **já são** `perfis_operacionais.id` válidos. A FK `uo_perfil_id_fk` valida sem erro. **Zero reescrita de id.**
- As ~29 colunas de domínio (`usuario_id → perfis(id)`) **continuam válidas como referência ao perfil** sem tocar nenhuma linha — porque `perfis_operacionais.id == perfis.id` para o perfil inicial. (A 060 não adiciona `perfil_id` nelas; a leitura/gravação de nome do perfil é write-site, Fase E.)
- `agente_conversas`: `perfil_id = usuario_id`, mantendo `NULL` onde `usuario_id` é `NULL` (conversa sem dono / impersonação). **Nenhuma conversa troca de dono.**
- `sessoes_contexto`: `perfil_id = usuario_id` **só** onde `impersonado_por IS NULL`. Impersonação histórica fica `perfil_id = NULL` (contrato futuro).

### Perfis adicionais (Fase G)

Um 2º perfil de uma conta recebe **`gen_random_uuid()` novo** (`id != conta_id`), `conta_id = <conta>`. O reaproveitamento vale **só para o perfil inicial** e existe só para não quebrar o legado.

---

## E. PRÉ-CHECK (queries read-only para rodar ANTES, no ambiente correto)

> Rode no SQL Editor do Supabase-alvo. **Nada aqui escreve.** Se as consultas **4, 5, 6 ou 7** retornarem `> 0`, **PARE e reporte** — não aplique a 060 (a criação das FKs falharia, mas o certo é diagnosticar antes).

```sql
-- 1) contas (perfis) hoje
select count(*) as perfis_total from perfis;

-- 2) perfis_operacionais esperados após backfill (== item 1)
select count(*) as perfis_op_esperado from perfis;

-- 3) perfis com nome vazio (vão para o fallback do e-mail)
select count(*) as perfis_sem_nome from perfis where nome is null or btrim(nome) = '';

-- 4) vínculos de EMPRESA cujo usuario_id não tem linha em perfis   >>> TEM QUE SER 0
select count(*) as uo_orfaos
  from usuarios_organizacoes uo
  left join perfis p on p.id = uo.usuario_id
 where p.id is null;

-- 5) vínculos de UNIDADE cujo usuario_id não tem linha em perfis    >>> TEM QUE SER 0
select count(*) as uu_orfaos
  from usuarios_unidades uu
  left join perfis p on p.id = uu.usuario_id
 where p.id is null;

-- 6) conversas do Agente cujo usuario_id (não-nulo) não tem linha em perfis  >>> 0
select count(*) as conv_orfas
  from agente_conversas c
  left join perfis p on p.id = c.usuario_id
 where c.usuario_id is not null and p.id is null;

-- 7) sessões cujo usuario_id não tem linha em perfis               >>> TEM QUE SER 0
select count(*) as sess_orfas
  from sessoes_contexto s
  left join perfis p on p.id = s.usuario_id
 where p.id is null;

-- 8) sessões vivas que serão revogadas
select count(*) as sessoes_a_revogar from sessoes_contexto where revogada_em is null;

-- 9) contas inativas (o perfil inicial nasce inativo também)
select count(*) as contas_inativas from perfis where ativo = false;

-- 10) agente_conversas com usuario_id NULL (informativo — perfil_id ficará NULL)
select count(*) as conv_sem_dono from agente_conversas where usuario_id is null;

-- 11) impersonações históricas (perfil_id ficará NULL nelas)
select count(*) as sessoes_impersonacao from sessoes_contexto where impersonado_por is not null;
```

**Não rodei estas queries** — não tenho um ambiente com o schema na versão 059. Você roda no ambiente-alvo e me devolve os números (ou aplicamos e conferimos no pós-check).

---

## F. PÓS-CHECK (validação depois de aplicar)

```sql
-- A) 1 perfil por conta e id == conta_id
select
  (select count(*) from perfis)                                  as contas,
  (select count(*) from perfis_operacionais)                     as perfis_op,
  (select count(*) from perfis_operacionais where id = conta_id) as id_reaproveitado_ok;
--   esperado: contas == perfis_op == id_reaproveitado_ok

-- B) backfill perfil_id nos vínculos
select count(*) as uo_pendentes    from usuarios_organizacoes where perfil_id is null;              -- 0
select count(*) as uo_divergentes  from usuarios_organizacoes where perfil_id <> usuario_id;        -- 0
select count(*) as uu_pendentes    from usuarios_unidades where perfil_id is null;                  -- 0
select count(*) as uu_divergentes  from usuarios_unidades where perfil_id <> usuario_id;            -- 0

-- C) agente_conversas — nenhuma conversa trocou de dono
select count(*) as conv_divergentes  from agente_conversas
  where usuario_id is not null and perfil_id <> usuario_id;                                         -- 0
select count(*) as conv_dono_perdido from agente_conversas
  where usuario_id is not null and perfil_id is null;                                               -- 0

-- D) sessões
select count(*) as sessoes_vivas from sessoes_contexto where revogada_em is null;                   -- 0
select count(*) as revogadas_060 from sessoes_contexto
  where motivo_revogacao = 'migracao_060_multi_perfil';                                             -- == pré-check 8
select count(*) as imp_com_perfil from sessoes_contexto
  where impersonado_por is not null and perfil_id is not null;                                      -- 0
select count(*) as normal_sem_perfil from sessoes_contexto
  where impersonado_por is null and perfil_id is null;                                              -- 0

-- E) FKs criadas
select conname from pg_constraint
 where conname in ('uo_perfil_id_fk','uu_perfil_id_fk','sessoes_perfil_id_fk','agente_conversas_perfil_id_fk')
 order by conname;                                                                                  -- 4 linhas

-- F) plataforma_auditoria: coluna criada + segue append-only
select column_name from information_schema.columns
 where table_name = 'plataforma_auditoria' and column_name = 'perfil_id';                           -- 1 linha
-- update plataforma_auditoria set perfil_id = null where false;   -- deve dar ERRO (trigger)

-- G) nenhuma tabela de domínio foi tocada
select column_name from information_schema.columns
 where table_name = 'lancamentos_financeiros_diarios' and column_name = 'perfil_id';                -- 0 linhas

-- H) RLS da tabela nova
select policyname from pg_policies where tablename = 'perfis_operacionais';                         -- rls_perfis_op_conta

-- I) índices novos
select indexname from pg_indexes
 where indexname in ('idx_perfis_op_conta','idx_uo_perfil','idx_uu_perfil',
                     'idx_sessoes_perfil_vivas','idx_agente_conversas_escopo_perfil','idx_audit_perfil')
 order by indexname;                                                                                -- 6 linhas
```

---

## G. Rollback — passo a passo

> `usuario_id` **nunca** foi removido, então o rollback devolve o estado exato de antes. A revogação de sessões **não** precisa ser desfeita (o usuário só re-seleciona contexto — e sessões vivas de 8h atrás já teriam expirado de qualquer forma).

```sql
-- 1. Índices novos
drop index if exists idx_audit_perfil;
drop index if exists idx_agente_conversas_escopo_perfil;
drop index if exists idx_sessoes_perfil_vivas;
drop index if exists idx_uu_perfil;
drop index if exists idx_uo_perfil;
drop index if exists idx_perfis_op_conta;

-- 2. FKs novas (ANTES de dropar a tabela-alvo)
alter table agente_conversas      drop constraint if exists agente_conversas_perfil_id_fk;
alter table sessoes_contexto      drop constraint if exists sessoes_perfil_id_fk;
alter table usuarios_unidades     drop constraint if exists uu_perfil_id_fk;
alter table usuarios_organizacoes drop constraint if exists uo_perfil_id_fk;

-- 3. Colunas perfil_id (todas nullable; nenhuma view/policy/trigger as referencia)
alter table plataforma_auditoria  drop column if exists perfil_id;
alter table agente_conversas      drop column if exists perfil_id;
alter table sessoes_contexto      drop column if exists perfil_id;
alter table usuarios_unidades     drop column if exists perfil_id;
alter table usuarios_organizacoes drop column if exists perfil_id;

-- 4. (opcional) comentários — inofensivos se ficarem
comment on column usuarios_organizacoes.usuario_id is null;
comment on column usuarios_unidades.usuario_id is null;
comment on column sessoes_contexto.perfil_id is null;   -- já terá sido dropada; ignore se erro
comment on column agente_conversas.usuario_id is null;

-- 5. RLS + tabela nova
drop policy  if exists rls_perfis_op_conta on perfis_operacionais;
drop trigger if exists trg_perfis_op_upd  on perfis_operacionais;
drop table   if exists perfis_operacionais;   -- perde só os perfis; NADA de domínio referencia esta tabela

-- 6. Nada a fazer em auth.users / perfis / set_updated_at() / policies antigas — não foram tocados.
```

Ordem = inversa da criação, respeitando dependências (índice → FK → coluna → policy/trigger → tabela). `drop table perfis_operacionais` por último porque as 4 FKs a referenciam.

---

## H. Backward compatibility

### Pergunta: "Posso aplicar a Migration 060 mantendo o backend/frontend atuais no ar?"

# **SIM.**

### Justificativa

| Aspecto | Análise |
|---|---|
| **Colunas novas** | Todas **NULLABLE**, sem default volátil. O backend atual insere em `usuarios_organizacoes` / `usuarios_unidades` / `sessoes_contexto` / `agente_conversas` **sem** `perfil_id` → continua funcionando (a coluna aceita NULL). |
| **Sem NOT NULL** | Nenhuma coluna `perfil_id` nasce `NOT NULL`. Nenhum `ALTER COLUMN … SET NOT NULL`. (Teste `060 … NENHUM perfil_id nasce NOT NULL` cobre isso.) |
| **Sem CHECK nova** | A CHECK `perfil_id IS NOT NULL OR impersonado_por IS NOT NULL` em `sessoes_contexto` **não** entra na 060 — se entrasse, o `criarSessao` atual (login normal, sem `perfil_id`) violaria a constraint e o **login quebraria**. Fica para a Fase D. |
| **Sem UNIQUE nova** | Nenhuma UNIQUE sobre `perfil_id`. A `unique (usuario_id, organizacao_id)` atual permanece → o backend atual segue barrando vínculo duplicado como sempre. |
| **Leituras do backend atual** | Todo `select` de `sessoes_contexto` / vínculos no código usa **lista explícita de colunas** (ex.: `requireContexto` → `.select("id, usuario_id, organizacao_id, unidade_id, papel, permissoes, modulos, impersonado_por, expira_em, revogada_em")`). A coluna nova é ignorada. Nenhum `select *` em caminho crítico. |
| **`perfis_operacionais` nova + RLS** | O backend usa `service_role`, que **ignora RLS**. A policy nova (SELECT por conta) só afeta acesso direto com a anon key — que o frontend não faz. |
| **`plataforma_auditoria` ADD COLUMN** | DDL de catálogo, não dispara os triggers de imutabilidade. `auditar()` atual insere sem `perfil_id` → NULL → OK. |
| **RLS/funções existentes** | Inalterados. `rls_uo_self` etc. continuam sobre `usuario_id`, que segue populado. |
| **Frontend atual** | Não toca nenhuma dessas tabelas (só Supabase Auth). Zero impacto. |
| **Efeito visível único** | Todas as **sessões de contexto vivas são revogadas**. Consequência para o usuário logado: no próximo request, `requireContexto` → 409 → `restaurarContexto()` volta `false` → cai na **tela de seleção de empresa/unidade** (não na de login — o JWT do Supabase está intacto). Ele re-seleciona a unidade **uma vez**. Aprovado no item 7 do pedido. |

**Ordem de deploy possível:** aplicar 060 → backend/frontend atuais seguem no ar → depois Fases C/D/E, cada uma com seu deploy. **Nenhuma exigência de "migration + backend novo no mesmo segundo".**

### Ressalvas documentadas (não são blockers)

- Vínculos criados pelo **backend antigo entre a 060 e a Fase C** terão `perfil_id = NULL`. A migration da Fase C que aplica `NOT NULL` fará antes um `update … set perfil_id = usuario_id where perfil_id is null` — cobre esses.
- Mesmo para `sessoes_contexto` e `agente_conversas`: linhas criadas pelo backend antigo no intervalo ficam com `perfil_id` NULL; as migrations das Fases D/E as backfillam antes de qualquer `NOT NULL`.

---

## I. Blockers

**Nenhum blocker encontrado.**

Pontos que exigiram decisão (todos resolvidos dentro das decisões já aprovadas):

| Ponto | Decisão | Onde |
|---|---|---|
| `perfil_id` pode ser `NOT NULL` após backfill? | **Não nesta fase** — quebraria o backend atual (item 25). O backfill cobre 100% das linhas existentes; o `NOT NULL` vem na Fase C/E. | Seção C, H |
| CHECK de impersonação (`perfil_id IS NOT NULL OR impersonado_por IS NOT NULL`) na 060? | **Não** — o `criarSessao` atual insere sem `perfil_id`. Fase D, depois que o backend novo grava a coluna. | Seção C, item 18 |
| Backfill de `plataforma_auditoria.perfil_id`? | **Não é possível** — o trigger `trg_audit_sem_update` recusa `UPDATE` inclusive para `service_role`. Histórico mantém identidade em `ator_id` + `ator_email`. `ADD COLUMN` (DDL) é seguro. | Seção C, item 8 |
| `agente_conversas.perfil_id` `NOT NULL`? | **Não** — `usuario_id` já é nullable ali (conversa sem dono / impersonação) e o backend atual insere sem `perfil_id`. Isolamento é responsabilidade da query, não de um `NOT NULL`. | Seção C, item 9 |
| `UNIQUE(conta_id, nome)` em `perfis_operacionais`? | **Não** (item 13). Nome não é identificador. | Seção C |
| ON DELETE de cada FK nova | Espelhar a coluna irmã existente: **CASCADE** para vínculos/sessões (estado atual), **SET NULL** para `agente_conversas` (histórico), **sem FK** para auditoria. | Seção C, item 15 |
| Estratégia das sessões existentes | **Revogar todas as vivas** com `motivo_revogacao = 'migracao_060_multi_perfil'`. Sem DELETE físico. | Seção C, item 7 |
| Aplicar 060 em banco de teste agora? | **Não** — `.env` é produção; `.env.test` está no schema ~016 (sem `agente_conversas` etc.). Validação foi estática (58 testes). | Seção "Determinação do ambiente" |

---

## J. Veredito

# **FASE B CONCLUÍDA — APTA PARA FASE C**

- `database/migrations/060_perfis_operacionais.sql` — DDL final, aditiva, transacional, idempotente, não-destrutiva, com pré-check / pós-check / rollback embutidos.
- `backend/test/migration-060-perfis-operacionais.test.js` — **58/58 testes passando** (validação estática da migration + invariantes do backfill; sem tocar banco). Cobre os cenários dos itens 24, 25, 15, 4, 7, 8, 10, 13, 18 e os 12 cenários de dados do item 26.
- **Backward compatible: SIM** — a 060 pode subir com o backend/frontend atuais no ar; único efeito é a re-seleção de contexto uma vez.
- **Nenhum blocker.**
- **Nenhuma migration aplicada em banco algum.** Os pré-checks (seção E) devem ser rodados por você no ambiente-alvo (com schema na versão 059) antes de aplicar; se as consultas 4–7 acusarem órfãos, **pare e me avise**.

**Próximo passo (após sua aprovação):** Fase C — autenticação multi-perfil no backend (`GET /sessao/perfis`, `POST /sessao/selecionar-perfil`, `perfilId` em `/sessao/selecionar`, `criarSessao({contaId, perfilId})`, `req.perfil` no `requireContexto`), **sem** frontend, **sem** PIN funcional, **sem** Context Token v2 ainda (ou com v2 já — a definir na abertura da Fase C).

---

## K. Anexo — análise RLS (item 17), detalhe

| Objeto | Definição atual | Quebra com `perfil_id`? | Ação na 060 | Racional |
|---|---|---|---|---|
| `rls_uo_self` / `rls_uu_self` | `for select … using (usuario_id = auth.uid() or is_platform_superadmin())` | **Não** (não referencia `perfil_id`) | **Nenhuma** | `usuario_id` segue populado (= conta). Policy correta como "vínculos da minha conta". Trocar para `perfil_id = auth.uid()` **esconderia** os perfis adicionais (id ≠ conta). |
| `auth_organizacao_ids()` / `auth_unidade_ids()` | `select organizacao_id from usuarios_organizacoes where usuario_id = auth.uid() and ativo` | **Não** | **Nenhuma** | Devolve a união das orgs da **conta** (todos os perfis). É autorização em nível de conta no RLS; a seleção fina por perfil é do backend + Context Token. Frontend não consulta essas tabelas direto → sem over-share real. **Risco conhecido:** se uma API futura usar a anon key contra tabelas de tenant, revisar para filtrar pelo perfil ativo da sessão. |
| `is_platform_superadmin()` | `exists (select 1 from plataforma_admins where usuario_id = auth.uid() and ativo)` | **Não** | **Nenhuma** | Superadmin é atributo da **conta**. Correto. |
| `rls_agente_conversas_tenant` | `using (organizacao_id in (select auth_organizacao_ids()) or is_platform_superadmin())` | **Não** (filtra por org, não por usuário) | **Nenhuma** | O isolamento por perfil de conversa é feito na **query do backend** (`buscarConversa`), não no RLS. |
| `perfis_operacionais` (nova) | — | — | **Cria** RLS + 1 policy SELECT `conta_id = auth.uid() or is_platform_superadmin()` | Padrão do projeto (deny-by-default; service_role ignora). `conta_id = auth.uid()` = "perfis da minha conta". Escrita só via backend. |

**Princípio registrado na migration (seção 7) e aqui:** no RLS, `auth.uid()` representa a **CONTA**. A granularidade fina por **PERFIL** é, e continua sendo, responsabilidade do backend + Context Token (`sessoes_contexto.perfil_id` / `pid`). A 060 **não** cria nenhuma policy que dê à conta acesso indiscriminado às orgs de todos os perfis para APIs futuras — as policies existentes já se comportam assim (nível conta) e o backend nunca as usa (service_role).
