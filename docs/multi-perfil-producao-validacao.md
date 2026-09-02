# Multi-perfil — validação em produção (deploy controlado)

**Data:** 2026-09-02 05:30–05:40 UTC
**Status:** ⏸️ **PARADO ANTES DA MIGRATION** — 3 dos 4 pré-requisitos confirmados; o 4º (**git limpo**, Regra 4) é um **BLOCKER** que exige decisão do revisor. **Nenhuma migration aplicada. Nenhum deploy. Nenhuma escrita em produção** (só `SELECT` e `pg_dump`).

> Conforme a instrução: *"COMECE PELO INVENTÁRIO + GIT + BACKUP + PRÉ-CHECK. NÃO APLIQUE MIGRATION ANTES DESSES QUATRO PONTOS ESTAREM CONFIRMADOS."*

---

## A. Backup / checkpoint

| Item | Resultado |
|---|---|
| Projeto Supabase de produção | `uqybgauuxcrqzquultfu` (`db.uqybgauuxcrqzquultfu.supabase.co:5432`, Postgres **17.6**) |
| Acesso Postgres | ✅ **CONECTA** — `postgres@db.uqybgauuxcrqzquultfu.supabase.co:5432` (senha do `DATABASE_URL` do `.env`, que estava truncado — host reconstruído). Conexão direta IPv6. |
| SQL Editor (painel) | ❌ não acessível a partir daqui — só a conexão Postgres direta via `psql` |
| Backup criado | ✅ **local** (scratchpad da sessão), `2026-09-02T053712Z`: <br>• `schema-public.sql` (252 KB) — DDL completo do schema `public` <br>• `data-afetadas.sql` (1,18 MB) — dados de `perfis`, `usuarios_organizacoes`, `usuarios_unidades`, `agente_conversas`, `sessoes_contexto` <br>• `constraints-antes.txt` — definição exata das constraints de `usuarios_organizacoes`/`usuarios_unidades` (para rollback preciso da 063) |
| Horário do backup | 2026-09-02 05:37 UTC |
| ⚠️ Recomendação | Antes de aplicar migrations, criar também um **backup no painel do Supabase** (Database → Backups → *Restore* mostra os pontos disponíveis; o plano free mantém 7 dias). O dump local é uma rede de segurança, não substitui o PITR. |

### Rollback salvo (rodapé de cada migration + medido no banco real)

| Migration | Rollback | Impacto do rollback |
|---|---|---|
| `060` | `drop constraint sessoes_perfil_id_fk; drop table perfis_operacionais cascade; alter table … drop column perfil_id` (×4) | perde só os 37 perfis backfillados (reconstruíveis); as 6 sessões revogadas não voltam (inofensivo) |
| `062` | `alter table sessoes_contexto drop constraint sessoes_contexto_perfil_xor_impersonacao` | nenhum |
| `063` | `drop constraint uo_perfil_org_unico, uu_perfil_uni_unico; add … usuarios_organizacoes_usuario_id_organizacao_id_key unique(usuario_id, organizacao_id)` etc.; `alter … alter column perfil_id drop not null` | volta o `UNIQUE(usuario_id, X)` — só seguro se **não houver 2º perfil real** (não haverá antes da Fase G ir a produção) |
| `064` | `drop function perfil_pin_registrar_*; drop index uq_sessoes_selecao_nonce; alter … drop column selecao_nonce, pin_atualizado_em` | nenhum |

---

## B. Branch / commit — 🔴 BLOCKER

| Item | Valor |
|---|---|
| Branch | `main` |
| HEAD (deployado hoje em produção) | `95b3858c7adf9847d500c14421bb32e11241fbf9` — *"feat(dashboard-executivo): Plano de Ação…"* (2026-09-01) |
| Hash da árvore de trabalho | `07dcd5c940828bb04d0b752ad48609ca62d7f649` |
| Commits pendentes | **NENHUM** — nada commitado |
| Árvore de trabalho | **100 arquivos** (43 modificados + 57 novos), com **3 features de terceiros entrelaçadas** com o multi-perfil |

