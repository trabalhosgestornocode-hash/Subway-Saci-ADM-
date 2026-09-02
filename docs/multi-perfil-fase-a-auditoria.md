# Multi-perfil por conta de acesso — Fase A (Auditoria)

**Status:** auditoria concluída, nenhum código/banco/migration alterado. Aguardando aprovação para a Fase B.
**Data:** 2026-09-01

---

## 1. Resumo executivo

O sistema já tem **duas camadas de sessão independentes** — identidade (Supabase Auth) e contexto de empresa (Context Token próprio). Isso é exatamente o alicerce que a evolução multi-perfil precisa. O trabalho **não é reescrever autenticação**; é **inserir uma camada de "perfil operacional" entre a conta e o contexto**, e **remover um único comportamento** que hoje impede sessões simultâneas.

**Veredito:** a evolução é viável sem quebrar a arquitetura atual, com **1 migration nova** e **sem migração de dados nas ~19 tabelas de domínio** — desde que se adote o truque de reaproveitar o UUID da conta como id do primeiro perfil (detalhado na seção 8).

**O maior risco** é o comportamento em `criarSessao()` que **revoga todas as sessões do usuário** a cada seleção de contexto (`sessao.service.js:527`). É ele que hoje quebraria a REGRA 7/8. Precisa passar a revogar por `perfil_id`, não por `usuario_id`.

---

## 2. Como a autenticação funciona hoje

### 2.1. Duas perguntas, dois mecanismos

| | QUEM é você | ONDE você está |
|---|---|---|
| Mecanismo | Supabase Auth (JWT) | "Context Token" (HMAC-SHA256 próprio) |
| Emitido por | Supabase (`signInWithPassword`, client-side) | Backend, após validar vínculo (`emitirContextToken`) |
| Middleware | `requireAuth` → `req.user` | `requireContexto` → `req.tenant` + `req.acesso` |
| Storage no browser | `localStorage` (supabase-js, `persistSession`) | `sessionStorage` `cd.contextToken` (**por aba**) |
| Header | `Authorization: Bearer <jwt>` | `x-context-token: <token>` |
| Lastro no banco | `auth.users` + `perfis` | linha viva em `sessoes_contexto` (relida a cada request pelo `sid`) |
| Validade | JWT curto, refresh automático pelo supabase-js | 8h (1h em impersonação) |
| Revogação | `admin/users/:id/logout` (GoTrue) | `update sessoes_contexto set revogada_em` |
| Falha → HTTP | 401 (`app:sessao-expirada` → tela de login) | 409 (`app:contexto-invalido` → tela de seleção) |

**Arquivos-chave:**
- `backend/src/middlewares/auth.js` — `requireAuth`, `requireContexto`, `requireSuperadmin`, `requirePermissao`, `requireModulo`, `requirePapel`, `exigirSenhaDefinitiva`
- `backend/src/shared/contextToken.js` — `emitirContextToken`, `verificarContextToken` (payload `{v, sub, sid, cid, uid, role, perms, imp, iat, exp}`)
- `backend/src/modules/sessao/sessao.service.js` — `selecionarContexto`, `trocarUnidadeDoContexto`, `criarSessao`, `revogarSessoes`, `encerrarContexto`, `listarAcessos`, `listarUnidadesContexto`, `contextoAtual`, `definirNovaSenha`
- `backend/src/modules/sessao/{sessao.routes.js, sessao.controller.js}`
- `backend/src/app.js` — `GET /api/v1/me` devolve `req.user` cru
- `frontend/src/sessao.js` — `login`, `carregarIdentidade`, `restaurarSessao`, `restaurarContexto`, `selecionarContexto`, `aplicarContexto`, `trocarUnidadeDoContexto`, `logout`, `pode`, `temModulo`
- `frontend/src/supabaseClient.js` — `getSupabase` (`persistSession:true`, `autoRefreshToken:true`), `tokenAtual`
- `frontend/src/app.js` — `encaminhar()` (o roteador de telas pós-login), `mostrarApp`, `mostrarSelecao`
- `frontend/src/selecaoAmbiente.js` — tela "Qual unidade deseja acessar?" (cards por empresa)
- `frontend/src/contextoEscopo.js` — geração de contexto (anti-corrida em troca de unidade)

