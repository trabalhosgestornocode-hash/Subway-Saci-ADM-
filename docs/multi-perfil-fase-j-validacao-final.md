# Multi-perfil — Fase J (validação final, staging, migrations e entrega)

**Data:** 2026-09-02
**Status:** ❌ **BLOQUEADA** — não existe ambiente de staging com schema equivalente ao de produção, e não há como aplicar as migrations em nenhum ambiente acessível. **Nenhuma migration aplicada. Nenhum deploy. Nenhuma escrita em produção.**

> Este relatório para no **inventário + ambiente** (pontos 2–4) conforme instrução do ponto 43: *"Se não houver staging seguro: NÃO fique criando mais código por horas. PARE e diga exatamente por que não consegue testar, o que precisamos criar e qual é o caminho mais rápido."*

---

## A. Ambientes — inventário completo

### Código

| Item | Valor |
|---|---|
| Branch | `main` |
| HEAD | `95b3858c7adf9847d500c14421bb32e11241fbf9` — *"feat(dashboard-executivo): Plano de Ação…"* (2026-09-01) |
| Hash da árvore de trabalho | `07dcd5c940828bb04d0b752ad48609ca62d7f649` (via `git stash create`) |
| **Commits pendentes** | **Nenhum** — **toda a implementação multi-perfil (Fases B–I) está NÃO COMMITADA** na árvore de trabalho |
| Working tree | **100 arquivos**: 43 modificados + 57 novos (`??`) |
| Trabalho de terceiros na mesma árvore | Módulos `ifood/`, `inteligencia/`, `administrativo/` + migrations `056`, `059`, `061` — também não commitados, entrelaçados com o meu |
| Deploy | Render Blueprint `render.yaml` — 1 serviço web `subway-saci` (plano free), auto-deploy no push, backend serve API + frontend estático |
| Frontend/backend em produção | O do commit `95b3858` (sem NADA de multi-perfil, sem iFood, sem inteligência, sem painel administrativo) |

### Bancos

| Env | Projeto Supabase | Estado do schema (verificado por leitura REST) | DDL possível? |
|---|---|---|---|
| **`.env`** (produção) | `uqybgauuxcrqzquultfu` | **≈ migration 055**. Tem `perfis` (37), `sessoes_contexto` (1132), `plataforma_auditoria` (8589), `usuarios_organizacoes` (200), `agente_conversas` (15), `organizacoes` (42), `unidades` (46). **NÃO tem** `perfis_operacionais`, `painel_administrativo_usuarios`, `inteligencia_secoes`, `ifood_*`, `martin_brower_integracao`. **Nenhuma coluna `perfil_id`** em lugar nenhum. | ❌ só chave `service_role` REST — sem SQL Editor, sem `psql` (o `DATABASE_URL` no `.env` está truncado: `postgresql://postgres:***/postgres`, sem host) |
| **`.env.test`** (descartável) | `imtpcfpdnrzakjcbzocl` (`ISOLATION_TEST_DISPOSABLE=1`) | **≈ migration 015 — ainda mais antigo**. Tem `perfis`, `usuarios_organizacoes`, `usuarios_unidades`, `organizacoes`, `unidades`, `plataforma_admins`. **NÃO tem `sessoes_contexto`** (migr. 020), nem `plataforma_auditoria`, nem `agente_conversas`, nem `perfis_operacionais`. | ❌ só chaves REST |

### Ferramentas locais

`psql` 17.4 ✅ · `pg_dump` ✅ · `docker` 29.6.2 ✅ · `supabase` CLI ❌ (ausente) · `node` v20.19.4

### Migrations — ordem real no repositório

`001`…`055` (aplicadas em produção) · **`056_ifood_integracao`** *(não commitada, não aplicada)* · `057_unidade_dados_contato` · `058_unidade_config` · **`059_inteligencia_modulo_secao`** *(não commitada)* · **`060_perfis_operacionais`** *(não commitada)* · **`061_painel_administrativo`** *(não commitada)* · **`062_sessoes_contexto_perfil_check`** *(não commitada — CHECK XOR)* · **`063_vinculos_perfil_id_not_null`** *(não commitada — NOT NULL + troca de UNIQUE)* · **`064_pin_selecao_perfil`** *(não commitada — `selecao_nonce` + `pin_atualizado_em` + RPCs de lockout)*

