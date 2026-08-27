# Worker Martin Brower no Render — plano de migração (Cloud Run → Render)

Plano para hospedar o `worker-martinbrower` como **serviço separado no Render**, ao lado do backend.
Substitui o alvo Cloud Run de [`martin-brower-worker.md`](martin-brower-worker.md) e
[`martin-brower-worker-deploy-checklist.md`](martin-brower-worker-deploy-checklist.md).

> **Nada foi deployado nem alterado.** Este documento é só o plano para aprovação.

---

## Veredito rápido (o resumo que você pediu)

| Item | Decisão |
|---|---|
| **Arquitetura** | **Private Service (Docker)** no Render. Fallback documentado: Web Service Docker + HMAC, se o backend no plano atual não alcançar o Private Service. |
| **Plano Render (worker)** | **Standard — 2 GB RAM / 1 CPU**. Starter (512 MB) = OOM garantido com Chromium. |
| **Plano Render (backend)** | Mantém como está, **exceto** se o plano `free` não tiver acesso à rede privada → subir para **Starter ($7)**. A confirmar no primeiro teste. |
| **Alterações de código** | 3 arquivos, todas pequenas. HMAC **intocado**. Nenhuma regra de negócio muda. |
| **Alterações no `render.yaml`** | +1 serviço (`mb-worker`), +4 env vars no backend. Nenhum segredo no arquivo. |
| **Custo mensal novo** | **~US$ 25/mês** (worker Standard, sempre ligado) + possível US$ 7 se o backend sair do free. |
| **Rollback** | `MB_PLAYWRIGHT_ENABLED=false` no backend → volta ao estado atual. Zero código. |

O maior trade-off vs. Cloud Run: **sem scale-to-zero**. O Render cobra o worker 24/7
(~US$ 25) mesmo que a sincronização rode uma vez por semana. Em troca: zero GCP, zero
OIDC, zero service account, deploy pelo mesmo painel do backend.

Ponto **a favor** do Render que o Cloud Run não tinha: não existe "CPU throttling entre
requisições". A flag `--no-cpu-throttling` (crítica no Cloud Run para o Chromium não
congelar durante a espera do 2FA) simplesmente **deixa de ser um problema**.

---

## 1. Auditoria de compatibilidade com o Render

| Aspecto | Estado atual | Compatível com Render? |
|---|---|---|
| **Dockerfile** | `FROM mcr.microsoft.com/playwright:v1.49.1-jammy`, multi-stage não, `USER pwuser`, `CMD ["node","src/server.js"]` | ✅ Render builda Docker de qualquer base. Imagem ~1.8 GB — ok em plano pago. |
| **Porta / `PORT`** | `config.porta = Number(process.env.PORT) \|\| 8080` ([config.js:52](../worker-martinbrower/src/config.js)) | ✅ Render injeta `PORT`; o worker já respeita. Recomendo **fixar `PORT=8080`** nas env vars para casar com `MB_WORKER_URL`. |
| **Health check** | `GET /health` **antes** do HMAC, sem auth ([server.js:21](../worker-martinbrower/src/server.js), [routes.js:141](../worker-martinbrower/src/routes.js)) | ✅ É exatamente o que o Render precisa em `healthCheckPath`. |
| **Chromium / Playwright** | `chromium.launch({ headless:true, args:["--no-sandbox","--disable-dev-shm-usage",...] })` ([browser.js:16](../worker-martinbrower/src/browser.js)) | ✅ `--no-sandbox` já presente (Render não dá privilégio de sandbox, igual Cloud Run). `--disable-dev-shm-usage` já presente (Render tem `/dev/shm` pequeno). |
| **Filesystem temporário** | Chromium escreve em `/tmp` (por causa do `--disable-dev-shm-usage`). Nenhuma escrita persistente no código. Sessões 100 % em memória ([sessions.js:3](../worker-martinbrower/src/sessions.js)). | ✅ Render dá filesystem efêmero **gravável** em runtime. Sem disco persistente necessário. |
| **Timeout** | `servidor.requestTimeout = config.timeoutExecucaoMs` (default 600 000). `headersTimeout = 65 000`. | ✅ Render não corta conexões longas de Private Service. Manter o teto interno (600 s) como rede de segurança. |
| **SIGTERM** | Shutdown gracioso com `encerrarTodas()` ([server.js:59](../worker-martinbrower/src/server.js)) | ✅ Render manda SIGTERM no deploy/restart. Já tratado. |
| **Variáveis de ambiente** | `validarConfig()` exige só `MB_WORKER_SECRET` (≥32 chars) e a trava de portal real | ✅ Ver seção 5. |
| **CORS / rotas públicas** | Nenhuma além de `/health`. `app.disable("x-powered-by")`. 404 genérico. | ✅ Postura correta para Private Service. |
| **Dependência de Cloud Run no código** | **Nenhuma funcional.** Só **comentários** citam Cloud Run ([server.js](../worker-martinbrower/src/server.js), [browser.js](../worker-martinbrower/src/browser.js), [sessions.js](../worker-martinbrower/src/sessions.js), [config.js](../worker-martinbrower/src/config.js)). Nenhum uso de `K_SERVICE`, `metadata.google.internal`, `run.app` ou IAM. | ✅ O worker sobe no Render **como está**. Comentários desatualizados são cosméticos. |

