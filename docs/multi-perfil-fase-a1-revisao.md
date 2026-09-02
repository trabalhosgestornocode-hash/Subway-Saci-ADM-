# Multi-perfil — Fase A.1 (revisão de pontos críticos)

**Status:** revisão concluída. Nenhum código/banco/migration alterado.
**Data:** 2026-09-01
**Versões auditadas:** `@supabase/supabase-js@2.109.0`, `@supabase/auth-js@2.109.0` (backend, `backend/package-lock.json`). Frontend carrega `@supabase/supabase-js@2` **sem pin** via jsDelivr (`frontend/index.html:441`) — ver R13.

---

## 1. Conclusão sobre logout do Supabase e sessões compartilhadas

### 1.1. O que o `@supabase/auth-js@2.109` faz de verdade (código instalado, não documentação)

`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js`:

- **`signOut(options = { scope: 'global' })`** (linha 3319) — **o default é `global`**. O próprio comentário no código: *"the default `scope` is `'global'`. This signs the user out of **every device they are currently signed in on**"*.
- `_signOut` (linha 3329) chama `this.admin.signOut(accessToken, scope)` → `POST {gotrue}/logout?scope=<scope>` autenticado com o **access token do próprio usuário**.
- `SIGN_OUT_SCOPES = ['global', 'local', 'others']` (`lib/types.js:22`) — os três existem nesta versão.
- `if (scope !== 'others')` (linha 3349) → para `local` e `global` o SDK também faz `_removeSession()` (limpa o `localStorage`) e dispara `SIGNED_OUT`. Para `others`, mantém a sessão local e **não dispara `SIGNED_OUT`**.
- **Cross-tab:** há um `BroadcastChannel` por `storageKey` (linha 243-262) + escuta de `storage` event. Logout/refresh numa aba propaga para as **outras abas do mesmo navegador**.
- **`getUser(jwt)` valida no servidor** (`_getUser`, linha ~2600): faz `GET {gotrue}/user` com o JWT. Comentário no código: *"JWT contains a `session_id` which does not correspond to an active session in the database, indicating the user is signed out"*. → Como o backend chama `supabase.auth.getUser(token)` em **todo** request (`requireAuth`), **uma revogação server-side (global/others/admin) derruba os outros devices no PRÓXIMO request deles — em segundos, não em ~1h.**

### 1.2. O que o projeto faz hoje

Só **dois** pontos tocam o Auth-level logout:

| Lugar | Chamada | Scope |
|---|---|---|
| `frontend/src/sessao.js:169` (`logout()`) | `await sb.auth.signOut()` | **`global`** (default — sem argumento) ⚠️ |
| `backend/.../plataforma.usuarios.service.js:684` (`encerrarSessoesAuth`, usado por `forcarLogout`) | `POST /auth/v1/admin/users/:id/logout` com `service_role` | `"global"` (correto para "derrubar a conta") |

Tudo o mais (`POST /sessao/encerrar`, troca de unidade, `atualizarVinculo`, desativar usuário) mexe só em `sessoes_contexto` (camada do Context Token) via `revogarSessoes(...)` — **não toca o Supabase Auth**.

### 1.3. Por que isso quebra o requisito hoje

`sb.auth.signOut()` (global) do Fulana 1 → GoTrue revoga **todas as `auth.sessions` da conta `operacional@email.com`** → Fulana 2, em outro computador, cai no próximo request (o backend faz `getUser` e o GoTrue diz "sessão não existe"). **Viola REGRA 8, 10, 13.**

### 1.4. Por que a correção é pequena — e por quê ela funciona

**Fato-chave:** o GoTrue emite **uma `auth.sessions` (refresh token) distinta por `signInWithPassword`**, ou seja, **por dispositivo** — mesmo com e-mail/senha idênticos. O JWT carrega o `session_id` daquela sessão.

Então `signOut({ scope: 'local' })`:
- chama `POST /logout?scope=local` → GoTrue revoga **apenas a `auth.session` identificada pelo JWT** (aquele device);
- limpa o `localStorage` local + dispara `SIGNED_OUT`;
- **não toca** o refresh token do computador da Fulana 2.

**Isso, sozinho, já entrega "logout da Fulana 1 ≠ logout da Fulana 2".** Não precisa de tabela nova nem de lógica de "sessões de conta".

