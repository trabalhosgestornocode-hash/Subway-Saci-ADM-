# Integração oficial iFood — Fase 1 (Fundação)

> Escopo: **conexão da unidade + OAuth distribuído + descoberta/vínculo de merchant + status**.
> **Não** cobre Analytics, Sales, Financial Events, Settlement, Reconciliation, sincronização de dados,
> nem qualquer escrita no Merchant. Merchant é **read-only** nesta fase.

---

## 1. Auditoria inicial

**Arquitetura encontrada (reaproveitada, nada paralelo criado):**

| Camada | Como funciona hoje | Uso na integração iFood |
|---|---|---|
| Multi-tenant | `organizacoes` → `unidades`; toda tabela operacional carrega `organizacao_id` + `unidade_id` redundantes | `ifood_conexoes` / `ifood_oauth_sessoes` seguem esse par |
| Auth | `requireAuth` (JWT Supabase) → `requireContexto` (Context Token, relê `sessoes_contexto`) → `requirePermissao`/`requireModulo` | Rotas montadas sob `requireModulo(MODULOS.IFOOD)` + `requirePermissao` |
| Isolamento | Backend usa **service_role** (ignora RLS); isolamento efetivo é a camada de repositório filtrando `organizacao_id` + `unidade_id` | `ifood.repository.js#exigirTenant` em toda query de conexão/sessão |
| Módulos | `ifood` **já existia** no catálogo (`shared/modulos.js` + migration 030) e no menu | Item de menu convertido de tela estática → página real; nenhum módulo novo |
| Integração externa (referência) | `modules/martinbrower/*` — client HTTP com retry/timeout/sanitização, catálogo de erros, `logsafe`, repository com `exigirTenant`, feature-flag por ENV | Padrão replicado 1:1 no módulo `ifood` |
| Migrations | `NNN_nome.sql` sequenciais, rodadas à mão no SQL Editor, idempotentes, RLS `enable` sempre + policies condicionais aos helpers 015/016 | Migration 056 no mesmo molde |
| Cripto em repouso | **Não existia** (Martin Brower é credencial efêmera, sem persistência) | Camada nova `shared/cripto.js` (AES-256-GCM) — o iFood precisa persistir tokens |
| Frontend | Vanilla JS, sem build; `config.js#MENU` → `router.js` switch → `renderXxx()`; testes puros sem DOM em `frontend/test/` | `ifood.js` (DOM) + `ifoodEstado.js` (puro, testado) |

**Riscos identificados e mitigados:**

- Sem cripto-at-rest → criada camada isolada `shared/cripto.js`.
- `authorizationCodeVerifier` precisa ser guardado temporariamente e nunca exposto → tabela `ifood_oauth_sessoes` com verifier **cifrado** e anulado ao concluir.
- Migrations pré-requisito podem não estar aplicadas em produção → migration 056 degrada com aviso (mesmo padrão do 017).
- `martinbrower.routes.js` usa `requirePapel("admin")` (papéis reais são `organization_admin` etc. — bug latente do MB) → iFood usa `requirePermissao(PERMISSOES.INTEGRACOES_GERENCIAR)`.
- Supabase MCP não autenticado nesta sessão → migration entregue como `.sql` para rodar no SQL Editor (fluxo padrão do projeto).

---

## 2. Plano executado (blocos, validados um a um)

| Bloco | Entrega |
|---|---|
| **A** Auditoria | read-only, sem alterações |
| **B** Banco + cripto | migration 056, `shared/cripto.js`, `IFOOD_TOKEN_SECRET` obrigatória, `config.ifood` |
| **C** Backend OAuth | `ifoodHttp.client`, `ifood.errors`, `ifood.logsafe`, `ifood.repository`, `ifoodToken.service`, `ifoodAuth.service`, `ifood.validators`, `ifood.controller`, `ifood.routes`, `ifood.ratelimit` — endpoints `/oauth/start` e `/oauth/complete` |
| **D** Merchant read-only | `ifoodMerchant.service` — `GET /merchants` (paginação completa), `GET /merchants/:id` |
| **E** Vínculo + status | `ifoodConnection.service` — `POST /merchants/link`, `GET /status`; duplicidade em 3 barreiras |
| **F** Frontend + desconexão | `ifoodEstado.js`, `ifood.js`, wrappers `api.js`, menu, `DELETE /` |
| **G** Auditoria final + entrega | este documento |

