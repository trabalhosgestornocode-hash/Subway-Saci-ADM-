# Multi-perfil — Fase G (CRUD administrativo de múltiplos perfis)

**Status:** implementado. **452/452 testes** nas áreas tocadas (31 novos em `perfis-crud-multi.test.js` + 421 de regressão), 3 skipped pré-existentes. Frontend: 193/193. **Nenhum deploy. Nenhuma migration aplicada. Nenhuma escrita em banco de produção.**
**Data:** 2026-09-02
**Escopo:** backend (service + endpoints SuperAdmin) + frontend (seção "Usuários desta conta" no detalhe do usuário, sem redesenho). Sem tela "Selecione seu usuário" (Fase F).

---

## A. Modelo administrativo

```
CONTA DE ACESSO  (perfis / auth.users)          1 e-mail + 1 senha + N perfis
   id, nome, e-mail, senha, ativo               "Operacional X"
   │
   ├── PERFIL OPERACIONAL  (perfis_operacionais) ← a PESSOA
   │     id (UUID), conta_id → perfis(id), nome, ativo, pin_hash
   │     "Fulana 1"  — PIN 1111
   │        └── vínculos: usuarios_organizacoes / usuarios_unidades  (perfil_id)
   │              Empresa A — Operação
   │
   └── PERFIL OPERACIONAL
         "Fulana 2"  — PIN 2222
            └── Empresa B — Gerência
```

**Invariantes (pontos 1/9/22):**
- 1 `auth.users`, 1 e-mail, 1 senha por conta — o 2º perfil é **só uma linha** em `perfis_operacionais`. Nenhum endpoint da Fase G chama `auth.admin.createUser`.
- Perfil legado (backfill 060): `id == conta_id`. Perfis adicionais: **UUID novo** (`gen_random_uuid()` — nunca reaproveita `conta_id`).
- `usuario_id` (LEGACY) dos vínculos de um 2º perfil = `conta_id` (satisfaz a FK → `auth.users` e o `NOT NULL`); `perfil_id` (CANÔNICO) = o UUID novo.

---

## B. UI — conta + usuários

**"Novo usuário" → "Nova conta de acesso"** (`adminViews.js`): cria a conta (e-mail/senha) + o 1º perfil + vínculos (fluxo atual, inalterado). Toast agora avisa que mais usuários são adicionados pelo detalhe.

**Detalhe da conta** — nova seção **"Usuários desta conta"** (renderizada de `GET /usuarios/:id/perfis`):
- 1 card compacto por perfil: nome, `Ativo/Inativo`, `PIN configurado / não configurado` (**nunca o PIN nem o hash**), empresas+cargos, `usuário inicial` quando `id == conta`.
- Ações por card: **[Renomear]** · **[Definir/Resetar PIN]** · **[Ativar/Desativar]**.
- **[+ Adicionar usuário]** → modal (nome, PIN, empresas+cargos; se algum perfil existente estiver sem PIN, o modal pede o PIN dele junto).
- Aviso vermelho quando a conta é multi-perfil e a config de PIN está incompleta.
- "Empresas/Unidades associadas" ganham o rótulo *(do usuário inicial)* quando a conta é multi-perfil.

Não redesenha o sistema (ponto 25). Termos técnicos (`perfil_operacional`, `account_id`) não aparecem na UI (ponto 27).

---

## C. Criação do 2º perfil — `criarPerfilNaConta` (fluxo transacional)

`POST /plataforma/usuarios/:contaId/perfis` — body `{ nome, pin, empresas:[{organizacaoId,papel}], unidades?:[{unidadeId,papel}], ativo?, pinsPerfisExistentes?:[{perfilId,pin}] }`.

