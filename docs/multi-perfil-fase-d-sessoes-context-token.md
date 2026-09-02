# Multi-perfil — Fase D (sessões + Context Token v2 + Model Y)

**Status:** implementado, **365/365 testes** nas áreas tocadas (36 novos + 329 de regressão). **Nenhum deploy. Nenhuma migration aplicada. Nenhum acesso a banco de produção.**
**Data:** 2026-09-01
**Escopo:** backend + 1 linha no frontend (`logout` scope). Sem tela de seleção de perfil (Fase F), sem PIN funcional (Fase H), sem criação de 2º perfil (Fase G).

---

## Pré-condição

Não há ambiente com schema 060 acessível (`.env` = produção). Implementação + **testes unitários (injeção de dependência) + decisões puras extraídas + scans de fonte**. Limitações de validação em **M**.

---

## A. Arquitetura final da sessão

```
┌── CONTA (auth.users / perfis)  ────────────────────────────────────────┐
│  req.user = { id, email, nome, superadmin, painelAdministrativo, ... } │
│  Supabase Auth: 1 e-mail, 1 senha, JWT + refresh (localStorage).       │
│  requireAuth valida o JWT a cada request → req.user.                   │
└───────────────────────────────────────────────────────────────────────┘
           │  login → GET /sessao/perfis (Fase C) → escolhe perfil
           ▼
┌── PERFIL (perfis_operacionais) ───────────────────────────────────────┐
│  req.perfil = { id, nome } | null  (null = impersonação)              │
│  req.acesso.perfilId = perfil_id | null                              │
│  resolverPerfilParaContexto: ausente+1 perfil→auto; ausente+2→400;   │
│  informado→valida posse+ativo.                                        │
└──────────────────────────────────────────────────────────────────────┘
           │  POST /sessao/selecionar { perfilId?, organizacaoId, unidadeId }
           │  → vínculos escopados por perfil_id → papel/permissões/módulos
           ▼
┌── SESSÃO (sessoes_contexto) ─────────────────────────────────────────┐
│  1 linha = 1 device/aba.  id = sid.  perfil_id set (ou null se imp.). │
│  MODEL Y: N linhas vivas por conta E por perfil. Nenhuma auto-revoga. │
│  Context Token v2: { v:2, sub, sid, cid, uid, pid, role, perms, imp } │
│  sessionStorage (por aba). requireContexto relê a linha a cada req.   │
└─────────────────────────────────────────────────────────────────────┘

Refresh do JWT (Supabase)  →  NÃO toca a sessão de contexto  →  perfil preservado.
```

**Isolamento garantido:**
- Fulana 1 e Fulana 2 (mesma conta) — sessões independentes, vínculos/permissões por `perfil_id`.
- Fulana 1 em 2 computadores — 2 linhas `sessoes_contexto`, nenhuma revoga a outra.
- Logout de uma = revoga só aquele `sid`. As irmãs seguem.
- Token com `pid` forjado (outro perfil da conta) → 409 (o `sid`/linha é a autoridade).

---

## B. Payload Context Token v2

```jsonc
{
  "v":   2,              // era 1. v1 -> "desatualizado" -> 409
  "sub": "<conta>",      // auth.users.id
  "sid": "<sessoes_contexto.id>",   // AUTORIDADE FINAL
  "cid": "<organizacao_id>",
  "uid": "<unidade_id> | null",
  "pid": "<perfil_id> | null",      // NOVO. null SÓ em impersonação
  "role":"<papel_acesso>",
  "perms":["..."],
  "imp": "<superadmin_id> | null",
  "iat": <epoch>, "exp": <epoch>    // 8h normal, 1h impersonação
}
```

`emitirContextToken({ ..., perfilId })` grava `pid`. `verificarContextToken`: check estrutural continua exigindo só `sub`/`sid`/`cid` — **`pid` fica fora** porque `null` é legítimo (impersonação). Arquivo: `backend/src/shared/contextToken.js`.