---

## 3. Arquivos criados

**Backend — `backend/src/modules/ifood/`**
- `ifood.constants.js` — base URL (via `IFOOD_API_BASE_URL`), rotas, `IFOOD_APPS`, config HTTP/token/OAuth/rate-limit, `maxPaginas`.
- `ifood.errors.js` — `IfoodError` + catálogo `codigo → [status HTTP, mensagem pt-BR]`, `erroPorStatusHttp`, `ehTransitorio`.
- `ifood.logsafe.js` — `sanitizar()` recursivo (redige por chave e por regex), `ifoodLog()`, `mascararId()`, `urlParaLog()`.
- `ifoodHttp.client.js` — `postForm()` (x-www-form-urlencoded, OAuth) e `getJson()` (Bearer, Merchant). Timeout, retry seletivo (5xx/rede/429), `fetchImpl` injetável.
- `ifood.repository.js` — 17 funções; `exigirTenant` em toda query de conexão/sessão; credencial só via `conexao_id` do tenant.
- `ifoodToken.service.js` — `credenciaisDoApp()`, `trocarAuthorizationCodePorToken()`, `renovarToken()`, `getValidAccessToken()`, `comAccessTokenValido()` (retry único em 401), `salvarTokens()`.
- `ifoodAuth.service.js` — `iniciarConexao()`, `concluirAutorizacao()`.
- `ifoodMerchant.service.js` — `listarMerchantsAutorizados()`, `validarMerchant()`, `sanitizarMerchant()`.
- `ifoodConnection.service.js` — `vincularMerchant()`, `obterStatus()`, `desconectar()`.
- `ifood.validators.js` — `validarAppType`, `validarSessionId`, `validarAuthorizationCode`, `validarMerchantId`.
- `ifood.controller.js` — handlers finos (`{ data }`, tenant de `req.tenant`).
- `ifood.routes.js` — rotas + `requirePermissao` + rate-limit.
- `ifood.ratelimit.js` — janela deslizante em memória por usuário.

**Backend — outros**
- `backend/src/shared/cripto.js` — AES-256-GCM (`cifrar`/`decifrar`/`mascarar`), chave via scrypt a partir de `IFOOD_TOKEN_SECRET`.

**Migration**
- `database/migrations/056_ifood_integracao.sql`

**Frontend**
- `frontend/src/ifoodEstado.js` — decisões puras (sem DOM).
- `frontend/src/ifood.js` — página + assistente de 2 etapas + seleção de merchant + desconexão.

**Testes** (84 backend + 24 frontend, todos passando)
- `backend/test/ifood-cripto.test.js` (7)
- `backend/test/ifood-http-client.test.js` (15)
- `backend/test/ifood-token-service.test.js` (14)
- `backend/test/ifood-auth-service.test.js` (10)
- `backend/test/ifood-merchant-service.test.js` (18)
- `backend/test/ifood-connection-service.test.js` (20)
- `frontend/test/ifood.test.js` (24)

---

## 4. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `backend/src/config/env.js` | `IFOOD_TOKEN_SECRET` obrigatória (backend não sobe sem ela, ≥16 chars); `config.ifood` (base URL + clientId/secret dos 2 apps, só de ENV) |
| `backend/src/routes.js` | `import { ifoodRouter }` + `tenant.use("/integracoes/ifood", requireModulo(MODULOS.IFOOD), ifoodRouter)` |
| `backend/.env.example` | Documentação das variáveis iFood |
| `backend/.env.test.example` | `IFOOD_TOKEN_SECRET` para a suíte de testes |
| `render.yaml` | 6 envVars iFood no serviço `subway-saci` (`sync: false` nos segredos) |
| `frontend/src/api.js` | Wrappers `ifoodStatus`, `ifoodMerchants`, `ifoodOauthStart`, `ifoodOauthComplete`, `ifoodVincularMerchant`, `ifoodDesconectar` |
| `frontend/src/config.js` | Item de menu `iFood`: `tipo: "integracao"` → `tipo: "ifood"` (mesma seção, mesmo módulo) |
| `frontend/src/router.js` | `import { renderIfood }` + `case "ifood"` |
| `frontend/src/styles.css` | Bloco `.ifood-*` (usa as variáveis de tema existentes) |