**Conclusão da auditoria:** o worker já pode subir no Render praticamente sem tocar no código.
As únicas mudanças ficam do lado do **backend** (adapter) e de **configuração** (`render.yaml`, env vars).

---

## 2. Simplificação do OIDC do GCP

**Onde o OIDC vive hoje:** só no adapter do backend,
[`martinbrower.remote.worker.js`](../backend/src/modules/martinbrower/martinbrower.remote.worker.js):

- `obterTokenIdentidade(audience)` — busca um ID token no `http://metadata.google.internal/...`
- `tokenCache` — cache desse token
- `if (tokenId) headers.Authorization = \`Bearer ${tokenId}\`` — anexa o token, **se existir**
- `if (process.env.MB_WORKER_SKIP_OIDC === "true") return null` — atalho

**O que acontece hoje rodando fora do GCP (Render):** `fetch("http://metadata.google.internal/...")`
falha (DNS não resolve) e cai no `catch` → devolve `null` → o header `Authorization` **não é
anexado** → segue só com HMAC. Ou seja, **já funciona** — mas com um custo: sem
`MB_WORKER_SKIP_OIDC=true`, cada chamada ao worker espera o timeout de 3 s do metadata server
antes de desistir (o `tokenCache` só guarda em caso de sucesso). **3 s de latência por chamada.**

**Recomendação — remoção limpa (Rota preferida):** apagar do adapter:
- a função `obterTokenIdentidade` e a variável `tokenCache` (~30 linhas);
- a linha `const tokenId = await obterTokenIdentidade(url);` e o `if (tokenId) headers.Authorization = ...`;
- ajustar o cabeçalho-comentário do arquivo (remover "camada 1: IAM do Cloud Run").

Some junto: `MB_WORKER_SKIP_OIDC` do `.env.example` e a linha correspondente no teste
[`martinbrower-remote-worker.test.js:48`](../backend/test/martinbrower-remote-worker.test.js) (o teste só
**desliga** o OIDC no setup, não testa o comportamento — remover a linha é seguro).

**O HMAC não é tocado.** `assinar()`, a mensagem canônica
`timestamp \n nonce \n MÉTODO \n path+query \n sha256(corpo)`, a janela de 60 s, o nonce
anti-replay e o `timingSafeEqual` continuam idênticos nos dois lados. Os testes de HMAC do
adapter usam `http://127.0.0.1:PORT` (HTTP puro) e passam — provando que o adapter não tem
problema nenhum com URL interna sem TLS.

**Alternativa zero-código:** manter o bloco e só setar `MB_WORKER_SKIP_OIDC=true` no backend.
Funciona, mas deixa ~30 linhas de código morto que confundem quem ler depois. Prefiro remover.

