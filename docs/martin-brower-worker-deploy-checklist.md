# Checklist de deploy — Worker Martin Brower (Fase 3)

Runbook passo a passo para ligar a sincronização automatizada ponta a ponta.
Complementa [`martin-brower-worker.md`](martin-brower-worker.md) (arquitetura, custo, rollback).

> **Estado hoje:** `MB_PLAYWRIGHT_ENABLED` não existe em produção, o worker
> nunca foi publicado, `render.yaml` só tem o serviço `subway-saci`. Nada abaixo
> foi executado.

---

## 0. Decisão obrigatória antes de começar — camada de identidade

O backend roda no **Render**, fora do GCP. O adapter
[`martinbrower.remote.worker.js`](../backend/src/modules/martinbrower/martinbrower.remote.worker.js)
só sabe obter o ID token OIDC pelo **metadata server do GCP** (`obterTokenIdentidade`) —
**não** há suporte a `GOOGLE_APPLICATION_CREDENTIALS` nem a `google-auth-library`.
Logo, de dentro do Render, o OIDC do Cloud Run **não tem como ser satisfeito** sem mudança de código.

| Rota | O que fazer | Segurança | Custo p/ ligar |
|---|---|---|---|
| **A — HMAC apenas (recomendada agora)** | Deploy com `--allow-unauthenticated`; `MB_WORKER_SKIP_OIDC=true` no Render | HMAC SHA-256 + janela 60 s + nonce anti-replay + compare em tempo constante. O worker não guarda segredo nenhum e só fala com o portal. | zero código |
| **B — manter IAM do Cloud Run** | Adicionar `google-auth-library` ao adapter para assinar um ID token a partir de uma chave de service account guardada em env var do Render | HMAC + OIDC (2 camadas) | ~1 arquivo alterado + testes |

**Este checklist segue a Rota A.** Se optar pela B, faça a alteração do adapter
antes do passo 4 e troque `--allow-unauthenticated` por `--no-allow-unauthenticated`
+ o binding `roles/run.invoker` (comandos na seção "Rota B" no fim).

---

## 1. Local — construir e testar a imagem

```bash
cd worker-martinbrower

# 1.1 suíte do worker verde
npm install
npm test

# 1.2 build da imagem (a tag do Playwright e o pacote DEVEM ser 1.49.1)
docker build -t mb-worker:local .

# 1.3 subir localmente contra um alvo INOFENSIVO (NUNCA o portal real aqui)
#     precisa de um segredo >= 32 chars
export MB_WORKER_SECRET=$(openssl rand -base64 48)
docker run --rm -p 8080:8080 \
  -e MB_WORKER_SECRET="$MB_WORKER_SECRET" \
  -e MB_PORTAL_URL=http://host.docker.internal:9099/ \
  mb-worker:local
# noutro terminal:
curl -s localhost:8080/health | jq
#   → { "ok": true, "servico": "mb-worker", ... }
```

- [ ] `npm test` verde
- [ ] imagem builda sem erro
- [ ] `/health` responde `ok:true`
- [ ] container recusa subir sem `MB_WORKER_SECRET` (teste rápido: rode sem a env)
- [ ] container recusa subir com `MB_PORTAL_URL` = portal real e **sem** `MB_ALLOW_REAL_PORTAL=true`

---

## 2. GCP — projeto, APIs e segredo

```bash
PROJETO=<seu-projeto>
REGIAO=southamerica-east1
gcloud config set project "$PROJETO"

# 2.1 APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com

# 2.2 service account de identidade do worker
gcloud iam service-accounts create mb-worker-sa --display-name "MB Worker"

# 2.3 segredo do HMAC — guarde a saída, vai IGUAL no Render
SEGREDO=$(openssl rand -base64 48)
printf '%s' "$SEGREDO" | gcloud secrets create mb-worker-secret --data-file=-
gcloud secrets add-iam-policy-binding mb-worker-secret \
  --member "serviceAccount:mb-worker-sa@$PROJETO.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor
```

- [ ] APIs habilitadas
- [ ] `mb-worker-sa` criada
- [ ] `mb-worker-secret` criado; valor salvo em local seguro (gerenciador de senhas)
- [ ] `MB_WORKER_SECRET` **não** foi commitado em lugar nenhum

---