---

## 5. Migrations criadas

**`056_ifood_integracao.sql`** — 3 tabelas + trigger + RLS. Idempotente. Rollback documentado no cabeçalho.

```
ifood_conexoes          1 viva por unidade (índice único parcial status<>'revogada')
  organizacao_id + unidade_id (NOT NULL, FK cascade)
  merchant_id / merchant_nome / merchant_razao_social  (NULL até o vínculo; único-vivo GLOBAL)
  status: pendente | ativa | revogada | reauth_required
  conectada_em, ultima_sincronizacao_em (só coluna), ultimo_erro, criado_por

ifood_credenciais       1 por (conexao_id, app_type)         — RLS deny-all (backend-only)
  app_type: analytics | financial
  access_token_cifrado (NOT NULL), refresh_token_cifrado (nullable)
  expira_em, token_type, status: ativa | reauth_required

ifood_oauth_sessoes     estado temporário do fluxo            — RLS deny-all (backend-only)
  app_type, user_code, authorization_code_verifier_cifrado
  verification_url[_complete], expira_em (~10 min)
  status: pending | authorized | expired | failed
  verifier_consumido_em (anula o verifier ao concluir)
```

RLS: `enable` sempre nas 3. `ifood_conexoes` recebe policy de tenant (`organizacao_id in auth_organizacao_ids()` **e** `unidade_id in auth_unidade_ids()`, ou `is_platform_superadmin()`), pulada com `raise notice` se os helpers 015/016 não existirem. `ifood_credenciais` e `ifood_oauth_sessoes` **sem policy = deny-all** para `authenticated`.

Nenhuma linha nova no catálogo `modulos` (o `ifood` já existe). Nenhum backfill em `organizacao_modulos` (o SuperAdmin libera por empresa).

---

## 6. Endpoints internos adicionados

Todos sob `/api/v1/integracoes/ifood`, atrás de `requireAuth` → `requireContexto` → `requireModulo("ifood")`.

| Método | Rota | Permissão | Rate-limit | Corpo | Resposta (`{ data }`) |
|---|---|---|---|---|---|
| `POST` | `/oauth/start` | `integracoes.gerenciar` | 5/min | `{ appType }` | `{ sessionId, appType, userCode, verificationUrl, verificationUrlComplete, expiraEm }` |
| `POST` | `/oauth/complete` | `integracoes.gerenciar` | 10/min | `{ appType, sessionId, authorizationCode }` | `{ appType, status: "authorized", conexaoStatus }` |
| `GET` | `/merchants` | `integracoes.gerenciar` | 20/min | — | `{ merchants: [{ id, idMascarado, nome, razaoSocial, tipo, status }], total, truncado }` |
| `GET` | `/merchants/:merchantId` | `integracoes.gerenciar` | 20/min | — | `{ id, idMascarado, nome, razaoSocial, tipo, status }` |
| `POST` | `/merchants/link` | `integracoes.gerenciar` | 20/min | `{ merchantId }` | status sanitizado (shape de `/status`) |
| `GET` | `/status` | `integracoes.ver` | — | — | ver abaixo |
| `DELETE` | `/` | `integracoes.gerenciar` | — | — | `{ ok, jaDesconectado, revogacaoNoIfood: "manual_no_portal" }` |

**`GET /status`:**
```json
{ "data": {
  "conectado": true,
  "status": "ativa",
  "merchant": { "idMascarado": "550e****0000", "nome": "Subway Saci", "razaoSocial": "Saci LTDA" },
  "apps": {
    "analytics": { "conectado": true, "status": "ativa", "expiraEm": "..." },
    "financial": { "conectado": true, "status": "ativa", "expiraEm": "..." }
  },
  "conectadaEm": "...", "ultimaSincronizacao": null, "ultimoErro": null
} }
```

---

## 7. Variáveis de ambiente necessárias

