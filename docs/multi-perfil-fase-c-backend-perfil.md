# Multi-perfil — Fase C (backend de perfil operacional)

**Status:** implementado, 34 testes novos + 149 de regressão passando (183/183). **Nenhum deploy. Nenhuma migration aplicada em banco algum.**
**Data:** 2026-09-01
**Escopo:** backend-only. Sem frontend, sem PIN funcional, sem Context Token v2, sem Model Y de sessões, sem CRUD de perfis, sem criação de 2º perfil.

---

## Pré-condição de desenvolvimento (item 1)

| | |
|---|---|
| Ambiente com schema 059 + 060 aplicada? | **Não.** `backend/.env` → produção (não toco). `backend/.env.test` → projeto descartável no schema ~016 (sem `agente_conversas`, `sessoes_contexto.modulos`, nem 060). |
| O que foi feito | Código + **testes unitários com injeção de dependência** (mesmo padrão de `sessao-heranca-empresa-unidade.test.js`). **Zero query real.** |
| Sem validação de integração | O fluxo real (`perfis_operacionais` de verdade, `usuarios_*.perfil_id` de verdade) **não foi exercitado contra um Postgres**. A lógica pura (posse, isolamento, contrato) está coberta; o "a query certa bate na coluna certa" depende da 060 estar aplicada e será validável na Fase F ou num ambiente 060. |

---

## A. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| **`backend/src/modules/sessao/perfil.service.js`** | **NOVO.** `listarPerfisDaConta`, `obterPerfilDaConta`, `validarPerfilDaConta`, `selecionarPerfil`, `listarAcessosDoPerfil`. Buscas-padrão (`buscarPerfisAtivosDaConta`, `buscarPerfilDaConta`) injetáveis. Nunca expõe `pin_hash`. |
| `backend/src/modules/sessao/sessao.service.js` | `listarAcessos({ usuarioId })` → aceita também `{ contaId, perfilId }` (mutuamente exclusivos). Novo `buscarVinculosDeUmPerfil({ contaId, perfilId })` nos deps-padrão: vínculos por `usuarios_*.perfil_id`, `superadmin` ainda por `plataforma_admins.usuario_id = contaId`. **Caminho legado 100% intacto.** |
| `backend/src/modules/sessao/sessao.controller.js` | `import * as perfilService`. Novos handlers `perfis`, `selecionarPerfil`. `acessos` passa a ramificar: `?perfilId=` → `listarAcessosDoPerfil`; sem → `service.listarAcessos({ usuarioId: req.user.id })` (**idêntico ao de antes**). |
| `backend/src/modules/sessao/sessao.routes.js` | `GET /perfis` e `POST /selecionar-perfil` — com `exigirSenhaDefinitiva`, **sem `requireContexto`** (é aqui que a identidade operacional é escolhida, antes de ter empresa). |
| `backend/test/sessao-perfil.test.js` | **NOVO.** 34 testes (contrato + segurança + isolamento + compat legado + scan de fonte dos controllers/rotas). |

**NÃO tocados:** `middlewares/auth.js`, `routes.js` (top-level), `contextToken.js`, `auditoria.js`, `plataforma.*`, nenhuma tabela de domínio, frontend.

---

## B. Endpoints

| Método / rota | Middlewares | Novo/alterado | O que faz |
|---|---|---|---|
| `GET /api/v1/sessao/perfis` | `requireAuth` (global) · `exigirSenhaDefinitiva` | **novo** | Lista os perfis operacionais **ativos da conta autenticada**. Conta = `req.user.id`. |
| `POST /api/v1/sessao/selecionar-perfil` | idem | **novo** | Valida que `perfilId` pertence à conta + está ativo. **Fase C: só valida** — não emite token, não persiste. |
| `GET /api/v1/sessao/acessos?perfilId=<uuid>` | idem | **alterado (aditivo)** | Acessos (empresas/unidades) **daquele perfil**, com validação de posse antes. |
| `GET /api/v1/sessao/acessos` *(sem `perfilId`)* | idem | **inalterado** | Acessos da **conta** (`usuarios_*.usuario_id`). É o que o frontend atual usa. |

Nenhum handler lê `conta_id` do corpo ou da query — teste `controllers — a conta vem SEMPRE de req.user.id` garante isso.

---

## C. Contratos request / response

### `GET /sessao/perfis`
```jsonc
// 200
{ "data": [
  { "id": "aaaa…", "nome": "Fulana 1", "ativo": true, "temPin": false },
  { "id": "cccc…", "nome": "Fulana 2", "ativo": true, "temPin": true }
] }
```
- **Nunca** retorna `pin_hash`, `pin_tentativas`, `pin_bloqueado_ate`.
- Conta com 1 perfil (legado) → lista com 1 item (o perfil inicial, `id == conta.id`).
- Conta sem perfil ativo → `[]` (200, não erro).