```
0. VALIDA TUDO antes de qualquer escrita:
     conta existe? nome ok? PIN do novo perfil no formato (4–6 dígitos)?
     todas as organizações existem?
1. A conta VAI ter 2+ perfis ativos?  (existentes ativos + este, se ativo)
     SIM e algum perfil ativo existente SEM PIN:
        - o PIN dele veio em `pinsPerfisExistentes`?  não -> 409 PIN_PENDENTE_PERFIS_EXISTENTES
          (payload traz a lista de perfis pendentes; a UI os coleta no mesmo form)
2. cria o perfil            (perfis_operacionais, UUID novo)
3. cria os vínculos          (inserirVinculoOrgComPerfil / ...UnidadeComPerfil, perfil_id = novo)
4. grava o PIN do novo perfil (definirPinDoPerfil, revogarSessoesDoPerfil:false — não tem sessão)
5. grava o PIN dos perfis existentes que faltavam
────────────────────────────────────────────────────────────
QUALQUER falha em 3/4/5  ->  DELETE do perfil recém-criado (CASCADE remove os vínculos)
                             + re-lança o erro. A conta volta EXATAMENTE ao estado anterior.
```

**Por que a compensação é segura** (ponto 3): o perfil recém-criado não tem histórico, sessões nem PIN antigo — apagá-lo por completo é limpo. O resultado é sempre **(a) nada criado** ou **(b) tudo criado, ambos os perfis com PIN**. Nunca "2 ativos, um sem PIN".

Não há transação SQL entre chamadas PostgREST; a compensação é o equivalente seguro (ponto 3, última frase).

---

## D. PIN (Fase H, reusado)

- **Novo perfil:** PIN obrigatório no `POST` (`validarFormatoPin`).
- **Reset:** `PUT /plataforma/usuarios/:id/perfis/:perfilId/pin { pin }` (Fase H) — novo hash, zera tentativas, limpa bloqueio, revoga as sessões **daquele** perfil. Nunca mostra o PIN anterior (a UI só reseta, nunca lê).
- **Config incompleta:** `resolverPerfilParaContexto` (Fase H) já barra login multi-perfil quando algum perfil ativo não tem PIN; `definirAtivoDoPerfil` barra a **reativação** que deixaria a conta nesse estado.

---

## E. Vínculos

- Criados/lidos por `perfil_id` (canônico). `inserirVinculoOrgComPerfil` / `inserirVinculoUnidadeComPerfil` gravam `usuario_id` (= conta, LEGACY) **+** `perfil_id` (= o perfil).
- **`onConflict` do upsert** passou a mirar a UNIQUE canônica `(perfil_id, X)` (constraint da 063), degradando para `(usuario_id, X)` (015) se a 063 não rodou.
- **Edição de vínculo de um perfil específico:** `atualizarVinculo`, `removerVinculo`, `associarEmpresa`, `associarUnidade`, `atualizarVinculoUnidade`, `removerVinculoUnidade` aceitam um `perfilId` opcional (`body.perfilId` / `opts.perfilId`) — resolvido por `resolverPerfilAlvo(contaId, perfilId)` (valida posse; ausente → perfil inicial). Quando o alvo não é o perfil inicial, a query ganha `.eq("perfil_id", perfilAlvo)` — sem isso, editar o cargo na Empresa A mexeria nos DOIS perfis que estivessem lá.
- **Cargos diferentes na mesma empresa** (Fulana 1 = Operação, Fulana 2 = Gerência na Empresa A) e **empresas diferentes** e **múltiplas empresas por perfil** — todos suportados (pontos 19/20/21).

---

## F. Constraints / migrations

**Nenhuma migration nova.** A **migration 063** (desenhada na Fase E, cabeçalho: *"Pré-requisito para a Fase G"*) É o gate:

| 015 (hoje) | 063 (pendente) |
|---|---|
| `usuarios_organizacoes.perfil_id` NULLABLE | **NOT NULL** (após backfill defensivo) |
| `UNIQUE (usuario_id, organizacao_id)` — auto-nome `..._usuario_id_organizacao_id_key` | **drop** → `UNIQUE (perfil_id, organizacao_id)` (`uo_perfil_org_unico`) |
| `UNIQUE (usuario_id, unidade_id)` | **drop** → `UNIQUE (perfil_id, unidade_id)` (`uu_perfil_uni_unico`) |
| `usuario_id NOT NULL references auth.users` | **mantido** (LEGACY — não removido) |