### 2.2. JWT / refresh token

- 100% gerido pelo **supabase-js no browser** (`localStorage`, `autoRefreshToken`). O backend **nunca vê senha nem refresh token** — só valida o access token via `supabase.auth.getUser(token)` a **cada requisição** (`requireAuth`).
- O backend **não tem rota `/login`**. Login é `sb.auth.signInWithPassword` no cliente.
- **`GET /api/v1/me`** = `res.json({ data: req.user })` — devolve `{ id, email, nome, superadmin, ativo, senhaProvisoria }`. Nenhuma empresa.
- **Consequência importante para o projeto:** o refresh do JWT **não toca o Context Token**. Logo, se o perfil viver no Context Token, a **REGRA 12 (refresh preserva o perfil) já é satisfeita de graça**.

### 2.3. Fluxo de login (frontend `app.js#encaminhar`)

1. `signInWithPassword` → `carregarIdentidade()` (`GET /me`)
2. `precisaDefinirSenha()` → tela "definir senha" (senha provisória bloqueia toda a API menos `/me` e `/sessao/senha`)
3. `restaurarContexto()` — se há Context Token no `sessionStorage`, valida em `GET /sessao/atual` → entra direto no app
4. `listarAcessos()` → `GET /sessao/acessos` (empresas/unidades vinculadas + flag superadmin)
5. superadmin **sem vínculo** (ou preferindo) → painel SuperAdmin (`abrirPainelAdmin`)
6. exatamente **1 acesso** → `selecionarContexto` automático → app
7. **2+ acessos** → tela de seleção (`montarSelecao` de `selecaoAmbiente.js`)
8. escolha → `POST /sessao/selecionar` → `selecionarContexto()` → `criarSessao()` → Context Token → `mostrarApp()`

> **É exatamente entre o passo 1 e o passo 4 que entra "Selecione seu usuário".**

### 2.4. `sessoes_contexto` — a sessão de contexto (migration 020)

```
id                uuid pk            -- este é o `sid` do token
usuario_id        uuid  → auth.users(id) ON DELETE CASCADE
organizacao_id    uuid  → organizacoes(id) ON DELETE CASCADE
unidade_id        uuid  → unidades(id) ON DELETE SET NULL
papel             papel_acesso NOT NULL
permissoes        jsonb                -- snapshot (calculado de permissoesDoPapel)
modulos           jsonb                -- snapshot (migration 030)
impersonado_por   uuid  → auth.users(id) ON DELETE SET NULL
ip, user_agent    text
criada_em, ultimo_uso_em, expira_em, revogada_em, motivo_revogacao
```

**Não há UNIQUE/constraint impedindo múltiplas linhas vivas por `usuario_id`.** Fisicamente, sessões simultâneas já são possíveis — só o código as impede (ver 3.1).

---

## 3. Blockers — o que impede a feature hoje

### 3.1. `criarSessao()` revoga TODAS as sessões do usuário  ⚠️ **CRÍTICO**

`backend/src/modules/sessao/sessao.service.js:527`:
```js
await revogarSessoes({ usuarioId, motivo: impersonadoPor ? "impersonacao" : "novo_contexto" });
```
Todo `selecionarContexto`, `trocarUnidadeDoContexto` e `entrarComoEmpresa` chamam `criarSessao`, que **primeiro apaga qualquer sessão viva daquele `usuario_id`**. Comentário no código: *"o usuário tem um contexto por vez"*.

→ Com o login compartilhado, Fulana 2 fazendo login **derruba a sessão da Fulana 1**. Quebra REGRA 7, 8, 9, 10.
→ **Correção:** revogar por `{ perfil_id, ... }` em vez de `{ usuario_id }`. Cada perfil segue com "um contexto por vez" (troca de unidade ainda limpa o anterior), mas perfis irmãos da mesma conta ficam intactos.

### 3.2. Supabase Auth = 1 `auth.users` por e-mail

E-mail é único em `auth.users`. Um login compartilhado é **uma** linha → **um** `req.user.id`. O "perfil" **não pode** morar no Supabase Auth — tem que ser uma camada nova, chaveada pelo `auth.users.id` da conta.