| Variável | Obrigatória | Onde | Observação |
|---|---|---|---|
| `IFOOD_TOKEN_SECRET` | **Sim** — o backend não sobe sem ela (≥16 chars) | Render → Environment (`sync: false`) e `backend/.env` local | Cifra access/refresh token e o verifier em repouso. `openssl rand -base64 48`. Trocar torna ilegíveis os tokens gravados (basta reconectar). |
| `IFOOD_API_BASE_URL` | Não (default `https://merchant-api.ifood.com.br`) | Render / `.env` | Só muda para apontar um mock em teste |
| `IFOOD_ANALYTICS_CLIENT_ID` | Para autorizar Analytics | Render (`sync: false`) / `.env` | Portal do Desenvolvedor iFood — app BI/Analytics |
| `IFOOD_ANALYTICS_CLIENT_SECRET` | idem | idem | **Nunca** vai a frontend/log/git |
| `IFOOD_FINANCIAL_CLIENT_ID` | Para autorizar Financial + descobrir merchant | Render (`sync: false`) / `.env` | Portal do Desenvolvedor iFood — app FINANCIAL |
| `IFOOD_FINANCIAL_CLIENT_SECRET` | idem | idem | **Nunca** vai a frontend/log/git |

Com os `CLIENT_ID`/`CLIENT_SECRET` vazios, `/oauth/start` responde `503 IFOOD_APP_SEM_CREDENCIAL` (erro controlado — nada quebra).

---

## 8. Fluxo de conexão completo

```
UNIDADE selecionada (Context Token) → menu "iFood" → GET /status

ETAPA 1 — Analytics (opcional, pode pular)
  [Gerar código] → POST /oauth/start { appType: "analytics" }
     backend: credenciaisDoApp("analytics") → POST {iFood}/authentication/v1.0/oauth/userCode { clientId }
     grava ifood_oauth_sessoes { user_code, authorization_code_verifier_cifrado, expira_em, status:'pending' }
     devolve { sessionId, userCode, verificationUrlComplete, expiraEm }   ← NUNCA o verifier
  usuário: abre verificationUrlComplete no Portal do Parceiro, autoriza, copia o authorizationCode
  [Concluir autorização] → POST /oauth/complete { appType, sessionId, authorizationCode }
     backend: valida sessão (pending, não expirada, appType) → decifra verifier
              POST {iFood}/authentication/v1.0/oauth/token
                { grantType:"authorization_code", clientId, clientSecret, authorizationCode, authorizationCodeVerifier }
              obterOuCriarConexao(unidade)  → ifood_conexoes 'pendente'
              salvarCredencial(conexao, "analytics", cifrar(accessToken), cifrar(refreshToken), expira_em)
              fecharSessaoOAuth('authorized') + ANULA o verifier
  → "Analytics ✓", avança para Etapa 2

ETAPA 2 — Financial + Merchant (mesmo fluxo OAuth, appType: "financial")
  após concluir Financial:
  GET /merchants
     backend: obterConexaoViva(unidade) → comAccessTokenValido(conexao, "financial", fn):
                getValidAccessToken → (renova se faltar <10min) → decifra accessToken
                fn: pagina GET {iFood}/merchant/v1.0/merchants?page=N&size=100 até lote < 100 (teto 50 páginas)
     devolve { merchants: [{ id, idMascarado, nome, razaoSocial, ... }], total, truncado }
  seleção: 0 lojas → aviso | 1 loja → confirmação | N lojas → lista de rádio
  troca de merchant (já havia um vinculado e é OUTRO) → window.confirm ANTES de vincular
  [Vincular] → POST /merchants/link { merchantId }
     backend: obterConexaoViva → validarMerchant (GET {iFood}/merchant/v1.0/merchants/{id}, token financial)
              conexaoVivaDoMerchant(merchantId) global → se de OUTRA unidade → 409 IFOOD_VINCULO_DUPLICADO
              definirMerchantDaConexao: grava merchant_id + nome/razão DA API + status:'ativa' + conectada_em
                (violação do índice único parcial → 23505 → 409 IFOOD_VINCULO_DUPLICADO)
     → GET /status reflete "Conectado"

DESCONEXÃO LOCAL — DELETE /api/v1/integracoes/ifood
  backend: apagarCredenciais(conexao)  (DELETE das linhas de token)
           cancelarSessoesPendentes
           ifood_conexoes.status = 'revogada'   (libera o merchant p/ outra unidade; obterConexaoViva passa a devolver null)
  NENHUMA chamada de revogação ao iFood (não há endpoint documentado).
  frontend: avisa que remoção local ≠ revogação no Portal do Parceiro.

RENOVAÇÃO DE TOKEN (automática, sob demanda)
  getValidAccessToken(conexao, app): se falta <10min p/ expirar → POST /oauth/token { grantType:"refresh_token", ... }
  comAccessTokenValido: se a chamada externa der 401 → 1 refresh + 1 repetição da chamada; se o refresh falhar →
    ifood_credenciais.status = 'reauth_required' + erro IFOOD_REFRESH_FALHOU ("Reconecte sua conta").
```