### 1.5. As três ações que precisam ficar explicitamente separadas

| Ação | Camada Context Token | Camada Supabase Auth |
|---|---|---|
| **1. Encerrar contexto atual** ("Trocar unidade/empresa") | `revogarSessoes({ sessionId: req.acesso.sessionId })` | nada |
| **2. Logout normal (este dispositivo)** | `revogarSessoes({ sessionId })` + `limparContexto()` | `signOut({ scope: 'local' })` |
| **3. Logout global / administrativo (conta toda)** | `revogarSessoes({ contaId })` (todos os perfis) | `signOut()` global **ou** admin `/logout?scope=global` |

Hoje `logout()` faz a #2 mas com `signOut()` global (= #3). `POST /sessao/encerrar` hoje faz `revogarSessoes({ usuarioId })` — em Model Y (seção 4) precisa virar `{ sessionId }`.

---

## 2. Matriz de impacto do logout

Cenário base: conta `operacional@email.com`, perfis Fulana 1 (comp. A) e Fulana 2 (comp. B), cada uma com sua `auth.session` (refresh token) própria.

| Ação | Context Token (aba atual) | Access token (JWT) | Refresh token (servidor) | Mesma aba | Outras abas (mesmo browser) | Outro browser / computador | Outro perfil da mesma conta |
|---|---|---|---|---|---|---|---|
| **`signOut()` — global — CÓDIGO ATUAL** | não é tocado pelo SDK (fica no sessionStorage até `limparContexto`) | rejeitado no **próximo request** (backend faz `getUser` → GoTrue: sessão revogada) | **TODOS os refresh tokens da conta revogados** | desloga (localStorage limpo, `SIGNED_OUT`) | deslogam (BroadcastChannel + storage event) | **cai no próximo request** → `app:sessao-expirada` → login ⚠️ | **cai junto** ⚠️ (mesma conta, refresh tokens revogados) |
| **`signOut({ scope:'local' })` — PROPOSTO p/ logout normal** | idem (SDK não toca) | válido só naquele device até expirar (ou até `encerrar` revogar o contexto) | **só o refresh token DAQUELA `auth.session`** | desloga | **deslogam** (mesmo browser = mesma `auth.session`) | **intacto** ✅ | **intacto** ✅ (device próprio, `auth.session` própria) |
| **`signOut({ scope:'others' })`** | idem | idem | revoga todos os refresh da conta **exceto o atual** | permanece logado | deslogam (sem `SIGNED_OUT`; caem no próximo request) | **cai** | **cai** ("outra sessão" da conta) |
| **`POST /sessao/encerrar` → `revogarSessoes({ sessionId })` — PROPOSTO** | invalidado no servidor (`revogada_em`); front chama `limparContexto()` | intacto (Auth não é tocado) | intacto | volta pra **seleção de empresa** (não login) | não afeta (cada aba tem seu Context Token no sessionStorage) | não afeta | não afeta ✅ |
| `POST /sessao/encerrar` → `revogarSessoes({ usuarioId })` — **ATUAL** | invalidado | intacto | intacto | seleção de empresa | outras abas caem (409) no próximo request | **outro computador cai (409)** ⚠️ | **outro perfil cairia (409)** ⚠️ |
| **`forcarLogout` (superadmin, alvo = perfil)** — PROPOSTO variante "só este perfil" | todas as sessões de contexto do perfil invalidadas | válido até `getUser` falhar (só se Auth revogado) | intacto | — | — | perfil-alvo cai (sem Context Token) | **não afeta os outros perfis** ✅ |
| **`forcarLogout` (superadmin, alvo = conta)** = `revogarSessoes({ contaId })` + admin `/logout?scope=global` | todas as sessões de todos os perfis da conta | rejeitado no próximo request | **global** | — | — | tudo da conta cai | **todos os perfis caem** (é o objetivo) |
| **só `limparContexto()` (limpar sessionStorage)** | removido só localmente; **linha no servidor continua viva** até expirar/ser revogada | intacto | intacto | seleção de empresa | não afeta | não afeta | não afeta |

**Comportamento obrigatório × como atingir:**

- **LOGOUT NORMAL DE FULANA 1** = `POST /sessao/encerrar` (`revogarSessoes({ sessionId })`) **+** `signOut({ scope:'local' })` **+** `limparContexto()`.
  → encerra contexto + credencial **daquele device**; **não** derruba Fulana 2; **não** revoga a conta.