### 3.3. Context Token e `sessoes_contexto` não têm perfil

Payload do token: `{v, sub, sid, cid, uid, role, perms, imp, iat, exp}` — sem `pid`. `sessoes_contexto` sem `perfil_id`. Precisam ganhar isso.

### 3.4. Vínculos são chaveados por `usuario_id = auth.users.id` (= conta)

`usuarios_organizacoes` e `usuarios_unidades`:
```
usuario_id uuid NOT NULL → auth.users(id) ON DELETE CASCADE
UNIQUE (usuario_id, organizacao_id)   -- resp. (usuario_id, unidade_id)
papel papel_acesso                    -- 'organization_admin' | 'unit_manager' | 'finance' | 'operations' | 'viewer'
ativo boolean
```
Se dois perfis da mesma conta têm empresas/cargos diferentes, o vínculo tem que ser **por perfil**. (Ver seção 8 para a estratégia sem migração de dados.)

### 3.5. `req.user.id` é usado como "a pessoa" em todo lugar

| Lugar | Uso hoje | Depende de |
|---|---|---|
| `listarAcessos({ usuarioId: req.user.id })` | vínculos da pessoa | perfil |
| `revogarSessoes({ usuarioId })` | derrubar sessões da pessoa | perfil |
| `auditar({ atorId: req.user.id })` | quem fez a ação | perfil (REGRA 14) |
| domínio: `insert ... usuario_id: <perfil>` | quem lançou/criou | perfil (opcional — ver 3.7) |
| `atualizarUsuario`/`atualizarVinculo` — guarda `id === req.user.id` | anti-auto-rebaixamento | perfil |
| `forcarLogout`, "usuários online" (`obterUsuario`, `listarUsuarios`) | contagem/kill por pessoa | perfil |
| `entrarComoEmpresa` (impersonação) | sessão do superadmin | conta (perfil = null) |

### 3.6. Auditoria grava `ator_id = req.user.id` (conta)

`shared/auditoria.js#contextoDaRequisicao` → `atorId: req.user?.id`. `plataforma_auditoria` (append-only, mas `ADD COLUMN` é permitido) precisa de `perfil_id` + o nome do perfil em `detalhes`. Threading via `req.acesso.perfilId`.

### 3.7. ~29 colunas de domínio `→ perfis(id)`

19 migrations + `schema.sql` têm colunas `usuario_id` / `criado_por` / `confirmado_por` / `atualizado_por_id` / `classificacao_override_usuario_id` com `references perfis(id) ON DELETE SET NULL`:

```
002 produto_historico       017 martin_brower (x3)      021 insumos_ficha_cmv
023 dashboard_executivo (x2) 024 modelo_logistico_ifood  025 unidades_teste_e_reset
026 lancamento_mensal        027 exclusao_lancamento      028 bonificacao_mensal (x2)
032 bonificacao_exclusoes    033 lancamento_mensal_ger (x2) 037 parser_fd (x2)
042 bonificacao_indic_manual 046 parser_fd_classificacao  048 agente_conversas
049 agente_uso               051 tabela_comercial_hist    052 super_restaurante_rev
056 ifood_integracao (x2)    schema.sql
```
**Decisão pendente:** manter `usuario_id = conta` nessas tabelas (zero migração, "quem fez" vem do log de auditoria), **ou** adicionar `perfil_id` incremental onde importa (Dashboard Executivo, Bonificação, Parser, Agente). Recomendação: manter como está + auditoria por perfil; evoluir tabela a tabela só se o cliente pedir "quem lançou este dia" na própria tela.

### 3.8. Frontend — tela de seleção de perfil (não existe)

`app.js#encaminhar` precisa de um passo novo. `selecaoAmbiente.js` (cards por empresa, busca, recentes) é o padrão a reaproveitar.

### 3.9. Telas de "Novo usuário" — 2 lugares

- **Painel SuperAdmin:** `frontend/src/adminViews.js#formUsuario` + `viewUsuarios` + `abrirDetalheUsuario` — o modal com "Empresas e cargos" (checkbox + `<select>` de cargo por empresa). Endpoint `POST /plataforma/usuarios` → `plataforma.usuarios.service.js#criarUsuario`.
- **Tenant (Configurações → Usuários):** `frontend/src/configuracoes.js` (campos `nu-nome`/`nu-email`/`nu-senha`/`papel`) → `POST /api/v1/usuarios` → `usuarios/usuarios.service.js#criarUsuario` (que já detecta e-mail existente e vira "concessão de acesso").

