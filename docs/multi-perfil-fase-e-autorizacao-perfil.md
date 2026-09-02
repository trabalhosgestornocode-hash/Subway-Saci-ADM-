# Multi-perfil — Fase E (autorização, vínculos e permissões por PERFIL)

**Status:** implementado. **404/404 testes** nas áreas tocadas (38 novos em `autorizacao-perfil.test.js` + 366 de regressão), 3 skipped pré-existentes. **Nenhum deploy. Nenhuma migration aplicada (060/062/063 continuam só em arquivo). Nenhuma escrita em banco de produção.**
**Data:** 2026-09-01
**Escopo:** backend. Sem tela "Selecione seu usuário" (Fase F), sem PIN funcional (Fase H), sem criação de 2º perfil (Fase G).

---

## Pré-condição / método de validação

Não há ambiente com o schema 060 acessível: `backend/.env` aponta para o projeto de produção (`uqybgauuxcrqzquultfu`) e a migration 060 não está aplicada em lugar nenhum. A validação é:

* **testes unitários** com injeção de dependência (`deps = { ... }`), mesmo padrão de `listarAcessos`;
* **helpers puros extraídos** (`filtrosDeRevogacao`, `validarPidContraSessao` da Fase D);
* **scans de fonte** (`assert.match` sobre o texto do módulo) para o que só é exercitável contra Supabase real;
* **guarda de auto-rebaixamento** testada de verdade (lança antes de tocar o banco).

Limitações completas em **O**.

---

## A. Mapa de autorização — antes × depois

| Dimensão | Antes (HEAD `95b3858`) | Depois (Fase E) |
|---|---|---|
| Identidade que autoriza | `req.user.id` (a CONTA) | `req.perfil.id` (a PESSOA); `req.user` intocado |
| Vínculo de empresa | `usuarios_organizacoes.usuario_id = req.user.id` | `.perfil_id = req.perfil.id` (degrada p/ `usuario_id` pré-060) |
| Vínculo de unidade | `usuarios_unidades.usuario_id = …` | `.perfil_id = …` (idem) |
| Papel | do vínculo da conta | do vínculo **do perfil resolvido** |
| Permissões | `permissoesDoPapel(papel)` | **inalterado** — `permissoesDoPapel(papel)`, sem merge entre perfis |
| Módulos | empresa/unidade do contexto | idem, mas o perfil só chega ao cálculo **depois** de vínculo válido |
| Sessão | `sessoes_contexto` 1 linha, sem perfil | + `perfil_id` (null só em impersonação); Model Y |
| Revogação por vínculo | `{ usuarioId }` (derrubava a conta toda) | `{ perfilId, organizacaoId|unidadeId }` (só o irmão afetado) |
| Auditoria | `ator_id` | `ator_id` (conta) **+ `perfil_id`** (pessoa) |

O `req.user` (CONTA) **nunca** é sobrescrito. `req.user.id = perfilId` não existe em lugar nenhum (scan `doesNotMatch(/req\.user\.id\s*=[^=]/)`).

---

## B. Usos de CONTA × PERFIL × CONTEXTO — scan de segurança

Grep `req.user.id` em `backend/src`, classificado:

| Arquivo | Função | Uso | Semântica | Correto? | Ação futura |
|---|---|---|---|---|---|
| `middlewares/auth.js` | `requireContexto` | `p.sub !== req.user.id`, `sessao.usuario_id !== req.user.id` | pareamento **token ↔ CONTA** | **Sim** | — |
| `middlewares/auth.js` | `requireContexto` | `req.perfil = …`, `req.acesso.perfilId = …` | expõe o PERFIL da sessão | **Sim** | — |
| `shared/auditoria.js` | `contextoDaRequisicao` | `perfilId: req.perfil?.id ?? req.acesso?.perfilId` | audit registra a PESSOA | **Sim** | — |
| `modules/sessao/sessao.controller.js` | `acessos` (sem `perfilId`) | `listarAcessos({ usuarioId: req.user.id })` | caminho **LEGADO** (frontend atual) | **Sim** (compat) | Fase F: frontend passa `perfilId` |
| `modules/sessao/sessao.controller.js` | `selecionar` / `trocarUnidade` | `perfilId: req.acesso.perfilId` / body | PERFIL, nunca do cliente na troca | **Sim** | — |
| `modules/usuarios/usuarios.controller.js` | `atualizar` / `excluir` | `solicitanteId: req.user.id`, `solicitantePerfilId: req.perfil?.id` | guarda de auto-rebaixamento **por perfil** | **Sim** | — |
| `modules/usuarios/usuarios.service.js` | `criar/atualizar/excluirUsuario` | vínculos por `perfil_id`; revogação `{ perfilId, organizacaoId }` | TENANT → Configurações → Usuários | **Sim** | — |
| `modules/plataforma/plataforma.usuarios.service.js` | `associar/remover/atualizarVinculo(Unidade)` | vínculos `perfil_id`; revogação `{ perfilId, org|unidade }` | Painel SuperAdmin | **Sim** | — |
| `modules/plataforma/plataforma.usuarios.service.js` | `atualizarUsuario`/`excluirUsuario`/`definirSuperadmin` | `id === req.user.id` | **CONTA** (painel do superadmin gerencia contas) | **Sim** — decisão documentada | — |
| `modules/plataforma/*` (empresas, unidades, estrutura, config) | vários | `atorId: req.user.id`, `p_ator_id` | ator de auditoria = a CONTA superadmin | **Sim** | — |
| `modules/plataforma/plataforma.empresas.service.js` | `entrarComoEmpresa` | `contaId: req.user.id`, `impersonadoPor: req.user.id`, `perfilId: null` | impersonação sem perfil | **Sim** | — |
| `modules/contexto/contexto.controller.js` | `obter` / `acessar` / `acessos` | `usuarioId: req.user.id` | módulo **LEGADO** (routes.js:92 — "contexto é legado"), fora do caminho crítico | **Sim** (aceitável) | Fase F/G: aposentar ou escopar por perfil |
| `modules/martinbrower/*.controller.js` | confirmar custo / conexão | `usuarioId: req.user.id` / `confirmadoPor` | coluna de **domínio** (autoria do registro), não autorização | **Sim** — Fase A classificou "manter" | opcional: `perfil_id` no futuro |
| `modules/ifood/ifood.controller.js` | conectar / autorizar / desconectar | `usuarioId: req.user.id` | autoria da ação (conexão da unidade) | **Sim** — domínio, não autz | opcional |
| `modules/agente/agente.controller.js` | `mensagem` / `historico` | `perfil: req.perfil` | isolamento de conversa por PESSOA | **Sim** | — |

**Nenhum `WHERE usuario_id = req.user.id` em código de autorização** (empresa/unidade/papel). Os restantes são: pareamento token↔conta (correto), auditoria (correto), painel do superadmin que gerencia CONTAS (correto), colunas de domínio (Fase A), e o módulo `contexto` legado (fora do caminho de decisão).

---

## C. Vínculos canônicos por `perfil_id`

`usuarios_organizacoes` / `usuarios_unidades` passam a ser lidos e escritos por `perfil_id`:

* **Leitura (autorização):**
  * `selecionarContexto` → `buscarVinculoOrgDoPerfil({ perfilId, organizacaoId })` e `acessoEfetivoDaUnidade({ perfilId, … })` → `buscarVinculoDiretoDaUnidade({ perfilId, unidadeId })`.
  * `listarAcessosDoPerfil` → `buscarVinculosDeUmPerfil({ contaId, perfilId })` (superadmin ainda por `contaId`).
* **Escrita (criação de vínculo):** `perfil.service.js#inserirVinculoOrgComPerfil` / `inserirVinculoUnidadeComPerfil` gravam `usuario_id` (LEGACY) **+** `perfil_id`. Antes disso, `garantirPerfilOperacionalInicial({ contaId })` cria a linha `perfis_operacionais` com `id == conta_id` (UUID reaproveitado da 060) — a FK do vínculo nunca fica órfã.
* **Ordem garantida:** `criarUsuario` (tenant e plataforma) chama `garantirPerfilOperacionalInicial` **antes** de `inserirVinculoOrg…` (teste de ordenação no índice do texto).
* **`usuario_id` não é removido** (Fase A.1) — só deixa de ser a chave de autorização.
* **`063_vinculos_perfil_id_not_null.sql`** (em arquivo, não aplicada) fecha a transição: backfill dos nulos restantes, `perfil_id NOT NULL`, e troca dos `UNIQUE(usuario_id, X)` por `UNIQUE(perfil_id, X)`. **Pré-requisito da Fase G.**

---

## D. Papel e permissões

