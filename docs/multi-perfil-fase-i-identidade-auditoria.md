# Multi-perfil — Fase I (consolidação de identidade e auditoria)

**Status:** implementado. **686/686 testes** nas áreas tocadas (24 novos em `identidade-conta-perfil.test.js` + 662 de regressão), 3 skipped pré-existentes. Frontend: 193/193. **Nenhum deploy. Nenhuma migration aplicada. Nenhuma escrita em banco de produção.**
**Data:** 2026-09-01
**Escopo:** backend (helper de identidade + write-sites de snapshot + auditoria + logout + usuários online) e 3 linhas no frontend (`state.sessao.perfil`, sem UI). Sem tela de seleção (Fase F), sem PIN (Fase H), sem criação de 2º perfil (Fase G).

---

## Pré-condição

`backend/.env` aponta para produção e a migration 060 não está aplicada em nenhum ambiente acessível. Validação: **testes unitários** (helper puro, `contextoDaRequisicao` puro), **scans de fonte** para os write-sites, **regressão** das suítes unitárias/calc. Limitações em **M**.

---

## A. Modelo final — CONTA × PERFIL

```
CONTA / CREDENCIAL ───────────────────────────  req.user   (Supabase Auth)
  id, email, nome, superadmin                   NUNCA sobrescrita
  1 e-mail + 1 senha, compartilhados             "qual credencial autenticou?"
        │
        │  login → resolve/seleciona o perfil (Fase C/D)
        ▼
PESSOA / PERFIL OPERACIONAL ───────────────────  req.perfil  (perfis_operacionais)
  id, nome                                       null em impersonação / sem contexto
  "quem, de carne e osso, fez isto?"
        │
        ▼
CONTEXTO ──────────────────────────────────────  req.tenant + req.acesso
  organização, unidade, papel, permissões, módulos
```

**Regra de uso (fixada nesta fase):**

| Pergunta | Fonte | Nunca |
|---|---|---|
| Qual credencial autenticou? | `req.user` / `/me` | — |
| Quem (pessoa) realizou a ação? | `req.perfil` (`identidadeOperacional(req).nome`) | `req.user.nome` como pessoa |
| Que e-mail exibir no "por Fulano"? | `req.user.email` (credencial compartilhada — perfis não têm e-mail próprio) | inventar e-mail por perfil |
| Autorização operacional? | `req.perfil.id` → vínculos por `perfil_id` (Fase E) | `usuarios_*.usuario_id` |
| Ator da auditoria? | `ator_id` = CONTA **e** `perfil_id` = PESSOA (colunas separadas) | um no lugar do outro |

`req.user` **nunca** é sobrescrito; `req.user.id = perfilId` não existe (scan).

---

## B. Auditoria de `req.user` — classificação

Legenda: **A** conta · **B** pessoa/perfil · **C** autorização · **D** auditoria · **E** histórico · **F** exibição · **G** legado/transição.

