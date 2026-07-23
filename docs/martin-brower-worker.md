# Worker Martin Brower — operação

Documento operacional: infraestrutura, deploy, custo e rollback.
A documentação **técnica** do worker está em [`worker-martinbrower/README.md`](../worker-martinbrower/README.md).

> **Estado atual: NÃO DEPLOYADO.** `MB_PLAYWRIGHT_ENABLED=false` em produção.
> Nada deste documento foi executado.

---

## Arquitetura

```
Navegador ──JWT Supabase──► Backend Render ──HTTPS + OIDC + HMAC──► Worker Cloud Run
                                  │                                      │
                                  │                                   Chromium
                                  │                                      │
                                  │                            Portal Martin Brower
                                  │                                      │
                                  ◄────────── payloads crus ─────────────┘
                                  │
                            normalizar → filtrar → upsert → histórico
                                  │
                                  ▼
                              Supabase
```

O worker **nunca** fala com o Supabase. Tenant, RLS, histórico e persistência
ficam centralizados no backend — é isso que preserva o isolamento multiempresa
já validado pelos testes de isolamento.

---

## Pré-requisitos no GCP

```bash
PROJETO=seu-projeto
REGIAO=southamerica-east1

gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# Service account do worker (identidade do processo)
gcloud iam service-accounts create mb-worker-sa --display-name "MB Worker"

# Segredo do HMAC — o mesmo valor vai no Render, como MB_WORKER_SECRET
openssl rand -base64 48 | gcloud secrets create mb-worker-secret --data-file=-
gcloud secrets add-iam-policy-binding mb-worker-secret \
  --member "serviceAccount:mb-worker-sa@$PROJETO.iam.gserviceaccount.com" \
  --role roles/secretmanager.secretAccessor

# Service account que o BACKEND usa para invocar o worker
gcloud iam service-accounts create mb-backend-invoker --display-name "MB Backend Invoker"
```

⚠️ O `MB_WORKER_SECRET` **não** é credencial da Martin Brower. É apenas o
segredo compartilhado do HMAC. Nunca vai para o frontend nem para arquivo
versionado.

---

## Deploy — proposta, não executada

```bash
cd worker-martinbrower

gcloud run deploy mb-worker \
  --source . \
  --region southamerica-east1 \
  --no-allow-unauthenticated \
  --service-account mb-worker-sa@$PROJETO.iam.gserviceaccount.com \
  --memory 2Gi \
  --cpu 1 \
  --no-cpu-throttling \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 1 \
  --timeout 900 \
  --set-secrets MB_WORKER_SECRET=mb-worker-secret:latest

# Permite que SÓ o backend invoque
gcloud run services add-iam-policy-binding mb-worker \
  --region southamerica-east1 \
  --member "serviceAccount:mb-backend-invoker@$PROJETO.iam.gserviceaccount.com" \
  --role roles/run.invoker
```

### Cada flag, e por quê

| Flag | Razão |
|---|---|
| `--no-allow-unauthenticated` | primeira camada: o Google recusa quem não tem OIDC válido |
| `--memory 2Gi` | Chromium + Node em 1 GiB arrisca OOM no meio do 2FA |
| `--no-cpu-throttling` | **obrigatório** — sem isso a CPU congela entre requisições e o Chromium fica suspenso durante a espera do código 2FA |
| `--concurrency 1` | uma sessão por instância; duas estourariam a memória |
| `--max-instances 1` | teto de custo e garantia de uma sincronização por vez |
| `--min-instances 0` | scale-to-zero: sem sincronização, custo zero |
| `--timeout 900` | maior que o fluxo completo com 2FA humano; o worker corta antes, em 600 s |

---

## Configuração no Render

```
MB_PLAYWRIGHT_ENABLED=true                      # só depois de tudo validado
MB_WORKER_URL=https://mb-worker-XXXXXX.a.run.app
MB_WORKER_SECRET=<mesmo valor do Secret Manager>
MB_WORKER_TIMEOUT_MS=300000
```

Com a flag ligada mas **sem** `MB_WORKER_URL`/`MB_WORKER_SECRET`, o adapter
não é registrado e as rotas continuam respondendo `WORKER_DISABLED` — falha
segura.

O backend fora do GCP precisa de credencial da service account
`mb-backend-invoker` para emitir o ID token OIDC. Sem ela, o adapter envia só
o HMAC e o Cloud Run recusa com 403, que o backend reporta como
`MARTIN_BROWER_WORKER_UNREACHABLE` — nunca como erro de senha do usuário.

---

## Custo estimado