### 3.10. PIN — infra inexistente

Não há tabela de rate-limit / tentativas em nenhum lugar do projeto. PIN com proteção anti-brute-force é uma **sub-fase própria** (Fase H). A arquitetura de perfil já deixa o `pin_hash` + `pin_tentativas` + `pin_bloqueado_ate` previstos na tabela nova; a validação e o lockout entram na Fase H.

---

## 4. O que joga a favor (simplificações)

- **O frontend NUNCA lê tabelas do Supabase direto** (`grep '.from(' frontend/src` = 0). Só usa Supabase para Auth. Todo dado de tenant passa pelo backend com `service_role`.
  → **RLS está dormente para o app.** Os helpers `auth_organizacao_ids()` / `auth_unidade_ids()` / `is_platform_superadmin()` (baseados em `auth.uid()`) **não precisam ser reescritos** para o app continuar funcionando. (Ainda vale ajustá-los por defesa em profundidade — ver R1/R2.)
- **A camada de Context Token JÁ É o mecanismo de isolamento de sessão.** Cada `sessoes_contexto` é independente, o token vive por aba (`sessionStorage`). Só o item 3.1 impede a concorrência.
- **Refresh de JWT não mexe no Context Token** → REGRA 12 satisfeita automaticamente.
- **Impersonação já é "superadmin agindo como ele mesmo num contexto de cliente"** — o modelo (`sessoes_contexto.impersonado_por`, sem "login como outra pessoa") encaixa direto; superadmin só não ganha a camada de perfil.
- **`permissoesDoPapel(papel)` não muda** — permissão continua derivando de `papel`, que passa a ser por-perfil-por-empresa.

---

## 5. Modelo de dados recomendado

Manter as duas camadas; **inserir "perfil operacional" entre conta e contexto**.

```
auth.users (Supabase)        CONTA DE ACESSO — e-mail + senha, 1 por e-mail. INALTERADA.
        │ 1:1
   perfis (existente)         Espelho de exibição da conta (nome/e-mail). Vira, conceitualmente,
        │                     "conta de acesso". Tabela mantida (FK-alvo de tudo).
        │ 1:N
   perfis_operacionais (NOVA) PERFIL DE USUÁRIO — a pessoa
        ├── id uuid pk
        ├── conta_id uuid → perfis(id) ON DELETE CASCADE
        ├── nome text NOT NULL
        ├── ativo boolean NOT NULL default true
        ├── pin_hash text            (Fase H — coluna já criada, nullable)
        ├── pin_tentativas int       (Fase H)
        ├── pin_bloqueado_ate timestamptz  (Fase H)
        ├── created_at / updated_at
        └── UNIQUE (conta_id, nome)   -- opcional

   usuarios_organizacoes   → passa a referenciar perfil_id (ver seção 8)
   usuarios_unidades       → idem
   sessoes_contexto        → + perfil_id → perfis_operacionais(id)
   plataforma_auditoria    → + perfil_id  (+ detalhes.perfil_nome)
   Context Token payload   → + pid   (VERSAO 1 → 2)
```

### Nomenclatura (proposta)
- **Conta de acesso** = `auth.users` + `perfis` (o par e-mail/senha).
- **Perfil** / **perfil operacional** = `perfis_operacionais` (a pessoa).
- No código: `req.user` continua sendo a **conta**; novo `req.perfil = { id, nome }` e `req.acesso.perfilId`.
- Evitar "usuário" solto daqui pra frente — usar "conta" ou "perfil".

---

## 6. Fluxo de autenticação novo