| Local | Uso | Cat | Ação Fase I |
|---|---|---|---|
| `middlewares/auth.js` `p.sub !== req.user.id`, `sessao.usuario_id !== req.user.id` | pareamento token ↔ CONTA | C/A | — (correto) |
| `middlewares/auth.js` `req.perfil = …` | expõe a PESSOA | B | — (Fase D) |
| `shared/auditoria.js` `contextoDaRequisicao` | `atorId`/`atorEmail` = conta; `perfilId`/`perfilNome` = pessoa | D | **+ `perfilNome` → `detalhes.perfil_nome`** |
| `shared/identidade.js` *(novo)* `identidadeOperacional(req)` | nome=pessoa, id/email=conta | B/E/F | **novo helper** |
| `sessao.controller.js` `usuario: req.user` (selecionar/senha) | a CONTA autenticando | A | — (correto) |
| `dashboard-executivo` / `bonificacao-mensal` / `parser-food-delivery` / `produtos` / `insumos` controllers `usuario: req.user` | snapshot "por Fulano" | B/E | **→ `identidadeOperacional(req)`** |
| `unidade/unidade.service.js:87` (histórico tabela comercial, `origem: "tenant"`) | snapshot | B/E | **→ `identidadeOperacional(req)`** |
| `plataforma/*` `atorId: req.user.id`, `id === req.user.id`, `usuario_nome: req.user.nome` (`origem: "superadmin"`) | painel do SuperAdmin — gerencia CONTAS | A/D | — (correto; `origem`/`ator_tipo` distinguem) |
| `plataforma.empresas.service.js#entrarComoEmpresa` | `perfilId: null`, `impersonadoPor` | A | — (Fase D) |
| `agente.controller.js` `usuario: req.user` + `perfil: req.perfil` | conta + pessoa | A/B | — (Fase D) + **prompt/auditoria usam perfil** |
| `contexto/contexto.controller.js` `usuarioId: req.user.id` | módulo **legado**, sem uso no frontend atual | G | — (aposentar; ver **I**) |
| `martinbrower` / `ifood` controllers `usuarioId: req.user.id` | autoria de registro de domínio, não exibida | C | — (Fase A "manter"; B-latente) |
| `administrativo.controller.js:35` (ping) | eco da identidade da CONTA | A | — (correto) |

**Replace em massa? Não.** 5 controllers + 1 service trocados cirurgicamente (`usuario: req.user` → `identidadeOperacional(req)`); o resto classificado e deixado.

---

## C. Snapshots de identidade — o helper

`shared/identidade.js` → `identidadeOperacional(req)`:

```js
{
  contaId:  req.user?.id ?? null,
  perfilId: req.perfil?.id ?? req.acesso?.perfilId ?? null,
  id:    req.user?.id ?? null,                       // "usuario_id" das tabelas de domínio — a CONTA
  nome:  req.perfil?.nome ?? req.user?.nome ?? null, // a PESSOA (cai para conta só sem perfil)
  email: req.user?.email ?? null,                    // a CONTA (credencial compartilhada)
  impersonando: !!req.acesso?.impersonando,
}
```

**Por que `id` continua sendo a CONTA:** as colunas `usuario_id` / `created_by` / `atualizado_por_id` / `classificacao_override_usuario_id` dessas 18 tabelas têm **FK para `perfis(id)`**. Um 2º perfil (Fase G) tem `perfis_operacionais.id` **fora** de `perfis` → gravar `perfil_id` ali violaria a FK e exigiria migration. A pessoa real fica **(a)** no snapshot `usuario_nome` (agora = perfil) e **(b)** em `plataforma_auditoria.perfil_id`. Migrar essas FKs é decisão de fase futura (**I**, tabela).

**`usuario_email`:** permanece o e-mail da CONTA — os perfis compartilham a credencial. Documentado; não se inventa e-mail por perfil.

---

## D. Mapa dos ~18 write-sites (Categoria B da Fase A.1)

Todas já tinham snapshot `_nome`. Fase I: o `_nome` passa a ser o do **perfil**; `_id`/`_email` seguem sendo da conta.