**Proteção final (inalterada):**
```
HMAC SHA-256  +  janela de 60 s  +  nonce anti-replay  +  compare em tempo constante
```
E, com Private Service, ainda por cima: **rede privada do Render** (o worker não tem URL pública).

---

## 3. Private Service vs Web Service Docker

| Critério | **Private Service** ✅ | Web Service Docker |
|---|---|---|
| Exposição | **Nenhuma URL pública.** Só alcançável de dentro da rede do Render. | URL pública `https://mb-worker-xxx.onrender.com` |
| Superfície de ataque | Praticamente zero — não roteável da internet | Aberta ao mundo; só o HMAC protege |
| Compatível com o adapter atual | ✅ `chamar()` faz `fetch(\`${url}${caminho}\`)` — aceita `http://mb-worker:8080` sem mudar nada. HMAC assina o **path**, não o host. | ✅ Idêntico, mas com URL pública |
| TLS | ❌ Tráfego interno do Render é **HTTP puro** (sem TLS entre serviços) | ✅ TLS público terminado pelo Render |
| Segredo do portal em trânsito | Vai em **JSON plaintext** por 1 hop dentro da rede privada isolada do Render. Integridade garantida pelo HMAC (corpo assinado); confidencialidade = isolamento da rede. | Vai cifrado (HTTPS), mas o endpoint é público |
| Custo | Mesmo plano (Standard US$ 25) | Mesmo plano; **não** tem free tier útil (512 MB free = OOM) |
| Simplicidade de debug | Só via logs do Render (não dá `curl` externo no `/health`) | `curl https://.../health` de qualquer lugar |
| Requisito | Backend **no mesmo region** e com acesso à rede privada | Nenhum |

**Escolha: Private Service.** O ganho de "sem endpoint público" supera o custo de "1 hop
HTTP interno". A rede privada do Render é isolada por workspace/region e não é roteável de
fora; combinada com o HMAC (que impede adulteração do corpo), o risco residual é baixo e
aceitável para a política atual.

**Fallback → Web Service Docker + HMAC**, aplicável se qualquer um destes acontecer no
primeiro teste:
- o backend no plano `free` **não** conseguir resolver `http://mb-worker:8080` (free tier
  historicamente tem acesso limitado à rede privada);
- você não quiser subir o backend para Starter só por isso.

Nesse caso: trocar `type: pserv` por `type: web` no `render.yaml`, usar a URL pública em
`MB_WORKER_URL`, e o HMAC passa a ser a única barreira (que é justamente o cenário para o
qual ele foi projetado).

---

## 4. Alterações no `render.yaml` (resumo)

Adicionar o serviço do worker e as env vars do backend. **Nenhum segredo no arquivo** —
`MB_WORKER_SECRET` entra com `sync: false` nos dois serviços (você digita o valor no painel,
o mesmo nos dois).

```yaml
services:
  # ---- backend (já existe — só ganha env vars) --------------------------
  - type: web
    name: subway-saci
    runtime: node
    plan: free                       # ver seção 7: pode precisar virar "starter"
    region: oregon                   # FIXAR — precisa casar com o worker
    buildCommand: cd backend && npm install
    startCommand: cd backend && npm start
    healthCheckPath: /health
    envVars:
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: SUPABASE_ANON_KEY
        sync: false
      - key: DEFAULT_ORG_ID
        value: "00000000-0000-0000-0000-000000000001"
      - key: DEFAULT_UNIDADE_ID
        value: "00000000-0000-0000-0000-0000000000a1"
      # --- novas ---
      - key: MB_PLAYWRIGHT_ENABLED
        value: "true"
      - key: MB_WORKER_URL
        value: "http://mb-worker:8080"     # hostname interno do Private Service
      - key: MB_WORKER_SECRET
        sync: false                        # MESMO valor do worker
      - key: MB_WORKER_TIMEOUT_MS
        value: "300000"

  # ---- worker Martin Brower (novo) -------------------------------------
  - type: pserv                      # Private Service
    name: mb-worker
    runtime: docker
    plan: standard                   # 2 GB / 1 CPU — ver seção 7
    region: oregon                   # MESMO region do backend
    rootDir: worker-martinbrower
    dockerfilePath: ./Dockerfile
    healthCheckPath: /health
    autoDeploy: false                # deploy manual: correções de seletor são deliberadas
    envVars:
      - key: MB_WORKER_SECRET
        sync: false
      - key: MB_PORTAL_URL
        value: "https://portal.martinbrower.com.br/"
      - key: MB_ALLOW_REAL_PORTAL
        value: "true"
      - key: PORT
        value: "8080"
      - key: NODE_ENV
        value: "production"
```

