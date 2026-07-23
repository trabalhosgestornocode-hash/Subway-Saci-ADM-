# Integração Martin Brower

Importa o catálogo oficial da distribuidora Martin Brower por **loja**, mantém
histórico de preços pelo **código oficial** e audita cada sincronização.

Estado atual: **Fases 1 e 2 concluídas.** A sincronização automatizada (worker
Playwright, Fase 3) está pronta em contrato mas **desligada** — ver
[Flag e worker](#flag-e-worker).

---

## Hierarquia do tenant

```
organizacao_id   empresa dentro do SaaS
  └─ unidade_id  loja física (tabela `unidades`)
      └─ client_id   a MESMA loja no portal Martin Brower
          └─ order_id    pedido corrente (findProxPedidoV2)
              └─ produtos e preços (loadItens)
```

O produto é identificado por **`organizacao_id + unidade_id + client_id + codigo`**.
`codigo` é o código oficial Martin Brower, guardado como `text` para preservar
zeros à esquerda (`"0002045"`). **Nunca** identifique um produto pela descrição.

### Isolamento

Duas camadas, e a primeira é a que realmente protege:

1. **Aplicação** — o backend usa `service_role`, que ignora RLS. Todo método do
   repositório filtra `organizacao_id` **e** `unidade_id`, e `exigirTenant()`
   falha alto se algum faltar em vez de rodar sem filtro.
2. **RLS (migration 017)** — exige vínculo com a organização **e** com a
   unidade, no padrão da migration 016. Isso impede inclusive acesso cruzado
   entre unidades da mesma organização.

Os ids vêm sempre de `req.tenant`, resolvido e validado pelo `requireAuth`
contra `usuarios_organizacoes` / `usuarios_unidades`. **Nenhum controller lê
`organizacaoId` ou `unidadeId` do corpo da requisição.**

---

## Política de credenciais

> **Credenciais efêmeras, mantidas exclusivamente em memória e descartadas ao
> final de cada sincronização.**

| Nunca é persistido | Onde vive |
|---|---|
| usuário e senha do portal | memória do processo, durante a sessão |
| código 2FA | memória do processo, durante a sessão |
| JWT do portal | só dentro do worker, nunca atravessa a fronteira |
| cookies de sessão | idem |

Não há armazenamento cifrado de senha nesta fase — foi decisão explícita, não
omissão. `finalizarSessao()` sobrescreve os campos antes de soltar a referência
e é chamado em bloco `finally`, inclusive no caminho de erro.

`paraCliente()` é a única forma de a sessão sair do backend, e por construção só
expõe `sessionId`, `status`, `etapa`, `aguardandoCodigo`, `expiraEm`,
`resultado` e `erro`.

---

## Rotas

Todas sob `/api/v1/integracoes/martin-brower`, já protegidas pelo `requireAuth`.

| Método | Rota | Acesso | Observação |
|---|---|---|---|
| GET | `/settings` | vínculo na unidade | clientId vem **mascarado** |
| PUT | `/settings` | admin | cadastra o clientId da loja |
| GET | `/products` | vínculo | catálogo, com filtros |
| GET | `/price-history` | vínculo | alterações de preço |
| GET | `/sync-history` | vínculo | auditoria das execuções |
| GET | `/unlinked` | vínculo | produtos sem insumo interno |
| POST | `/links` | admin | vínculo **manual**, nunca automático |
| DELETE | `/links/:mbProdutoId` | admin | |
| POST | `/import-manual` | admin | ferramenta temporária de teste |
| POST | `/start` | admin | ⛔ exige `MB_PLAYWRIGHT_ENABLED=true` |
| POST | `/:sessionId/code` | dono da sessão | ⛔ idem |
| POST | `/:sessionId/cancel` | dono da sessão | ⛔ idem |
| GET | `/:sessionId/status` | dono da sessão | ⛔ idem |

Consultar uma sessão de outro usuário devolve **404**, não 403 — não
confirmamos sequer que o `sessionId` existe.

---

## Flag e worker

```bash
MB_PLAYWRIGHT_ENABLED=false   # padrão; mantenha assim no Render Free
```

Com a flag desligada, as quatro rotas de sincronização são barradas por
middleware **antes** do controller: o corpo com a senha é descartado sem ser
lido, e a resposta é `MARTIN_BROWER_WORKER_DISABLED`. O frontend nem exibe o
formulário de credenciais.

### Por que o worker roda separado

O serviço principal do Render Free tem **512 MB**. Um Chromium headless consome
300–500 MB só para abrir uma aba, e o pacote do browser pesa ~150 MB no build.
Instalar Playwright no serviço principal derrubaria a API.

| Recurso | Estimativa por execução |
|---|---|
| RAM (pico) | ~600 MB |
| Disco | ~400 MB (imagem + browser) |
| CPU | 1 vCPU por 40–90 s |
| Duração | ~60 s (com 2FA humano, vários minutos) |
| Concorrência | 1 por unidade (imposto pelo lock) |

Opções de hospedagem: Render Background Worker (≥ 1 GB), VPS pequena
(1 vCPU / 2 GB) ou container efêmero por execução (Cloud Run / Fly Machines) —
esta última a mais econômica, já que a sincronização é esporádica.

### Contrato

`martinbrower.worker.contract.js` define quatro métodos — `iniciar`,
`informarCodigo`, `coletar`, `encerrar`. O backend só conhece essa interface,
então trocar "worker no processo" por "worker HTTP remoto" não muda uma linha
do controller. `registrarWorker()` é o único ponto que a Fase 3 toca.

Variáveis futuras (documentadas em `.env.example`, ainda não exigidas):
`MB_WORKER_URL`, `MB_WORKER_TOKEN`, `MB_WORKER_TIMEOUT_MS`.

---

## Importação manual — ferramenta temporária

Aba **Martin Brower → Importar catálogo (JSON)**. O administrador cola a
resposta de `loadItens` e o backend roda o **mesmo** caminho da sincronização
automática: normalizar → filtrar → comparar preços → gravar → histórico.

Serve para validar a Fase 2 sem depender do Playwright. **Não substitui a
integração final**: não autentica e não descobre o `orderId` sozinha.

---

## Regras que o código impõe

**Normalizador** — um item torto nunca derruba a sincronização; vai para
`rejeitados` com o motivo. Códigos duplicados: o primeiro vence.

**Nunca derivado automaticamente:**
- custo por kg a partir de `weight` — é peso **bruto** da caixa
  (`"BACON TIRAS CX 4 PCT X 1 KG"` tem `weight: 4.62`, não 4.0);
- embalagem a partir do texto da descrição;
- `perc` do `findProxPedidoV2` em regra de negócio — significado não confirmado.

**Filtro** — ignorar nunca é apagar. O produto é gravado com `ignorado = true`,
`motivo_ignorado` e `regra_ignorado`, tudo auditável e reversível. Um admin pode
sobrepor (`classificacao_manual`), e a decisão humana passa a vencer o filtro.

Fora da lista padrão de propósito: **"meia"** (casaria com "PÃO MEIA LUA"),
**"touca"** e **"luva"** (descartáveis são EPI de cozinha, item operacional).
Só "luva de malha" é ignorada. Quem quiser excluí-los cria uma regra em
`martin_brower_filtros`.

**Preços** — histórico só quando o preço muda de fato, comparado ao **centavo**
(evita registrar 486.01 → 486.009999). Produto novo não conta como "preço
alterado": é a linha de base.

**Nunca excluído** — produto que some do catálogo recebe
`visto_na_ultima_sincronizacao = false` e fica para revisão humana.

**Ficha técnica e CMV não são tocados.** O gancho existe
(`emitirEventoCatalogoAtualizado`) mas só registra — nenhum custo é propagado.

**Cliente da API** — 401 → sessão expirada, 403 → acesso negado, 429 → limite,
5xx → indisponível. **401/403/429 nunca são repetidos**; repetir com sessão
inválida só queima tentativa. `Authorization` e `Cookie` jamais são logados.

**Concorrência** — lock por `organizacao + unidade + clientId`, com TTL de 15
min. O TTL é essencial: o Render Free hiberna e reinicia sem avisar, e sem ele
um processo morto travaria a loja para sempre. Só o dono libera o lock.

---

## Migration

`database/migrations/017_martin_brower.sql` — idempotente, rode inteira no SQL
Editor do Supabase.

Tabelas: `martin_brower_integracoes`, `martin_brower_sincronizacoes`,
`martin_brower_produtos`, `martin_brower_precos_historico`,
`martin_brower_filtros`, `martin_brower_vinculos`.

Depende das migrations **015 e 016** (helpers `auth_organizacao_ids`,
`auth_unidade_ids`, `is_platform_superadmin`). Se ainda não rodaram, a 017 avisa
por `notice` e deixa as tabelas com RLS habilitado em deny-all — seguro por
padrão, e o backend segue funcionando via `service_role`. Rode 015/016 e
reexecute a 017.

Cadastrar a loja depois de aplicar (o `clientId` real vem do portal):

```sql
insert into martin_brower_integracoes (organizacao_id, unidade_id, client_id, unidade_nome, status)
select o.id, u.id, <CLIENT_ID>, u.nome, 'pronto'
  from unidades u join organizacoes o on o.id = u.organizacao_id
 where u.nome ilike '%saci%';
```

---

## Testes

```bash
cd backend && npm test                              # suite completa
node --test test/martinbrower-*.test.js             # só a integração
```

65 testes, todos com fixtures e mocks. **Nenhuma chamada real à Martin Brower**
— nem localmente, nem no CI.

| Arquivo | Cobre |
|---|---|
| `martinbrower-normalizer.test.js` | item sem código/preço/descrição, grupo ausente, duplicata, datas numéricas |
| `martinbrower-filtros.test.js` | uniformes, acentos, palavra inteira, falsos positivos, regras custom |
| `martinbrower-api-client.test.js` | 401, 403, 429, 5xx, retry, JSON inválido, cancelamento, ausência de orderId, restrição financeira |
| `martinbrower-sync.test.js` | preço igual/alterado, produto novo/existente, isolamento entre unidades e organizações, erro individual |
| `martinbrower-seguranca.test.js` | sanitização de logs, descarte de credenciais, isolamento de sessão, concorrência |

`processarCatalogo` aceita um repositório injetável (`repo`), então os testes
rodam sem Supabase e sem variável de ambiente nenhuma.