| # | Tabela | Campo(s) | Controller/service | Hoje grava | Fase I grava | Alterado? |
|---|---|---|---|---|---|---|
| 3 | `produto_historico` | `usuario_nome/_email` | `produtos.controller` → `produtos.service:184` | conta | **nome=perfil**, email/id=conta | **sim** (controller) |
| 4 | `insumo_preco_historico` | `usuario_nome/_email` | `insumos.controller` → `insumos.service:301` | conta | idem | **sim** |
| 8 | `lancamentos_financeiros_diarios` | `usuario_nome/_email` | `dashboardExecutivo.controller` (criar/atualizar) | conta | idem | **sim** |
| 9 | `lancamentos_financeiros_edicoes` | `usuario_nome/_email` | `dashboardExecutivo.service:1061` | conta | idem | **sim** |
| 10 | `lancamentos_financeiros_exclusoes` | `usuario_nome/_email` | `dashboardExecutivo.controller#excluir` | conta | idem | **sim** |
| 11 | `lancamentos_mensais` | `usuario_nome/_email` | `dashboardExecutivo.controller#lancamentoMensal` | conta | idem | **sim** |
| 12 | `lancamentos_mensais` | `atualizado_por_nome/_email` | `dashboardExecutivo.service:1532` | conta | idem | **sim** |
| 13 | `lancamentos_mensais_exclusoes` | `usuario_nome/_email` | `dashboardExecutivo.controller#excluirLancamentoMensal` | conta | idem | **sim** |
| 14 | `bonificacao_importacoes` | `usuario_nome` | `bonificacaoMensal.controller#importar*` | conta | **nome=perfil** | **sim** |
| 15 | `bonificacao_lancamentos_diarios` | `usuario_nome` | `bonificacaoMensal.controller#upsertLancamentoManual` | conta | idem | **sim** |
| 16 | `bonificacao_lancamentos_exclusoes` | `usuario_nome/_email` | `bonificacaoMensal.controller#excluirLancamento` | conta | idem | **sim** |
| 17 | `bonificacao_indicadores_manuais` | `usuario_nome` | `bonificacaoMensal.controller#salvarValorDiaIndicador` | conta | idem | **sim** |
| 18 | `bonificacao_rev_mensal` | `usuario_nome/_email` | `bonificacaoMensal.controller#salvarRevMensal` | conta | idem | **sim** |
| 14b | `bonificacao_metas` | `usuario_nome` | `bonificacaoMensal.controller#salvarMeta` | conta | idem | **sim** |
| 19 | `parser_fd_importacoes` | `usuario_nome/_email` | `parserFoodDelivery.controller#importar` | conta | idem | **sim** |
| 20 | `parser_fd_importacoes_exclusoes` | `usuario_nome/_email` | `parserFoodDelivery.controller#excluirImportacao` | conta | idem | **sim** |
| 21 | `parser_fd_pedidos` | `classificacao_override_usuario_nome/_email` | `parserFoodDelivery.controller#classificar` + `editarCodigos` | conta | idem | **sim** |
| 22 | `unidade_modelo_logistico_historico` | `usuario_nome/_email` | `dashboardExecutivo.controller#atualizarModeloLogistico` | conta | idem | **sim** |
| 23 | `unidade_tabela_comercial_historico` (`origem: "tenant"`) | `usuario_nome/_email` | `unidade.service#alterarTabelaComercial` | conta | idem | **sim** |
| 24 | `dashboard_teste_reset_log` | `usuario_nome/_email` | `dashboardExecutivo.controller#resetTeste` | conta | idem | **sim** |

**Não alterados** (deliberado): `unidade_tabela_comercial_historico` com `origem: "superadmin"` (o SuperAdmin não tem perfil operacional — ação da conta, distinguível por `origem`); `created_by` de `insumos`/`ficha_tecnica`/`produtos` (Categoria C, nunca exibido); `agente_uso`, MB/iFood `criado_por` (Categoria C / B-latente).

**Histórico antigo:** não migrado. Linhas gravadas antes da Fase I mantêm o `usuario_nome` da conta.

---

## E. Agente Crescer

* **Isolamento de conversa** por `perfil?.id` (Fase D) — mantido; teste `agente-conversas-isolamento.test.js` (Fulana 1 não vê a conversa da Fulana 2 na mesma conta).
* **Nome no chat:** `construirSystemPrompt` passou a receber `{ ...usuario, nome: perfil?.nome ?? usuario?.nome }` — o Agente fala com a PESSOA, não com "Operacional X".
* **Auditoria da mensagem** (`AGENTE_MENSAGEM_ENVIADA`): já gravava `perfil_id`; agora também `perfil_nome` em `detalhes`.
* **Uso/custo** (`agente_uso`): permanece agregado por conta/org (Categoria C) — drill-down por perfil é opcional, Fase G.

---

## F. Usuários online

`obterUsuario` (Painel SuperAdmin → detalhe da conta) passou a devolver:

```jsonc
{
  "perfisOperacionais": [{ "id", "nome", "ativo" }],   // 1 hoje; N na Fase G
  "sessoes": [{ …, "perfilId", "perfilNome", "viva" }],
  "sessoesResumo": {
    "contaOnline": true,            // qualquer sessão viva
    "totalSessoesVivas": 3,
    "impersonacoesVivas": 0,        // sessões vivas sem perfil (superadmin dentro da empresa)
    "porPerfil": [{ "perfilId", "nome", "ativo", "sessoesVivas": 2 }]
  }
}
```

`listarUsuarios` (a LISTA) segue com `online` por CONTA — a lista enumera **contas**, então "conta online" é a semântica certa ali. Frontend não mexido (Fase G evolui a UI). Degrada pré-060 (conta = seu próprio perfil).

---

## G. Logout — PERFIL × CONTA

`forcarLogout(req, contaId, perfilId?)` — duas semânticas **explícitas** (ponto 17):

| Chamada | Revogação Context Token | Supabase Auth | Efeito |
|---|---|---|---|
| `POST /usuarios/:id/logout` **sem corpo** | `revogarSessoes({ usuarioId })` | `encerrarSessoesAuth` (global) | a CONTA inteira cai; re-login |
| `POST /usuarios/:id/logout` **`{ perfilId }`** | `revogarSessoes({ perfilId })` | **nada** | só aquela PESSOA cai; irmãos e a credencial seguem |

Retorno carrega `escopo: "perfil" \| "conta"`. Auditoria (`USUARIO_LOGOUT_FORCADO`) grava `detalhes.escopo`. Sem UI nesta fase — contrato pronto para o botão "Encerrar sessões deste perfil" (Fase G).

Outras revogações (Fase E, inalteradas): logout normal → `{ sessionId }`; papel/vínculo alterado → `{ perfilId, organizacaoId|unidadeId }`; módulo da org → `{ organizacaoId }`; conta desativada/senha → `{ usuarioId }` + Auth.

---

## H. SuperAdmin e impersonação

| Caso | `perfil_id` da sessão | `ator_id` auditoria | `perfil_id` auditoria | Nome no snapshot |
|---|---|---|---|---|
| Usuário normal (inclui superadmin **com vínculo**) | o perfil | a conta | o perfil | perfil |
| SuperAdmin **impersonando** empresa | `null` | o superadmin | `null` | nome do superadmin (`req.perfil` null → cai para `req.user.nome`) — coerente com "quem operou foi o superadmin" |
| SuperAdmin no **painel** (sem Context Token) | — | o superadmin | `null` | conta do superadmin; linhas marcadas `ator_tipo: "superadmin"` / `origem: "superadmin"` |

Impersonação **não** fabrica perfil (`criarSessao` exige `impersonadoPor && !perfilId`). Migration `062` (CHECK XOR `perfil_id`/`impersonado_por`) — **re-revisada, continua coerente** após a Fase I (nenhuma mudança na invariante).

---

## I. `usuario_id` legado — mapa definitivo