```
1. signInWithPassword (cliente)                → JWT (conta)
2. GET /sessao/perfis                           → [{id, nome, empresasResumo}]  (perfis_operacionais ativos da conta)
   │
   ├── 0 perfis      → conta sem perfil: tela "fale com o administrador" (já existe p/ "sem empresa")
   ├── 1 perfil      → auto-seleciona, segue SEM tela extra   (REGRA 6 / 15)
   └── 2+ perfis     → tela "Selecione seu usuário"
3. (2+) usuário escolhe Fulana 1
4. (se pin_hash != null) POST /sessao/selecionar-perfil {perfilId, pin}  → valida conta+ativo+PIN
5. GET /sessao/acessos?perfilId=…               → vínculos DAQUELE perfil
6. POST /sessao/selecionar {organizacaoId, unidadeId, perfilId}
   → selecionarContexto valida: perfilId pertence à conta? perfil ativo? org ∈ vínculos do perfil? PIN ok?
   → criarSessao({contaId, perfilId, …}) → Context Token com `pid`
```

### Estado intermediário seguro (sem token temporário novo)

O requisito "não entregar token operacional antes de escolher o perfil" **já é atendido pela arquitetura atual**: entre o passo 1 e o 6 o cliente tem só o JWT, e **`requireContexto` bloqueia toda rota de tenant com 409 enquanto não houver Context Token**. As rotas de perfil (`/sessao/perfis`, `/sessao/selecionar-perfil`) ficam no `sessaoRouter`, que **não exige contexto** (igual `/sessao/acessos` hoje). Não é preciso inventar um token temporário — o "autenticado sem contexto" **é** o estado limitado.

Validação server-side no `selecionar-perfil` / `selecionar` (REGRA 10):
- `perfil_id` pertence a `perfis_operacionais WHERE conta_id = req.user.id`
- perfil `ativo = true`
- PIN confere (Fase H)
- a empresa/unidade escolhida ∈ vínculos **do perfil** (não da conta)

---

## 7. Sessões simultâneas + refresh + logout

| Regra | Como fica |
|---|---|
| **7/8** sessões independentes | `criarSessao` → `revogarSessoes({ perfilId, … })` (não `usuarioId`). `sessoes_contexto` já suporta N linhas vivas. |
| **9** identidade em toda operação | `req.perfil` setado por `requireContexto` a partir de `sessoes_contexto.perfil_id`. |
| **11** troca de empresa respeita o perfil | `trocarUnidadeDoContexto`/`selecionarContexto` filtram vínculos por `perfil_id`. |
| **12** refresh preserva o perfil | Automático — o perfil está no Context Token, que o refresh do JWT não toca. |
| **13** logout normal derruba só a sessão atual | `encerrarContexto` → `revogarSessoes({ sessionId })` (hoje é `{ usuarioId }` — **mudar**). Logout do Auth (`sb.auth.signOut`) só quando a **conta inteira** sai (aí derruba todos os perfis daquele login — é o comportamento correto: a credencial saiu). |
| "usuários online" | contar por `perfil_id`. |
| `forcarLogout` (superadmin) | contexto: por perfil; Auth-level (`admin/users/:id/logout`) mata a conta toda (todos os perfis). **Decisão:** oferecer "derrubar este perfil" (contexto) vs "derrubar a conta" (Auth). |

---

## 8. Migration — estratégia sem migração de dados (o truque)

**Problema:** `usuarios_organizacoes.usuario_id`, `usuarios_unidades.usuario_id` e ~29 colunas de domínio referenciam `perfis(id)` (= `auth.users.id`). Trocar para `perfil_id` parece exigir reescrever milhares de linhas.

**Solução:** ao fazer o backfill, **criar o primeiro perfil de cada conta com `perfis_operacionais.id = perfis.id`** (o mesmo UUID da conta). Então:
- todo `usuario_id` já existente em `usuarios_organizacoes` / `usuarios_unidades` **já é** um `perfil_id` válido — **zero UPDATE de dados**, só repontar a FK;
- todas as ~29 colunas de domínio continuam válidas como referência ao perfil sem tocar em nenhuma linha;
- `sessoes_contexto` vivas: revogar todas na migration (comportamento aceitável — todo mundo refaz login/seleção uma vez).

