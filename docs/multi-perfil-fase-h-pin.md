# Multi-perfil — Fase H (PIN individual + prova segura de seleção)

**Status:** implementado. **421/421 testes** nas áreas tocadas (52 novos em `pin-selecao-perfil.test.js` + 369 de regressão), 3 skipped pré-existentes. **Nenhum deploy. Nenhuma migration aplicada (060/062/063/064 só em arquivo). Nenhuma escrita em banco de produção.**
**Data:** 2026-09-02
**Escopo:** backend. Sem UI de PIN, sem tela "Selecione seu usuário", sem criação de 2º perfil (tudo Fase F/G). Zero mudança no frontend.

---

## Pré-condição

`backend/.env` aponta para produção; 060/064 não aplicadas em nenhum ambiente acessível. Validação: **testes unitários** (helpers puros + injeção de dependência), **scans de fonte**, **regressão**. Limitações em **P**.

---

## A. A ameaça / o bypass que o PIN resolve

Conta `operacional@email.com` com e-mail+senha **compartilhados** e 2 perfis (Fulana 1, Fulana 2). **Conhecer a credencial da conta NÃO pode bastar para assumir qualquer perfil.**

O ataque que **precisa falhar**:

> Atacante sabe e-mail+senha, sabe que existem Fulana 1 e Fulana 2, **não** sabe o PIN da Fulana 2. Ignora a tela de PIN e chama direto:
> `POST /sessao/selecionar { perfilId: <Fulana 2>, organizacaoId: <Empresa B> }`
> **Resultado obrigatório: NEGADO.** Só após provar conhecimento do PIN da Fulana 2 o backend emite um Context Token com `pid = Fulana 2`.

**Por que um boolean não serve:** `pinValidado: true` no corpo, `localStorage`, estado JS — todos forjáveis pelo cliente. A prova tem de ser **verificável server-side**.

**A solução:** um **Profile Selection Token** — HMAC-assinado por um segredo que só o servidor conhece, curtíssima duração, vinculado a `(conta, perfil)`, de **uso único**. `POST /sessao/selecionar` de conta multi-perfil **exige** essa prova; o `perfilId` do corpo sozinho é ignorado.

---

## B. Algoritmo de hash do PIN

| Item | Decisão |
|---|---|
| Função | **`crypto.scrypt`** (Node core, assíncrono) — KDF memory-hard |
| Por que não bcrypt/argon2 | Não estão instalados. O projeto já usa `crypto.scryptSync` (`shared/cripto.js`, chave de cifra do iFood). scrypt no core = **zero dependência nova em caminho de autenticação**. |
| Por que não SHA/HMAC/base64 | Não são password hashes — brute-force trivial num PIN de 6 dígitos |
| Parâmetros | `N=32768 (2^15)`, `r=8`, `p=1`, `keylen=32` — ~30–60 ms/verificação. **Gravados no próprio hash** (rotação futura sem ambiguidade) |
| Salt | **16 bytes aleatórios por PIN** (`crypto.randomBytes`). Dois perfis com o mesmo PIN → hashes diferentes (ponto 51 — sem UNIQUE de PIN) |
| Formato `pin_hash` | `s1:<N>:<r>:<p>:<keylen>:<saltB64url>:<hashB64url>` |
| Comparação | `crypto.timingSafeEqual` (tempo constante) |
| Hash malformado/nulo | `verificarPin` devolve `false`, **nunca lança** (sem 500 inseguro) |

`shared/pin.js` — `hashPin`, `verificarPin`, `validarFormatoPin`. O PIN em texto puro nunca sai dessas funções.

---

## C. Política de PIN

| Regra | Valor / decisão |
|---|---|
| Formato | 4 a 6 **dígitos** numéricos. Rejeita: vazio, não-string, não-numérico, tamanho fora |
| Sequências fracas (0000, 1234) | **Não** bloqueadas (ponto 13 — pouco ganho, muito atrito; o lockout é a proteção) |
| Onde vive | `perfis_operacionais.pin_hash`. **Nunca** no Supabase Auth, nunca autentica sozinho, não troca e-mail/senha da conta |
| Conta com **1 perfil ativo** | PIN **não** é pedido, mesmo que `pin_hash` exista. Fluxo legado intacto (pontos 7/20/33) |
| Conta com **2+ perfis ativos** | **Todos** precisam de PIN. Se qualquer um estiver sem → `CONFIGURACAO_PIN_INCOMPLETA` (ninguém entra pelo fluxo multi-perfil — ponto 8) |
| Perfis **inativos** | Não contam para a regra de "2+" (ponto 9). Perfil A ativo + B inativo = fluxo de conta única |
| PIN igual entre perfis irmãos | Permitido — salt por perfil; sem constraint global (ponto 51) |

