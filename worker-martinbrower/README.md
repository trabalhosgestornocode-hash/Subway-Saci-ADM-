# Worker Martin Brower

Processo separado que dirige o Chromium via Playwright para autenticar no
Portal Martin Brower e coletar o catálogo. **Não faz parte do backend
principal** e nunca é deployado junto com ele.

## Por que separado

O backend roda no Render Free, com **512 MB**. Um Chromium headless consome
300–500 MB só para abrir uma aba, e o pacote do browser pesa ~150 MB no build.
Instalar Playwright lá derrubaria a API.

## O que ele faz — e o que não faz

**Faz:** login, 2FA, `findProxPedidoV2`, `loadItens`, e devolve os payloads
**crus** ao backend.

**Não faz:** normalizar, filtrar, calcular preço, gravar no Supabase. Nada de
regra de negócio. Toda a lógica de tenant, RLS, histórico e persistência fica
centralizada no backend — é o que preserva o isolamento multiempresa.

```
Backend Render ──HTTPS + OIDC + HMAC──► Worker ──► Portal Martin Brower
                 ◄── payloads crus ────
```

## Segurança

| Regra | Como é garantida |
|---|---|
| Credenciais só em memória | `sessions.js`; senha descartada logo após preencher o formulário |
| JWT e cookies nunca saem | ficam no browser context; usamos `page.request`, que os carrega sozinho |
| Nada persistido | sem banco, sem Redis, sem arquivo, sem volume |
| Sem segredo em log | `logsafe.js` mascara chaves sensíveis e padrões de JWT/cookie |
| Sem CAPTCHA contornado | detectado → `MARTIN_BROWER_MANUAL_VERIFICATION_REQUIRED`, para o humano resolver |
| Autenticação em 2 camadas | IAM do Cloud Run + HMAC próprio |
| Limpeza garantida | `finally` em cada rota, `SIGTERM`/`SIGINT`, TTL e varredura periódica |

## Rotas internas

Todas exigem HMAC. **Nunca chamadas pelo navegador.**

| Método | Rota |
|---|---|
| POST | `/internal/martin-brower/sessions` |
| POST | `/internal/martin-brower/sessions/:id/code` |
| POST | `/internal/martin-brower/sessions/:id/collect` |
| GET | `/internal/martin-brower/sessions/:id/status` |
| DELETE | `/internal/martin-brower/sessions/:id` |
| GET | `/health` — **sem HMAC** (o probe do Cloud Run não assina) |

### HMAC

```
mensagem = timestamp \n nonce \n MÉTODO \n path+query \n sha256(corpo)
assinatura = HMAC-SHA256(MB_WORKER_SECRET, mensagem)
```

Cabeçalhos: `X-MB-Timestamp`, `X-MB-Nonce`, `X-MB-Signature`.

Janela de **60 s**, nonce de uso único, comparação em tempo constante, cache de
nonces com teto e limpeza automática. O segredo e a assinatura completa nunca
são logados — só os 8 primeiros caracteres da assinatura, para correlacionar
linhas de log.

## Variáveis de ambiente

Ver [`.env.example`](.env.example). A única obrigatória é `MB_WORKER_SECRET`
(mínimo 32 caracteres) — **o worker recusa subir sem ela**.

## Trava de acesso ao portal real

O worker **recusa subir** se `MB_PORTAL_URL` apontar para um host da Martin
Brower sem `MB_ALLOW_REAL_PORTAL=true`. A verificação acontece em dois pontos:
na validação de configuração (subida) e imediatamente antes do `page.goto`.

**Por que existe.** Em 2026-07-22 um teste automatizado de HMAC — que no
Windows parava por falta de Chromium — seguiu adiante dentro do container e fez
uma tentativa de login no portal de produção com credenciais falsas. O script
era o mesmo; só o ambiente mudou. A trava mora no worker, e não nos scripts de
teste, porque um script pode ser escrito sem cuidado e o worker não.

Note que o **padrão** de `MB_PORTAL_URL` é o portal real — ou seja, subir o
container sem configurar nada resulta em recusa. Falha fechada, de propósito.

## Build e teste local

```bash
# Testes (sem Chromium, sem rede, sem Martin Brower)
npm install && npm test

# Build da imagem
docker build -t mb-worker:local .

# Rodar local — SEMPRE com alvo local, nunca o portal real
docker run --rm -p 8080:8080 \
  -e MB_WORKER_SECRET="$(openssl rand -base64 48)" \
  -e MB_PORTAL_URL="http://host.docker.internal:9099/" \
  --add-host host.docker.internal:host-gateway \
  mb-worker:local

# Health
curl http://127.0.0.1:8080/health
```