---

## 9. Tratamento de erros implementado

| Origem | Código de domínio | HTTP | Comportamento |
|---|---|---|---|
| appType != analytics/financial | `IFOOD_APP_TYPE_INVALIDO` | 400 | rejeita antes de qualquer I/O |
| ENV do app vazia | `IFOOD_APP_SEM_CREDENCIAL` | 503 | mensagem "fale com o suporte" |
| sessão OAuth inexistente | `IFOOD_OAUTH_SESSAO_NAO_ENCONTRADA` | 404 | — |
| sessão OAuth vencida | `IFOOD_OAUTH_SESSAO_EXPIRADA` | 400 | marca `expired`, "gere outro código" |
| sessão não-`pending` / verifier já anulado | `IFOOD_OAUTH_SESSAO_JA_USADA` | 409 | — |
| iFood recusa o `authorizationCode` (400) | `IFOOD_OAUTH_CODIGO_INVALIDO` | 400 | marca sessão `failed`, **sem retry** |
| `GET /merchants*` 401 | `IFOOD_TOKEN_EXPIRADO` | 401 | `comAccessTokenValido`: **1 refresh + 1 repetição**; persistente → propaga sem loop |
| refresh falha | `IFOOD_REFRESH_FALHOU` | 401 | `ifood_credenciais.status='reauth_required'` |
| merchant 403 | `IFOOD_MERCHANT_SEM_PERMISSAO` | 403 | "Você não tem permissão para vincular esta loja" |
| merchant 404 | `IFOOD_MERCHANT_NAO_ENCONTRADO` | 404 | — |
| merchant já vinculado a outra unidade / corrida (23505) | `IFOOD_VINCULO_DUPLICADO` | 409 | "já vinculada a outra unidade" (não revela qual) |
| iFood 429 | `IFOOD_RATE_LIMITED` | 429 | respeita `Retry-After` (teto 30 s) + backoff exponencial; senão erro amigável |
| iFood 5xx / rede / timeout | `IFOOD_INDISPONIVEL` | 503 | até 3 tentativas |
| corpo/JSON/content-type inesperado | `IFOOD_RESPOSTA_INVALIDA` | 502 | corta resposta > 4 MB |
| cancelamento (AbortController) | `IFOOD_CANCELADO` | 499 | — |
| unidade sem conexão | `IFOOD_CONEXAO_NAO_ENCONTRADA` | 404 | falha antes de chamar a API |
| app não autorizado | `IFOOD_CREDENCIAL_NAO_ENCONTRADA` | 404 | — |

Rate-limit interno do Crescer estoura → `IFOOD_RATE_LIMITED` (429). Em produção, 5xx nunca vaza stack/detalhe ao cliente (`errorHandler` já existente). Nenhum `details` de erro iFood carrega token/secret/merchantId completo.

---

## 10. Testes executados

| Suíte | Testes | Resultado |
|---|---|---|
| `ifood-cripto` | 7 | ✅ 7/7 |
| `ifood-http-client` | 15 | ✅ 15/15 |
| `ifood-token-service` | 14 | ✅ 14/14 |
| `ifood-auth-service` | 10 | ✅ 10/10 |
| `ifood-merchant-service` | 18 | ✅ 18/18 |
| `ifood-connection-service` | 20 | ✅ 20/20 |
| `frontend/test/ifood` | 24 | ✅ 24/24 |
| **Total iFood** | **108** | **✅ 108/108** |
| Suíte backend completa | 1043 | 1005 ✅ / 38 ❌ (pré-existentes — exigem `TEST_SUPABASE_*`/`.env.test`; `bonificacao-mensal-*` e `parser-food-delivery-paginacao`; **nenhum iFood**) |
| Suíte frontend completa | 91 | ✅ 91/91 (0 regressão) |