### Classificação dos 100 arquivos

**PURO multi-perfil (~29 arquivos)** — commitáveis sem risco:
`sessao/{service,controller,routes}.js` · `sessao/perfil.service.js` *(novo)* · `usuarios/{service,controller}.js` · `shared/{pin,profileSelectionToken,identidade,contextToken}.js` · `agente/*` · controllers `dashboard-executivo`/`bonificacao-mensal`/`parser-food-delivery`/`produtos`/`insumos` · `unidade/unidade.service.js` · `plataforma/plataforma.empresas.service.js` · `frontend/src/{selecaoPerfil,sessao,state}.js` (partes) · migrations `060`/`062`/`063`/`064` · `frontend/test/selecaoPerfil.test.js` + 6 testes backend · 11 docs.

**PURO terceiros (~22 arquivos)** — não são meus, não devem entrar sem aprovação:
`modules/{ifood,inteligencia,administrativo}/*` · `frontend/src/{ifood,ifoodEstado,painelAdm,painelAdmApi,painelAdmViews,encaminhamento}.js` · migrations `056`/`059`/`061` · testes `ifood-*`, `inteligencia-*`, `painelAdm*`, `plataforma-painel-administrativo` · 2 docs.

**COMPARTILHADOS (~22 arquivos)** — multi-perfil **E** terceiros editaram o MESMO arquivo, sem fronteira de commit:
`middlewares/auth.js` · `routes.js` · `shared/auditoria.js` · `shared/modulos.js` · `plataforma/{routes,controller,usuarios.service,repo}.js` · frontend `{app,adminApi,adminViews,api,config,router,views,dashboardExecutivo,agentePainel,styles.css,index.html}` .

### Por que a separação NÃO é segura para eu fazer sozinho

O ponto mais crítico: **`middlewares/auth.js#requireAuth`** (o middleware por onde passa **toda** requisição autenticada) contém a mudança de terceiros do **Painel Administrativo**:

```js
const [perfilRes, superRes, painelAdmRes] = await Promise.all([
  ...
  supabase.from("painel_administrativo_usuarios").select("usuario_id")...  // ← tabela da migration 061
]);
```

A tabela `painel_administrativo_usuarios` **não existe em produção** (migration `061` não aplicada). Se eu deployar `auth.js` como está — e eu **preciso** dele para o `requireContexto` multi-perfil — **toda requisição autenticada retorna 500**.

Reverter só esse hunk cascateia para `routes.js` (mount do `administrativoRouter` + `inteligenciaRouter`), `modulos.js` (`MODULOS.INTELIGENCIA` usado num `requireModulo` de `routes.js`), `plataforma.{routes,controller}.js` (rotas do painel-adm intercaladas com as minhas de perfil), `auditoria.js` (`ACOES.PAINEL_ADM_*`). São ~6 arquivos com `git checkout -p` cirúrgico contra produção — **exatamente o que a Regra 25 proíbe** ("NÃO CORRIGIR ÀS PRESSAS EM PRODUÇÃO") — e deixaria o trabalho do colega num estado meio-quebrado para ele re-mesclar.

### Caminhos (precisa da sua decisão)

| # | Caminho | Prós | Contras |
|---|---|---|---|
| **A** | O colega **commita/branча primeiro** o dele (Painel Adm + iFood + Inteligência). Depois eu faço rebase do multi-perfil limpo. Deploy do conjunto, migrations `056→064` em ordem. | separação real; cada feature auditável | depende do colega; migrations de 3 features de uma vez |
| **B** | **Aprovar o deploy do lote inteiro** (multi-perfil + Painel Adm + iFood + Inteligência) como uma entrega. Working tree é **internamente consistente** — 455 testes backend + 215 frontend passam **juntos**. Migrations `056`, `059`, `060`, `061`, `062`, `063`, `064` na ordem. | 1 deploy, código já testado em conjunto | envia 3 features de terceiros que eu não revisei; precisa das aprovações delas; pré-check só rodei para a `060` |
| **C** | Eu produzo um build **só-multi-perfil** revertendo os hunks de terceiros de ~6 arquivos compartilhados. | deploy isolado | alto risco de erro num split contra produção; cria dor de merge para o colega; contra a Regra 25 |