* **Papel** = o do vínculo **do perfil resolvido** naquela empresa/unidade (`vinculoOrg.papel`, ou o do vínculo direto de unidade quando definido — regra pré-existente preservada).
* **Permissões:** `permissoesDoPapel(papel)` — **arquivo `permissoes.js` intocado**. Não há merge, união, nem "o maior papel da conta". Fulana 2 (Gerência na Empresa B) e Fulana 1 (Operação na Empresa A) recebem exatamente o conjunto do próprio papel. Teste: `viewer` nunca contém `usuarios.gerenciar`; `permissoesDoPapel` é 1:1.
* **Snapshot:** as permissões vão para `sessoes_contexto.permissoes` no momento da seleção. Trocar o papel depois **não** reescreve a linha — a sessão é revogada (ver **G**) e a pessoa refaz a seleção, recebendo o snapshot novo.

---

## E. Módulos

* O perfil só chega ao cálculo de módulos **depois** de `buscarVinculoOrgDoPerfil` devolver um vínculo ATIVO — sem vínculo, `selecionarContexto` nega antes (`negarAcesso` → `ApiError.forbidden`).
* `modulosDaEmpresa` / `modulosEfetivosDaUnidade` continuam por `organizacao_id` / `unidade_id` do contexto — **não** por perfil. É correto: módulo é da empresa/unidade, não da pessoa.
* Mudança de módulo é evento **organizacional** → revogação por `{ organizacaoId }` / `{ unidadeId }` (todos os perfis daquela empresa/unidade), não por `{ perfilId }`. Ver **G**.

---

## F. Empresa → unidade e herança, por perfil

A REGRA DE ACESSO EFETIVO (topo de `sessao.service.js`) é preservada, agora escopada por `perfil_id`:

* vínculo de EMPRESA do perfil ⇒ acesso a todas as unidades ATIVAS dela (as de hoje e as futuras);
* vínculo DIRETO de unidade do perfil basta para aquela unidade, mesmo sem vínculo de empresa;
* papel do vínculo direto sobrepõe o da empresa quando definido;
* "todas as unidades" (consolidado) exige o vínculo de empresa ATIVO.

`listarAcessosDoPerfil(Fulana 1)` devolve **só** a Empresa A e suas unidades; a Empresa B da Fulana 2 não aparece por herança de conta (provado em `sessao-perfil.test.js`, cenários 1–13).

---

## G. Matriz de revogação

`revogarSessoes` combina todos os escopos informados com **AND** (`filtrosDeRevogacao`, puro). Chamada sem escopo **lança** (nunca "revoga tudo").

| Evento | Escopo | Efeito | Onde |
|---|---|---|---|
| Logout normal | `{ sessionId }` | só aquela aba/device | `encerrarContexto` |
| Troca de unidade/empresa | `{ sessionId }` (a antiga) | substitui a sessão atual; irmãs seguem | `selecionarContexto(revogarSessionId)` / `trocarUnidadeDoContexto` |
| Perfil desativado | `{ perfilId }` | todas as sessões daquele perfil, em qualquer empresa/device | admin (Fase G liga a ação) |
| Conta bloqueada / senha redefinida / "forçar logout" | `{ usuarioId }` (= conta) | todos os perfis, todos os devices | `plataforma.usuarios.service.js` |
| Papel alterado na Empresa A | `{ perfilId, organizacaoId }` | só as sessões daquele perfil naquela empresa | `atualizarVinculo`, `usuarios.service.js#atualizarUsuario` |
| Vínculo de Empresa A removido | `{ perfilId, organizacaoId }` | idem | `removerVinculo`, `excluirUsuario` |
| Vínculo de Unidade A1 removido | `{ perfilId, unidadeId }` | só aquele perfil naquela unidade | `removerVinculoUnidade` (**passou a revogar** — antes não revogava nada) |
| Papel do vínculo de unidade alterado | `{ perfilId, unidadeId }` | idem | `atualizarVinculoUnidade` |
| Módulo da Empresa A alterado | `{ organizacaoId }` | **todos** os perfis na empresa | `plataforma.empresas.service.js` |
| Módulo da Unidade A1 alterado | `{ unidadeId }` | todos os perfis na unidade | `plataforma.unidades.service.js` |
| "Encerrar sessões deste perfil" (admin) | `{ perfilId }` | preparado; UI na Fase G | — |
| "Encerrar sessões desta conta" (admin) | `{ usuarioId }` | todos os perfis | já existe |