**Por que 063 é BLOCKER do 2º perfil real** (pontos 12/35): sem ela, Fulana 1 e Fulana 2 na **mesma empresa** teriam `(usuario_id, organizacao_id) = (contaId, A)` idêntico → a UNIQUE legada recusa o segundo INSERT. Com a 063, a chave é `(perfil_id, A)` → `(contaId, A)` vs `(uuidNovo, A)`, distintas.

O backend degrada (onConflict `perfil_id,X` → `usuario_id,X`; insert `perfil_id` → sem) para não quebrar pré-063, mas **a criação de um 2º perfil na mesma empresa que outro perfil da conta só é confiável pós-063**. `criarPerfilNaConta` recusa explicitamente com mensagem clara quando `perfis_operacionais` não existe (pré-060).

RLS: `perfis_operacionais` policy = `conta_id = auth.uid() or is_platform_superadmin()` — a conta lê os próprios perfis; a escrita é service_role. Nada muda na Fase G.

---

## G. Ativação / desativação

`PATCH /plataforma/usuarios/:id/perfis/:perfilId/ativo { ativo }` → `definirAtivoDoPerfil`:

- **Nunca DELETE físico** — só `ativo = false/true` (pontos 15/17).
- **Desativar:** revoga `revogarSessoes({ perfilId, motivo: "perfil_desativado" })` — só aquele perfil; os irmãos seguem.
- **Reativar:** se a conta passaria a ter 2+ ativos e nem todos têm PIN → `403 CONFIGURACAO_PIN_INCOMPLETA` (com a lista `perfisSemPin`) (ponto 16).
- Se após desativar restar 1 perfil ativo → a conta volta ao fluxo single-profile (PIN dos inativos fica salvo).
- Histórico/snapshots do perfil desativado permanecem (FK SET NULL / auditoria) (ponto 19).

Não há "remover perfil" — a UI oferece "Desativar" (ponto 17). `excluirUsuario` (conta) permanece como está: apaga a conta inteira (CASCADE nos perfis).

---

## H. Auditoria

| Ação | `acao` | detalhes |
|---|---|---|
| Perfil criado | `perfil.criado` | `{ conta, nome, empresas:[orgIds], pinsExistentesConfigurados }` |
| Perfil renomeado | `perfil.editado` | `{ conta, nome }` |
| Perfil ativado / desativado | `perfil.ativado` / `perfil.desativado` | `{ conta, sessoesRevogadas }` |
| Vínculo criado/editado/removido | `vinculo.*` (Fase E) | `{ ... }` |
| PIN definido/resetado | `perfil.pin_definido` (Fase H) | `{ conta, sessoesRevogadas }` — **nunca o PIN** |

`ator_id` = a CONTA do SuperAdmin; `ator_tipo` = `superadmin`; `perfil_id` = o perfil do admin (`req.perfil?.id ?? null` — o painel não tem contexto). Nenhuma auditoria da Fase G grava PIN/hash (scan confirma).

---

## I. Endpoints

Todos sob `/api/v1/plataforma` → `requireSuperadmin` (protege o router inteiro — **nenhuma permissão nova**, ponto 23). `:id` = a CONTA; `:perfilId` = o PERFIL.

| Método | Rota | Função |
|---|---|---|
| GET | `/usuarios/:id/perfis` | `perfisDaConta` — perfis + vínculos de cada + `temPin` (nunca o hash) |
| POST | `/usuarios/:id/perfis` | `criarPerfilNaConta` — cria o perfil adicional (transacional) |
| PATCH | `/usuarios/:id/perfis/:perfilId` | `renomearPerfil` — só `nome`, nunca e-mail/senha |
| PATCH | `/usuarios/:id/perfis/:perfilId/ativo` | `alternarAtivoPerfil` |
| PUT | `/usuarios/:id/perfis/:perfilId/pin` | `definirPinPerfil` (Fase H) |
| DELETE | `/usuarios/:id/perfis/:perfilId/pin` | `removerPinPerfil` (Fase H) |