- **LOGOUT GLOBAL / ADMIN** = ação distinta (botão separado no painel / "sair de todos os dispositivos"): `revogarSessoes({ contaId })` **+** admin `/logout?scope=global`.

> Limitação consciente: "mesmo navegador, abas diferentes" compartilham **uma** `auth.session` — logout `local` numa aba desloga as outras abas do mesmo browser. Isso é correto (é a mesma credencial no mesmo device) e não afeta o cenário do pedido (dois computadores).

---

## 3. Classificação linha a linha das referências de identidade

**Descoberta que muda o plano:** quase todas as tabelas de domínio que gravam "quem fez" **já carregam um snapshot denormalizado `usuario_nome` / `usuario_email`** gravado no momento da ação (comentário literal da migration 002: *"snapshot do nome (sobrevive à exclusão do perfil)"*). E o frontend **já exibe** esse nome ("Importado por…", "Criado em … por …", "Alterado manualmente por …").

→ Para essas, **não há migration**: basta o backend gravar `req.perfil.nome` no `usuario_nome` já existente (troca de `usuario: req.user` por um `ator = { id, nome, email }` do perfil nos controllers — ~8 arquivos, mecânico, Fase E/I).

### Categorias

- **A — SEGURANÇA / AUTORIZAÇÃO** → id **tem de ser o perfil**.
- **B — IDENTIDADE EXIBIDA** → o front mostra "por Fulano". Corrigir gravando o nome do **perfil** no snapshot já existente (sem migration), **ou** adicionar o snapshot (migration mínima) quando a coluna é FK-pura.
- **C — AUDITORIA TÉCNICA** → pode continuar com id da **conta**; a pessoa real vem de `plataforma_auditoria.perfil_id`.
- **D — REFERÊNCIA À CONTA** → deve mesmo ser a conta.

### Tabela