**Recomendação:** **A** (mais seguro) se o colega puder commitar hoje; senão **B** com aprovação explícita das 3 features e um pré-check das migrations `056`/`059`/`061` antes.

---

## C. Migrations aplicadas

**Nenhuma.** Bloqueado no ponto B.

### Ordem real e dependências (auditado — Regra 6)

| Migration | Feature | Aplicada em prod? | 060 depende dela? |
|---|---|---|---|
| `001`–`055` | base | ✅ SIM | — |
| `056_ifood_integracao` | **iFood** (terceiros) | ❌ não | **NÃO** |
| `057_unidade_dados_contato` | base | ✅ SIM (`unidades.telefone` existe) | não |
| `058_unidade_config` | base | ✅ SIM (`unidade_config` existe) | não |
| `059_inteligencia_modulo_secao` | **Inteligência** (terceiros) | ❌ não | **NÃO** |
| **`060_perfis_operacionais`** | **multi-perfil** | ❌ não | — |
| `061_painel_administrativo` | **Painel Adm** (terceiros) | ❌ não | **NÃO** |
| **`062_sessoes_contexto_perfil_check`** | multi-perfil | ❌ não | precisa de `060` |
| **`063_vinculos_perfil_id_not_null`** | multi-perfil | ❌ não | precisa de `060` + backend C/D/E deployado |
| **`064_pin_selecao_perfil`** | multi-perfil | ❌ não | precisa de `060` |

**Confirmado: a cadeia multi-perfil `060 → 062 → 063 → 064` é auto-contida.** Não depende de `056`/`059`/`061`. Verificado no banco real: `set_updated_at()`, `is_platform_superadmin()`, `gen_random_uuid()`, `sessoes_contexto.modulos` — **todos existem**. Os nomes de constraint que a `063` derruba (`usuarios_organizacoes_usuario_id_organizacao_id_key`, `usuarios_unidades_usuario_id_unidade_id_key`) **batem exatamente** com o que está em produção.

**Ordem de aplicação recomendada:** `060` → deploy backend multi-perfil → verificar → `062` → `063` → `064`.

---

## D. Pré-check (produção, READ-ONLY) — ✅ TODOS PASSAM

`psql … -tAc` em `db.uqybgauuxcrqzquultfu.supabase.co`, 2026-09-02 05:35 UTC:

| # | Check | Valor | Esperado | OK? |
|---|---|---|---|---|
| 1 | `perfis` (contas) | **37** | — | — |
| 2 | `perfis_operacionais` esperados após backfill | 37 | == item 1 | ✅ |
| 3 | perfis sem nome | **0** | 0 | ✅ |
| 4 | `usuarios_organizacoes` órfãos (usuario_id sem perfil) | **0** | **0** | ✅ |
| 5 | `usuarios_unidades` órfãos | **0** | **0** | ✅ |
| 6 | `agente_conversas` órfãs (usuario_id inexistente) | **0** | **0** | ✅ |
| 7 | `sessoes_contexto` órfãs | **0** | **0** | ✅ |
| 8 | sessões vivas a revogar pela `060` | **6** | (informativo) | ✅ baixo |
| 9 | contas inativas | **0** | (informativo) | ✅ |
| 10 | `agente_conversas` sem dono (`usuario_id NULL`) | **0** | (informativo) | ✅ |
| 11 | sessões de impersonação (histórico — `perfil_id` fica NULL) | **32** | (informativo) | ✅ |
| — | `usuarios_organizacoes` total | 200 | — | — |
| — | `usuarios_unidades` total | 10 | — | — |
| — | duplicatas `(usuario_id, organizacao_id)` → violariam `UNIQUE(perfil_id, org)` da `063` | **0** | **0** | ✅ |
| — | duplicatas `(usuario_id, unidade_id)` | **0** | **0** | ✅ |

