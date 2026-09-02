# Multi-perfil — Fase F (tela "Selecione seu usuário" + PIN + fluxo de login)

**Status:** implementado. Frontend: **215/215 testes** (22 novos em `selecaoPerfil.test.js`). Backend (contrato, pontos 45/46): **373/373** nas áreas tocadas, 3 skipped pré-existentes. Verificado no navegador (login → tela de perfil → painel de PIN → voltar). **Nenhum deploy. Nenhuma migration aplicada. Nenhuma escrita em banco de produção.**
**Data:** 2026-09-02
**Escopo:** frontend (novo módulo `selecaoPerfil.js`, tela `#selecao-perfil-screen`, wiring em `app.js`/`sessao.js`, 3 blocos CSS). Backend: 1 ajuste de contrato (`chamar` carrega `codigo`/`status`/`details` no erro). Sem redesenho.

---

## A. Fluxo final

```
e-mail + senha da CONTA  ──►  signInWithPassword  ──►  carregarIdentidade() (/me)
        │
        ▼
  precisaDefinirSenha()?  ──sim──►  tela "Definir senha" (pertence à CONTA — vem ANTES)
        │ não
        ▼
  restaurarContexto()  ──Context Token válido──►  mostrarApp()   [NUNCA pede perfil/PIN]
        │ sem contexto
        ▼
  GET /sessao/perfis   ──erro/pré-060──►  perfis = null  ──►  FLUXO LEGADO (idêntico ao de hoje)
        │
        ├─ 0 perfis ativos  ──►  tela "Selecione seu usuário" → estado "Nenhum usuário disponível"
        ├─ 1 perfil ativo   ──►  FLUXO AUTOMÁTICO (sem tela, sem PIN)  →  listarAcessos()  → rotaPosAcessos
        └─ 2+ perfis ativos ──►  TELA "SELECIONE SEU USUÁRIO"
                                   │  escolhe Fulana 1 / Fulana 2
                                   ▼
                                 painel de PIN  ──►  POST /sessao/selecionar-perfil { perfilId, pin }
                                   │  PIN correto → Profile Selection Token (memória)
                                   ▼
                                 GET /sessao/acessos?perfilId=<perfil>   (só os acessos DAQUELE perfil)
                                   │
                                   ├─ 1 acesso   ──►  auto-seleciona
                                   └─ N acessos  ──►  seletor de empresa/unidade ATUAL (montarSelecao)
                                   ▼
                                 POST /sessao/selecionar { organizacaoId, unidadeId, profileSelectionToken }
                                   │  → Context Token v2 (pid); prova consumida (uso único)
                                   ▼
                                 mostrarApp()
```

**Conta → Perfil → Empresa → Unidade** — três camadas distintas, nunca misturadas.

---

## B. Telas

| Tela | id | Quando |
|---|---|---|
| Login | `#login-screen` | inalterada |
| Definir senha | `#senha-screen` | senha provisória — **antes** da seleção de perfil (pertence à CONTA) |
| **Selecione seu usuário** *(nova)* | `#selecao-perfil-screen` | conta com **2+ perfis ativos** (ou 0, para o estado tratado) |
| Selecione um ambiente | `#selecao-screen` | inalterada — recebe só os acessos do perfil escolhido |
| App | `#app` | inalterada |

**`#selecao-perfil-screen`:** lista de cards (nome do perfil — **nunca PIN/hash/id técnico**), painel de PIN embutido (aparece ao escolher um perfil), aviso de config incompleta, botão Sair. Responsiva (`sel-screen`/`sel-wrap--estreito`, cards em 1 coluna). Acessível: cards são `<button>` (clique + teclado, `:focus-visible`), input de PIN tem `<label>`, erros visíveis.

---

## C. Estado (`state.sessao`)

| Campo | Papel | Persistência |
|---|---|---|
| `usuario` | a CONTA (`/me`) | — |
| `perfil` | a PESSOA do contexto atual (`{ id, nome }`; null em impersonação) | — |
| `perfisDisponiveis` | perfis ativos da conta durante o fluxo de seleção | **memória** |
| `profileSelectionToken` | a prova de PIN | **memória** — nunca localStorage/sessionStorage/URL |
| `empresa/unidade/papel/permissoes/modulos` | o CONTEXTO | Context Token no `sessionStorage` (opaco) |