| # | Tabela | Coluna | FK atual | Snapshot `_nome`? | Escrita | Leitura / frontend | Influencia autz? | Semântica futura | Migrar agora? | Cat | Justificativa |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `agente_conversas` | `usuario_id` | `perfis(id)` SET NULL | não | `agente.conversas.service.js#criarConversa` | `buscarConversa` **filtra por `usuario_id`** (isolamento da conversa) | **SIM** | **perfil** | **SIM** | **A** | Conta compartilhada → Fulana 1 veria as conversas do Agente da Fulana 2. Único blocker novo. Tabela pequena, sessões revogadas na migration. |
| 2 | `agente_uso` | `usuario_id` | `perfis(id)` SET NULL | não | `agente.uso.service.js#registrarUso` | painel SuperAdmin (custo, agregado por org) | não | conta ok (ou perfil, opcional) | não | C | Métrica de custo agregada por org. Perfil seria "nice to have" no drill-down; não bloqueia. |
| 3 | `produto_historico` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `produtos.service.js:183` | `historicoModal.js:88/94/104` — "por {usuario_nome}" | não | perfil (exibido) | não (só write-site) | B | Snapshot já existe; gravar `perfil.nome`. |
| 4 | `insumo_preco_historico` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `insumos.service.js:300` | `insumoModal.js:199` — "{usuario_nome}" | não | perfil (exibido) | não (write-site) | B | idem. |
| 5 | `insumos` | `created_by` | `perfis(id)` SET NULL | não | `insumos.service.js:179` | não exibido | não | conta ok | não | C | "quem cadastrou" nunca é mostrado. Se um dia for tela, add snapshot então. |
| 6 | `ficha_tecnica` | `created_by` | `perfis(id)` SET NULL | não | `produtos.service.js:329` | não exibido | não | conta ok | não | C | idem. |
| 7 | `produtos` | `created_by` | `perfis(id)` SET NULL | não | `produtos.service.js:329`-área | não exibido | não | conta ok | não | C | idem. |
| 8 | `lancamentos_financeiros_diarios` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.service.js:878/1002` | Dashboard Executivo — histórico/edições | não | **perfil** | não (write-site) | B | "quem lançou o financeiro do dia" — o cliente vai querer distinguir Fulana 1 × Fulana 2. Snapshot já existe. |
| 9 | `lancamentos_financeiros_edicoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.service.js:1060/1095` | `views.js:217` "autor"; drawer de edições | não | **perfil** | não (write-site) | B | Correção de lançamento finalizado — auditoria visível. |
| 10 | `lancamentos_financeiros_exclusoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.service.js` (exclusão) | drawer de exclusões | não | **perfil** | não (write-site) | B | idem. |
| 11 | `lancamentos_mensais` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.service.js:1319/1401` | `dashboardExecutivoMensal.js:342` "Criado … por {criadoPor.nome}" | não | **perfil** | não (write-site) | B | REV/desempenho mensal. |
| 12 | `lancamentos_mensais` | `atualizado_por_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** (migr 033) | `dashboardExecutivo.service.js:1532` | `dashboardExecutivoMensal.js:343` "Última atualização por {atualizadoPor.nome}" | não | **perfil** | não (write-site) | B | idem. |
| 13 | `lancamentos_mensais_exclusoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.service.js` (exclusão mensal) | histórico de exclusões | não | **perfil** | não (write-site) | B | idem. |
| 14 | `bonificacao_importacoes` | `usuario_id` (+`_nome`) | `perfis(id)` SET NULL | **sim** (só nome) | `bonificacaoMensal.service.js:352` | `bonificacaoMensal.js:816` "Importado … por {usuarioNome}" | não | **perfil** | não (write-site) | B | Import dos PDFs Visio. |
| 15 | `bonificacao_lancamentos_diarios` | `usuario_id` (+`_nome`) | `perfis(id)` SET NULL | **sim** (só nome) | `bonificacaoMensal.service.js:634/671` | histórico do dia de bonificação | não | **perfil** | não (write-site) | B | idem. |
| 16 | `bonificacao_lancamentos_exclusoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `bonificacaoMensal.service.js:856` | histórico de exclusões | não | **perfil** | não (write-site) | B | idem. |
| 17 | `bonificacao_indicadores_manuais` | `usuario_id` (+`_nome`) | `perfis(id)` SET NULL | **sim** (só nome) | `bonificacaoMensal.service.js` (indic. manual) | histórico do indicador | não | **perfil** | não (write-site) | B | REV/Pesquisas/Nota iFood lançados à mão. |
| 18 | `bonificacao_rev_mensal` (`super_restaurante_rev_mensal`) | `usuario_id` (+`_nome`) | `perfis(id)` SET NULL | **sim** (só nome) | `bonificacaoMensal.service.js:925` | `bonificacaoMensal.js:875` "Atualizado … por {usuarioNome}" | não | **perfil** | não (write-site) | B | idem. |
| 19 | `parser_fd_importacoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `parserFoodDelivery.service.js:356` | `parserFoodDelivery.js:440/493` "Importado por" | não | **perfil** | não (write-site) | B | Import do relatório .xls do food delivery. |
| 20 | `parser_fd_importacoes_exclusoes` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `parserFoodDelivery.service.js:449` | `parserFoodDelivery.js:892` histórico | não | **perfil** | não (write-site) | B | idem. |
| 21 | `parser_fd_pedidos` | `classificacao_override_usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** (migr 046) | `parserFoodDelivery.service.js:602` | `parserFoodDelivery.js:780` "Alterado manualmente por {…UsuarioNome}" | não | **perfil** | não (write-site) | B | O "classificado por" que você citou explicitamente. Snapshot já existe. |
| 22 | `unidade_modelo_logistico_historico` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `dashboardExecutivo.metas.service.js:108` | histórico do modelo logístico | não | **perfil** | não (write-site) | B | Troca Marketplace/Full Service. |
| 23 | `unidade_tabela_comercial_historico` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | `unidade.service.js` (troca de tabela) | histórico de tabela comercial | não | **perfil** | não (write-site) | B | Troca da tabela oficial da unidade. |
| 24 | `dashboard_teste_reset_log` | `usuario_id` (+`_nome`,`_email`) | `perfis(id)` SET NULL | **sim** | reset de unidade de teste | log de reset | não | **perfil** | não (write-site) | B | Só unidade de teste; ainda assim "quem resetou". |
| 25 | `martin_brower_integracao` | `criado_por` | `perfis(id)` SET NULL | não | `martinbrower.service.js:86/286` (`criadoPor: usuarioId`) | não exibido hoje | não | conta ok (perfil se virar tela) | não | C→B-latente | "quem conectou a Martin Brower". Se o painel passar a mostrar, add `criado_por_nome`. |
| 26 | `martin_brower_sincronizacoes` | `criado_por` | `perfis(id)` SET NULL | não | `martinbrower.repository.js:94` | painel MB (worker, não usuário) | não | conta ok | não | C | Sync é do worker/sistema na maioria dos casos. |
| 27 | `martin_brower_vinculos` | `confirmado_por` | `perfis(id)` SET NULL | não | `martinbrower.controller.js:69` (`confirmadoPor: req.user.id`) | não exibido hoje | não | conta ok (perfil se virar tela) | não | C→B-latente | O "confirmado por" que você citou. Hoje não aparece; se aparecer, add snapshot. |
| 28 | `ifood_integracao_credenciais` | `criado_por` | `perfis(id)` SET NULL | não | `ifoodAuth.service.js` (`criadoPor: usuarioId`) | não exibido hoje | não | conta ok (perfil se virar tela) | não | C→B-latente | "quem conectou o iFood". |
| 29 | `ifood_oauth_verificadores` | `criado_por` | `perfis(id)` SET NULL | não | `ifood.repository.js:50` | interno (fluxo OAuth) | não | conta ok | não | C | Efêmero (verifier PKCE). |
| 30 | `movimentacoes_estoque` (`schema.sql`) | `usuario_id` | `perfis(id)` SET NULL | não | — (estoque não implementado) | — | não | rever quando estoque nascer | não | C | Módulo dormante. |