Notas:
- `region: oregon` é o **default** do Render quando omitido — mas para Private Service é
  obrigatório os dois serviços estarem no **mesmo** region declarado explicitamente.
- `rootDir: worker-martinbrower` isola o build do worker; o build do backend
  (`cd backend && npm install`) continua intacto.
- `autoDeploy: false` no worker evita que um push de seletor suba sozinho no meio de um teste.

---

## 5. Env vars do worker (auditadas)

**Obrigatórias:**

| Var | Valor | Por quê |
|---|---|---|
| `MB_WORKER_SECRET` | ≥ 32 chars aleatórios (`openssl rand -base64 48`) | HMAC. `validarConfig()` **recusa subir** sem, ou com < 32 chars. `sync: false`. |
| `MB_PORTAL_URL` | `https://portal.martinbrower.com.br/` | Sem, usa o default (que já é o portal real). |
| `MB_ALLOW_REAL_PORTAL` | `true` (string exata) | O worker **recusa subir** apontando pro portal real sem esta. `"1"`/`"yes"` não valem. |
| `PORT` | `8080` | Fixado para casar com `MB_WORKER_URL=http://mb-worker:8080`. |
| `NODE_ENV` | `production` | Já no Dockerfile; repetir não faz mal. |

**Opcionais (têm default no código — só setar se quiser mudar):**

| Var | Default | Observação |
|---|---|---|
| `MB_MAX_SESSOES` | `1` | **Manter 1.** Uma segunda sessão = segundo Chromium = OOM. |
| `MB_SESSION_TTL_MS` | `600000` (10 min) | TTL total da sessão remota. |
| `MB_2FA_TTL_MS` | `300000` (5 min) | Janela para o humano digitar o código. |
| `MB_IDLE_TTL_MS` | `180000` (3 min) | Inatividade fora do 2FA. |
| `MB_WORKER_TIMEOUT_MS` | `600000` | Teto de uma execução no worker. |
| `MB_MAX_BODY_BYTES` | `65536` | Corpo das requisições internas (entradas são pequenas). |
| `MB_MAX_CATALOG_BYTES` | `12582912` (12 MB) | Teto da resposta do portal. |

**Nunca existem no worker:** usuário, senha, JWT ou cookie da Martin Brower. Política de
credenciais efêmeras só em memória — inalterada.

---

## 6. Env vars do backend (auditadas contra o adapter)

| Var | Valor | Situação |
|---|---|---|
| `MB_PLAYWRIGHT_ENABLED` | `true` | `workerHabilitado()` e `inicializarWorkerRemoto()` exigem. |
| `MB_WORKER_URL` | `http://mb-worker:8080` (Private Service) **ou** `https://mb-worker-xxx.onrender.com` (Web Service) | `config()` no adapter faz `.replace(/\/+$/, "")` — pode ter ou não barra final. |
| `MB_WORKER_SECRET` | mesmo valor do worker | `sync: false`. Enquanto os dois lados divergirem, **toda** chamada é recusada (falha fechada). |
| `MB_WORKER_TIMEOUT_MS` | `300000` | `config()` usa `MB_WORKER.timeoutPadraoMs` (300 000) como default se ausente. |
| ~~`MB_WORKER_SKIP_OIDC`~~ | — | **Removida** junto com o bloco OIDC do adapter (seção 2). Se optar por não mexer no código, setar `=true`. |