`limparContexto()` zera `perfil` + `profileSelectionToken`. `logout()` zera tudo (`perfil`, `perfisDisponiveis`, `profileSelectionToken`).

---

## D. PIN (frontend)

- Campo `type="text"` `inputmode="numeric"` `maxlength="6"` — **tratado como STRING** (`"0123"` continua `"0123"`; zeros à esquerda preservados).
- Validação de formato no cliente (`/^\d{4,6}$/`) antes de enviar; a validação real é do backend.
- **Nunca persistido:** o PIN só vive no `<input>`; `limparPin()` zera o campo no "Voltar", no sucesso e ao fechar o painel.
- **Voltar** (`onVoltar`): `limparPerfilPendente()` — descarta a prova e o perfil pendente — e reabre a lista.
- **Estados de erro tratados:** `PIN inválido.` (genérico — não revela tentativas restantes), `PIN_TEMPORARIAMENTE_BLOQUEADO` → "Muitas tentativas…" (com o tempo genérico que o backend mandar), `CONFIGURACAO_PIN_INCOMPLETA` → "Esta conta precisa ter os PINs configurados pelo administrador" + cards desabilitados, perfil desativado no meio do fluxo (403/404) → recarrega a lista de perfis.

---

## E. Profile Selection Token

- Recebido de `POST /sessao/selecionar-perfil` → `state.sessao.profileSelectionToken` (memória).
- `selecionarContexto()` o envia em `POST /sessao/selecionar` **quando existe** (`{ ...(prova ? { profileSelectionToken: prova } : {}) }`). Conta de 1 perfil não tem token → o backend resolve o perfil sozinho.
- **Uso único:** logo após `aplicarContexto()`, `selecionarContexto` faz `state.sessao.profileSelectionToken = null` — a prova foi consumida na criação do Context Token.
- **Expirou / consumida** (backend responde `PROVA_PERFIL_*` / `perfilObrigatorio`): `entrarNoContexto` detecta o código, faz `limparPerfilPendente()` e volta para `encaminhar()` → a tela de PIN reaparece. **Sem fallback para `perfilId` puro.**

---

## F. Empresa / unidade

- `listarAcessos(perfilId)` → `GET /sessao/acessos?perfilId=…` — só os acessos daquele perfil (nunca da conta inteira no fluxo multi-perfil).
- 1 acesso → `rotaPosAcessos` → `auto-tenant` → `selecionarContexto` automático.
- N acessos → `mostrarSelecao(dados)` — o **mesmo** seletor de ambiente de sempre (`montarSelecao`), só que alimentado com os acessos do perfil.
- Empresa com várias unidades → seletor de unidade atual, inalterado (`mostrarApp` já entra direto quando há 1 unidade).
- Troca de empresa/unidade pelo topbar (`trocarUnidadeRapido` / `trocarUnidadeDoContexto`) **mantém o perfil** — não repassa por PIN (o Context Token já é a autoridade).

---

## G. Restore (reload)

`encaminhar()` chama `restaurarContexto()` **antes** de qualquer coisa de perfil. Context Token válido → `mostrarApp()` restaura conta + perfil + empresa + unidade + papel + permissões + módulos (de `GET /sessao/atual`, que já devolve `perfil`). **Nunca** mostra seleção de perfil nem PIN num reload com contexto vivo.

---

## H. Logout / contexto inválido

| Evento | Ação |
|---|---|
| Logout normal | `POST /sessao/encerrar` (revoga o `sessionId`) → `limparContexto()` → `signOut({ scope: "local" })` → zera `perfil`/`perfisDisponiveis`/`profileSelectionToken`. **Não** derruba outro device/perfil. |
| `app:sessao-expirada` (401) | `logout()` + `mostrarLogin()` |
| `app:contexto-invalido` (409) | `limparContexto()` (já feito por `chamar`) + `encaminhar()` → resolve o perfil de novo (mostra "Selecione seu usuário" se a conta é multi). **Nunca** logout global. |

---

## I. SuperAdmin / impersonação

- **SuperAdmin puro** (backfill = 1 perfil): `perfis.length === 1` → fluxo automático, sem PIN. `listarAcessos(perfilId)` → 0 opções + `superadmin: true` → `rotaPosAcessos` → painel SuperAdmin. Inalterado.
- **SuperAdmin com vínculo:** tem perfil → passa pelo fluxo normal (seleção se 2+).
- **Impersonação** ("Entrar como empresa" pelo painel): `entrarPorImpersonacao(contexto)` → `aplicarContexto` → `mostrarApp`. Fluxo próprio, **sem PIN de perfil fictício** (o backend grava `perfil_id: null`).
- **Senha provisória:** resolvida antes da seleção de perfil — pertence à CONTA. Ordem inalterada.