---

## D. Lockout (anti brute-force)

| Item | Valor |
|---|---|
| Limite | **5** tentativas incorretas |
| Bloqueio | **15 min** (`pin_bloqueado_ate`) |
| Contabilização | **Server-side**, por perfil, **atômica** |
| Atomicidade | RPC `perfil_pin_registrar_falha(perfil_id, max, lock_min)` (migration 064) — incremento + bloqueio condicional em **um** statement. Degrada para **compare-and-swap** otimista (`.eq("pin_tentativas", n)`) se a 064 não rodou — sob corrida extrema pode coalescer (só reduz lockouts, nunca deixa passar do limite; o check de bloqueio roda antes) |
| PIN correto | `perfil_pin_registrar_sucesso(perfil_id)` — zera `pin_tentativas`, limpa `pin_bloqueado_ate`, atômico |
| Perfil bloqueado | `429 PIN_TEMPORARIAMENTE_BLOQUEADO`, **sem calcular hash**. Informa "~N min" (genérico, sem vazar) |
| Rate limit HTTP por IP | **Não existe** infraestrutura no projeto (sem `express-rate-limit`). A proteção é o lockout persistente por perfil (ponto 39). Documentado como limitação — **P**. |

---

## E. Profile Selection Token

`shared/profileSelectionToken.js` — espelha `shared/contextToken.js` (mesmo formato, mesma robustez, zero dependência).

```jsonc
{
  "v": 1,                        // independente da versão do Context Token
  "purpose": "profile_selection",// validado — barra token confusion
  "acc": "<conta / req.user.id>",// a prova é inútil para outra conta
  "pid": "<perfil exato>",       // o perfil que passou pelo PIN
  "jti": "<nonce uuid>",         // uso único (sessoes_contexto.selecao_nonce)
  "iat": ..., "exp": ...         // validade: 5 min
}
```

Formato: `base64url(payload) + "." + base64url(HMAC-SHA256)`.

| Propriedade | Como é garantida |
|---|---|
| Impossível de fabricar pelo browser | HMAC-SHA256 com `config.profileSelectionSecret` (server-only) |
| Segredo próprio | `PROFILE_SELECTION_TOKEN_SECRET` **ou** derivado da `SUPABASE_SERVICE_ROLE_KEY` com string de propósito **distinta** (`crescer:profile-selection:v1` ≠ `crescer:context-token:v1`) → chaves independentes mesmo no fallback |
| Não confundível com Context Token | Segredo diferente **E** campo `purpose` **E** `v` próprio. Testado nos dois sentidos (Context Token não verifica como selection e vice-versa) |
| Curta duração | 5 min. Expirou → informa o PIN de novo. **Sem fallback para `perfilId`** |
| Vinculada à conta | `acc` comparado com `req.user.id` em `resolverPerfilParaContexto` |
| Vinculada ao perfil exato | `pid`; se o corpo mandou `perfilId`, exige `perfilId === pid` |
| Rejeitada para outra conta | `acc !== req.user.id` → negado |
| **Uso único** | `jti` gravado em `sessoes_contexto.selecao_nonce` (UNIQUE parcial, migration 064) **no mesmo insert** que cria a sessão. Reusar o token → violação de unicidade → `PROVA_PERFIL_CONSUMIDA`. Degrada pré-064 para "reutilizável dentro de 5 min" (documentado) |
| Não aceito em APIs normais | Só `resolverPerfilParaContexto` (via `POST /sessao/selecionar`) o lê. Não há middleware genérico. |

**Três tokens, três papéis** (nunca misturados):
- **JWT Supabase** → autentica a CONTA.
- **Profile Selection Token** → prova temporária de PIN. Só em `/sessao/selecionar`.
- **Context Token v2** → sessão operacional completa. Emitido **depois** de empresa/unidade escolhidas.