Preços de referência do Cloud Run **instance-based** (`southamerica-east1`,
sujeitos a mudança — confira antes de aprovar orçamento):
CPU ≈ US$ 0,0000180/vCPU-s · Memória ≈ US$ 0,0000020/GiB-s

**1 vCPU + 2 GiB ≈ US$ 0,000022/s ≈ US$ 0,079/hora de instância viva.**

| Volume mensal | Instância viva | Custo |
|---|---|---|
| 30 sincronizações | ~5 h | **~US$ 0,40** |
| 100 sincronizações | ~17 h | **~US$ 1,30** |

Somando Artifact Registry (~US$ 0,16/mês) e Secret Manager (~US$ 0,06/mês):
**menos de US$ 1/mês** no volume esperado. O free tier do Cloud Run
provavelmente absorve quase tudo, mas não conto com ele no orçamento.

**O risco de custo não é o preço unitário — é instância que não morre.** Por
isso `max-instances 1`, `timeout 900`, encerramento em SIGTERM e:

```bash
gcloud billing budgets create --billing-account=CONTA \
  --display-name="mb-worker" --budget-amount=5USD
```

---

## Rollback

O worker é **completamente desacoplado**. Desligá-lo não afeta nada do que já
existe: portal em iframe, importação manual, catálogo, histórico e vínculos
seguem funcionando.

**Nível 1 — desligar a integração automatizada (segundos, sem deploy)**

No Render: `MB_PLAYWRIGHT_ENABLED=false` → restart. As rotas voltam a
responder `WORKER_DISABLED` e o frontend deixa de exibir o formulário de
credenciais. **Este é o rollback padrão.**

**Nível 2 — voltar à revisão anterior do worker**

```bash
gcloud run revisions list --service mb-worker --region southamerica-east1
gcloud run services update-traffic mb-worker \
  --region southamerica-east1 --to-revisions REVISAO_ANTERIOR=100
```

**Nível 3 — remover o worker**

```bash
gcloud run services delete mb-worker --region southamerica-east1
```

**Nível 4 — reverter o código do backend**

`git revert` do commit da Fase 3. Como o adapter só é carregado com a flag
ligada, mesmo sem reverter nada o backend opera normalmente com a flag em
`false`.

**Rotação do segredo**, se `MB_WORKER_SECRET` vazar:

```bash
openssl rand -base64 48 | gcloud secrets versions add mb-worker-secret --data-file=-
gcloud run services update mb-worker --region southamerica-east1 \
  --set-secrets MB_WORKER_SECRET=mb-worker-secret:latest
# e atualize o mesmo valor no Render
```
Enquanto os dois lados não tiverem o mesmo valor, toda chamada é recusada —
falha fechada, que é o comportamento desejado.

---

## Riscos conhecidos

| # | Risco | Grav. | Mitigação |
|---|---|---|---|
| R1 | **Seletores do portal não validados contra o site real** | 🔴 | Isolados em `portal.selectors.js`, com lista de candidatos e log `seletor.fallback`. A primeira execução autenticada é o teste de verdade |
| R2 | Instância reciclada durante o 2FA perde a sessão | 🟡 | `MARTIN_BROWER_REMOTE_SESSION_LOST` com mensagem clara; usuário reinicia. Consequência aceita de não persistir credencial |
| R3 | CAPTCHA no login | 🟡 | Worker **para** e devolve `MANUAL_VERIFICATION_REQUIRED`. Sem contorno |
| R4 | Cold start de 10–25 s (imagem grande) | 🟢 | Aceitável; a UI mostra "Iniciando navegador seguro" |
| R5 | Senha atravessa dois serviços | 🟡 | HTTPS + OIDC + HMAC sobre o corpo; só em memória; descartada após preencher o formulário |
| R6 | Custo por instância presa | 🟢 | max-instances 1, timeout, SIGTERM, alerta de orçamento |
| R7 | Versão da imagem ≠ versão do pacote Playwright | 🟢 | Pinadas em 1.49.1 nos dois lugares, documentado no Dockerfile |
| R8 | Relógio do Render fora de sincronia > 60 s | 🟢 | Toda chamada falharia; o log `hmac.recusado` traz o desvio em ms |

---

## Antes de ligar a flag em produção

- [ ] Imagem construída e testada localmente
- [ ] Worker deployado e `/health` respondendo
- [ ] IAM configurado (só `mb-backend-invoker` pode invocar)
- [ ] Segredo no Secret Manager e no Render, **iguais**
- [ ] Uma sincronização real concluída em homologação
- [ ] Log revisado: nenhuma senha, token ou cookie
- [ ] Seletores confirmados (sem `seletor.fallback` no log)
- [ ] Alerta de orçamento criado
- [ ] Suíte completa verde