---

## J. Erros tratados (ponto 34)

rede · sessão Supabase expirada (401 → login) · perfil inativo (403/404 → recarrega lista) · PIN inválido (401 → mensagem genérica) · PIN bloqueado (429 → "Muitas tentativas…") · prova expirada/consumida (`PROVA_PERFIL_*` → volta ao PIN) · `CONFIGURACAO_PIN_INCOMPLETA` (403 → aviso, bloqueia) · `perfilObrigatorio` (400 → volta ao PIN) · acesso removido / contexto inválido (409 → `encaminhar`). Nenhum stack trace na UI.

---

## K. Arquivos alterados

**Frontend (novos):**
* `src/selecaoPerfil.js` — `montarSelecaoPerfil`, `abrirPinDoPerfil`, `setErroPin`, `setPinCarregando`, `fecharPinDoPerfil`, `mostrarSemPerfil`, `limparPin`.
* `test/selecaoPerfil.test.js` — 22 testes (fake DOM + scans).

**Frontend (alterados):**
* `index.html` — `#selecao-perfil-screen` (lista + painel de PIN).
* `src/state.js` — `sessao.perfil` / `perfisDisponiveis` / `profileSelectionToken`.
* `src/sessao.js` — `carregarPerfis`, `selecionarPerfil`, `limparPerfilPendente`; `listarAcessos(perfilId?)`; `selecionarContexto` envia+consome a prova; `logout`/`limparContexto` limpam perfil+prova; `chamar` enriquece o erro com `codigo`/`status`/`details`.
* `src/app.js` — `encaminhar()` insere a resolução de perfil; `entrarComAcessosDoPerfil`, `mostrarSelecaoDePerfil`, `iniciarPinDoPerfil`; `TELAS.selecaoPerfil`; `#selp-sair`; `entrarNoContexto` trata prova expirada.
* `src/styles.css` — bloco `#selecao-perfil-screen` / `.selp-pin` / `.sel-card-nome`.

**Backend:** nada de lógica — o contrato (`/sessao/perfis`, `/sessao/selecionar-perfil`, `/sessao/selecionar`, `?perfilId=`) já existe das Fases C/D/E/H.

**Migrations:** nenhuma.

---

## L. Testes

**`selecaoPerfil.test.js` (22)** — pontos 44:

| # | Cobertura |
|---|---|
| 2/3 | 1 card por perfil, com o nome de cada |
| 4 | nunca renderiza `pin_hash` / `pin` / `pin_tentativas` |
| 5 | clicar num card abre o PIN daquele perfil |
| 6 | PIN válido (`"0123"` — zeros preservados) → `onConfirmar(pin)`; Enter também |
| 7 | PIN em formato inválido → erro, não confirma |
| 9 | Voltar → restaura a lista |
| 10 | PIN não sobrevive (campo zerado no Voltar) |
| 11/13 | scan: PIN nunca persistido; prova só em `state` (memória), consumida ao criar o Context Token |
| 14/19 | scan: `listarAcessos(perfilId)` escopado; `entrarComAcessosDoPerfil({ perfilId })` |
| 16 | scan: reload com Context Token → `mostrarApp()` direto, sem perfil/PIN |
| 17/26 | scan: logout limpa perfil + prova; `signOut({ scope: "local" })`, nunca global |
| 21 | `mostrarSemPerfil` → estado tratado |
| 23 | scan: `selecionarContexto` envia `profileSelectionToken` quando existe |
| 24/25 | scan: troca de unidade/empresa não repassa por `selecionarPerfil` |
| 35 | scan: prova expirada em `entrarNoContexto` → volta a `encaminhar()` |
| 1/2 | scan: 1 perfil (ou legado) → automático; 2+ → tela; erro/pré-060 → legado |
| 19/25 | scan: 409 → `app:contexto-invalido` → `encaminhar()` |

**Contrato de backend (pontos 45/46)** — regressão das suítes existentes (**373/373**): `pin-selecao-perfil.test.js` cobre 26–32 (multi-perfil sem prova → negado; PIN correto → prova; prova → contexto; `pid` no Context Token; Fulana 1 ↛ Empresa B; Fulana 2 ↛ Empresa A; logout de A ↛ B). O **caso real (46)** ponta-a-ponta exige 060 + 2 perfis num ambiente real — **staging gate**.