Vínculo (Fase E, agora perfil-aware): `POST/PATCH/DELETE /usuarios/:id/empresas[/:organizacaoId]` e `.../unidades[/:unidadeId]` aceitam `perfilId` opcional no corpo.

**Segurança de posse (ponto 29):** `resolverPerfilAlvo` recusa (`404` genérico) qualquer `perfilId` cujo `conta_id` ≠ `:id` da URL — mesmo para o SuperAdmin, um `perfilId` de outra conta no payload nunca é aceito.

---

## J. Arquivos alterados

**Backend:**
* `src/modules/sessao/perfil.service.js` — `criarPerfilOperacional` (UUID novo), `definirAtivoDoPerfil` (nunca DELETE, revoga só o perfil, gate de PIN na reativação); `inserirVinculoOrg/UnidadeComPerfil` — `onConflict` canônico `(perfil_id, X)` com degrade.
* `src/modules/plataforma/plataforma.usuarios.service.js` — `resolverPerfilAlvo`, `perfisDaConta`, `criarPerfilNaConta` (transacional + compensação), `renomearPerfil`, `alternarAtivoPerfil`; `perfilId` opcional em `associarEmpresa` / `atualizarVinculo` / `removerVinculo` / `associarUnidade` / `atualizarVinculoUnidade` / `removerVinculoUnidade`.
* `src/modules/plataforma/plataforma.controller.js` + `.routes.js` — 4 endpoints novos.
* `src/shared/auditoria.js` — `ACOES.PERFIL_CRIADO/EDITADO/ATIVADO/DESATIVADO`.

**Frontend:**
* `src/adminApi.js` — `perfisDaConta`, `criarPerfil`, `renomearPerfil`, `alternarAtivoPerfil`, `definirPinPerfil`, `removerPinPerfil`.
* `src/adminViews.js` — `cardPerfil`, seção "Usuários desta conta" em `abrirDetalheUsuario`, handlers `perfil-novo` / `perfil-renomear` / `perfil-pin` / `perfil-toggle`; modal "Nova conta de acesso".

**Migrations:** nenhuma nova (063 é o gate).

---

## K. Testes (`perfis-crud-multi.test.js` — 31) + regressão

| Grupo | Testes numerados |
|---|---|
| `criarPerfilOperacional` | 2, 3, 9 (UUID novo, não reaproveita contaId; conta inexistente 404) |
| `definirAtivoDoPerfil` | 15, 16, 17, 18, 19 (desativar revoga só o perfil; reativar sem PIN → 403; nunca DELETE) |
| Segurança de posse | 15, 29 (perfil de outra conta → 404; funções de vínculo escopam por `perfil_id`) |
| `criarPerfilNaConta` | 1, 3, 6, 7, 8, 14, 22, 24, 34 (sem auth.users; PIN obrigatório; PIN pendente → 409; grava PIN de todos; compensação; vínculos por perfil_id; auditoria sem PIN; valida orgs antes) |
| Migration gate 063 | 12, 35 (troca de UNIQUE; mantém usuario_id; degrade onConflict) |
| Endpoints + compat | 21, 23, 28, 31 (rotas; 1 perfil no fluxo antigo; pin_hash nunca retornado; renomear não toca e-mail/senha) |
| Auditoria | 32 (ACOES; nenhuma grava PIN) |

**Caso real (teste 34):** coberto por scan de `criarPerfilNaConta` — o fluxo cria 1 `perfis_operacionais` (UUID novo), N vínculos por `perfil_id`, grava PIN, **não** toca `auth.admin`. Um teste de integração ponta-a-ponta (`1 auth.users / 2 perfis / 2 conjuntos de vínculos`) exige 060+063 num ambiente real — **staging gate**.