---

## F. Fluxo de seleção

```
1. e-mail + senha  ─────────────────────────────►  JWT (CONTA)         [Supabase Auth]
2. GET  /sessao/perfis                          ►  [{ id, nome, temPin }]   (nunca o hash)
3. POST /sessao/selecionar-perfil { perfilId, pin? }
      conta 1 perfil ......►  { precisaPin:false, profileSelectionToken }   (sem PIN)
      conta 2+ perfis, config incompleta ..►  403 CONFIGURACAO_PIN_INCOMPLETA
      conta 2+ perfis, sem pin no corpo ...►  { precisaPin:true }           (sem prova)
      conta 2+ perfis, pin errado .........►  401 / 429 (lockout)
      conta 2+ perfis, pin correto ........►  { precisaPin:false, profileSelectionToken }
4. POST /sessao/selecionar { organizacaoId, unidadeId, profileSelectionToken?, perfilId? }
      resolverPerfilParaContexto:
        1 perfil ativo   ►  usa o único (compat legado — prova/PIN dispensados)
        2+ perfis ativos ►  EXIGE profileSelectionToken:
                            acc == req.user.id ?  pid é perfil ativo da conta ?
                            perfilId (se veio) == pid ?  →  perfil = pid, nonce = jti
      criarSessao: grava perfil_id + selecao_nonce (uso único)  →  Context Token v2 (pid)
```

`resolverPerfilParaContexto` devolve `{ id, nome, selecaoNonce }`. `selecionarContexto` passa `provaSelecao` para o resolver e `selecaoNonce` para `criarSessao`.

---

## G. Compatibilidade de conta única

* Conta com **1 perfil** (todos os usuários atuais): `resolverPerfilParaContexto` → `ativos.length === 1` → resolve o único, `selecaoNonce = null`, **sem prova, sem PIN**. `POST /sessao/selecionar { organizacaoId, unidadeId }` (o que o frontend faz hoje) continua funcionando idêntico.
* `perfilId` no corpo, para conta de 1 perfil: aceito se for o perfil da conta; senão 404 genérico.
* Pré-060 (sem `perfis_operacionais`): `buscarPerfisAtivosDaConta` lança → tratado como conta = seu próprio perfil.

---

## H. Reset / troca / remoção de PIN

| Operação | Quem | Efeito | Endpoint |
|---|---|---|---|
| **Definir / reset** | SuperAdmin | grava hash, `pin_atualizado_em`, zera tentativas, limpa bloqueio, **revoga todas as sessões do perfil** (não os irmãos) | `PUT /plataforma/usuarios/:id/perfis/:perfilId/pin { pin }` |
| **Remover** | SuperAdmin | `pin_hash = NULL`, zera lockout, revoga sessões do perfil. **Bloqueado** se a conta tem 2+ perfis ativos (`CONFIGURACAO_PIN_INCOMPLETA`) | `DELETE /plataforma/usuarios/:id/perfis/:perfilId/pin` |
| **Troca pelo próprio perfil** | o perfil | exige `pinAtual` (com lockout) + `pinNovo`; revoga sessões do perfil | **service-only** (`trocarPinDoPerfil`) — sem rota/UI (Fase G) |

"Definir pela 1ª vez" e "reset administrativo" são a **mesma** operação. Fase G exigirá PIN em todos os perfis antes de ativar multi-perfil (as primitivas já existem).

Permissão: as rotas ficam sob `requireSuperadmin` (protege o router `/plataforma` inteiro) — **nenhuma permissão nova inventada** (ponto 30). `:id` = a CONTA; `:perfilId` = o PERFIL (hoje `== :id`; N na Fase G).

---

## I. Auditoria

| Ação | `acao` | detalhes (NUNCA o PIN/hash) |
|---|---|---|
| PIN definido/resetado | `perfil.pin_definido` | `{ conta, sessoesRevogadas }` |
| PIN removido | `perfil.pin_removido` | `{ conta, sessoesRevogadas }` |
| Perfil bloqueado por PIN | `perfil.pin_bloqueado` | **reservado** — ainda não emitido (precisa de contexto de request; Fase G quando houver UI) |