**Verificação no navegador:** login renderiza; `#selecao-perfil-screen` mostra cards "Fulana 1"/"Fulana 2" + conta; escolher um perfil abre o painel de PIN ("Entrar como Fulana 1"); PIN mal formatado → erro; Voltar limpa o campo e reabre a lista.

---

## M. Backward compatibility

| Pergunta | Resposta | Como |
|---|---|---|
| **A.** Usuário atual (1 perfil) continua entrando sem tela extra? | **SIM** | `perfis.length <= 1` → fluxo automático; e `GET /sessao/perfis` falhando (pré-060) → `perfis = null` → **fluxo legado idêntico** |
| **B.** Usuário atual sem PIN continua entrando? | **SIM** | conta de 1 perfil nunca pede PIN, mesmo com `pin_hash` |
| **C.** SuperAdmin continua? | **SIM** | 1 perfil → automático → painel; impersonação intacta |
| **D.** Se nenhuma conta tiver 2 perfis, a experiência é praticamente igual à atual? | **SIM** | a única diferença possível é 1 request a mais (`GET /sessao/perfis`) quando 060 está aplicada; sem 060, zero diferença |

---

## N. Staging gate

Sem ambiente com 060/063. **Antes de produção:**

1. Staging: 060 → deploy backend C+D+E+I+H+G → 062 → 063 → 064.
2. Deploy do frontend (Fase F).
3. Criar "Operacional X" + Fulana 1 (Empresa A, PIN 1111) e, pelo detalhe, adicionar Fulana 2 (Empresa B, PIN 2222; informando 1111 no mesmo form).
4. **Fluxo A:** login X → tela "Selecione seu usuário" [Fulana 1, Fulana 2] → Fulana 1 → 1111 → (1 acesso) Empresa A → app.
5. **Fluxo B (outro navegador/perfil anônimo):** login X → Fulana 2 → 2222 → Empresa B → app. **A sessão do Fluxo A continua viva.**
6. Reload em ambos → não pede PIN. Logout do Fluxo A → não derruba o B. PIN errado 5× → lockout. Prova expirada (esperar 5 min entre PIN e seleção) → volta ao PIN.
7. Rollback ensaiado.

**Não executar enquanto o staging não existir.**

---

## O. Blockers

**Para a Fase F:** nenhum — o fluxo está implementado, testado e verificado no navegador (mock).

**Para produção (registrado):**
* 060 + 063 + 064 aplicadas em staging antes do deploy multi-perfil.
* O caso real ponta-a-ponta (ponto 46) só é verificável com 060 aplicada.
* Sem 060, o frontend cai no fluxo legado — nenhuma regressão, nenhuma tela nova aparece.

---

## P. Veredito

> ## FASE F CONCLUÍDA — APTA PARA A FASE J
>
> O fluxo do critério final está implementado: `e-mail X + senha X` → (conta com 2 perfis) **"Selecione seu usuário"** → Fulana 1 → **PIN** → backend valida → Profile Selection Token (memória) → acessos só da Fulana 1 → Empresa A → app. Em outro computador, a mesma conta entra como Fulana 2 (PIN 2222 → Empresa B) **sem derrubar a primeira sessão**. Conta de 1 perfil (todos os usuários atuais) nunca vê a tela nem informa PIN — e, sem a migration 060, o frontend cai no fluxo legado idêntico ao de hoje.
>
> PIN tratado como string (zeros preservados), nunca persistido. Profile Selection Token só em memória, consumido ao criar o Context Token, e reexigido quando expira/some. Reload com Context Token válido não pede nada. Logout é `scope: "local"`. Nenhum `signOut` global, nenhum bypass, nenhum acesso de conta inteira no fluxo multi-perfil.
>
> 215/215 testes frontend (22 novos) + 373/373 backend nas áreas tocadas. Verificado no navegador. Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção.
>
> **A próxima fase (J — testes/QA de ponta a ponta) é decisão do revisor. Não avancei.**

---

## NÃO FIZ (respeitado)

migration aplicada · produção · deploy · remover compatibilidade com contas de 1 perfil · reescrever autenticação · `signOut` global · persistir PIN/prova · refatorar a UI admin (Fase G) · avançar para J.