**Migration `060_perfis_operacionais.sql` (rascunho conceitual, a detalhar na Fase B):**
```sql
-- 1. tabela nova
create table perfis_operacionais (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references perfis(id) on delete cascade,
  nome text not null,
  ativo boolean not null default true,
  pin_hash text, pin_tentativas int not null default 0, pin_bloqueado_ate timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_perfis_op_conta on perfis_operacionais(conta_id);

-- 2. backfill DETERMINÍSTICO: 1 perfil por conta, id == id da conta
insert into perfis_operacionais (id, conta_id, nome, ativo)
select p.id, p.id, coalesce(p.nome, split_part(coalesce(p.email,''),'@',1), 'Usuário'), coalesce(p.ativo, true)
from perfis p
on conflict (id) do nothing;

-- 3. vínculos: adiciona perfil_id, backfill = usuario_id, FK nova
alter table usuarios_organizacoes add column perfil_id uuid;
update usuarios_organizacoes set perfil_id = usuario_id;
alter table usuarios_organizacoes alter column perfil_id set not null,
  add constraint uo_perfil_fk foreign key (perfil_id) references perfis_operacionais(id) on delete cascade,
  add constraint uo_perfil_unico unique (perfil_id, organizacao_id);
-- usuario_id mantido durante a transição (dropar em migration posterior)

-- (idem usuarios_unidades)

-- 4. sessão + auditoria
alter table sessoes_contexto add column perfil_id uuid references perfis_operacionais(id) on delete cascade;
update sessoes_contexto set perfil_id = usuario_id where revogada_em is null;  -- ou revoga todas
alter table plataforma_auditoria add column perfil_id uuid;  -- append-only permite ADD COLUMN

-- 5. helper RLS (defesa em profundidade)
create or replace function conta_do_perfil(p uuid) returns uuid
  language sql stable security definer set search_path=public as $$
  select conta_id from perfis_operacionais where id = p $$;
```

**Rollback:** dropar `perfil_id` das 4 tabelas + `drop table perfis_operacionais`. `usuario_id` nunca foi removido → volta tudo. Auditoria: coluna extra fica (append-only), inofensiva.

---

## 9. Riscos

| # | Sev | Risco | Mitigação |
|---|---|---|---|
| R1 | Alta | RLS `rls_uo_self`/`rls_uu_self` usam `usuario_id = auth.uid()`. Com `perfil_id`, perfis não-primários quebram a policy. | Frontend não lê essas tabelas direto → impacto real nulo. Ainda assim: trocar policy p/ `conta_do_perfil(perfil_id) = auth.uid()`. **Não esquecer.** |
| R2 | Alta | `auth_organizacao_ids()` / `auth_unidade_ids()` passariam a devolver as orgs de **todos** os perfis da conta se o join for ingênuo. | Dormente (frontend não usa). Documentar. Se algum dia o front consultar direto, filtrar por perfil ativo na sessão. |
| R3 | Média | Se **não** reaproveitar o id da conta como id do 1º perfil → migração de dados nas 29 colunas + repontar FKs. | Adotar o truque da seção 8. |
| R4 | Média | `obterUsuario` / `listarUsuarios` (painel) contam sessões/online por `usuario_id`. | Passar a agrupar por `perfil_id`; a tela de conta lista perfis, cada um com suas sessões. |
| R5 | Média | `forcarLogout` + `encerrarSessoesAuth`: logout no Auth é **por conta** — derruba todos os perfis daquele login. | Separar "derrubar perfil" (revoga contexto) de "derrubar conta" (revoga Auth). |
| R6 | Média | Guardas anti-auto-rebaixamento (`id === req.user.id`) em `usuarios.service.js` e `plataforma.usuarios.service.js`. | Trocar para `perfilId === req.perfil.id` onde a semântica é "a pessoa logada". |
| R7 | Baixa | `perfis.senha_provisoria` é da conta (compartilhada) — bloqueia todos os perfis até alguém trocar. | Aceitável (é a credencial). Documentar. |
| R8 | Baixa | Mesmo navegador, 2 abas: sessão Supabase (localStorage) é compartilhada; Context Token (sessionStorage) é por aba. Funciona; refresh do JWT numa aba vale para a outra. | Cenário do pedido é "2 computadores" — OK. Anotar a borda "mesmo navegador". |
| R9 | Baixa | Backfill precisa inserir `id` explícito (não o `gen_random_uuid()` default). | Trivial no INSERT ... SELECT. |
| R10 | Média | Superfície de testes: 11 arquivos de isolamento/sessão + `context-token` + `usuarios-listar-vinculos` assertam em `usuario_id`. | Atualizar + novos testes (seção 11). |
| R11 | Média | `entrarComoEmpresa` / `trocarUnidadeDoContexto` (impersonação) chamam `criarSessao` → hoje revogam por `usuarioId`. Superadmin em 2 máquinas se derrubaria. | Revogar por `perfil_id` (null para superadmin) OU por `(usuario_id, impersonado_por is not null)`. Definir na Fase D. |
| R12 | Baixa | `plataforma_auditoria` é append-only por trigger. `ALTER TABLE ADD COLUMN` **é permitido** (o trigger só barra UPDATE/DELETE/TRUNCATE). Confirmado na migration 020. | Sem ação — só registrar que foi verificado. |