| Local | Uso | Classificação | Ação |
|---|---|---|---|
| `sessao.service.js#buscarVinculoOrgDoPerfil` / `buscarVinculoDiretoDaUnidade` / `buscarVinculosDeUmPerfil` | autorização operacional | **PERFIL necessário** — já por `perfil_id`, `usuario_id` só no fallback pré-060 | ✅ ok (Fase E) |
| `sessao.service.js#buscarVinculosOrgEUnidade` + `listarAcessos({ usuarioId })` | monta a LISTA de "onde posso entrar" quando o frontend **não** passa `perfilId` | **LEGADO/TRANSIÇÃO** — para conta multi-perfil listaria empresas dos dois perfis | **Fase F:** frontend passa `perfilId`; depois restringir/remover o ramo sem `perfilId`. Não é blocker da Fase I (não existe conta multi-perfil até a Fase G). |
| `contexto/contexto.service.js#obterContexto` (`GET /api/v1/contexto`) | listava orgs/unidades da conta | **LEGADO** — **sem uso no frontend atual** (grep confirmou; `routes.js:92` "contexto é legado") | aposentar num cleanup; `GET /contexto/acessos` (histórico de acesso do superadmin) permanece, é sobre a conta |
| `usuarios/usuarios.service.js#listarVinculos` / `criarUsuario` / `atualizarUsuario` / `excluirUsuario` | tela Configurações→Usuários (gestão), **não** autorização | **HISTÓRICO / gestão** — grava `perfil_id` (Fase E); lê/deleta por `usuario_id` | ✅ ok; `063` troca os `UNIQUE` |
| `plataforma/plataforma.usuarios.service.js` (list/obter/vínculos) | Painel SuperAdmin (gestão de CONTAS) | **LEGÍTIMO COMO CONTA** (+ escreve `perfil_id`) | ✅ ok |
| `plataforma.empresas/unidades.service.js` (contagens, `impactoExclusao`) | métricas / bloqueio de exclusão | **LEGÍTIMO COMO CONTA** (conta ≈ pessoa hoje) | opcional: `COUNT(DISTINCT perfil_id)` na Fase G |
| `martinbrower` / `ifood` `usuario_id` (domínio) | autoria de registro | **SEGURANÇA/domínio** — Fase A "manter"; não exibido | B-latente |
| `movimentacoes_estoque.usuario_id` | módulo dormante | rever quando estoque nascer | — |

**Nenhuma autorização operacional decide acesso por `usuarios_*.usuario_id` da conta.** O único ponto que ainda usa `usuario_id` num contexto de "o que a pessoa pode ver" é a **lista de seleção** (`listarAcessos` sem `perfilId`), que: (a) não concede acesso — `selecionarContexto` revalida por `perfil_id`; (b) só teria efeito visível numa conta multi-perfil, que não existe até a Fase G; (c) é resolvida na Fase F. Registrado como item obrigatório da Fase F, **não** blocker da Fase I.

---

## J. Scans de segurança

**Scan 1 — `req.user.id` / `usuario_id` em autorização** (ponto 38): nenhum. Detalhe na tabela **I** e no relatório da Fase E (seção B).

**Scan 2 — `req.user.nome` / `req.user.email` como "quem fez"** (ponto 39):

| Local | Veredito |
|---|---|
| `sessao.service.js:901` (`contextoAtual` montando `conta`) | é literalmente a conta — correto |
| `plataforma.unidades.service.js:314` (`usuario_nome: req.user.nome`, `origem: "superadmin"`) | ação direta do SuperAdmin (sem perfil), linha marcada `origem: "superadmin"` — aceitável, documentado |
| `administrativo.controller.js:35` (ping) | eco da CONTA — correto |
| **write-sites de tenant** (dashboard/bonificação/parser/produtos/insumos/unidade) | **todos migrados** para `identidadeOperacional(req)` — `req.user.nome` não aparece mais como pessoa |
| `atorEmail: req.user.email` (auditoria, painel superadmin) | `ator_email` = a CONTA por design; a pessoa é `perfil_id` — correto |

**Scan 3 — guardas "eu mesmo"** (ponto 33): `usuarios/usuarios.service.js` compara `solicitantePerfilId ?? solicitanteId` (PERFIL — Fase E). `plataforma.usuarios.service.js` (`:274/:391/:704`) compara `id === req.user.id` (CONTA) — correto: o painel gerencia CONTAS, não perfis.

---

## K. Testes

| Arquivo | Testes | Cobre |
|---|---|---|
| `identidade-conta-perfil.test.js` *(novo)* | 24 | `identidadeOperacional` (nome=pessoa, email/id=conta, impersonação, perfis irmãos, req vazio); `contextoDaRequisicao` separa conta/perfil/perfilNome; `auditar` move perfilNome p/ detalhes; `contextoAtual` expõe `conta` e `perfil`; `/me` continua conta; `forcarLogout` perfil×conta; `obterUsuario.sessoesResumo`; scan write-sites; guardas "eu mesmo" |
| regressão (multi-perfil, agente, calc, contexto, plataforma, unidade) | 662 | Fases C/D/E + dashboard/bonificação/parser/produtos/insumos calc |
| **Total áreas tocadas** | **686 pass / 3 skip / 0 fail** | |
| Frontend | 193/193 | — |