**Nenhum valor inesperado. Nenhum órfão. A `060` está segura para aplicar** (assim que o ponto B for resolvido). A `060` exclui corretamente as 32 linhas de impersonação do backfill (`… and impersonado_por is null`), então a CHECK XOR da `062` não será violada.

---

## E–P. Deploy / fixtures / E2E / smoke / auditoria / rollback ensaiado

**Não executados** — bloqueados no ponto B (git). Ficam pendentes:
* E. pós-check `060` (contar `perfis_operacionais`, `id == conta_id`, backfill de `perfil_id`);
* F. deploy backend + smoke de `/me`, `/sessao/perfis`, `/sessao/acessos`, conta legada;
* G. deploy frontend;
* H. criar `Operacional Teste MultiPerfil` + `Fulana Teste 1`/`Fulana Teste 2` (org/unidade de teste — **verificar se já existem antes de criar fixture**);
* I–P. E2E 2 perfis / sessões simultâneas / logout isolado / bypass de PIN / lockout mínimo / isolamento via API / auditoria / legado / superadmin / rollback ensaiado.

---

## Q. Erros observados

Nenhum — nenhuma mudança feita em produção. Só `SELECT` (pré-checks) e `pg_dump` (backup).

---

## R. Rollback disponível

* **Backup local:** `schema-public.sql` + `data-afetadas.sql` + `constraints-antes.txt` (2026-09-02T053712Z).
* **Rollback SQL por migration:** documentado no rodapé de `060`/`062`/`063`/`064` (transacional, `drop … if exists`).
* **Supabase daily backup:** disponível no painel (a confirmar antes da migration).
* **Código:** produção segue em `95b3858` — nada foi deployado, rollback de código = não fazer nada.

---

## S. Veredito

> ## ⏸️ VALIDAÇÃO EM PRODUÇÃO — PARADA NO GATE 2 (GIT)
>
> **3 de 4 pré-requisitos confirmados:**
> * ✅ **Inventário** — completo (código, bancos, migrations, deploy).
> * 🔴 **Git limpo** — **BLOCKER**: o multi-perfil está entrelaçado com Painel Administrativo + iFood + Inteligência (de terceiros) em ~22 arquivos compartilhados, incluindo `middlewares/auth.js#requireAuth` (que passou a consultar `painel_administrativo_usuarios`, tabela da migration `061` não aplicada → 500 em toda requisição se eu deployar só o meu). Separar sozinho, contra produção, viola a Regra 25.
> * ✅ **Backup** — `pg_dump` de schema + dados das tabelas afetadas, local, mais rollback SQL por migration. (Recomendo somar um backup do painel Supabase.)
> * ✅ **Pré-check `060`** — **TODOS PASSAM** contra o banco real: 37 contas, 0 órfãos em `usuarios_organizacoes`/`usuarios_unidades`/`agente_conversas`/`sessoes_contexto`, 0 duplicatas, 6 sessões vivas. A cadeia `060→062→063→064` é auto-contida (não precisa de `056`/`059`/`061`).
>
> **Preciso da sua decisão sobre o ponto B** (caminho A, B ou C da tabela acima). Assim que resolvido, sigo direto para: aplicar `060` → pós-check → deploy backend → smoke → `062`/`063`/`064` → deploy frontend → criar fixture de teste → E2E das 2 contas/2 perfis → veredito final.
>
> **Estimativa após destravar o git:** 1 sessão de trabalho até `✅ MULTI-PERFIL VALIDADO EM PRODUÇÃO`.

---

## NÃO FIZ (respeitado)

Nenhuma migration aplicada · nenhum deploy · nenhuma escrita em produção · nenhum `git checkout`/split arriscado · nenhuma feature de terceiros commitada · nenhum teste destrutivo/carga · nenhum dado de cliente tocado.