### Resumo

- **Categoria A (obrigatório perfil, na migration):** só **`agente_conversas.usuario_id`**. Novo blocker que a Fase A não pegou.
- **Categoria B (18 colunas):** todas **já têm snapshot de nome** → correção só no write-site (gravar `perfil.nome`), **sem migration**. Cobre Dashboard Executivo, Bonificação, Parser, históricos de produto/insumo/modelo/tabela.
- **Categoria B-latente (4 colunas — MB `criado_por`/`confirmado_por`, iFood `criado_por`):** FK-pura, hoje **não exibida**. Deixar como conta; **se** alguma tela passar a mostrar "conectado/confirmado por", aí adiciona a coluna `_nome` naquela migration específica. Não bloqueia.
- **Categoria C (7 colunas):** `created_by` de insumo/ficha/produto, `agente_uso`, MB sync, iFood verifier, estoque. Conta ok; a pessoa vem de `plataforma_auditoria.perfil_id`.
- **Categoria D:** nenhuma. Não há coluna cuja semântica correta seja "a conta como entidade".

**Nenhuma coluna é lida para autorização** exceto `agente_conversas.usuario_id` (isolamento de conversa).

---

## 4. Múltiplas sessões do mesmo perfil — decisão

### Pergunta direta

> Se Fulana 1 estiver em dois computadores e selecionar contexto no segundo, ela derruba o primeiro?

**Com a recomendação original da Fase A (revogar por `perfil_id` em `criarSessao`): SIM, derrubaria.** É o "um contexto vivo por perfil".

### Model X — "um contexto vivo por perfil" (recomendação original)

`criarSessao` → `revogarSessoes({ perfilId })` antes de criar.

- ✅ REGRA 7/8: perfis diferentes nunca colidem.
- ❌ Fulana 1 em 2 computadores: o 2º login mata o 1º.
- Herda a lógica atual ("usuários online" = 1 linha por perfil; "forçar logout" trivial).

### Model Y — `conta_id + perfil_id + session_id`, sem auto-revogação de irmãs

`criarSessao` **não** revoga nada por perfil. Cada `sessoes_contexto` é independente. Revogação é **sempre explícita e escopada**:

| Evento | Revogação |
|---|---|
| Logout normal | `{ sessionId: req.acesso.sessionId }` |
| Troca de unidade/empresa (tem contexto) | `{ sessionId: req.acesso.sessionId }` **antes** de criar a nova (senão sobra sessão órfã por troca) |
| Login (sem contexto) | nada a revogar |
| `atualizarVinculo` / troca de papel | `{ perfilId, organizacaoId }` — pega as 2..N sessões daquele perfil naquela empresa |
| Bloquear acesso do perfil a uma empresa | `{ perfilId, organizacaoId }` |
| Bloquear/excluir a **conta** | `{ contaId }` (todos os perfis) + Auth global |
| "Forçar logout deste perfil" (superadmin) | `{ perfilId }` |