---

## C. Regras do `pid` — `validarPidContraSessao` (pura, `contextToken.js`)

Chamada por `requireContexto` depois de achar a linha pelo `sid`. Três checagens, nesta ordem:

| # | Regra | Falha → |
|---|---|---|
| 1 | **Cruzamento** (igual `cid`/`uid`): `token.pid` === `sessoes_contexto.perfil_id`, incluindo `null == null` | 409 "Contexto divergente" |
| 2 | **Invariante**: `perfil_id` NULL só se `impersonado_por` setado | 409 "Contexto inválido" |
| 3 | **Perfil ativo**: sessão normal exige `perfis_operacionais.ativo = true` (relido — não é snapshot) | 409 "Perfil desativado" |

| Caso | linha `perfil_id` | linha `impersonado_por` | `token.pid` | resultado |
|---|---|---|---|---|
| Perfil normal | `<uuid>` | null | `= perfil_id` | ✅ modo `normal` |
| Superadmin **com vínculo** (login normal) | `<uuid>` do perfil 1:1 | null | `= perfil_id` | ✅ `normal` (perfil obrigatório — item 26) |
| Painel SuperAdmin puro | — (sem Context Token) | — | — | não passa por `requireContexto` |
| Impersonação | **null** | `<uuid>` | **null** | ✅ modo `impersonacao`, `req.perfil = null` |
| Token forjado `pid` de outro perfil | `<Fulana1>` | null | `<Fulana2>` | ❌ 409 (cruzamento) |
| Token normal com `pid` null | `<uuid>` | null | null | ❌ 409 (cruzamento) |
| Token com `pid` fingindo impersonação | null | `<uuid>` | `<uuid>` | ❌ 409 (cruzamento) |

---

## D. Model Y

**`criarSessao` NÃO revoga mais nada** (era `revogarSessoes({ usuarioId })`). A única revogação que faz é `{ sessionId: revogarSessionId }` — a sessão da **própria aba** numa troca de unidade/empresa, e **depois** de criar a nova (falha aqui não deixa a aba sem sessão).

| Cenário | Comportamento | Teste |
|---|---|---|
| 1. Fulana 1 sessão A, cria sessão B (mesmo perfil) | A **continua válida** | scan `criarSessao` sem `revogarSessoes({usuarioId/contaId/perfilId})` |
| 2. Fulana 1 sessão A + Fulana 2 sessão B | criar B **não afeta** A | idem — nenhuma revogação cruza perfil/conta |
| 3. Logout sessão A | revoga só `sid` de A → B intacta | `encerrarContexto` → `{ sessionId: acesso.sessionId }` |
| 4. Logout sessão B | idem, A intacta | idem |
| 5. Troca de unidade na sessão A | A antiga revogada (`revogarSessionId`), A2 nova, B intacta | `trocarUnidade` → `sessionIdAtual` → `selecionarContexto({ revogarSessionId })` |
| 6. Mesmo perfil, 2 devices | ambos válidos | Model Y — sem UNIQUE, sem auto-revoke |
| 7. 3 sessões do mesmo perfil | coexistem | idem |

"Usuários online" (`plataforma.usuarios.service.js#listarUsuarios`) conta `sessoes_contexto` por `usuario_id` — **inalterado nesta fase** (funciona, só não distingue perfil). Distinção por perfil = melhoria de painel, fora do escopo D (item 30).

---

## E. Tabela de escopos de revogação (`revogarSessoes`, item 10 + 44)

`revogarSessoes` agora **LANÇA** se chamada sem nenhum escopo (nunca "revoga tudo por engano"). `contaId` e `usuarioId` são o **mesmo** escopo (coluna `usuario_id` = a conta) — os dois nomes aceitos.