**Testes obrigatórios (ponto 40) — cobertura:**

1–3. auditoria Fulana 1 → perfil 1; Fulana 2 → perfil 2; `ator_id` igual → `contextoDaRequisicao` + `identidadeOperacional` (perfis irmãos, mesma conta). ✅
4–6. snapshot nome Fulana 1/Fulana 2 correto; e-mail compartilhado → `identidadeOperacional` (`nome` do perfil, `email` da conta). ✅
7–11. Dashboard/Bonificação/Parser/Produto/Insumo usam nome de perfil → scan dos 5 controllers + `unidade.service`. ✅
12. Agente usa perfil → `agente-conversas-isolamento` + scan prompt/auditoria. ✅
13–14. perfil inativo / conta desativada mantêm histórico → snapshot `_nome` sobrevive (FK SET NULL); nada é DELETE. ✅ (documental + FK)
15. impersonação `perfil_id` null → `contextoDaRequisicao` test. ✅
16. superadmin com vínculo grava perfil → caminho normal (Fase E/D). ✅
17. `/me` continua conta → scan `app.js`. ✅
18. `contextoAtual` expõe perfil (e conta) → test. ✅
19. online distinguível por perfil → `obterUsuario.sessoesResumo` test. ✅
20–21. mesmo perfil em 2 devices = 2 sessões; irmãos não se confundem → Model Y (Fase D/E) + `sessoesResumo.porPerfil`. ✅
22–23. force logout perfil não derruba irmão; force logout conta derruba todos → `forcarLogout` test (escopo perfil não toca Auth; escopo conta + Auth). ✅
24. guarda "eu mesmo" compara perfil → test (tenant). ✅
25–26. nenhum `req.user.nome` como pessoa em write-site crítico; nenhum `usuario_id` legado como autorização → Scan 2 + Scan 1. ✅

---

## L. Arquivos alterados

**Backend:**
* `shared/identidade.js` *(novo)* — `identidadeOperacional(req)`.
* `shared/auditoria.js` — `perfilNome` → `detalhes.perfil_nome`; `contextoDaRequisicao` devolve `perfilNome`.
* `modules/sessao/sessao.service.js` — `contextoAtual` passa a devolver `conta` separada de `perfil`.
* `modules/dashboard-executivo/dashboardExecutivo.controller.js`, `modules/bonificacao-mensal/bonificacaoMensal.controller.js`, `modules/parser-food-delivery/parserFoodDelivery.controller.js`, `modules/produtos/produtos.controller.js`, `modules/insumos/insumos.controller.js` — `usuario: req.user` → `usuario: identidadeOperacional(req)`.
* `modules/unidade/unidade.service.js` — histórico de tabela comercial (`origem: "tenant"`) usa `identidadeOperacional(req)`.
* `modules/plataforma/plataforma.usuarios.service.js` — `obterUsuario` (+`perfisOperacionais`, `sessoesResumo`, `perfilNome` por sessão); `forcarLogout(req, id, perfilId?)` com escopo perfil×conta.
* `modules/plataforma/plataforma.controller.js` — `forcarLogout` repassa `body.perfilId`.
* `modules/agente/agente.service.js` — prompt fala com o perfil; auditoria grava `perfilNome`.

**Frontend (3 linhas, sem UI):**
* `src/state.js` — `state.sessao.perfil` no modelo + comentário CONTA×PESSOA.
* `src/sessao.js` — `state.sessao.perfil = data.perfil ?? null` em `aplicarContexto` / `restaurarContexto` / `limparContexto`.

**Migrations:** nenhuma nova. `062` re-revisada (coerente).

---

## M. Limitações