`ator_id` = a CONTA administradora; `ator_tipo` = `superadmin`; `perfil_id` = o perfil do administrador quando houver. **Nunca** grava `pin`, `pin_hash`, salt, ou o token completo (scan confirma).

---

## J. Migrations adicionais

**`064_pin_selecao_perfil.sql`** (criada, **NÃO aplicada**) — aditiva, o backend degrada sem ela:

1. `sessoes_contexto.selecao_nonce` (text) + `create unique index ... where selecao_nonce is not null` — uso único da prova.
2. `perfis_operacionais.pin_atualizado_em` (timestamptz) — para o workflow da Fase G + auditoria.
3. RPCs `perfil_pin_registrar_falha` / `perfil_pin_registrar_sucesso` (`security definer`, sem grant para anon/authenticated) — lockout atômico.

**Não altera** 060, a CHECK XOR da 062, nem o Context Token. Ordem: `060 → C/D/E/I/H → 062 → 063 → 064` (064 depende só de 060 + backend H). Rollback documentado no rodapé do arquivo. **Migration 062 (CHECK XOR): re-revisada — o PIN não muda a regra `perfil_id`/`impersonado_por`; continua coerente.**

---

## K. Endpoints

| Método | Rota | Auth | Novo/alterado |
|---|---|---|---|
| POST | `/api/v1/sessao/selecionar-perfil` | JWT + senha definitiva | **alterado** — agora aceita `{ pin }`, valida (multi-perfil), devolve `profileSelectionToken` |
| POST | `/api/v1/sessao/selecionar` | JWT + senha definitiva | **alterado** — aceita `{ profileSelectionToken }`; conta multi-perfil o exige |
| PUT | `/api/v1/plataforma/usuarios/:id/perfis/:perfilId/pin` | SuperAdmin | **novo** — definir/reset PIN |
| DELETE | `/api/v1/plataforma/usuarios/:id/perfis/:perfilId/pin` | SuperAdmin | **novo** — remover PIN |

`GET /sessao/perfis` inalterado — continua devolvendo `temPin: boolean`, nunca o hash.

---

## L. Arquivos alterados

**Novos:**
* `backend/src/shared/pin.js` — hash/verificação scrypt.
* `backend/src/shared/profileSelectionToken.js` — a prova assinada.
* `backend/test/pin-selecao-perfil.test.js` — 52 testes.
* `database/migrations/064_pin_selecao_perfil.sql`.

**Alterados:**
* `backend/src/config/env.js` — `config.profileSelectionSecret` (derivação distinta).
* `backend/src/shared/ApiError.js` — `tooManyRequests` (429); `details` em `forbidden`/`notFound`/`unauthorized`.
* `backend/src/shared/auditoria.js` — `ACOES.PERFIL_PIN_DEFINIDO`/`_REMOVIDO`/`_BLOQUEADO`.
* `backend/src/modules/sessao/perfil.service.js` — `selecionarPerfil` (PIN + emite prova), `validarPinParaSelecao` (lockout), `emitirProvaSelecao`, `definirPinDoPerfil`/`trocarPinDoPerfil`/`removerPinDoPerfil`, `resolverPerfilParaContexto` (exige prova p/ multi-perfil).
* `backend/src/modules/sessao/sessao.service.js` — `selecionarContexto` (`provaSelecao`), `criarSessao` (`selecaoNonce`, uso único).
* `backend/src/modules/sessao/sessao.controller.js` — repassa `pin` / `profileSelectionToken`.
* `backend/src/modules/plataforma/plataforma.usuarios.service.js` + `.controller.js` + `.routes.js` — endpoints de PIN do SuperAdmin.
* `backend/.env.example` — documenta os dois segredos de token.

**Frontend:** nada.

---

## M. Testes (`pin-selecao-perfil.test.js` — 52) + regressão