### `POST /sessao/selecionar-perfil`
```jsonc
// req
{ "perfilId": "aaaa…" }
// 200
{ "data": {
  "perfil": { "id": "aaaa…", "nome": "Fulana 1" },
  "temPin": false,
  "precisaPin": false,          // Fase H liga isto
  "proximoPasso": "selecionar_contexto"
} }
```
- Não retorna `contextToken` / `token` / `pid` (isso é Fase D).
- `perfilId` de outra conta ou inexistente → **404** `{ "error": "Perfil não encontrado." }` (mesma resposta — não vaza existência).
- `perfilId` da conta mas inativo → **403** `{ "error": "Este perfil está desativado." }`.
- `perfilId` ausente/mal formado → **400** (`v.uuid`).

### `GET /sessao/acessos?perfilId=…`
- Mesmo shape de `GET /sessao/acessos` de sempre (`{ data: { superadmin, opcoes: [...] } }`), mas `opcoes` contém **só** as empresas/unidades vinculadas ao perfil.
- `perfilId` inválido/de outra conta/inativo → 400/404/403 **antes** de qualquer query de vínculo.

### Erros (item 16) — padrão do projeto (`ApiError`)
| Cenário | Status | Mensagem |
|---|---|---|
| conta sem perfil ativo | 200 | `[]` |
| perfil inexistente | 404 | `Perfil não encontrado.` |
| perfil de outra conta | 404 | `Perfil não encontrado.` *(idêntico ao acima)* |
| perfil inativo (da conta) | 403 | `Este perfil está desativado.` |
| perfil sem vínculos | 200 | `opcoes: []` |
| `perfilId` mal formado | 400 | `Perfil inválido.` |

Nenhum 500 para caso de negócio. (500 só se `perfis_operacionais` não existir — ver item G.)

---

## D. Validações de segurança

| # | Regra | Onde | Teste |
|---|---|---|---|
| 1 | Conta vem **sempre** de `req.user.id` — nunca do cliente | `sessao.controller.js` (`perfis`, `selecionarPerfil`, `acessos`) | `controllers — a conta vem SEMPRE de req.user.id` (scan de fonte + `doesNotMatch req.(body\|query).(contaId\|…)`) |
| 2 | `perfis_operacionais` só é lido com `conta_id === contaId` | `buscarPerfilDaConta` retorna `null` se `data.conta_id !== contaId`; `buscarPerfisAtivosDaConta` faz `.eq("conta_id", contaId)` | testes 1, 2, 8, D |
| 3 | "não existe" ≡ "de outra conta" (404 idêntico) | `validarPerfilDaConta`: `null → notFound` | teste `8/A) … mesma resposta de 'não existe'` (compara `e.message`) |
| 4 | Perfil inativo bloqueado | `validarPerfilDaConta`: `!ativo → forbidden` | testes `C`, `selecionarPerfil … inativo` |
| 5 | `listarAcessosDoPerfil` valida a posse **antes** de tocar vínculos | `await validarPerfilDaConta(...)` antes de `listarAcessos` | teste `A) … 404 antes de qualquer query de vínculo` (`tocouVinculos === false`) |
| 6 | Isolamento: Fulana 1 nunca enxerga org/unidade/cargo da Fulana 2 | `buscarVinculosDeUmPerfil` faz `.eq("perfil_id", perfilId)` | testes 9–13, B |
| 7 | `superadmin` continua sendo atributo da **conta** | `buscarVinculosDeUmPerfil`: `plataforma_admins.eq("usuario_id", contaId)` | teste `17) superadmin COM vínculo` |
| 8 | Manipulação de `perfilId`/`contaId`/`usuarioId` no body/query nunca troca a conta autenticada | controller usa só `req.user.id`; serviço só usa os params explícitos | testes `18/D`, scan de fonte |
| 9 | `pin_hash` nunca sai | `listarPerfisDaConta`/`selecionarPerfil` só devolvem `temPin: boolean` | teste `19) resposta NUNCA expõe pin_hash` (`Object.keys` exato) |

---

## E. Compatibilidade com legado

### "O backend com a Fase C continua compatível com usuários atuais de um único perfil?"

# **SIM.**

- `GET /sessao/acessos` **sem `?perfilId`** chama `service.listarAcessos({ usuarioId: req.user.id })` — **exatamente a mesma chamada de antes**. Testes de herança existentes (`sessao-heranca-*`) passam inalterados.
- `listarAcessos` continua aceitando `{ usuarioId }`; o caminho `{ contaId, perfilId }` é opt-in e só é alcançado via `listarAcessosDoPerfil`.
- `listarUnidadesContexto` (usado pelo seletor global do topbar) chama `deps.listarAcessos({ usuarioId })` — caminho legado, intocado.
- Os endpoints novos (`/perfis`, `/selecionar-perfil`, `?perfilId`) **não são chamados pelo frontend atual** (a tela "Selecione seu usuário" é da Fase F).
- Conta legada tem 1 perfil (`id == conta.id`, criado pela 060). `validarPerfilDaConta({ contaId: X, perfilId: X })` funciona — teste `6/20`.