**Migration criada para PIN:** `064_pin_selecao_perfil.sql` (Fase H). Não existe uma "migration de PIN" separada além dela; as colunas `pin_hash` / `pin_tentativas` / `pin_bloqueado_ate` já vieram na `060`.

---

## B–D. Migrations / pré-check / pós-check

**Não executados.** Requerem um banco de staging (não existe) e um meio de rodar DDL (não tenho).

O que está **pronto em arquivo, revisado, com pré/pós-check e rollback documentados**:
* `060` — pré-checks 1–10 (perfis, órfãos em `usuarios_*`, `agente_conversas`, `sessoes_contexto`, sessões vivas); backfill UUID reaproveitado; revoga Context Tokens vivos com `motivo='migracao_060_multi_perfil'`.
* `062` — CHECK XOR `(perfil_id NOT NULL AND impersonado_por NULL) OR (perfil_id NULL AND impersonado_por NOT NULL)` + pré-check de linhas incompatíveis.
* `063` — backfill defensivo, `perfil_id NOT NULL`, drop `UNIQUE(usuario_id, X)` → `UNIQUE(perfil_id, X)`; **pré-requisito da Fase G** (2 perfis da mesma conta na mesma empresa).
* `064` — aditiva; o backend degrada sem ela.

---

## E. Testes de integração — baseline medido

`node --env-file-if-exists=.env --test` (contra **produção**, só leitura+seed dos próprios testes):

| | Total | Pass | **Fail** | Skip |
|---|---|---|---|---|
| Com o backend multi-perfil (árvore atual) | 1418 | 1363 | **52** | 3 |
| **Baseline — SEM o backend multi-perfil** (`git stash` das mudanças de `backend/src` + `backend/test`, tests de amostra) | 16 | 3 | **13** | — |

**As 52 falhas são PRÉ-EXISTENTES** — a amostra falha **na mesma proporção com e sem** o meu backend. Causas:

| Grupo | ~qtd | Causa (não multi-perfil) |
|---|---|---|
| iFood (`iniciarConexao`, `concluirAutorizacao`, `401 na descoberta`…) | ~15 | tabelas `ifood_*` não existem em produção (migr. `056` não aplicada) — módulo de terceiros |
| Bonificação / indicadores manuais / metas / REV | ~22 | fixtures ausentes ("Migration 041 metas seedadas"), FK `parser_fd_importacoes_unidade_id_fkey`, unidade de teste inexistente no DB de produção — os testes foram escritos para um DB de dev com fixtures |
| Parser >1000 pedidos (`importação com 999/1000/1001/1300`) | ~7 | mesma FK de unidade de teste ausente |
| REV / super-restaurante upsert | ~8 | fixture/constraint de unidade+ano+mês ausente |

`"Você não tem acesso a esta unidade."` aparece **no baseline também** (HEAD usa `.eq("usuario_id", …)`) → é falta de fixture, não a mudança para `perfil_id`.

**Nenhuma falha nova atribuível ao multi-perfil.** Mas isso é comparação de baseline contra um DB sem 060 — **não substitui** a validação de integração real que a Fase J pede.

---

## F–M. E2E multi-perfil / segurança PIN / sessões / autorização / auditoria / Agente / legado / SuperAdmin

**Não executados — bloqueados pela falta de ambiente.**

Cobertura atual (unitária + injeção de dependência + scans de fonte + smoke visual com mock), por fase:

| Área | Como está coberto hoje | O que a Fase J ainda precisa provar em banco real |
|---|---|---|
| E2E "PC1 Fulana 1 / PC2 Fulana 2" (13) | fluxo verificado no navegador com **mock** (login → tela de perfil → PIN → voltar); backend por unidade | 2 sessões reais simultâneas em Context Tokens distintos, cada uma criando linha em `sessoes_contexto` com `perfil_id` distinto |
| Mesmo perfil em 2 devices (14) | Model Y — `criarSessao` não auto-revoga (scan + unit) | 2 linhas vivas reais, logout de uma não derruba a outra |
| Isolamento empresa/unidade/cargo (15–17) | `sessao-perfil.test.js` (34), `autorizacao-perfil.test.js` (38) com deps | `POST /sessao/selecionar` real: Fulana 1 → Empresa B → 403 do Postgres+backend |
| Bypass de PIN (18) | `pin-selecao-perfil.test.js` — `resolverPerfilParaContexto` exige a prova (unit) | chamada HTTP real de conta multi-perfil sem `profileSelectionToken` → 400 |
| PIN errado / lockout (19) | `validarPinParaSelecao` com deps; RPC `perfil_pin_registrar_falha` (064) | incremento atômico real + `pin_bloqueado_ate` gravado; PIN certo durante bloqueio → 429 |
| Prova de perfil (20) | `profileSelectionToken.js` — assinatura/purpose/exp (unit) + cross-confusion | token real cruzado (Fulana 1 → perfilId Fulana 2 / Empresa B) → 400; uso único via `sessoes_contexto.selecao_nonce` UNIQUE |
| Context Token v2 (21) | `validarPidContraSessao` (unit); `requireContexto` com degrade | `pid` forjado / `sid` inexistente / sessão revogada → 409 contra a linha real; v1 rejeitado |
| Logout isolado (22) | `signOut({ scope: "local" })` (scan) + Model Y | 2 devices reais, logout de A não afeta B |
| Reload (23) | `restaurarContexto` antes da resolução de perfil (scan) | F5 real com Context Token vivo entra direto, sem PIN |
| Auditoria (24/25) | `identidade-conta-perfil.test.js` (24); `contextoDaRequisicao` grava `perfil_id`+`perfil_nome` | linha real em `plataforma_auditoria`: `ator_id`=conta, `perfil_id`=Fulana 1, `detalhes.perfil_nome` |
| Snapshots humanos (25) | 5 controllers migrados para `identidadeOperacional(req)` (scan) | linha real em `lancamentos_*` / `bonificacao_*` / `parser_fd_*` com `usuario_nome` = "Fulana 1" |
| Agente isolado (26) | `agente-conversas-isolamento.test.js` (PERFIL_A ≠ PERFIL_B) | conversa real da Fulana 1 invisível para a Fulana 2 na mesma conta |
| Revogação escopada (27) | `filtrosDeRevogacao` (puro), matriz de revogação (scan) | alterar papel de Fulana 1/Empresa A → só as sessões dela nessa empresa caem |
| Módulo global (28) | escopo `{ organizacaoId }` (scan) | alterar módulo da Empresa A → todas as sessões legítimas dela caem |
| Legado 1 perfil (29) | `resolverPerfilParaContexto` — 1 perfil / pré-060 → sem tela, sem PIN (unit + navegador mock) | conta real de 1 perfil entra sem tela/PIN após 060 aplicada |
| SuperAdmin (30) | scans; impersonação `perfil_id: null` (unit) | painel puro + superadmin com vínculo + impersonação, todos contra 060 |

**Totais de teste automatizado hoje:** backend ~373 nas áreas multi-perfil (0 falhas próprias), frontend 215/215.

---

## N. Browser smoke

Feito **parcialmente** (frontend estático, sem backend): login renderiza; `#selecao-perfil-screen` mostra cards "Fulana 1"/"Fulana 2" + label da conta; escolher perfil abre o painel de PIN ("Entrar como Fulana 1"); PIN mal formatado → erro "Informe o PIN (4 a 6 dígitos)"; **Voltar** limpa o campo e reabre a lista. Desktop OK. **Mobile e o fluxo completo (com backend) pendentes** — dependem do ambiente.

---

## O. Regressão