| Grupo | Cobre (numeração do pedido) |
|---|---|
| Hash scrypt | 1–6, 20 + "não é SHA/HMAC/base64", timingSafeEqual |
| Formato PIN | 13 |
| Selection Token | 26–28, 45 + malformado, duração 5 min, cross-confusion 29/30 |
| `selecionarPerfil` | 19–20, 31–36 (1 perfil sem PIN; 2+ incompleto; 2+ sem pin; 2+ pin certo/errado; outra conta 404) |
| Lockout | 7–13, 15–19, 41–42 (inativo antes do hash; bloqueado sem hash; expira; incremento com tentativas atuais; limite→429; sucesso→reset; atômico) |
| **BYPASS (crítico)** | 21–25 (só perfilId→NEGADO; prova ausente→NEGADO; Fulana1+perfilId Fulana2→NEGADO; prova de Fulana1 resolve Fulana1; pid inexistente→NEGADO; prova de Conta A por Conta B→NEGADO; expirada→NEGADO; config incompleta antes da prova) |
| Uso único + sessão | 37–41, 44 (nonce gravado + reuso rejeitado; reload não pede PIN; PIN não entra no Context Token) |
| Reset admin | 42–47 (hash+zera+limpa+`pin_atualizado_em`; revoga só o perfil; auditoria sem PIN; removerPin bloqueado em multi-perfil) |
| Compat | 31–36, A–D (1 perfil sem prova; pré-060; frontend antigo) |

**Regressão:** 369 testes das áreas de sessão/perfil/agente/plataforma/contexto passam (Fases C/D/E/I). 3 testes da Fase D (`resolverPerfilParaContexto` multi-perfil) **reescritos** — o caminho multi-perfil mudou legitimamente (agora exige prova); a cobertura detalhada migrou para `pin-selecao-perfil.test.js`.

---

## N. Scans de segurança (ponto 62)

| Padrão | Resultado |
|---|---|
| `pin` / `pin_hash` logado | **Nenhum**. `morgan("combined"/"dev")` loga método/URL/status/UA — **não** o corpo. Nenhum `console.log(req.body)`. `errorHandler` só loga `err.message` em 5xx; as mensagens de PIN são genéricas ("PIN incorreto.") |
| `pin_hash` serializado numa resposta | **Nenhum**. `listarPerfisDaConta`/`selecionarPerfil` só devolvem `temPin: boolean`. `pin_hash`/`pin_tentativas`/`pin_bloqueado_ate` só circulam em variáveis internas |
| Selection token completo logado | **Nenhum** — vai só no corpo da resposta/requisição; morgan não loga corpo |
| PIN em query string | **Não** — o PIN vai no corpo de `POST` (ponto 1 de privacidade) |
| Bypass de `/sessao/selecionar` para conta multi-perfil | **Fechado** — `resolverPerfilParaContexto` exige `provaSelecao`; `perfilId` do corpo sozinho → `PROVA_PERFIL_OBRIGATORIA` |
| Segredo hardcoded | **Nenhum** — `config.profileSelectionSecret` do ambiente ou derivado; salt do PIN aleatório |
| `contextToken.js` menciona `pin` | **Não** — o PIN não entra no Context Token |
| `requireContexto` menciona `pin` | **Não** — reload com Context Token válido nunca revalida PIN (ponto 47) |

---

## O. Backward compatibility

| Pergunta | Resposta | Como |
|---|---|---|
| **A.** Conta atual (1 perfil, sem PIN) continua funcionando? | **SIM** | `resolverPerfilParaContexto` → 1 perfil → resolve sem prova nem PIN |
| **B.** Frontend atual continua funcionando? | **SIM** | Zero mudança no frontend. `POST /sessao/selecionar { organizacaoId, unidadeId }` continua válido para conta de 1 perfil |
| **C.** Backend H pode ser deployado antes de G/F? | **SIM** | Nada exige PIN enquanto não existir 2º perfil (Fase G). 064 é aditiva e o backend degrada sem ela |
| **D.** 2º perfil ainda NÃO pode ser criado pela UI/API pública? | **SIM** | Nenhum endpoint de criação de perfil. As rotas de PIN só atuam em perfil existente |

---

## P. Limitações