- ✅ REGRA 7/8: perfis diferentes nunca colidem (a revogação nunca cruza `perfil_id`).
- ✅ Fulana 1 em 2 computadores simultâneos: **funciona** (nenhuma revogação automática).
- "Usuários online" = `COUNT(DISTINCT perfil_id)` com sessão viva recente (ou listar N dispositivos).
- Custo de complexidade: **baixo** — as chamadas de `revogarSessoes` já existem, só mudam de `{ usuarioId }` para `{ sessionId }` ou `{ perfilId, ... }`. O único ponto novo é troca-de-unidade revogar a própria sessão explicitamente (1 linha).

### Por que "um contexto por perfil" existe hoje

Comentário em `sessao.service.js:305`: *"tem o efeito colateral desejável de o usuário ter um contexto por vez, o que torna 'usuários online' e 'forçar logout' honestos"*. É **conveniência de telemetria**, não requisito de segurança:
- não é session fixation (cada token é novo e assinado);
- token roubado já morre com a linha no logout e tem teto de 8h;
- o pedido **quer** multi-device para o mesmo perfil.

### Recomendação: **Model Y**

`conta_id + perfil_id + session_id`, sem revogar sessões irmãs do mesmo perfil. Troca de unidade revoga explicitamente a sessão chamadora. "Usuários online" passa a contar perfis distintos. Ganha-se multi-device do mesmo perfil de graça; REGRA 7/8 continua garantida porque **nenhuma revogação automática cruza `perfil_id`**.

---

## 5. Estratégia para não disponibilizar multi-perfil sem PIN

### O risco real

Se Fases B–G forem para produção antes da H, uma conta com 2 perfis permitiria Fulana 1 clicar em "Fulana 2" sem confirmação individual.

### A observação que resolve

**As Fases B–E não criam nenhuma conta multi-perfil.** A migration 060 gera **exatamente 1 perfil por conta** (o backfill 1:1). Enquanto **ninguém consegue adicionar um 2º perfil**, toda conta tem 1 perfil → a tela "Selecione seu usuário" **nunca aparece** → comportamento idêntico ao de hoje → **nada a explorar**.

O 2º perfil só passa a existir quando a **Fase G** (UI de admin "adicionar usuário a esta conta") for para produção.

### Recomendação: PIN vira **pré-requisito da Fase G**, não a última fase

**Nova ordem:** B → C → D → E → I(auditoria) → **H (PIN)** → **G (admin: criar/editar perfil, exige PIN)** → F (tela de seleção) → J (testes).

E um **invariante forte**, verificado no backend (`selecionar-perfil` / criação de perfil):

> Uma conta com **2 ou mais perfis** exige que **todo** perfil tenha `pin_hash` definido. Um perfil sem PIN numa conta multi-perfil **não pode ser selecionado**, e a criação do 2º perfil **obriga** definir o PIN de todos.

Contas de 1 perfil (legado + a maioria) **nunca** pedem PIN — nada muda para elas.

### Alternativas consideradas

- **(A) Feature-flag até a H:** funciona, mas é redundante — sem a Fase G não há multi-perfil de qualquer forma. Serve como reforço se G e H forem PRs separados: G atrás de flag até H entrar.
- **(B) PIN antes do frontend:** é a recomendação acima (reordenar).
- **(C) Outra:** desnecessária.

**Resultado:** não existe janela em produção onde Fulana 1 possa selecionar Fulana 2 sem PIN, porque o único caminho para criar Fulana 2 (Fase G) carrega o PIN como obrigatório.

---

## 6. Regra exata do `pid` no Context Token v2

### Situação atual

`verificarContextToken` (estrutural) exige `sub`, `sid`, `cid`; rejeita `v !== VERSAO` (hoje 1). `requireContexto` (semântico) **relê a linha `sessoes_contexto`** e cruza: `sessao.organizacao_id === p.cid` e `(sessao.unidade_id ?? null) === (p.uid ?? null)` — divergência → 409 (`auth.js:153`).

### v2

1. **`VERSAO` 1 → 2.** Tokens v1 caem como "desatualizado" → 409 → re-seleção. Aceitável: a migration 060 revoga todas as sessões de qualquer forma (re-login único para todos).