**Regressão:** 421 testes das áreas de sessão/perfil/PIN/plataforma/agente/contexto passam. 2 scans da Fase E ajustados (`removerVinculo` usa `perfilAlvo`; helper de vínculo tem o retry de `onConflict`).

---

## L. Staging gate

Sem ambiente com 060/063. **Antes de liberar a Fase G (e a F) em produção:**

1. Staging com schema até 059 → aplica **060** (pré/pós-check).
2. Deploy do backend **C+D+E+I+H+G**.
3. Aplica **062**, depois **063** (pós-check: `select conname from pg_constraint where conname in ('uo_perfil_org_unico','uu_perfil_uni_unico')` → 2 linhas; `perfil_id` NOT NULL nas duas tabelas), depois **064**.
4. Suite de integração completa.
5. **Teste manual do caso real:** criar conta "Operacional X"; no detalhe, "+ Adicionar usuário" Fulana 2 (Empresa B, Gerência, PIN 2222) — informando o PIN 1111 da Fulana 1 no mesmo form. Conferir no banco: `select count(*) from auth.users where email = 'x@…'` = 1; `select count(*) from perfis_operacionais where conta_id = …` = 2; vínculos: `select perfil_id, organizacao_id from usuarios_organizacoes where usuario_id = …` → 2 linhas com `perfil_id` distintos.
6. Login como a conta → tela de seleção (Fase F) → escolher Fulana 2 → PIN 2222 → contexto Empresa B/Gerência. Fulana 1 (PIN 1111) → Empresa A/Operação. Um não vê o outro.
7. Rollback ensaiado (rodapé da 063/064).

**Não executar enquanto o staging não existir.**

---

## M. Blockers

**Para a Fase G:** nenhum — o service, os endpoints e a UI estão prontos e testados por unidade/scan.

**Para produção (registrado):**
* **063 é obrigatória** antes de qualquer 2º perfil na mesma empresa que outro perfil da conta. O backend degrada, mas a UNIQUE legada `(usuario_id, org)` recusaria o INSERT.
* **060** antes de tudo (senão `criarPerfilNaConta` responde 400 explicativo).
* Integração ponta-a-ponta do caso real (teste 34 completo) só é verificável em staging.

---

## N. Veredito

> ## FASE G CONCLUÍDA — APTA PARA A FASE F
>
> O SuperAdmin pode configurar, pela UI e pela API, uma **conta de acesso** ("Operacional X", 1 e-mail, 1 senha) com **N usuários operacionais** — Fulana 1 (PIN, Empresa A, Operação) e Fulana 2 (PIN, Empresa B, Gerência) — **sem criar outro `auth.users`, sem duplicar e-mail, sem compartilhar vínculos**: o 2º perfil é um UUID novo em `perfis_operacionais` da mesma conta, com vínculos próprios por `perfil_id`. A criação é transacional (compensação em falha — nunca "2 perfis ativos, um sem PIN"). Perfis se ativam/desativam sem DELETE; desativar revoga só aquele perfil.
>
> A migration **063** (já desenhada, *"Pré-requisito para a Fase G"*) É o gate de schema — troca `UNIQUE(usuario_id, X)` por `UNIQUE(perfil_id, X)`, permitindo dois perfis da mesma conta na mesma empresa. Nenhuma migration nova foi necessária.
>
> 452/452 testes nas áreas tocadas (31 novos) + 193/193 frontend. Nenhuma migration aplicada, nenhum deploy, nenhuma escrita em produção.
>
> **A próxima fase (F — tela "Selecione seu usuário") é decisão do revisor. Não avancei.**

---

## NÃO FIZ (respeitado)

migration aplicada · produção · deploy · tela "Selecione seu usuário" · alterar login · remover `usuario_id` · duplicar `auth.users` · e-mail por perfil · avançar para F.