### "O backend pode ser deployado antes do frontend da seleção de perfil?"

# **SIM.**

Os endpoints novos ficam **dormentes** (nenhum cliente os chama). O caminho legado de `/sessao/acessos` é bit-a-bit o de hoje.

### Ordem recomendada

```
060 (migration)  →  Fase C (backend)  →  Fase F (frontend "Selecione seu usuário")
```

Fase C é **tecnicamente** deployável antes da 060 (os endpoints novos só dariam 500, e ninguém os chama), mas **não há razão** para isso — a 060 é backward-compatible e deve vir primeiro de qualquer forma.

---

## F. Testes

`backend/test/sessao-perfil.test.js` — **34 testes**, unit (injeção de deps, sem rede):

| Grupo | Cobre itens do pedido |
|---|---|
| `listarPerfisDaConta` (8 testes) | 1, 2, 3, 4, 5, 14, 19, 18/D + `conta_id` inválido |
| `validarPerfilDaConta / obterPerfilDaConta` (6) | 6, 20, 7, 8/A, C, D |
| `selecionarPerfil` (4) | 7, 8/A, C + "não emite token" |
| `listarAcessosDoPerfil — ISOLAMENTO` (10) | 9, 10, 11, 12, 13, 15, 17, sec. A, B, C |
| `controllers — conta vem de req.user.id` (4) | 18 |
| `rotas` (1) | rotas sem `requireContexto` |
| `compat legado` (1) | 20 |

**Regressão:** `sessao-heranca-empresa-unidade`, `sessao-heranca-integracao`, `sessao-unidades-contexto`, `context-token`, `modulos`, `migration-060` → **149 testes, todos passando** com as mudanças em `sessao.service.js`.

**Total: 183/183.**

Cenários de segurança explícitos (item 19) — todos cobertos:
- **A** — Conta A envia `perfilId` da Conta B → **404** (idêntico a "não existe"), e em `listarAcessosDoPerfil` **antes** de tocar vínculos.
- **B** — Conta A, perfil Fulana 1, tenta org da Fulana 2 → a org **não aparece** nas opções da Fulana 1 (não é enumerável nem selecionável).
- **C** — Perfil inativo → **403**, não selecionável.
- **D** — `perfilId`/`contaId`/`usuarioId` no body/query → o serviço só usa os params explícitos e o controller só `req.user.id`; conta autenticada nunca troca.

---

## G. Limitações temporárias

1. **Sem validação de integração real.** A 060 não está aplicada em nenhum ambiente acessível → `perfis_operacionais` e `usuarios_*.perfil_id` não existem em lugar nenhum que eu possa testar. `GET /sessao/perfis` e `?perfilId` respondem **500** enquanto a 060 não estiver aplicada. **Impacto zero para o usuário**: o frontend atual não chama nenhum dos dois.
2. **`selecionarPerfil` não persiste nada** (Fase C por design). O cliente futuro usa o resultado como passo intermediário: `/sessao/selecionar-perfil` → (valida) → `/sessao/selecionar { perfilId, organizacaoId, unidadeId }`. A emissão do Context Token **com `pid`** é da **Fase D**.
3. **`precisaPin` sempre `false`.** PIN é Fase H. Sem risco: a criação de 2º perfil (Fase G) não existe → nenhuma conta tem PIN → nenhuma janela onde "Fulana 1 seleciona Fulana 2 sem confirmação".
4. **`req.perfil` não existe ainda.** Só será populado no `requireContexto` (Fase D), a partir de `sessoes_contexto.perfil_id`. Fase C **não** sobrescreve `req.user.id` com `perfilId` (proibido — item 13).
5. **`GET /sessao/selecionar` ainda não aceita `perfilId`.** Adicionar `perfilId` ao corpo de `/sessao/selecionar` + `criarSessao({ contaId, perfilId })` + `pid` no token é **Fase D** — evitei mexer em `criarSessao`/`selecionarContexto`/Context Token nesta fase.

---

## H. Dependências para a Fase D