| Arquivo:linha | Chamada | Escopo | Afeta sessão | Afeta perfil | Afeta conta | Model Y OK? |
|---|---|---|---|---|---|---|
| `sessao.service.js` `criarSessao` | `{ sessionId: revogarSessionId }` | 1 sessão | esta aba | — | — | ✅ (só a substituída) |
| `sessao.service.js` `encerrarContexto` | `{ sessionId: acesso.sessionId }` **(era `{usuarioId}`)** | 1 sessão | esta | — | — | ✅ **corrigido** |
| `usuarios/usuarios.service.js:221` `atualizarUsuario` | `{ usuarioId, organizacaoId }` | conta ∩ org | todas da conta naquela org | (todos os perfis) | parcial | ✅ (amplo mas correto p/ mudança de acesso; Fase E → `perfilId`) |
| `usuarios/usuarios.service.js:273` `excluirUsuario` | `{ usuarioId, organizacaoId }` | idem | idem | | | ✅ idem |
| `plataforma.usuarios.service.js` `atualizarUsuario` (desativar conta) | `{ usuarioId }` | conta inteira | todas | todos | sim | ✅ (é "bloquear a conta") |
| `plataforma.usuarios.service.js` `redefinirSenha` | `{ usuarioId }` | conta inteira | todas | todos | sim | ✅ (credencial trocada) |
| `plataforma.usuarios.service.js` `forcarLogout` | `{ usuarioId }` + `encerrarSessoesAuth` (Auth global) | conta inteira + Auth | todas | todos | sim | ✅ (é "derrubar a conta"). Variante `forcarLogoutPerfil` = futuro (item 29) |
| `plataforma.usuarios.service.js` `atualizarVinculo` | `{ usuarioId, organizacaoId }` | conta ∩ org | | | | ✅ (Fase E → `{ perfilId, organizacaoId }`) |
| `plataforma.usuarios.service.js` `removerVinculo` | `{ usuarioId, organizacaoId }` | idem | | | | ✅ idem |
| `plataforma.usuarios.service.js` `atualizarVinculoUnidade` | `{ usuarioId, unidadeId }` | conta ∩ unidade | | | | ✅ (Fase E → `{ perfilId, unidadeId }`) |
| `plataforma.usuarios.service.js` `definirSuperadmin` (revogar) | `{ usuarioId }` | conta inteira | | | sim | ✅ |
| `plataforma.unidades.service.js` ×3 | `{ unidadeId }` | unidade inteira | todas naquela unidade | todos os perfis | — | ✅ (bloqueio/mudança da unidade) |
| `plataforma.empresas.service.js` ×2 | `{ organizacaoId }` | empresa inteira | todas naquela empresa | todos | — | ✅ (status/módulos da empresa) |

**Escopos que a Fase D deixou explícitos e disponíveis, ainda não usados:** `{ perfilId }` (derrubar 1 perfil em todos os devices), `{ perfilId, organizacaoId }` (mudança de cargo do perfil — Fase E os adota).

---

## F. Logout do Supabase (item 23 — opção A, implementada agora)

`frontend/src/sessao.js#logout()` — **1 linha**: `sb.auth.signOut()` → `sb.auth.signOut({ scope: "local" })`.

- Default do supabase-js (`@2.109`, confirmado no código instalado — Fase A.1 §1) é `"global"`: revoga os refresh tokens da conta em **todos os dispositivos**.
- `"local"` revoga só a `auth.session` daquele device (o GoTrue emite uma por `signInWithPassword`).
- Sem isso: Fulana 1 clicando "Sair" → Fulana 2 cai no outro computador no próximo request.

**"Sair de todos os dispositivos"** = ação SEPARADA (item 24). Não implementada; NÃO reusa `logout()`. Quando existir: `signOut({ scope: "global" })` + `revogarSessoes({ contaId })` no backend.

Scan de fonte no teste garante: nenhum `auth.signOut()` sem escopo em `sessao.js`.

---

## G. Impersonação (itens 25, 26, 28, 29)