---

## 10. Arquivos envolvidos (Fases B–J)

### Banco
- **NOVO** `database/migrations/060_perfis_operacionais.sql` (Fase B)
- **NOVO** `database/migrations/061_perfil_pin.sql` (Fase H) — se as colunas de PIN não entrarem já na 060
- `database/schema.sql` — nota de referência (não é backfillado desde a 020, mas o comentário de `perfis` deve mencionar `perfis_operacionais`)

### Backend
| Arquivo | Mudança |
|---|---|
| `src/middlewares/auth.js` | `requireContexto`: ler `sessao.perfil_id`, setar `req.perfil` + `req.acesso.perfilId`. `requirePermissao/requireModulo/requirePapel`: sem lógica nova. |
| `src/shared/contextToken.js` | payload `+ pid`; `VERSAO` 1 → 2; `verificarContextToken` valida `pid`. |
| `src/modules/sessao/sessao.service.js` | `criarSessao(+perfilId, revogação por perfil)`, `selecionarContexto(+perfilId, valida vínculo do perfil)`, `trocarUnidadeDoContexto`, `listarAcessos(+perfilId)`, `revogarSessoes(+perfilId)`, `encerrarContexto` (por sessionId), `contextoAtual` (+perfil). **NOVO** `listarPerfisDaConta`, `selecionarPerfil` (valida + PIN). |
| `src/modules/sessao/sessao.routes.js` | **NOVO** `GET /sessao/perfis`, `POST /sessao/selecionar-perfil`. `/sessao/selecionar` ganha `perfilId` no corpo. |
| `src/modules/sessao/sessao.controller.js` | handlers novos. |
| `src/modules/plataforma/plataforma.usuarios.service.js` | CRUD conta + perfis; `obterUsuario`/`listarUsuarios` (perfis, sessões por perfil). |
| `src/modules/plataforma/plataforma.usuarios.controller.js` + `.routes.js` | endpoints de perfil. |
| `src/modules/plataforma/plataforma.empresas.service.js` | `entrarComoEmpresa` — `perfil_id = null`. |
| `src/modules/usuarios/{usuarios.service.js, .controller.js, .routes.js}` | gestão de acesso do tenant — vínculo por `perfil_id`. |
| `src/shared/auditoria.js` | `contextoDaRequisicao(+perfilId)`, `auditar(+perfil_id, detalhes.perfil_nome)`. |
| `src/shared/permissoes.js` | verificar (esperado: sem mudança). |
| `src/app.js` | `/me` pode devolver `temMultiplosPerfis` como dica (opcional). |
| `src/modules/agente/agenteAcesso.js` | lê `req.acesso` — sem mudança. |

### Frontend
| Arquivo | Mudança |
|---|---|
| `src/sessao.js` | `login` (não seleciona contexto), **NOVO** `listarPerfis`/`selecionarPerfil`, `aplicarContexto(+perfil)`, `pode`/`temModulo` (sem mudança). |
| `src/state.js` | `state.sessao.perfil`, `state.sessao.perfisDisponiveis`. |
| `src/app.js` | `encaminhar()` — inserir passo de perfil; **NOVO** `mostrarSelecaoPerfil()`. |
| `src/selecaoAmbiente.js` **ou NOVO** `src/selecaoPerfil.js` | tela "Selecione seu usuário" (cards: nome + empresa(s) resumo; estados loading/erro/PIN inválido/perfil desativado). |
| `src/adminViews.js` | `formUsuario`/`viewUsuarios`/`abrirDetalheUsuario` → "Nova conta de acesso" + "Usuários desta conta" (add/editar/ativar/desativar perfil, empresas+cargo por perfil, PIN). |
| `src/adminApi.js` | endpoints de perfil. |
| `src/configuracoes.js` | "novo usuário" do tenant (`nu-*`) → conta + perfil. |
| `src/adminEmpresaDetalhe.js` | aba "Usuários" (read-only) — mostrar perfil + conta. |
| `index.html` / `styles.css` | markup/estilo da tela de seleção de perfil (seguir `#selecao-screen`). |