1. **Sem ambiente 060/064.** O fluxo completo (PIN real gravado, RPC de lockout, UNIQUE do nonce) não foi exercitado contra Postgres — `.env` = produção. Validado por unidade (injeção de dependência) + scan.
2. **Sem rate limit HTTP por IP.** O projeto não tem infraestrutura de rate limiting; a Fase H não a criou (ponto 39). A proteção anti-brute-force é o **lockout persistente por perfil** (5 tentativas / 15 min, server-side). Um atacante distribuído (muitos IPs, muitos perfis) não é contido por IP — mas cada perfil individual trava em 5 tentativas.
3. **Uso único degrada pré-064.** Sem a coluna `selecao_nonce`, a prova é reutilizável durante os 5 min de validade (continua vinculada a conta+perfil+expiração). Documentado; fecha ao aplicar a 064.
4. **CAS de fallback (pré-064) pode coalescer incrementos** sob corrida extrema — só **reduz** lockouts, nunca deixa exceder o limite (o check de bloqueio roda antes de cada verificação).
5. **`perfil.pin_bloqueado` não é auditado ainda** — precisa de contexto de request no caminho de `validarPinParaSelecao`; entra na Fase G junto da UI.
6. **`trocarPinDoPerfil` sem rota** — service pronto e testado, sem endpoint (não há UI de auto-serviço; Fase G).

---

## Q. Blockers

**Para a Fase H:** nenhum.

**Registrado para fases seguintes:**
* **Fase G:** exige PIN em **todos** os perfis antes de ativar multi-perfil — primitivas prontas (`definirPinDoPerfil`, `resolverPerfilParaContexto` já barra config incompleta). `063` antes da Fase G.
* **Fase F:** a tela "Selecione seu usuário" chama `POST /sessao/selecionar-perfil { perfilId, pin }`, guarda o `profileSelectionToken` retornado e o envia em `POST /sessao/selecionar`. O frontend deve tratar `precisaPin`, `CONFIGURACAO_PIN_INCOMPLETA`, `PIN_TEMPORARIAMENTE_BLOQUEADO`, `PROVA_PERFIL_*`.
* **Antes de deploy multi-perfil:** aplicar `060`; depois `062`, `063`, `064` na ordem, em **staging** (ver abaixo).

---

## Staging gate (ponto 64)

Não existe ambiente com schema ≥ 060. **Antes de liberar G/F em produção:**

1. Staging com schema até 059.
2. Aplicar `060` (pré-check → aplicar → pós-check).
3. Deploy do backend **C + D + E + I + H**.
4. Aplicar `062`, depois `063`, depois `064` (pós-checks de cada).
5. Suite de integração completa contra o staging.
6. Teste manual de 2 contas / 2 perfis + PIN: PIN certo/errado, lockout, bypass (chamar `/sessao/selecionar` sem prova → deve negar), prova cruzada Fulana 1↔2, prova de outra conta, uso único.
7. Rollback ensaiado (rodapés das migrations).

**Não executar enquanto o staging não existir.**

---

## R. Veredito

> ## FASE H CONCLUÍDA — APTA PARA A FASE G
>
> O ataque descrito em **A** falha: uma conta multi-perfil só recebe um Context Token com `pid = Fulana 2` **depois** de `POST /sessao/selecionar-perfil` validar o PIN da Fulana 2 e emitir um Profile Selection Token — HMAC-assinado por segredo server-only, 5 min, vinculado a `(conta, perfil)`, uso único. `POST /sessao/selecionar` de conta multi-perfil **exige** essa prova; `perfilId` do corpo sozinho → NEGADO. Prova de Fulana 1 não serve para Fulana 2; prova de outra conta → NEGADO; expirada → NEGADO; sem fallback para `perfilId`.
>
> PIN: scrypt (Node core, zero dependência), salt por perfil, `timingSafeEqual`, nunca em texto puro, nunca serializado, nunca logado. Lockout server-side por perfil (5/15 min), atômico via RPC. Conta de 1 perfil **nunca** pede PIN — frontend atual intacto. Conta multi-perfil exige PIN em **todos** os perfis. Reset administrativo revoga só o perfil, não os irmãos.
>
> 421/421 testes nas áreas tocadas (52 novos). Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção.
>
> **A próxima fase (G — criação do 2º perfil, com PIN obrigatório) é decisão do revisor. Não avancei.**

---

## NÃO FIZ (respeitado)

migration aplicada · produção · deploy · criar 2º perfil · UI de PIN · tela "Selecione seu usuário" · remover `usuario_id` · alterar Supabase Auth · trocar e-mail/senha · alterar a 060 · CHECK XOR da 062 · avançar para G/F/J.