`node --test` completo — backend **1363 pass / 52 fail (pré-existentes) / 3 skip**; frontend **215/215**. Suítes 100% multi-perfil: `pin-selecao-perfil` (52), `perfis-crud-multi` (31), `sessao-perfil` (34), `autorizacao-perfil` (38), `identidade-conta-perfil` (24), `sessao-model-y` (41), `migration-060-*` (58), `context-token`, `selecaoPerfil` (22 — frontend) — **todas passam**.

---

## P. Rollback ensaiado

**Não ensaiado** — sem banco descartável com 060 aplicada para reverter. Os rollbacks estão escritos no rodapé de `060`, `062`, `063`, `064` (todos `drop … if exists`, transacionais). `060` e `063` são as únicas com impacto de dados: `060` (drop `perfis_operacionais` — perde só os perfis, o backfill é reconstruível; sessões revogadas não voltam, mas isso é inofensivo); `063` (volta `UNIQUE(usuario_id, X)` — exige que não exista 2º perfil real ainda).

---

## Q. Plano de produção

**Não elaborado em detalhe** — o ponto 38 condiciona o plano a "TODOS os gates anteriores passarem", e os gates E–P não puderam rodar. Esqueleto (a completar após a validação real):

1. Backup/checkpoint do projeto Supabase (snapshot no painel).
2. Pré-check da `060` (queries do cabeçalho — todas devem dar 0 nos itens críticos).
3. Aplicar em ordem: `056` → `057` → `058` → `059` → `060` → `061` → `062` → `063` → `064`. *(Nota: `056/059/061` são de terceiros — coordenar; podem já estar planejadas à parte.)*
4. Pós-check `060` (perfis_operacionais total == perfis; `id == conta_id` em todos; backfill de `perfil_id` completo).
5. Deploy do backend (todo o multi-perfil C–I + F + G + H) — **precisa ser commitado primeiro**.
6. Deploy do frontend (Fase F).
7. Smoke imediato: login legado (1 perfil, sem PIN), reload, logout.
8. Monitoramento: taxa de 409 (re-seleção de contexto — esperada, ver R/janela), erros 5xx em `/sessao/*`.
9. Rollback se: 409 em massa que não cede após 1 re-seleção, ou qualquer 5xx sistemático em `/sessao/selecionar` / `/sessao/selecionar-perfil`.

**Janela de deploy (ponto 39):** a `060` revoga **todos os 1132 Context Tokens vivos** (`motivo='migracao_060_multi_perfil'`). Impacto: **todo usuário logado terá que escolher empresa/unidade uma vez**. NÃO perde JWT (Supabase Auth intacto), senha, dados, nem vínculos. Confirmar no staging antes.

---

## R. Blockers

### BLOCKER 1 (crítico) — não existe ambiente de staging

O único banco no schema atual (≈055/059) é **produção**. O `.env.test` está ≈40 migrations atrás (nem `sessoes_contexto` tem). A Fase J **exige** um DB clonado do schema de produção (sem dados sensíveis) para aplicar `060`–`064` e rodar o fluxo real.

### BLOCKER 2 (crítico) — não há como aplicar migrations

Só tenho a chave `service_role` **REST** (PostgREST não executa DDL). Não há:
* SQL Editor (painel Supabase) acessível a partir daqui;
* connection string Postgres válida (`DATABASE_URL` no `.env` está truncado, sem host);
* `supabase` CLI instalado.

`psql`/`pg_dump`/`docker` existem localmente, mas sem uma connection string de origem (`pg_dump` da produção) e sem um destino (projeto Supabase novo ou stack local), não dá para montar o staging.

### BLOCKER 3 (organizacional) — código não commitado

Toda a implementação multi-perfil + o trabalho de terceiros (iFood, inteligência, painel admin) estão numa **única árvore de trabalho não commitada** (100 arquivos). Antes de qualquer deploy é preciso separar/commitar (idealmente: multi-perfil numa branch própria).

---

## O CAMINHO MAIS RÁPIDO PARA DESTRAVAR (ponto 43)

Em ordem de rapidez/segurança:

### Opção 1 — Supabase Branching (minutos, se o projeto for Pro/Team)
No painel do projeto de produção → **Branches** → *Create branch* (copia schema; escolher **sem dados** ou com dados anonimizados). O branch vem com SQL Editor próprio e connection string própria.
→ aplicar `056`–`064` no SQL Editor do branch → apontar um deploy de staging do backend para as chaves do branch → rodar E2E.
**Requisito:** plano pago do Supabase + acesso ao painel.

### Opção 2 — Novo projeto Supabase free + dump de schema (30–60 min)
1. `pg_dump --schema-only --no-owner --no-privileges` da produção (**leitura**, seguro) → precisa da connection string real da produção (`db.uqybgauuxcrqzquultfu.supabase.co:5432`, senha do painel → *Settings → Database*).
2. Criar um **projeto Supabase free novo** (dashboard) → restaurar o schema via SQL Editor / `psql`.
3. Aplicar `060`–`064` (e `056/059/061` se quiser paridade total).
4. Preencher um `.env.staging` com as chaves do projeto novo → rodar o backend local apontado para ele → E2E no navegador.
**Requisito:** connection string + senha do DB de produção (para o dump) + criar 1 projeto free.

### Opção 3 — Stack Supabase local (Docker, ~1 h)
`npm i -g supabase` (ou binário) → `supabase init` → colocar `001`…`064` em `supabase/migrations/` → `supabase start` (sobe Postgres + GoTrue + PostgREST + Kong em Docker) → `supabase db reset` aplica tudo → backend local aponta para `http://localhost:54321` → E2E.
**Requisito:** conseguir instalar a CLI; revisar se as migrations `001`–`055` rodam limpas do zero (algumas são "fix"/assumem estado — pode exigir ajuste).
**Risco:** GoTrue local ≠ produção em detalhes de sessão; ainda assim cobre 90% do fluxo.

### Opção 4 (menos ideal) — usar o `.env.test` descartável
Trazer o `imtpcfpdnrzakjcbzocl` de ≈015 até `064` aplicando `016`…`064` no SQL Editor dele. É seguro (descartável, sem dados de cliente) mas são ~48 migrations, várias com dependência de ordem/seed — **trabalhoso e frágil**.

**Recomendação:** Opção 1 se houver plano pago; senão Opção 2.

---

## S. Veredito

> ## ❌ FASE J BLOQUEADA
>
> **MOTIVO EXATO:** não existe um ambiente de banco de dados em schema equivalente ao de produção-imediatamente-antes-da-060 onde eu possa (a) aplicar as migrations `060`–`064` e (b) rodar o backend + frontend + E2E. O único banco no schema atual é **produção** (proibido usar como teste — ponto 3); o `.env.test` descartável está ≈40 migrations atrás; e não tenho meio de executar DDL (só chave REST, sem SQL Editor, sem connection string Postgres, sem `supabase` CLI).
>
> **O que NÃO está bloqueado / já entregue:**
> * Backend + frontend das Fases B–I completos, com degradação graciosa pré-060, cobertos por ~373 testes de backend e 215 de frontend (0 falhas próprias).
> * Migrations `060`/`062`/`063`/`064` prontas em arquivo, com pré/pós-check e rollback.
> * As 52 falhas de integração são **pré-existentes** (fixtures ausentes + migrations de terceiros não aplicadas), confirmado por comparação de baseline — **nenhuma regressão de multi-perfil**.
> * Smoke visual do frontend (desktop) OK.
>
> **Para destravar:** criar um staging (Opção 1: Supabase Branching, ou Opção 2: projeto free + `pg_dump --schema-only` da produção) e fornecer o acesso para aplicar as migrations. Estimativa até "pronto para produção" depois disso: **1–2 sessões de trabalho** (aplicar migrations + pós-check + rodar as suítes de integração + E2E das 2 contas/2 perfis + ensaiar rollback + fechar o plano de produção).

---

## NÃO FIZ (respeitado — ponto 40)

Nenhuma funcionalidade nova · nenhum redesenho · nenhuma compatibilidade legada removida · `usuario_id` não removido · nenhum refactor cosmético · **nenhuma migration aplicada** · **nenhum toque em produção** · nenhum deploy.