2. **`pid` NÃO entra no check estrutural de "incompleto"** de `verificarContextToken`. Motivo: a impersonação legitimamente tem `pid = null`. O check estrutural continua: `sub`, `sid`, `cid` obrigatórios.

3. **A validade do `pid` é atestada pela LINHA, não pelo token** — mesmo mecanismo de `cid`/`uid`. Em `requireContexto`, além dos cruzamentos atuais:

   ```
   // cruzamento (igual cid/uid): o token tem de bater com a linha
   if ((sessao.perfil_id ?? null) !== (p.pid ?? null))
       → 409 "Contexto divergente. Selecione a unidade novamente."

   // invariante: perfil_id só pode ser null em impersonação
   if (sessao.perfil_id === null && sessao.impersonado_por === null)
       → 409 (sessão malformada — defensivo)

   // perfil normal: validar posse + estado
   if (sessao.perfil_id !== null) {
       perfil = SELECT id, nome, conta_id, ativo FROM perfis_operacionais WHERE id = sessao.perfil_id
       if (!perfil)                          → 409 "Perfil não encontrado."
       if (perfil.conta_id !== req.user.id)  → 409 "Contexto não pertence a esta conta."
       if (!perfil.ativo)                    → 409 "Perfil desativado."
       req.perfil = { id: perfil.id, nome: perfil.nome }
   } else {
       req.perfil = null   // impersonação
   }
   ```

### Matriz `pid`

| Caso | `sessoes_contexto.perfil_id` | `impersonado_por` | token `pid` | Como `verificarContextToken` / `requireContexto` diferencia |
|---|---|---|---|---|
| **Perfil normal** | `<uuid>` **NOT NULL** | `null` | `= perfil_id` (obrigatório) | cruzamento `pid === perfil_id`; valida `conta_id` + `ativo`; seta `req.perfil` |
| **Superadmin sem perfil** (login normal com vínculo — raro) | `<uuid>` do perfil 1:1 backfillado | `null` | `= perfil_id` | superadmin que TEM vínculo é conta normal → tem perfil (o 1:1) → `pid` setado, caminho normal |
| **Superadmin via painel** | — (não existe Context Token) | — | — | painel passa por `requireAuth` + `requireSuperadmin`, **nunca** `requireContexto` |
| **Impersonação** ("Entrar como empresa") | **`null`** | `<uuid>` do superadmin **NOT NULL** | `null` | `pid=null` só é aceito porque a **linha** tem `impersonado_por` setado; `req.perfil = null`; `req.acesso.impersonando = true` (bypass já existente em `requireModulo`/`requirePermissao`) |

**Por que não abre brecha:** um token forjado com `pid = null` sem impersonação → a linha `sessoes_contexto` correspondente (pelo `sid`) tem `perfil_id` real e `impersonado_por` null → cruzamento `pid (null) !== perfil_id (uuid)` → **409**. O atacante teria que também inserir/alterar uma linha em `sessoes_contexto` — que é escrita só pelo backend com `service_role`. Idêntico à proteção que hoje impede trocar o `cid`.

**`criarSessao`** passa a exigir `perfilId` **exceto** quando `impersonadoPor` está setado (aí grava `perfil_id = null`). Assinatura: `criarSessao({ contaId, perfilId = null, impersonadoPor = null, ... })` com `assert(perfilId || impersonadoPor)`.

---

## 7. Alterações no plano da Fase A