> ### ⚠️ Windows + Docker Desktop: use `127.0.0.1`, não `localhost`
>
> No Windows, `localhost` costuma resolver primeiro para IPv6 (`::1`), e o
> encaminhamento de porta do Docker Desktop não responde nesse endereço — a
> conexão fica pendurada até dar timeout, sem mensagem de erro útil.
>
> ```bash
> curl http://localhost:8080/health    # trava e expira
> curl http://127.0.0.1:8080/health    # funciona
> ```
>
> Vale para o `MB_WORKER_URL` do backend também: use
> `http://127.0.0.1:8080`. Em Linux e no Cloud Run isso não acontece.

Para exercitar uma rota interna localmente é preciso assinar a requisição — o
backend faz isso pelo adapter `martinbrower.remote.worker.js`. Chamar com curl
sem assinatura devolve `401`, corretamente.

## Memória medida (container, cgroup)

Medição real com Chromium ativo carregando uma página de 4000 linhas. O número
que vale é o do **cgroup** (`/sys/fs/cgroup/memory.current`): `docker stats` é
impreciso no backend WSL2, e `process.memoryUsage()` do Node **não** enxerga os
processos do Chromium, que são separados.

| Etapa | Memória | % de 2 GiB | Processos Chromium |
|---|---|---|---|
| Repouso | 62 MB | 3,0% | 0 |
| Browser lançado | 101 MB | 4,9% | 5 |
| Contexto + aba | 116 MB | 5,7% | 6 |
| Página carregada | 312 MB | 15,2% | 6 |
| Após interação | 325 MB | 15,9% | 6 |
| **Duas abas (pico)** | **499 MB** | **24,4%** | 7 |
| Após fechar tudo | 56 MB | 2,7% | 0 vivos |

**2 GiB tem folga de ~1,5 GB sobre o pior caso medido.** 1 GiB também caberia,
mas com margem bem menor — e o portal real tende a ser mais pesado que a página
de teste.

## Deploy (Cloud Run) — proposta, não executada

```bash
gcloud run deploy mb-worker \
  --source . \
  --region southamerica-east1 \
  --no-allow-unauthenticated \
  --service-account mb-worker-sa@PROJETO.iam.gserviceaccount.com \
  --memory 2Gi --cpu 1 --no-cpu-throttling \
  --concurrency 1 --min-instances 0 --max-instances 1 \
  --timeout 900 \
  --set-secrets MB_WORKER_SECRET=mb-worker-secret:latest
```

`--no-cpu-throttling` é **obrigatório**: sem ele o Cloud Run congela a CPU
entre requisições e o Chromium ficaria suspenso durante a espera do 2FA.

## Seletores do portal

Todos em [`src/portal.selectors.js`](src/portal.selectors.js), em lista de
candidatos por ordem de estabilidade (role/label → atributo → CSS). Quando um
candidato preferido falha, o log emite `seletor.fallback` — é o aviso de que o
portal mudou, **antes** de quebrar de vez.

⚠️ Os seletores **não foram validados contra o portal real**. A primeira
execução autenticada vai dizer quais acertaram.

## Pendência conhecida: processos zumbi

Cada ciclo de navegador deixa ~2 processos `headless_shell` em estado `Z`
(defunct), com PPID 1. **Não consomem memória** — só uma entrada na tabela de
processos — mas se acumulam enquanto a instância viver.

**Causa.** O Chromium cria subprocessos (renderer, gpu, zygote). Quando o
processo principal sai, os filhos são reparentados para o PID 1. Aqui o PID 1
é o Node, que não chama `wait()` em filhos que não são dele. É o problema
clássico de "Node como PID 1" em container.

**Impacto real.** Baixo no desenho atual: com `min-instances=0` e
`concurrency=1`, a instância morre entre sincronizações e os zumbis somem
junto. Só viraria problema se uma instância ficasse quente por centenas de
sincronizações seguidas.

**Correção quando fizer sentido:** adicionar `tini` como ENTRYPOINT no
Dockerfile — ele reaproveita o papel de PID 1 e colhe os órfãos. `docker run
--init` resolve localmente, mas o Cloud Run não expõe essa opção.

## Métricas

`/health` e os logs estruturados trazem memória (RSS/heap) e duração de cada
etapa cara (abertura do browser, login, coleta). É com isso que se dimensiona
memória e timeout do Cloud Run depois das primeiras execuções reais.