Cobertura por cenário exigido:
gerar userCode financial ✅ · gerar userCode analytics ✅ · appType inválido ✅ · sem acesso à unidade (tenant) ✅ · sessão OAuth expirada ✅ · authorizationCode inválido ✅ · token válido ✅ · refresh token ✅ · refresh falhando ✅ · 401 com retry único ✅ · GET merchants ✅ · paginação de merchants ✅ · merchant único ✅ · múltiplos merchants ✅ · merchant sem permissão ✅ · vínculo merchant/unidade ✅ · bloqueio de duplicidade (mesma unidade / outra unidade / 23505) ✅ · status analytics apenas ✅ · status financial apenas ✅ · ambos conectados ✅ · desconexão local ✅ · sanitização de secrets em erros/logs ✅ · reauth_required ✅ · 400/401/403/404/409/429/5xx ✅ · contador de expiração ✅ · troca de merchant com confirmação ✅.

### Revisão de segurança (Bloco G)

| Item | Verificação | Resultado |
|---|---|---|
| Secrets em ENV | `clientSecret` só lido de `process.env` em `env.js`; nunca hardcoded | ✅ |
| Secrets no git | `backend/.env` é gitignored (`git check-ignore` confirma); `.env.example`/`render.yaml` só placeholders/`sync:false` | ✅ |
| Tokens no frontend | `/oauth/start` devolve só `userCode`+URLs+prazo; `/status` e `/merchants/link` sanitizados; testes asseguram ausência de `token`/`secret`/`cifrado`/merchantId completo | ✅ |
| Verifier | nasce cifrado, nunca volta ao frontend (teste explícito), anulado ao concluir/falhar/expirar | ✅ |
| localStorage | `ifood.js` não escreve nada; `sessionId` só em memória do módulo, limpo no reset de contexto | ✅ |
| Logs | módulo só usa `ifoodLog()` (nenhum `console.*` direto); `sanitizar()` redige por chave + regex (JWT/Bearer); `urlParaLog` remove query sensível; nunca loga corpo/headers | ✅ |
| Tokens em repouso | AES-256-GCM, IV por operação, authTag verifica adulteração, chave via scrypt de `IFOOD_TOKEN_SECRET` | ✅ |
| RLS | `ifood_credenciais` e `ifood_oauth_sessoes` deny-all para `authenticated`; `ifood_conexoes` com policy de tenant (org ∩ unidade) | ✅ |
| Isolamento tenant | `exigirTenant(org, unidade)` em toda query de conexão/sessão; credencial só via `conexao_id` do tenant; `conexaoVivaDoMerchant` é global mas retorna campos mínimos e o erro não revela a unidade | ✅ |
| Permissões | `integracoes.gerenciar` (mutações + Merchant) / `integracoes.ver` (status); nunca `requirePapel("admin")` | ✅ |
| Refresh/retry | renovação proativa (<10 min); `comAccessTokenValido` = 1 refresh + 1 repetição, sem loop (teste "401 nas duas vezes → 2 chamadas") | ✅ |
| Sessões OAuth expiradas | rejeitadas + marcadas `expired` + verifier anulado; higiene em lote no `start` | ✅ |
| Vínculo concorrente | 3 barreiras: `conexaoVivaDoMerchant` (app) → índice único parcial (DB) → tradução de `23505` | ✅ |
| Troca de contexto/unidade | tenant re-resolvido por request de `sessoes_contexto`; `registrarResetDeContexto` no frontend limpa wizard/timer/status | ✅ |
| Paginação | percorre todas as páginas; dedup por `id`; teto 50 páginas com `ifoodLog("warn", ...)` (nunca silencioso) | ✅ |
| Rate limiting | 5/10/20 por minuto por usuário, em memória, com limpeza periódica | ✅ |
| Escrita no Merchant | `IFOOD_ROTAS` só tem GETs de merchant; `httpClient` só expõe `postForm` (OAuth) + `getJson`; nenhum caminho de escrita existe | ✅ |
| Analytics/Financial data | `IFOOD_ROTAS` não tem endpoint de Analytics/Sales/Events/Settlement | ✅ |