`inicializarWorkerRemoto()` na subida do backend:
- flag off → não carrega nada, rotas respondem `WORKER_DISABLED`;
- flag on + falta `MB_WORKER_URL` ou `MB_WORKER_SECRET` → `{habilitado:false, motivo:"... ausentes"}`, log `worker DESABILITADO`;
- flag on + as duas presentes → importa o adapter, `registrarWorker(remoteWorker)`, log **`Martin Brower: worker remoto ATIVO (<url>)`**.

---

## 7. Memória, CPU e plano do Render (estimativa conservadora)

Consumo real de uma execução (Chromium headless + 1 aba do portal Angular/PrimeFaces + Node):

| Componente | RAM |
|---|---|
| Node (processo worker), medido ocioso | ~70 MB (`rssMb: 66` no teste local) |
| Chromium headless — processo base + GPU process + zygote | ~200–300 MB |
| 1 aba renderizando o portal (JS pesado, tabelas grandes) | ~250–450 MB |
| Buffer/parse da resposta do `loadItens` (até 12 MB de JSON, parseado ocupa mais) | ~50–120 MB transiente |
| **Pico realista** | **≈ 700 MB – 1,1 GB** |

| Plano Render | RAM / CPU | Preço/mês¹ | Veredito |
|---|---|---|---|
| Starter | 512 MB / 0.5 CPU | US$ 7 | ❌ **OOM garantido.** Chromium sozinho já passa disso. |
| **Standard** | **2 GB / 1 CPU** | **US$ 25** | ✅ **Recomendado.** ~1 GB de folga sobre o pico. Risco de OOM: **baixo**. |
| Pro | 4 GB / 2 CPU | US$ 85 | Exagero — só se um dia rodar `MB_MAX_SESSOES > 1`. |

¹ *Confirme o valor atual no painel do Render — a tabela de planos muda.*

**Recomendação conservadora: Standard (2 GB / 1 CPU).** É o mesmo dimensionamento que já
tinha sido aprovado para o Cloud Run (2 GiB / 1 vCPU). Não desça para Starter "pra economizar" —
o Chromium não cabe.

**Risco de OOM em 2 GB:** baixo, mas não zero. Se o portal tiver uma tela muito pesada ou o
catálogo de alguma loja for gigante, pode chegar perto. Mitigações já no código: `page.route`
aborta imagens e mídia ([browser.js:45](../worker-martinbrower/src/browser.js)),
`NODE_OPTIONS=--max-old-space-size=512` no Dockerfile, `MB_MAX_CATALOG_BYTES` corta resposta
anômala, `MB_MAX_SESSOES=1`. Se acontecer OOM: o Render reinicia o container, a sessão se
perde, o backend devolve `MARTIN_BROWER_REMOTE_SESSION_LOST` e o usuário recomeça — sem
corrupção de dado.

**Backend:** o `free` atual (512 MB) continua suficiente para a API. **Única ressalva:**
se o `free` não tiver acesso à rede privada do Render para alcançar o Private Service, subir
para **Starter (US$ 7)**. Isso se confirma no primeiro teste `backend → worker` (seção 9).

---

## 8. Health check

Sem mudança no código. O worker já expõe `GET /health` sem HMAC, retornando:
```json
{ "ok": true, "servico": "mb-worker", "sessoesAtivas": 0,
  "memoria": { "rssMb": 66, "heapUsadoMb": 16, "externoMb": 3 }, "uptimeSegundos": 12 }
```
No `render.yaml`: `healthCheckPath: /health` no serviço `mb-worker`. O Render passa a
sondar esse endpoint e só marca o deploy como "live" quando ele responde 200. Private
Services suportam health check normalmente.

---

## 9. Plano de validação (antes do portal real)

Rodar **em ordem**, um passo por vez, sem paralelismo:

1. **Deploy do worker** (painel Render, seção 12). `autoDeploy: false` → disparar manual.
2. **Worker online** — evento `worker.iniciado` no log do Render, deploy "live".
3. **`/health`** — no painel do worker, aba Logs, confirmar as sondagens do Render batendo 200.
   (Private Service não dá `curl` externo; a evidência é o log + status "live".)
4. **Backend chama o worker** — no backend, com `MB_PLAYWRIGHT_ENABLED=true` e as env vars,
   confirmar no log de subida: `Martin Brower: worker remoto ATIVO (http://mb-worker:8080)`.
   Depois: `GET /api/v1/integracoes/martin-brower/settings` deve retornar `workerHabilitado: true`.
5. **HMAC aceito** — a própria chamada de `settings`/`start` que chega ao worker aparece no
   log do worker como `worker.chamada ... status:2xx`.
6. **HMAC inválido recusado** — teste pontual: com o worker no ar, um `POST` ao endpoint
   interno sem assinatura (ou com segredo errado) → **401** + log `hmac.recusado`.
   (Se Private Service, esse teste só dá para fazer de outro serviço Render ou de um shell
   no container; anotar como "validado no build local" se não for prático — já foi:
   `POST /internal/martin-brower/sessions` sem assinatura → 401, confirmado localmente.)
7. **Timeout funcionando** — `MB_WORKER_TIMEOUT_MS` baixo temporário (ex. 5000) + endpoint
   que demora → backend recebe `MARTIN_BROWER_UNAVAILABLE` com `motivo: "timeout do worker"`.
   Reverter o valor depois.

Só com 1–7 verdes: **primeira sincronização real supervisionada.**

---

## 10. Primeira sincronização real (supervisionada)

Mesmo plano de sempre, uma única tentativa, acompanhando o log do worker no Render:

```
login → 2FA → findProxPedidoV2 → loadItens → catálogo/preços → Crescer com Delivery
```

Observar no log: `seletor.fallback` (caiu no candidato alternativo → portal mudou),
`seletor.nao_encontrado` (bloqueante), `sinal.detectado sinalCaptcha` (worker para),
`portal.chamada ... findProxPedidoV2 / loadItens` com status e bytes.

Se um seletor falhar: **parar**, inspecionar o DOM real, ajustar **só** o candidato afetado
em [`portal.selectors.js`](../worker-martinbrower/src/portal.selectors.js), redeploy manual
do worker, tentar de novo. Sem refatoração.

---

## 11. Garantia — o worker continua só coletor

Nada neste plano move regra de negócio para o worker. Ele continua fazendo **apenas**:
login, 2FA, gestão de sessão, `findProxPedidoV2`, `loadItens`, e devolve **payloads crus**.

Permanecem no backend, sem exceção: normalização, filtros, comparação de preço, histórico,
upsert, `organizacao_id`/`unidade_id`, RLS, CMV, ficha técnica, Dashboard. O
[`martinbrower.sync.service.js`](../backend/src/modules/martinbrower/martinbrower.sync.service.js)
e o repositório não são tocados.

---

## 12. Passo a passo de deploy (painel do Render)

> Só executar **após sua autorização**. Requer as alterações de código da seção 2 já
> commitadas e o `render.yaml` da seção 4 no repositório.

**A. Segredo compartilhado**
1. Gerar: `openssl rand -base64 48` → guardar no gerenciador de senhas.

**B. Criar o Private Service do worker**
2. Render → **New** → **Private Service** → conectar o repositório.
3. **Root Directory:** `worker-martinbrower` · **Runtime:** Docker · **Dockerfile Path:** `./Dockerfile`.
4. **Region:** o mesmo do backend (confirmar em Settings do `subway-saci` — provável **Oregon**).
5. **Instance Type:** **Standard (2 GB / 1 CPU)**.
6. **Health Check Path:** `/health`.
7. **Auto-Deploy:** **Off**.
8. **Environment** → adicionar:
   `MB_WORKER_SECRET` = *(o valor do passo 1)* ·
   `MB_PORTAL_URL` = `https://portal.martinbrower.com.br/` ·
   `MB_ALLOW_REAL_PORTAL` = `true` ·
   `PORT` = `8080` ·
   `NODE_ENV` = `production`.