**Isolamento:** remover o vínculo da Fulana 1 na Empresa A revoga `{ perfil_id: Fulana1, organizacao_id: A }` — as sessões da Fulana 2 na Empresa B (`perfil_id` diferente) **não** casam o filtro. Mudança de módulo da organização é a exceção intencional: escopo amplo por `organizacaoId`.

Testes A–H em `autorizacao-perfil.test.js` (`filtrosDeRevogacao`) + scans das 12 chamadas reais.

---

## H. Guarda de auto-rebaixamento

`usuarios.service.js#atualizarUsuario` / `excluirUsuario` recebem `solicitanteId` (conta) **e** `solicitantePerfilId` (`req.perfil?.id`). A guarda compara **por perfil**:

```js
const solicitante = solicitantePerfilId ?? solicitanteId;
if (usuarioId === solicitante) throw ApiError.badRequest("Você não pode alterar/remover o seu próprio acesso.");
```

`usuarioId` aqui é o `perfil_id` do alvo (a rota de Configurações → Usuários opera sobre perfis). Uma pessoa não rebaixa/remove a si mesma; um **irmão de perfil** da mesma conta pode ser gerenciado normalmente (contas diferentes de PESSOA). Testado de verdade (lança antes do banco).

No Painel SuperAdmin (`plataforma.usuarios.service.js`) a guarda `id === req.user.id` permanece **por CONTA** — lá o objeto gerenciado é a conta inteira, não o perfil. Decisão documentada, deliberada.

---

## I. SuperAdmin e impersonação

| Caso | `perfil_id` da sessão | `impersonado_por` | Autorização |
|---|---|---|---|
| Superadmin **puro** (sem vínculo) selecionando contexto | exige perfil resolvido | null | `resolverPerfilParaContexto` — precisa de ≥1 perfil ativo (ou vínculo). Superadmin sem nenhum vínculo usa impersonação. |
| Superadmin **com vínculo** operando como si | `perfil_id` = seu perfil | null | igual a qualquer perfil |
| Superadmin **impersonando** empresa (`entrarComoEmpresa`) | **null** | `req.user.id` | `criarSessao` exige `impersonadoPor && !perfilId`; `validarPidContraSessao` só aceita `pid=null` **com** `impersonado_por` |

**Proibido e ausente:** nenhum `if (!perfilId) usar req.user.id` no caminho de autorização. Um token normal com `pid=null` e sem impersonação → 409 (`validarPidContraSessao`). A única exceção controlada é a impersonação.

`062_sessoes_contexto_perfil_check.sql` (em arquivo) grava o XOR no banco: `(perfil_id NOT NULL AND impersonado_por NULL) OR (perfil_id NULL AND impersonado_por NOT NULL)`. **Revisado — continua válido após a Fase E**, é exatamente a invariante que `criarSessao` já aplica na aplicação.

---

## J. Usuários online

`plataforma.usuarios.service.js#obterUsuario` passa a devolver `perfilId` por sessão (`sessoes_contexto.perfil_id ?? null`; null = impersonação). É o dado bruto para "online por perfil". A **contagem/semântica** ("3 sessões, 2 perfis distintos") fica para a Fase I/G — aqui só a fonte de dados, sem quebrar o payload atual.

---

## K. RLS

* As policies de `perfis_operacionais` (060) e das tabelas de vínculo usam `auth.uid()` = a **CONTA**. RLS garante isolamento **entre contas**, não fino entre perfis irmãos da mesma conta.
* O isolamento entre perfis da mesma conta é **da aplicação** (`perfil_id` nas queries + revogação escopada + `validarPidContraSessao`). Isto é explícito e intencional: a Fase E **não** alega isolamento por RLS entre perfis.
* Nada em RLS foi alterado nesta fase.

---

## L. Arquivos alterados