| Fluxo | Fase D |
|---|---|
| `entrarComoEmpresa` | `criarSessao({ contaId: req.user.id, perfilId: null, impersonadoPor: req.user.id, ... })`. `criarSessao` **exige** `perfilId` XOR `impersonadoPor` — impersonação passa por ter `impersonadoPor`. Sessão nasce com `perfil_id = null`. |
| `trocarUnidadeDoContexto` (impersonação) | `criarSessao({ perfilId: null, impersonadoPor: usuario.id, revogarSessionId: sessionIdAtual })`. Model Y: só a sessão de suporte atual é substituída. |
| `requireContexto` | `sessao.perfil_id` null + `impersonado_por` set → `validarPidContraSessao` → `modo: "impersonacao"`, `req.perfil = null`, `req.acesso.impersonando = true`. O bypass de `requireModulo`/`requirePermissao` (já existente) continua. |
| **Superadmin COM vínculo** (login normal na própria empresa) | **perfil obrigatório** — cai no `resolverPerfilParaContexto` como qualquer conta. `criarSessao` recusaria `perfilId` null sem `impersonadoPor`. Não é tratado como impersonação. |
| Token normal fingindo impersonação (`pid` null, sem `impersonado_por` na linha) | 409 (invariante #2). |

`criarSessao` não revoga sessões irmãs em impersonação também (item 8) — um superadmin pode dar suporte a 2 empresas em 2 abas.

---

## H. Backward compatibility

### "O backend com a Fase D continua compatível com usuários de 1 perfil?" — **SIM**

- `POST /sessao/selecionar` **sem `perfilId`** (frontend antigo) → `resolverPerfilParaContexto` acha o único perfil ativo da conta (backfill 060: `id == conta.id`) e segue. Fluxo idêntico ao de hoje.
- Vínculos escopados por `perfil_id`, mas `perfil_id == usuario_id` para contas legadas (backfill 060) → mesmos resultados.
- Conversas do Agente: `perfil_id == usuario_id` legado → nenhuma conversa perdida.
- `GET /sessao/acessos` sem `?perfilId` → caminho legado intocado (Fase C).

### "O backend pode ser deployado antes do frontend da seleção de perfil?" — **SIM**

A tela "Selecione seu usuário" é Fase F. O frontend atual não manda `perfilId` → auto-resolve. **Enquanto nenhuma conta tem 2+ perfis (só Fase G cria)**, o caminho "2+ perfis → 400" nunca dispara.

### Matriz de deploy (item 32)

| Cenário | Funciona? |
|---|---|
| **A.** 060 + backend antigo | ✅ (aprovado na Fase B) |
| **B.** 060 + backend Fase C+D + **frontend antigo** + contas de 1 perfil | ✅ — auto-resolve do perfil; Model Y transparente; `logout` local |
| **C.** backend Fase D + frontend antigo + conta com **2+ perfis** | ⚠️ `/sessao/selecionar` sem `perfilId` → **400 "Selecione o perfil"**. **Cenário não liberado** (Fase G ainda não cria 2º perfil). Esperado. |
| **D.** backend Fase D + frontend Fase F | ✅ preparado (contrato `perfil`/`perfilId` já existe nas respostas) |

### ⚠️ Fase D **exige** a 060 aplicada

`selecionarContexto`/`requireContexto` consultam `perfis_operacionais` e `usuarios_*.perfil_id`. Sem a 060 → **login quebra**. Ordem obrigatória: **060 → Fase C+D → Fase F**.

**Janela de transição 060→Fase D:** o backend antigo (pós-060) cria `sessoes_contexto` com `perfil_id = NULL`. Quando a Fase D deploya, `requireContexto` recusa essas sessões (invariante #2) → **1 re-seleção de contexto** por usuário (mesma UX da própria 060, que já revoga tudo). Minimizar a janela entre aplicar 060 e deployar a Fase D.

---

## I. Agente Conversas (item 17, 33 — feito AGORA)

`agente_conversas` passa a isolar por **`perfil_id`** (era `usuario_id`/conta). Sem isto, Fulana 1 e Fulana 2 (mesma conta) leriam as conversas uma da outra assim que a Fase G liberasse o 2º perfil.

| Arquivo | Mudança |
|---|---|
| `agente.conversas.service.js` | `buscarConversa`/`criarConversa`: `usuarioId` → `perfilId` (filtro/insert em `perfil_id`); `contaId` mantido no insert (`usuario_id`, transição). Degrada para `usuario_id` se `perfil_id` ausente (pré-060 / cache de schema). |
| `agente.service.js` | `processarMensagem`/`obterHistoricoConversa` recebem `perfil`; chave de isolamento = `perfil?.id ?? usuario?.id` (impersonação → o próprio superadmin, mantém superadmins isolados entre si). |
| `agente.controller.js` | passa `perfil: req.perfil`. |
| `agente.uso.service.js` | **inalterado** — `usuario_id` (conta) é o certo p/ métrica de custo (Categoria C da Fase A.1). |

Testes: `agente-service.test.js` (fake atualizado p/ `perfilId`), `agente-conversas-isolamento.test.js` (integração — `perfilId`, gated por 060).

**Dependência ainda aberta:** `agente_uso` e as ~28 colunas Cat. B/C de domínio (Fase I).

---

## J. Auditoria (item 34 — feito AGORA)

`shared/auditoria.js`:
- `contextoDaRequisicao(req)` → `perfilId: req.perfil?.id ?? req.acesso?.perfilId ?? null`.
- `auditar()` → grava `perfil_id`. **Degrada** (retry sem a coluna) se `plataforma_auditoria.perfil_id` não existe (pré-060) — mesmo padrão de `agente.conversas`.
- `auditar` calls de sessão (`selecionarContexto`, `encerrarContexto`, `entrarComoEmpresa`, `agente.service`) passam `perfilId` explícito.

Impersonação → `perfil_id = null`, `ator_id = superadmin`, `impersonado_por` como hoje. **Sem backfill histórico** (tabela append-only — Fase B).

As ~28 `auditar()` de domínio (fora de sessão) pegam `perfil_id` automaticamente via `contextoDaRequisicao(req)` quando usam `auditarReq(req, ...)`; as que passam campos manualmente → Fase I.

---

## K. Arquivos alterados

### Backend
| Arquivo | Mudança |
|---|---|
| `shared/contextToken.js` | `VERSAO` 1→2; `pid` no payload + `emitirContextToken({ perfilId })`; **novo** `validarPidContraSessao` (pura). |
| `middlewares/auth.js` | `requireContexto`: select `perfil_id`; busca `perfis_operacionais` (paralelo à empresa); `validarPidContraSessao`; `req.perfil = { id, nome }|null`; `req.acesso.perfilId`. Typedef `AcessoContexto` += `perfilId`. **`requireAuth` intocado** (bloco do peer preservado). |
| `modules/sessao/sessao.service.js` | `criarSessao`: `contaId`/`perfilId`/`revogarSessionId`, **remove auto-revoke**, invariante XOR. `revogarSessoes`: escopos `sessionId`/`perfilId`/`contaId`(+alias `usuarioId`), **guard "sem escopo → lança"**. `selecionarContexto`: `perfilId` + `resolverPerfilParaContexto` + vínculos por `perfil.id` + `acessoEfetivoDaUnidade({ perfilId })` + retorna `perfil`. `trocarUnidadeDoContexto`: `perfilId` + `sessionIdAtual`. `encerrarContexto`: `{ sessionId }`. `acessoEfetivoDaUnidade`/`buscarVinculoDiretoDaUnidade`: `usuarioId` → `perfilId`. `contextoAtual` += `perfil`. |
| `modules/sessao/perfil.service.js` | **novo** `resolverPerfilParaContexto` (deps-injetável); `buscarPerfisAtivosDaConta` exportado. |
| `modules/sessao/sessao.controller.js` | `selecionar` passa `perfilId: body.perfilId`; `trocarUnidade` passa `perfilId: req.acesso.perfilId` + `sessionIdAtual: req.acesso.sessionId`. (peer adicionou `painelAdministrativo` no `acessos` — coexiste.) |
| `modules/plataforma/plataforma.empresas.service.js` | `entrarComoEmpresa`: `criarSessao({ contaId, perfilId: null })` explícito; `auditar({ perfilId: null })`. |
| `shared/auditoria.js` | `perfilId` no typedef/`contextoDaRequisicao`/`auditar` (com degrade). Peer's `ACOES.PAINEL_ADM_*` preservados. |
| `modules/agente/{agente.conversas.service.js, agente.service.js, agente.controller.js}` | isolamento de conversa por `perfil_id`. |

### Frontend
| Arquivo | Mudança |
|---|---|
| `src/sessao.js` | `logout()` → `signOut({ scope: "local" })` (1 linha). **Nada mais.** |

### DB
| Arquivo | Mudança |
|---|---|
| `database/migrations/062_sessoes_contexto_perfil_check.sql` | **NOVO — NÃO aplicar.** CHECK XOR `perfil_id`×`impersonado_por`. Aplicar só após 060 + Fase D deployados + pré-check zerado. |

### Testes
`backend/test/sessao-model-y.test.js` (**novo**, 36 testes) + ajustes em `agente-service.test.js`, `agente-conversas-isolamento.test.js`, `sessao-heranca-empresa-unidade.test.js`.

---

## L. Testes

**365/365** nas áreas tocadas (`context-token`, `sessao-model-y`, `sessao-perfil`, `sessao-heranca-*`, `sessao-unidades-contexto`, `migration-060`, `modulos`, `agente-service`, `agente-tools`, `agente-pageContext`, `inteligencia-catalogo`).

| Grupo (`sessao-model-y.test.js`) | Cenários do pedido |
|---|---|
| Context Token v2 | 8, 11, 13 + pid fora do check estrutural |
| `validarPidContraSessao` | **8, 9, 10, 10b, 11, 12, 18** + perfil-não-encontrado |
| `resolverPerfilParaContexto` | **16, 17, 22, 23, 24, 24b, 25** |
| `criarSessao` invariantes | sessão normal sem perfil / impersonação com perfil / sem conta |
| `revogarSessoes` guard | "nunca revoga tudo" + escopos |
| Model Y scans | **1-7**, 44 (criarSessao sem auto-revoke, encerrarContexto por sessionId, selecionarContexto escopa por perfil, trocarUnidade por sessionIdAtual) |
| `requireContexto` scan | pid + `req.perfil` + não sobrescreve `req.user.id` (item 13) |
| logout frontend | **43** (scope local) |
| impersonação scan | 26-29 (`entrarComoEmpresa` perfilId null) |

**Cobertura de regressão:** herança empresa→unidade, context-token pré-existentes, isolamento de conversa do Agente, herança de módulos — todos passando.

**Suite completa:** 1275 testes, 52 falhas — **as mesmas 52 de antes** (integração DB-gated + trabalho paralelo de iFood/painel administrativo). **Zero** falha nova de sessão/perfil/token/auditoria/agente.

---

## M. Limitações

1. **Sem validação de integração real** — 060 não aplicada em lugar acessível. Não exercitado contra Postgres: o embed/select de `perfis_operacionais` em `requireContexto`, o `.eq("perfil_id", ...)` nos vínculos, a CHECK 062. Cobertos por decisão pura + scan; a prova SQL vem num ambiente 060 ou na Fase F.
2. **`req.perfil` name** vem da linha `perfis_operacionais` (não do token) — bom; mas em impersonação `req.perfil = null` (por design).
3. **`agente_uso.usuario_id`** e as ~28 colunas Cat. B/C de domínio — ainda conta. Fase I.
4. **"Usuários online" / painel de sessões** conta por `usuario_id` (conta) — não distingue perfil. Melhoria de painel, fora do escopo D (item 30).
5. **CHECK 062 não aplicada** — a invariante XOR é garantida só pela aplicação (`criarSessao`) até a 062 rodar (pós-Fase-D-deploy).
6. **`forcarLogoutPerfil`** (derrubar 1 perfil, não a conta) — só documentado; implementação na Fase E/G junto do CRUD de perfis.
7. **Janela 060→Fase D**: sessões criadas pelo backend antigo pós-060 (`perfil_id` NULL) → 409 na Fase D → 1 re-seleção. Minimizar a janela.

---

## N. Blockers

**Nenhum.**

Decisões (dentro do já aprovado):

| Ponto | Decisão |
|---|---|
| `revogarSessoes` — renomear `usuarioId`? | **Não** — mantido como alias de `contaId` (mesma coluna). Evita mexer nos ~12 callers admin (e na colisão com a Fase C do peer em `plataforma.usuarios.service.js`). Model Y correto: essas ações admin SÃO amplas de propósito. |
| CHECK XOR na 062: `OR` ou `XOR`? | **XOR** — auditado: nenhum fluxo da Fase D produz os dois setados (`criarSessao` lança). Migration desenhada, não aplicada. |
| Agente conversas isolamento — agora ou Fase I? | **Agora** — é segurança (item 33), escopo contido (3 arquivos), e não pode ficar para depois da Fase G. |
| Auditoria `perfil_id` — agora? | **Agora** — mudança localizada em `auditoria.js` (item 34), com degrade para pré-060. |
| Fallback do isolamento de conversa em impersonação | `perfil?.id ?? usuario?.id` → superadmin fica isolado dele mesmo (melhor que "balde null" compartilhado). |
| Circular import `sessao.service ⇄ perfil.service` | Estático nos dois sentidos; funções só usadas em runtime → Node ESM resolve. Testado o load. |

---

## O. Veredito

# **FASE D CONCLUÍDA — APTA PARA FASE E**

**Critério de aprovação (item 48) — provado (unit/decisão pura/scan; integração real pendente de ambiente 060):**

| Requisito | Como | Onde |
|---|---|---|
| Fulana 1 + Fulana 2, mesma conta, simultâneas | `criarSessao` sem auto-revoke; vínculos/permissões por `perfil_id` | Model Y scans; `selecionarContexto` scan |
| Fulana 1 em 2 computadores | Model Y — N linhas vivas por perfil, sem UNIQUE, sem revoke | `criarSessao` scan; migration 060 (sem UNIQUE) |
| Logout de uma sessão ≠ derruba as outras | `encerrarContexto` → `{ sessionId }`; `logout()` → `signOut({ scope: "local" })` | testes `encerrarContexto`/`logout` |
| `pid` não forjável | cruzamento contra a linha `sessoes_contexto` (igual `cid`/`uid`) | `validarPidContraSessao` cenário 9/12 |
| Perfil inativo perde acesso | `validarPidContraSessao` checa `perfis_operacionais.ativo` a cada request | cenário 18 |
| Impersonação continua segura | `perfil_id`/`pid` null atestados por `impersonado_por`; token normal com `pid` null → 409 | cenários 10b/11/12/29 |
| Conta de 1 perfil + frontend antigo | `resolverPerfilParaContexto` auto-resolve | cenário 22 |

**Próximo passo (após aprovação):** Fase E — permissões e organizações por perfil (CRUD de vínculo `usuarios_*.perfil_id`, `NOT NULL` + `UNIQUE(perfil_id, org)` via migration, narrow das revogações admin para `{ perfilId, organizacaoId }`). **Ainda sem** Fase F/G/H.