9. **Create Private Service.** Aguardar o build (lento na 1ª vez — imagem Playwright ~1.8 GB).
10. Na aba **Connect** do serviço, anotar o **hostname interno** (deve ser `mb-worker`) e a porta.
11. Confirmar nos **Logs**: `worker.iniciado` + health checks do Render em 200 + status **Live**.

**C. Configurar o backend**
12. Render → serviço **`subway-saci`** → **Environment** → adicionar:
    `MB_PLAYWRIGHT_ENABLED` = `true` ·
    `MB_WORKER_URL` = `http://mb-worker:8080` *(usar o hostname/porta reais do passo 10)* ·
    `MB_WORKER_SECRET` = *(o MESMO valor do passo 1)* ·
    `MB_WORKER_TIMEOUT_MS` = `300000`.
13. **Manual Deploy** do backend (ou salvar as env vars já dispara o restart).
14. **Logs** do backend → confirmar `Martin Brower: worker remoto ATIVO (http://mb-worker:8080)`.

**D. Validação (seção 9)**
15. Logado no app: `GET /api/v1/integracoes/martin-brower/settings` → `workerHabilitado: true`.
16. Rodar os testes 5–7 da seção 9.

**E. Só então:** primeira sincronização real supervisionada (seção 10).

**Se cair no fallback Web Service:** no passo 2 escolher **Web Service** em vez de Private
Service; no passo 12 usar a URL pública `https://...onrender.com` em `MB_WORKER_URL`. Resto igual.

---

## 13. Rollback

| Nível | Ação | Efeito |
|---|---|---|
| 1 (padrão) | Backend: `MB_PLAYWRIGHT_ENABLED=false` + restart | `obterWorker()` volta a `workerIndisponivel`; rotas respondem `WORKER_DISABLED`; botão de sync some. Importação manual, catálogo, histórico, iframe e vínculos **intactos**. |
| 2 | Render → `mb-worker` → **Suspend** | Para de cobrar o worker. Backend já está em nível 1. |
| 3 | Render → `mb-worker` → **Delete** + `git revert` do commit da seção 2 | Remove tudo. O backend opera normal com a flag `false` mesmo sem reverter. |

Rotação do segredo (se `MB_WORKER_SECRET` vazar): gerar novo, atualizar nos **dois** serviços
no painel, restart de ambos. Enquanto divergirem, toda chamada é recusada — falha fechada.

---

## Lista curta — alterações de código necessárias

1. **`backend/src/modules/martinbrower/martinbrower.remote.worker.js`** — remover
   `obterTokenIdentidade`, `tokenCache`, a chamada e o header `Authorization: Bearer`;
   atualizar o comentário do topo. HMAC intocado. (~35 linhas a menos)
2. **`backend/.env.example`** — remover as 4 linhas de `MB_WORKER_SKIP_OIDC`; trocar o
   exemplo de `MB_WORKER_URL` para `http://mb-worker:8080`; nota "worker no Render, não Cloud Run".
3. **`backend/test/martinbrower-remote-worker.test.js`** — remover a linha
   `process.env.MB_WORKER_SKIP_OIDC = "true"` do `before()`.
4. **`render.yaml`** — adicionar o serviço `mb-worker` + as 4 env vars do backend (seção 4).
5. *(Cosmético, opcional)* — atualizar comentários que citam "Cloud Run" em
   `worker-martinbrower/src/{server,browser,sessions,config}.js` para "Render". Não é
   funcional; pode ficar para depois da 1ª sincronização.

Nenhuma mudança em: `martinbrower.sync.service.js`, `martinbrower.repository.js`,
`martinbrower.normalizer.js`, `martinbrower.filtros.js`, controller, rotas, ou qualquer
arquivo de regra de negócio. O Dockerfile **não muda**.