## 3. Deploy do worker em HOMOLOGAÇÃO (portal real, mas flag do backend ainda OFF)

```bash
cd worker-martinbrower

gcloud run deploy mb-worker \
  --source . \
  --region "$REGIAO" \
  --allow-unauthenticated \
  --service-account mb-worker-sa@$PROJETO.iam.gserviceaccount.com \
  --memory 2Gi \
  --cpu 1 \
  --no-cpu-throttling \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 1 \
  --timeout 900 \
  --set-env-vars MB_PORTAL_URL=https://portal.martinbrower.com.br/,MB_ALLOW_REAL_PORTAL=true \
  --set-secrets MB_WORKER_SECRET=mb-worker-secret:latest
```

Guarde a URL do serviço (`https://mb-worker-XXXX.a.run.app`).

```bash
curl -s https://mb-worker-XXXX.a.run.app/health | jq   # deve responder ok:true
```

Cada flag e o porquê estão na tabela de [`martin-brower-worker.md`](martin-brower-worker.md#cada-flag-e-por-quê).
`--no-cpu-throttling` é **obrigatório**: sem ele a CPU congela entre requisições e o Chromium
fica suspenso durante a espera do código 2FA.

- [ ] deploy concluído
- [ ] `/health` público responde
- [ ] `gcloud run services describe mb-worker --region $REGIAO` confirma: memória 2Gi, cpu-throttling desligado, concurrency 1, max-instances 1, timeout 900
- [ ] `MB_ALLOW_REAL_PORTAL=true` presente (senão o worker recusa subir apontando pro portal real)
- [ ] alerta de orçamento criado:
  ```bash
  gcloud billing budgets create --billing-account=<CONTA> \
    --display-name="mb-worker" --budget-amount=5USD
  ```

---

## 4. Backend (Render) — ligar o adapter

No painel do Render, serviço `subway-saci`, **Environment**:

```
MB_PLAYWRIGHT_ENABLED = true
MB_WORKER_URL         = https://mb-worker-XXXX.a.run.app
MB_WORKER_SECRET      = <MESMO valor do Secret Manager, passo 2.3>
MB_WORKER_TIMEOUT_MS  = 300000
MB_WORKER_SKIP_OIDC   = true
```

Registre também no [`render.yaml`](../render.yaml) (com `sync: false` para os dois segredos)
para o Blueprint não divergir do estado real:

```yaml
      - key: MB_PLAYWRIGHT_ENABLED
        value: "true"
      - key: MB_WORKER_URL
        sync: false
      - key: MB_WORKER_SECRET
        sync: false
      - key: MB_WORKER_TIMEOUT_MS
        value: "300000"
      - key: MB_WORKER_SKIP_OIDC
        value: "true"
```

Após o restart, o log de subida deve mostrar:

```
Martin Brower: worker remoto ATIVO (https://mb-worker-XXXX.a.run.app)
```

- [ ] envs configuradas no Render
- [ ] `render.yaml` atualizado e commitado
- [ ] log de subida diz **"worker remoto ATIVO"** (e não "DESABILITADO")
- [ ] relógio do Render dentro de ±60 s do UTC real (senão todo HMAC falha — ver `hmac.recusado` com `desvioMs` no log do worker)

---

## 5. Verificação de acesso — módulo e configuração da loja

- [ ] `migration 030` aplicada em produção → a org da loja tem `martin_brower` em `organizacao_modulos`
      (senão **toda** rota `/integracoes/martin-brower/*` responde 403 antes do controller — [routes.js:66](../backend/src/routes.js))
- [ ] na aba **Martin Brower → ⚙ Configurar**, o **código de cliente** da loja está salvo
      (string, com zero à esquerda se houver — migration 019)
- [ ] `GET /api/v1/integracoes/martin-brower/settings` retorna `workerHabilitado: true`

---

## 6. Primeira sincronização real — SUPERVISIONADA (valida os seletores)

Os seletores de login/2FA em
[`portal.selectors.js`](../worker-martinbrower/src/portal.selectors.js)
**nunca foram testados contra o site real** — foram escritos a partir de padrões de framework.
Esta execução é o teste de verdade.

1. Deixe aberto: `gcloud beta run services logs tail mb-worker --region $REGIAO`
2. Na aba Martin Brower, clique **⟳ Sincronizar catálogo** → informe usuário/senha do portal → informe o código 2FA quando pedido.
3. Acompanhe o progresso textual na UI (Autenticando → Aguardando código → Identificando pedido → Processando catálogo → Concluído).

Observe no log do worker:

| Evento no log | Significado | Ação |
|---|---|---|
| `seletor.fallback` (posição > 0) | o candidato preferido falhou, caiu no alternativo | ajustar `SELETORES` para o DOM real e redeployar |
| `seletor.nao_encontrado` | nenhum candidato casou → o fluxo quebra | idem, é bloqueante |
| `estado pos-login nao reconhecido` | `classificarResultado` não achou sinal de 2FA/erro/autenticado | ajustar `sinalDois2fa` / `sinalAutenticado` |
| `sinal.detectado sinalCaptcha` | portal pediu CAPTCHA | worker **para** (`MANUAL_VERIFICATION_REQUIRED`) — resolver no portal oficial e repetir |
| `api.content_type_inesperado` / `api.resposta status:4xx` em `findProxPedidoV2`/`loadItens` | os paths de [`portal.api.js`](../worker-martinbrower/src/portal.api.js) podem estar errados | conferir os endpoints reais no DevTools do portal |

- [ ] login concluído sem `seletor.fallback`
- [ ] 2FA aceito
- [ ] `findProxPedidoV2` e `loadItens` retornaram 200 com JSON
- [ ] sincronização terminou em **Concluído**; aba **Histórico** mostra a linha "Automática"
- [ ] aba **Catálogo** populada; **Alterações de preço** coerente
- [ ] log revisado: **nenhuma** senha, token JWT ou cookie do portal apareceu
- [ ] `GET /sessions/:id/status` e o polling do frontend (2 s) funcionaram durante todo o fluxo

---

## 7. Fechamento

- [ ] Rodar a suíte completa do backend (`cd backend && npm test`) — verde
- [ ] Atualizar a nota de memória `martin-brower-integracao` com "Fase 3 no ar em <data>"
- [ ] Atualizar o cabeçalho de [`martin-brower-worker.md`](martin-brower-worker.md) (tirar o "NÃO DEPLOYADO")
- [ ] `graphify update .`
- [ ] Confirmar o rollback nível 1: `MB_PLAYWRIGHT_ENABLED=false` no Render volta tudo ao estado atual sem deploy

---

## Rollback rápido

| Nível | Ação | Efeito |
|---|---|---|
| 1 (padrão) | Render: `MB_PLAYWRIGHT_ENABLED=false` + restart | rotas voltam a `WORKER_DISABLED`; botão some; importação manual, catálogo, histórico e iframe seguem intactos |
| 2 | `gcloud run services update-traffic mb-worker --to-revisions <ANTERIOR>=100` | volta à revisão anterior do worker |
| 3 | `gcloud run services delete mb-worker --region $REGIAO` | remove o worker |

Rotação do segredo (se `MB_WORKER_SECRET` vazar): nova versão no Secret Manager +
`gcloud run services update mb-worker --set-secrets MB_WORKER_SECRET=mb-worker-secret:latest` +
mesmo valor no Render. Enquanto os dois lados divergem, toda chamada é recusada — falha fechada.

---

## Rota B — manter o IAM do Cloud Run (se decidir não usar `--allow-unauthenticated`)

1. No adapter, implementar a emissão de ID token a partir de uma chave de SA
   (`mb-backend-invoker`) guardada como env var no Render — hoje `obterTokenIdentidade`
   só lê o metadata server.
2. Criar a SA e a chave:
   ```bash
   gcloud iam service-accounts create mb-backend-invoker --display-name "MB Backend Invoker"
   gcloud iam service-accounts keys create mb-backend-invoker.json \
     --iam-account mb-backend-invoker@$PROJETO.iam.gserviceaccount.com
   ```
3. Deploy do worker com `--no-allow-unauthenticated` e:
   ```bash
   gcloud run services add-iam-policy-binding mb-worker --region "$REGIAO" \
     --member "serviceAccount:mb-backend-invoker@$PROJETO.iam.gserviceaccount.com" \
     --role roles/run.invoker
   ```
4. No Render: conteúdo do JSON numa env var, `MB_WORKER_SKIP_OIDC` **ausente/false**.