### Testes
- Atualizar: `backend/test/context-token.test.js`, `sessao-heranca-empresa-unidade.test.js`, `sessao-heranca-integracao.test.js`, `sessao-unidades-contexto.test.js`, `usuarios-listar-vinculos.test.js`, `isolamento-tenant.test.js`, `isolamento-martinbrower.test.js`, `isolamento-configuracoes-http.test.js`, `agente-conversas-isolamento.test.js`, `estrutura-organizacional.test.js`
- **Novos:** `perfis-multi.test.js` (backfill/1 conta N perfis), `sessao-perfil.test.js` (seleção + validação de posse), `sessoes-simultaneas.test.js` (REGRA 7–10), `perfil-pin.test.js` (Fase H), `frontend/test/selecaoPerfil.test.js`

---

## 11. Mapa de FKs / dependências

```
auth.users(id)
 ├─ perfis.id                         (1:1, CASCADE)            ← alvo das ~29 colunas de domínio
 ├─ usuarios_organizacoes.usuario_id  (CASCADE)  UNIQUE(usuario_id, organizacao_id)
 ├─ usuarios_unidades.usuario_id      (CASCADE)  UNIQUE(usuario_id, unidade_id)
 ├─ plataforma_admins.usuario_id      (CASCADE, PK)
 ├─ sessoes_contexto.usuario_id       (CASCADE)
 ├─ sessoes_contexto.impersonado_por  (SET NULL)
 └─ plataforma_acessos.superadmin_id  (CASCADE)

perfis(id)  ← 29 colunas ON DELETE SET NULL:
  usuario_id / criado_por / confirmado_por / atualizado_por_id / classificacao_override_usuario_id
  (produto_historico, martin_brower x3, insumos_ficha, dashboard_executivo x2, modelo_logistico_ifood,
   unidades_teste, lancamento_mensal x3, exclusao_lancamento, bonificacao x4, parser_fd x3,
   agente_conversas, agente_uso, tabela_comercial_hist, super_restaurante_rev, ifood x2)

SEM FK (guardam auth.users.id como texto/uuid solto):
  plataforma_auditoria.ator_id, .impersonado_por
  organizacao_modulos.habilitado_por
  unidade_modulos.habilitado_por
  unidade_config.atualizado_por

Funções SECURITY DEFINER (RLS) baseadas em auth.uid():
  is_platform_superadmin()   auth_organizacao_ids()   auth_unidade_ids()
```

---

## 12. Recomendação final

1. **Adotar** o modelo da seção 5 (`perfis_operacionais` entre conta e contexto) com o **truque do id reaproveitado** (seção 8) — 1 migration, zero migração de dados de domínio, REGRA 15 satisfeita por construção.
2. **Manter** `usuario_id` = conta nas 29 colunas de domínio; a identidade da pessoa em ações vem da **auditoria por `perfil_id`** (seção 3.6). Revisitar tabela a tabela só sob demanda do cliente.
3. **Fase D (sessões)** é o coração: trocar `revogarSessoes({usuarioId})` por `{perfilId}` em `criarSessao`, `encerrarContexto` (por `sessionId`), e revisar impersonação (R11).
4. **PIN** como **Fase H** separada — colunas já previstas na 060, validação + lockout depois.
5. **RLS** (R1/R2): ajustar os helpers por defesa em profundidade, mesmo estando dormentes.
6. Superadmin/impersonação: **sem camada de perfil**, comportamento preservado.

**Próximo passo:** aprovar para eu detalhar a **Fase B** (DDL final da migration 060 + revisão linha a linha das FKs + plano de rollback).