1. **Sem ambiente 060.** As gravações de snapshot com nome de perfil não foram verificadas end-to-end contra Postgres (write-sites batem em Supabase; `.env` = produção). Validado por unidade + scan.
2. **Suite de integração (pré-existente, ~17–52 falhas).** `parser_fd_importacoes_unidade_id_fkey`, "Você não tem acesso a esta unidade", metas seedadas — o DB alvo não tem 060 nem as fixtures. **Não é regressão da Fase I** (nenhuma mudança de schema/seed/FK). Mesmo baseline da Fase E, seção O.
3. **Histórico antigo** não é reprocessado — linhas anteriores mantêm o nome da conta.
4. **`usuario_id`/FK das 18 tabelas** continuam apontando para a conta (FK → `perfis(id)`). Migrar para `perfis_operacionais` é decisão de fase futura; hoje a pessoa vive no `_nome` + `plataforma_auditoria.perfil_id`.
5. **`listarAcessos` sem `perfilId`** ainda une vínculos de todos os perfis da conta (só relevante quando existir 2º perfil — Fase G; corrigir na Fase F).

---

## N. Blockers

**Para a Fase I:** nenhum.

**Para fases seguintes (registrado):**
* **Fase F:** frontend deve passar `perfilId` a `GET /sessao/acessos`; depois restringir/remover o ramo legado sem `perfilId` em `listarAcessos`.
* **Antes de deploy multi-perfil:** aplicar `060` (senão `/sessao/selecionar` degrada mas não é estado suportado); `063` antes da Fase G.
* **Cleanup:** aposentar `GET /api/v1/contexto` (`contexto.service.js#obterContexto`) — sem uso.

---

## Staging gate (ponto 42) — obrigatório antes de qualquer deploy multi-perfil

Não existe ambiente com schema ≥ 060. **Antes de produção:**

1. Criar/usar **staging** com schema atualizado até 059.
2. Rodar **pré-check da 060** (queries de contagem no cabeçalho da migration).
3. Aplicar **060** no staging (Supabase SQL Editor).
4. **Pós-check** (linhas de `perfis_operacionais`, colunas `perfil_id`, sessões revogadas com `motivo = 'migracao_060_multi_perfil'`).
5. Deploy do backend **C + D + E + I** no staging.
6. Rodar a **suite de integração** completa contra o staging (deve passar — hoje falha só por falta de 060/fixtures).
7. **Teste manual de 2 contas / 2 perfis** (cenário Operacional X / Fulana 1 / Fulana 2): auditoria, snapshots, isolamento, revogação.
8. **Rollback ensaiado** (bloco de rollback documentado no rodapé da 060).
9. Só então: `062`, depois `063` (antes da Fase G).

**Não executar nada disso enquanto o ambiente staging não existir.**

---

## O. Veredito

> ## FASE I CONCLUÍDA — APTA PARA A FASE H
>
> O sistema distingue de forma consistente **CONTA** (`req.user` — credencial compartilhada, `/me`, `ator_id`, e-mail) de **PESSOA** (`req.perfil` — `identidadeOperacional().nome`, `perfil_id`, snapshots "por Fulano"). Quando Fulana 1 age, o snapshot e a auditoria dizem "Fulana 1"; quando Fulana 2 age, dizem "Fulana 2" — mesmo compartilhando e-mail, senha, conta Supabase e `req.user.id`. Ações que são realmente da CONTA (senha, e-mail, bloqueio, logout global, painel do SuperAdmin) continuam sendo da conta.
>
> `req.user` nunca é sobrescrito. Auditoria: `ator_id` = conta, `perfil_id` + `detalhes.perfil_nome` = pessoa. Logout tem contrato explícito perfil × conta. "Usuários online" é distinguível por perfil no backend. Nenhuma autorização operacional decide por `usuario_id` da conta.
>
> 686/686 testes nas áreas tocadas (24 novos) + 193/193 frontend. Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção.
>
> **A próxima fase (H — PIN) é decisão do revisor. Não avancei.**

---

## NÃO FIZ (respeitado)

migration aplicada · produção · deploy · PIN · 2º perfil · UI de seleção · remoção de `usuario_id` · renomear `perfis` · mexer em `auth.users` · replace em massa · migrar FKs de domínio · avançar para H/G/F/J.