Busca no repositório por `clientSecret`, `accessToken`, `refreshToken`, `authorizationCode`, `authorizationCodeVerifier`, `IFOOD_`, `Bearer`: **todas as ocorrências são legítimas** — código de serviço (segredo em trânsito/memória, cifrado antes de persistir), comentários de política, valores fake em teste (`"s"`, `"AT-1"`, `"teste-secret-fixo-..."`), nomes de variáveis de ambiente, `Authorization: Bearer` obrigatório na Merchant API (não logado). Nenhum segredo real hardcoded ou commitado.

---

## 11. Pendências

**Você (manual):**
1. Aplicar `database/migrations/056_ifood_integracao.sql` no SQL Editor do Supabase (idempotente).
2. Definir `IFOOD_TOKEN_SECRET` no Render (o backend não sobe sem ela).
3. Cadastrar os 4 `IFOOD_*_CLIENT_ID`/`SECRET` no Render após regenerar os secrets expostos nos testes.
4. Redeploy do backend.
5. Smoke test manual (a página não é exercitável no preview automático — precisa de login + unidade + migration + credenciais).

**Melhorias futuras (não bloqueiam a Fase 1):**
- `GET /merchants/{id}/status` (opcional na spec) não implementado.
- Card do hub "Integrações" (`views.renderIntegracoes` / `INTEGRACOES.ifood`) ainda diz "em planejamento" — cosmético.
- Confirmações via `window.confirm`/`window.alert` (mesmo padrão do Martin Brower) — trocar por modal estilizado depois.
- `ifood.repository.js#obterConexaoDoTenant` exportado e ainda sem chamador (primitivo para fases futuras).
- Comparação de merchant na troca usa `idMascarado` (o `/status` não expõe o id completo).

---

## 12. O que ficou explicitamente FORA desta fase

- Consumo de **Analytics** (KPIs, GMV, pedidos agregados, cancelamentos, ticket médio, canais, pagamentos, logística).
- Consumo de **Sales / Financial Events / Settlement / Reconciliation / repasses / conciliação**.
- Qualquer **escrita no Merchant**: `POST/DELETE /interruptions`, `PUT /opening-hours`, `*/myPreparationTime`, pausas, interrupções, edição de merchant.
- Sincronização automática de dados, lançamento diário automático, dashboard automático.
- Botão **"Sincronizar agora"** funcional (a tela mostra "Ainda não sincronizado", estático).
- Endpoint de revogação no iFood (não existe documentado — a desconexão é **local**).
- Modal estilizado do assistente; ajuste do card do hub de Integrações.
- `GET /merchants/{id}/status`.

---

## Checklist antes do primeiro teste real com iFood

> Ordem recomendada. Nada disso é feito automaticamente.

### Infra / configuração
- [ ] **Aplicar a migration**: Supabase → SQL Editor → colar e executar `database/migrations/056_ifood_integracao.sql` inteiro.
  - Verificar: `select tablename, rowsecurity from pg_tables where schemaname='public' and tablename like 'ifood_%';` → 3 tabelas, `rowsecurity = true`.
  - Verificar: `select tablename, policyname from pg_policies where tablename like 'ifood_%';` → só `rls_ifood_conexoes_tenant` (as outras 2 são deny-all).
  - Se aparecer o `NOTICE` sobre helpers 015/016 ausentes: rodar 015 e 016 e reexecutar a 056.
- [ ] **`IFOOD_TOKEN_SECRET`**: gerar com `openssl rand -base64 48` → cadastrar no Render (Environment do serviço `subway-saci`). **Sem isso o backend não sobe.** Guardar o valor com segurança — trocá-lo depois torna ilegíveis os tokens já gravados (basta reconectar as unidades).
- [ ] **Regenerar os Client Secrets** dos dois apps no Portal do Desenvolvedor iFood (os antigos foram expostos durante os testes de vocês).
- [ ] **Cadastrar no Render** (todos `sync: false`):
  - [ ] `IFOOD_ANALYTICS_CLIENT_ID`
  - [ ] `IFOOD_ANALYTICS_CLIENT_SECRET`
  - [ ] `IFOOD_FINANCIAL_CLIENT_ID`
  - [ ] `IFOOD_FINANCIAL_CLIENT_SECRET`
  - [ ] (opcional) `IFOOD_API_BASE_URL` — deixar o default se for produção iFood.