**Backend (código):**
* `middlewares/auth.js` — `requireContexto`: lê `perfil_id`, resolve `perfis_operacionais`, aplica `validarPidContraSessao`, seta `req.perfil` / `req.acesso.perfilId`. **Degradação pré-060** (relê sem a coluna, pula a regra do pid).
* `modules/sessao/sessao.service.js` — vínculos por `perfil_id` (`buscarVinculoOrgDoPerfil`, `buscarVinculoDiretoDaUnidade`, `buscarVinculosDeUmPerfil`), `acessoEfetivoDaUnidade({ perfilId })`, `selecionarContexto` resolve o perfil antes de tudo, `filtrosDeRevogacao` (puro), `criarSessao` grava `perfil_id`. **Degradação pré-060** em todas as buscas + `criarSessao` + `revogarSessoes`.
* `modules/sessao/perfil.service.js` *(novo — Fase C, estendido)* — `garantirPerfilOperacionalInicial`, `inserirVinculoOrgComPerfil`, `inserirVinculoUnidadeComPerfil`, `resolverPerfilParaContexto` (com degradação pré-060).
* `modules/sessao/sessao.controller.js` — passa `perfilId` / `solicitantePerfilId`.
* `modules/usuarios/usuarios.service.js` + `.controller.js` — vínculos por perfil na criação; revogação `{ perfilId, organizacaoId }`; guarda de auto-rebaixamento por perfil.
* `modules/plataforma/plataforma.usuarios.service.js` — todas as funções de vínculo (org e unidade) por `perfil_id`; revogação escopada; `removerVinculoUnidade` **passou a revogar**; `obterUsuario` expõe `perfilId`.
* `modules/plataforma/plataforma.empresas.service.js` — `entrarComoEmpresa` com `perfilId: null` + `impersonadoPor`.
* `modules/agente/*` — conversa isolada por `perfil?.id ?? usuario?.id` (agrupamento, não autorização).
* `shared/contextToken.js` — `pid` no payload v2 + `validarPidContraSessao` (Fase D).
* `shared/auditoria.js` — `perfil_id` na linha de auditoria, com degradação de coluna.

**Migrations (em arquivo, NÃO aplicadas):** `060_perfis_operacionais.sql`, `062_sessoes_contexto_perfil_check.sql`, `063_vinculos_perfil_id_not_null.sql`.

**Testes:** `autorizacao-perfil.test.js` *(novo, 38)*; ajustes em `sessao-model-y.test.js` (scans após extração de helpers).

---

## M. Testes

| Arquivo | Testes | Cobre |
|---|---|---|
| `autorizacao-perfil.test.js` *(novo)* | 38 | `filtrosDeRevogacao` A–H; guarda de auto-rebaixamento (real); `selecionarContexto` autoriza só por `perfil_id`; revogação de vínculo escopada; eventos organizacionais mantêm escopo amplo; criação de vínculo grava `perfil_id` + garante `perfis_operacionais`; degradação pré-060; `permissoes.js` inalterado |
| `sessao-perfil.test.js` (Fase C) | 34 | isolamento horizontal via `listarAcessosDoPerfil` (Fulana 1 só vê Empresa A) |
| `sessao-model-y.test.js` (Fase D) | 41 | Model Y, `validarPidContraSessao`, `resolverPerfilParaContexto`, scans |
| `migration-060-perfis-operacionais.test.js` | 58 | DDL da 060 |
| `sessao-heranca-empresa-unidade.test.js`, `agente-*`, `plataforma-*`, `modulos.test.js`, … | regressão | herança, agente, módulos, lote |
| **Total áreas tocadas** | **404 pass / 3 skip / 0 fail** | |

**Testes obrigatórios (ponto 44) — cobertura:**
1. perfil A só lista organizações de A → `sessao-perfil.test.js` ✅
2. perfil B não recebe papel de A → `sessao-perfil.test.js` (cargo por vínculo do perfil) ✅
3. mesma empresa, papéis diferentes: viewer não recebe admin do irmão → `permissoes.js` inalterado + papel por vínculo ✅
4. empresas diferentes: A não enxerga B → ✅
5. unidades diferentes → herança por `perfil_id` ✅
6. revogação isolada (remover A não derruba B) → `filtrosDeRevogacao` + scans ✅
7. mudança global de módulo derruba os dois → escopo `{ organizacaoId }` ✅
8. perfil desativado → `{ perfilId }` + `validarPidContraSessao(perfilAtivo=false)` ✅
9. conta desativada → `{ usuarioId }` ✅
10. `pid` forjado → 409 → `validarPidContraSessao` (Fase D) ✅
11. impersonação sem fallback para `req.user.id` → scan ✅
12. auto-rebaixamento por perfil → teste real ✅

**Testes `revogarSessoes` A–H (ponto 45):** todos em `autorizacao-perfil.test.js` › "filtrosDeRevogacao — escopos AND".

---

## N. Backward compatibility