| # | O que a Fase D precisa fazer | Por quê |
|---|---|---|
| 1 | `/sessao/selecionar` aceitar `perfilId` no corpo; `selecionarContexto`/`trocarUnidadeDoContexto` propagar; `criarSessao({ contaId, perfilId })` gravar `sessoes_contexto.perfil_id` | fechar o funil Conta → Perfil → Empresa → Unidade |
| 2 | Context Token **v2**: `pid` no payload; `VERSAO` 1→2; `verificarContextToken` mantém `pid` **fora** do check estrutural (impersonação tem `pid=null`) | Fase A.1 §6 |
| 3 | `requireContexto`: cruzar `sessao.perfil_id === token.pid` (igual `cid`/`uid`); validar `perfil.conta_id === req.user.id` + `perfil.ativo`; setar `req.perfil = { id, nome }`; `perfil_id NULL` só se `impersonado_por` setado | Fase A.1 §6 |
| 4 | **CHECK** `sessoes_contexto (perfil_id IS NOT NULL OR impersonado_por IS NOT NULL)` — migration nova (062+), **depois** que o backend novo garante a escrita | Fase B / A.1 §7 item 5 |
| 5 | Revogação por `sessionId` (logout normal) e por `{ perfilId, organizacaoId }` (troca de papel) — **Model Y**, sem auto-revogar sessões irmãs do mesmo perfil | Fase A.1 §4 |
| 6 | `impersonação` (`entrarComoEmpresa`, `trocarUnidadeDoContexto`): `criarSessao` com `perfilId = null`, `impersonadoPor` setado | item 10.C |

### ⚠️ Dependência de SEGURANÇA — `agente_conversas` (item 17)

A migration 060 já adicionou `agente_conversas.perfil_id` (+ índice `idx_agente_conversas_escopo_perfil`). A **query** de isolamento (`agente.conversas.service.js#buscarConversa` / `criarConversa`) ainda filtra por `usuario_id`.

> **ANTES DE LIBERAR O SEGUNDO PERFIL (Fase G), `agente_conversas` DEVE filtrar por `perfil_id`.**

Enquanto a criação de 2º perfil não existir, toda conta tem 1 perfil (`id == usuario_id == perfil_id` para o legado) → a query por `usuario_id` é equivalente à por `perfil_id` → **sem exposição**. Assim que a Fase G puder criar Fulana 2, a Fase E/D **tem** que ter trocado essa query, senão Fulana 1 lê as conversas do Agente da Fulana 2. Registrado aqui e no `comment on column` da 060.

---

## I. Blockers

**Nenhum.**

Decisões tomadas (dentro do já aprovado):

| Ponto | Decisão |
|---|---|
| Onde mora o código de perfil | `backend/src/modules/sessao/perfil.service.js` — co-locado com sessão, sem módulo novo. `listarAcessos` continua em `sessao.service.js` (só ganhou um caminho). Sem ciclo de import (`perfil.service` → `sessao.service`, nunca o contrário). |
| `listarAcessosDoPerfil` passa `deps` para `listarAcessos`? | Só quando não-vazio; senão `undefined`, para `listarAcessos` usar seus próprios defaults (incluindo `buscarVinculosPorPerfil`). |
| 404 vs 403 para "perfil de outra conta" | **404** (`Perfil não encontrado.`), idêntico a "não existe". `403` só para "é seu, mas inativo". Segue o princípio de `selecionarContexto` ("mesma mensagem para não-existe e sem-vínculo"). |
| Persistir "perfil selecionado" na Fase C? | **Não** (item 6). É estado de sessão futura (Fase D), nunca da conta. Nenhum campo `perfil_ativo`/`perfil_atual` em `perfis`/`auth.users`. |
| Tocar `auth.js` / `criarSessao` / Context Token? | **Não** (fora do escopo — Fase D). |
| Coordenação com sessão paralela (Painel Administrativo) | Confirmado: ela usa migration **061** + `auth.js` + `routes.js` (top-level); eu uso 060 + só `modules/sessao/`. Zero colisão. |

---

## J. Veredito

# **FASE C CONCLUÍDA — APTA PARA FASE D**

- `perfil.service.js` + endpoints `/sessao/perfis`, `/sessao/selecionar-perfil`, `/sessao/acessos?perfilId=` implementados.
- Validação de posse (conta → perfil), isolamento por perfil, contrato de PIN preparado, **sem** persistir estado / emitir token.
- **Backward compatible: SIM** — caminho legado de `/sessao/acessos` intocado; endpoints novos dormentes; deployável antes do frontend (e, com ressalva, antes da 060).
- **183/183 testes** (34 novos + 149 de regressão).
- **Nenhum deploy. Nenhuma migration aplicada.**
- Dependência de segurança registrada: **`agente_conversas` tem que filtrar por `perfil_id` antes de a Fase G liberar o 2º perfil.**

**Próximo passo (após aprovação):** Fase D — sessão + Context Token v2 + Model Y de revogação. Abre com a definição de: (a) `pid` obrigatório vs. opcional-atestado-pela-linha, (b) migration 062 da CHECK de impersonação, (c) ordem de deploy (v1→v2 força re-login de todos — aceitável, a 060 já revoga tudo).