| # | Item da Fase A | Ajuste da Fase A.1 |
|---|---|---|
| 1 | "manter `usuario_id` = conta nas 29 colunas; identidade só pela auditoria" | **Refinado:** `agente_conversas.usuario_id` → **perfil_id na migration** (Categoria A, isolamento). As 18 colunas Categoria B **já têm snapshot de nome** → corrigir no write-site (gravar `perfil.nome`), sem migration. As demais (C) ficam como conta. |
| 2 | (logout não detalhado) | **Novo:** `frontend/src/sessao.js:169` `signOut()` → `signOut({ scope: 'local' })`. `POST /sessao/encerrar` → `revogarSessoes({ sessionId })` (não `{ usuarioId }`). Ação "logout global" separada. |
| 3 | "revogar sessões por `perfil_id` em `criarSessao`" | **Trocado por Model Y:** `criarSessao` **não** auto-revoga irmãs. Revogação sempre explícita e escopada (`sessionId` / `perfilId+org` / `contaId`). Troca de unidade revoga a própria sessão. Habilita Fulana-1-em-2-devices. |
| 4 | "PIN na Fase H (última)" | **Reordenado:** H (PIN) **antes** de G (admin cria 2º perfil). Invariante "conta multi-perfil ⇒ todo perfil com PIN", validado no backend. B–E deployáveis (0 contas multi-perfil). |
| 5 | "Superadmin/impersonação: sem camada de perfil" | **Detalhado:** `pid = null` **apenas** quando a linha tem `impersonado_por`; cruzado contra a linha (seção 6). `VERSAO` 1→2. `criarSessao` exige `perfilId` OU `impersonadoPor`. |
| 6 | migration 060 (escopo) | **+** coluna `perfil_id` em `agente_conversas` (backfill = `usuario_id`, mesmo truque do id reaproveitado → zero reescrita) **+** `plataforma_auditoria.perfil_id`. |
| 7 | `forcarLogout` | Ganha variante "só este perfil" (`revogarSessoes({perfilId})`, sem Auth) vs "a conta toda" (`+ admin /logout global`). |
| 8 | Testes | **+** `logout-scope.test.js` (matriz da seção 2), `agente-conversas` isolamento por perfil, `pid` inválido/forjado, `sessoes-simultaneas` Model Y (Fulana 1 em 2 devices + Fulana 1/Fulana 2). |
| 9 | (não citado) | **Novo (R13):** pinar a versão do `supabase-js` no CDN do frontend (`@2` → `@2.x.y`), para o comportamento de `signOut` não mudar silenciosamente num deploy futuro. |

O **truque do id reaproveitado** (perfil 1:1 com id = id da conta) segue válido e agora cobre também `agente_conversas` (o `usuario_id` existente já é um `perfil_id` válido no backfill).

---

## 8. Veredito

### **APTO PARA FASE B**, com o plano atualizado pelos itens da seção 7.

Nenhum showstopper. As descobertas da A.1 **reduzem** o risco:

- O logout compartilhado tem correção de **1 linha** (`scope: 'local'`) porque o GoTrue já isola sessão por dispositivo — confirmado no código instalado (auth-js 2.109), não na documentação.
- As ~29 colunas: só **1** exige migration por segurança (`agente_conversas`); **18** já têm snapshot de nome e se resolvem no write-site; o resto fica como conta com a pessoa preservada em `plataforma_auditoria.perfil_id`.
- Multi-device do mesmo perfil é viável (Model Y) sem complexidade relevante.
- A janela "multi-perfil sem PIN" **não existe** se G depender de H — e G é o único caminho para criar um 2º perfil.
- `pid` é validado contra a linha `sessoes_contexto` (igual `cid`/`uid` hoje); `null` só é legal na impersonação atestada pela própria linha — sem brecha.

**Blockers remanescentes: nenhum.** Itens obrigatórios para a Fase B carregar no plano: seção 7, itens 1–9.

---

## Anexo — arquivos tocados nas descobertas da A.1

- `frontend/src/sessao.js:161-172` (`logout`) — `signOut({ scope: 'local' })`
- `frontend/index.html:441` — pinar `@supabase/supabase-js`
- `backend/src/modules/sessao/sessao.service.js` — `revogarSessoes` (escopos), `criarSessao` (sem auto-revoke), `encerrarContexto` (por `sessionId`)
- `backend/src/middlewares/auth.js#requireContexto` — cruzamento `pid`, `req.perfil`
- `backend/src/shared/contextToken.js` — `VERSAO` 2, campo `pid`
- `backend/src/modules/agente/agente.conversas.service.js` — filtro por `perfil_id`
- `backend/src/modules/agente/agente.service.js` — passar `perfilId` para conversas
- controllers que passam `usuario: req.user` (Categoria B — write-site): `dashboard-executivo/*.controller.js`, `bonificacao-mensal/*.controller.js`, `parser-food-delivery/*.controller.js`, `produtos`, `insumos`, `dashboardExecutivo.metas.service.js`, `unidade.service.js`
- `backend/src/modules/plataforma/plataforma.usuarios.service.js#forcarLogout` / `encerrarSessoesAuth` — variantes perfil × conta
- migration 060 — `+ agente_conversas.perfil_id`, `+ plataforma_auditoria.perfil_id`