| Pergunta | Resposta | Como |
|---|---|---|
| **A.** Conta legada de 1 perfil continua logando e selecionando contexto? | **SIM** | `resolverPerfilParaContexto` sem `perfilId` + 1 perfil ativo → usa esse. Pré-060: degrada e trata a conta como o próprio perfil (`{ id: contaId }`). |
| **B.** Frontend atual (não manda `perfilId`) continua funcionando? | **SIM** | `GET /sessao/acessos` sem `perfilId` → caminho legado `listarAcessos({ usuarioId })`. `POST /sessao/selecionar` sem `perfilId` → resolução automática. |
| **C.** Callers administrativos de `revogarSessoes({ usuarioId })` continuam válidos? | **SIM** | `usuarioId` é alias de `contaId` (mesma coluna `usuario_id`). ~12 callers intocados. |
| **D.** Auditoria continua gravando se `perfil_id` não existe na tabela? | **SIM** | `auditar()` reinsere sem `perfil_id` no `RE_COLUNA_AUSENTE`. |

**Janela de transição pré-060:** todas as buscas de vínculo, `criarSessao`, `revogarSessoes`, `requireContexto` e `resolverPerfilParaContexto` degradam para `usuario_id` quando a coluna/tabela não existe. Pré-060 o comportamento é **idêntico ao de antes da Fase D** (sem camada de perfil). Quando a 060 for aplicada, cada sessão viva pede 1 reseleção (documentado desde a Fase D).

---

## O. Limitações

1. **Sem ambiente 060.** Isolamento fim-a-fim de `selecionarContexto` (resolve perfil → vínculo → papel → módulos → `criarSessao` → `auditar`) não foi rodado contra Postgres real — `criarSessao`/`auditar`/`negarAcesso` batem em Supabase e `.env` = produção. Validado por unidade + scan.
2. **Suite de integração (52 falhas) contra DB sem 060.** `test/bonificacao-mensal-*`, `test/importacao-*`, `test/ifood-*` etc. falham com "Você não tem acesso a esta unidade" — a autorização agora consulta `perfil_id` e a coluna não existe naquele DB. Isto **começou na Fase D** (não é regressão da Fase E) e a Fase E **mitiga** com a degradação pré-060, mas a mitigação não pôde ser integration-testada aqui. **Recomendação:** rodar a suite de integração contra um staging com 060 aplicada como gate da Fase I/J.
3. **RLS não isola perfis irmãos** (ver **K**) — por design; o isolamento é da aplicação.
4. **`removerVinculoUnidade` agora revoga sessões** — mudança de comportamento (antes era silenciosa). Correta, mas é diferença observável.
5. **`perfil_id` como `usuario_id` no fallback** assume a identidade legada (1 perfil == conta). Verdadeiro pré-060; irrelevante pós-060.

---

## P. Blockers

Nenhum blocker para a Fase E em si. **Dependências para fases seguintes:**

* **Antes de qualquer deploy da Fase C/D/E:** aplicar `060` (senão `/sessao/selecionar` responde 500 — mitigado pela degradação, mas não é estado suportado).
* **Fase G (criação de 2º perfil):** exige `063` aplicada (`perfil_id NOT NULL` + `UNIQUE(perfil_id, X)`).
* **`062`:** aplicar só depois de `060` + Fase D em produção.

---

## Q. Veredito

> ## FASE E CONCLUÍDA — APTA PARA A PRÓXIMA FASE
>
> Toda a autorização operacional (empresa, unidade, herança, papel, permissões, módulos) deriva de `CONTA + PERFIL + ORGANIZAÇÃO + UNIDADE`. Não há vazamento entre perfis irmãos: vínculos por `perfil_id`, revogação escopada, `validarPidContraSessao` contra `pid` forjado, guarda de auto-rebaixamento por perfil. `req.user` (CONTA) nunca é sobrescrito. `permissoes.js` intocado — sem merge entre perfis. Mudança global (módulo da organização, bloqueio da conta) mantém escopo amplo, por design.
>
> 404/404 testes nas áreas tocadas (38 novos). Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção.
>
> **A próxima fase (I / H / G / F) é decisão do revisor — não avancei.**

---

## NÃO FIZ (respeitado)

Migration 060/062/063 aplicada · deploy · escrita em banco de produção · tela "Selecione seu usuário" · PIN · criação de 2º perfil · remoção de `usuario_id` · refazer `permissoes.js` · alterar papéis/módulos existentes · avançar de fase · sobrescrever `req.user` · fallback `if (!perfilId) req.user.id` em autorização.