- [ ] **Confirmar `.env` local** (`backend/.env`) tem `IFOOD_TOKEN_SECRET` + os 4 client id/secret, se for testar localmente.
- [ ] **Redeploy do backend** no Render. Conferir no log de boot: **sem** `[config] Variáveis de ambiente faltando`.
- [ ] Conferir `GET /health` responde 200.

### Habilitação do módulo
- [ ] No Painel SuperAdmin → Acessos: garantir que a **empresa** da unidade de teste tem o módulo **`iFood`** habilitado (e a unidade também, se a empresa usa módulos por unidade).
- [ ] Garantir que o usuário de teste tem papel com `integracoes.gerenciar` (organization_admin, unit_manager, finance ou operations).

### Smoke test manual
- [ ] Login → selecionar a **unidade de teste** → menu **iFood**.
- [ ] A tela carrega mostrando **"Não conectado"**, Analytics e Financial "Não conectado", "Nenhuma loja iFood vinculada".
- [ ] Clicar **Conectar iFood**.

### Autorizar Analytics (Etapa 1)
- [ ] **Gerar código** → aparece o `userCode` (ex. `HJLX-LPSQ`) e o contador começa em ~`09:5x`.
- [ ] **Abrir Portal do iFood** → confirmar que abre o `verificationUrlComplete` no Portal do Parceiro.
- [ ] Autorizar o app **Analytics/BI** no Portal → copiar o **código de autorização**.
- [ ] Colar no campo → **Concluir autorização** → tela avança para a Etapa 2 com "Desempenho / Analytics autorizado ✓".
  - Se o contador zerar antes: **Gerar novo código** e repetir.
  - Se der erro de código: conferir se copiou o `authorizationCode` certo (não o `userCode`).

### Autorizar Financial (Etapa 2)
- [ ] **Gerar código** → autorizar o app **FINANCIAL** no Portal do Parceiro → copiar o código → **Concluir autorização**.

### Descobrir merchant
- [ ] Após concluir Financial, a tela busca as lojas automaticamente (`GET /merchants`):
  - **0 lojas** → mensagem "não possui acesso a nenhuma loja" (revisar autorização no Portal).
  - **1 loja** → card com nome + razão social + `idMascarado`.
  - **N lojas** → lista para escolher.

### Vincular merchant à unidade
- [ ] Selecionar a loja da unidade → **Vincular a esta unidade** / **Vincular loja selecionada**.
- [ ] Toast "Loja vinculada à unidade." e a tela de status mostra **"Conectado"** (ou "Parcialmente conectado" se pulou o Analytics), com a loja em "Loja iFood vinculada".

### Verificações finais
- [ ] `GET /api/v1/integracoes/ifood/status` (via a própria tela) reflete `analytics` e `financial` separadamente.
- [ ] No banco: `select status, merchant_id is not null as tem_merchant from ifood_conexoes;` → `ativa`, `true`. `select app_type, status from ifood_credenciais;` → linhas `ativa`. `select status from ifood_oauth_sessoes;` → `authorized` (nenhuma `pending` velha com verifier). `select authorization_code_verifier_cifrado from ifood_oauth_sessoes;` → **NULL** em todas as concluídas.
- [ ] Nos logs do Render: procurar por `[ifood]` → conferir que **nenhuma linha** contém token, secret, `authorizationCode` ou verifier (tudo deve aparecer como `[REDACTED]` ou mascarado).
- [ ] Testar **Desconectar** → confirma o aviso sobre o Portal do Parceiro → tela volta a "Não conectado". No banco: `ifood_conexoes.status = 'revogada'`, `ifood_credenciais` da conexão **apagadas**.
- [ ] (opcional) Reconectar para confirmar que uma nova conexão é criada sem esbarrar em duplicidade do merchant.
```
