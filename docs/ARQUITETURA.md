# Subway Saci — Arquitetura do Sistema

Sistema de gestão inteligente para franquia Subway. Núcleo operacional único:
produtos, estoque, CMV, distribuidora, vendas, faturamento, relatórios, IA e
notificações automáticas. **Multi-tenant desde o dia 1** (escala para outras franquias).

---

## 1. Princípios de arquitetura

| Princípio | Como aplicamos |
|-----------|----------------|
| **Multi-tenant** | `organizacoes` (grupo) → `unidades` (lojas). Catálogo é da organização; operação é da unidade. |
| **Modular** | Cada domínio (produtos, estoque, cmv…) é um módulo isolado no backend. |
| **Regras no lugar certo** | Baixa de estoque e integridade → triggers no PostgreSQL. Orquestração → backend. |
| **Idempotência** | Vendas de iFood/SWFast usam `external_id` único p/ não duplicar. |
| **Automação-ready** | Alertas gravam em tabela; n8n e WhatsApp apenas consomem. |
| **Backend é dono da verdade** | Frontend nunca fala direto com o banco (no MVP). |

---

## 2. Visão de alto nível

```
┌─────────────┐     ┌──────────────────────────────────────┐     ┌──────────────┐
│  FRONTEND   │────▶│              BACKEND API               │────▶│   SUPABASE   │
│ HTML/CSS/JS │◀────│           Node.js + Express            │◀────│ (PostgreSQL) │
└─────────────┘ WS  │  modules/ produtos, estoque, cmv,      │     │  + Auth      │
       ▲       │    │  vendas, distribuidora, dashboard, ia  │     │  + Realtime  │
       │       │    └───────┬───────────────┬────────────────┘     └──────────────┘
       │    Socket.io       │               │
       └───────────────┘    │               ▼
                            │        ┌───────────────┐   ┌──────────────┐
                    Webhooks│        │   Agente IA   │──▶│  OpenAI /    │
              (iFood/SWFast)│        │ (jobs + regras)│  │  Claude API  │
                            ▼        └───────┬───────┘   └──────────────┘
                     ┌──────────┐            │ grava alertas
                     │   n8n    │◀───────────┘
                     │(workflows)│──▶ Evolution API / Baileys ──▶ WhatsApp
                     └──────────┘
```

**Fluxo de dados típico (venda):**
`Venda entra (PDV/iFood/manual)` → `INSERT vendas_itens` → `trigger baixa estoque`
→ `agente IA avalia (CMV, ruptura)` → `grava alerta` → `n8n envia WhatsApp`.

---

## 3. Stack

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Express |
| Frontend | HTML + CSS + JavaScript puro |
| Banco | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| Tempo real | Socket.io (MVP) → migrar p/ Supabase Realtime se fizer sentido |
| Automação | n8n |
| IA | OpenAI ou Claude API |
| WhatsApp | Evolution API ou Baileys |
| Hospedagem | Render (MVP) → VPS quando escalar |

---

## 4. Modelo de dados (resumo)

Schema completo em [`database/schema.sql`](../database/schema.sql).

**Núcleo multi-tenant:** `organizacoes` · `unidades` · `perfis`

**Catálogo (por organização):** `categorias` · `fornecedores` · `ingredientes` ·
`produtos` · `produto_ingredientes` *(ficha técnica — coração do CMV)*

**Operação (por unidade):** `estoque` · `movimentacoes_estoque` · `lotes` ·
`pedidos_compra` · `pedidos_compra_itens` · `notas_fiscais` · `divergencias_compra` ·
`vendas` · `vendas_itens`

**Inteligência (por unidade):** `alertas` · `notificacoes` · `insights_ia` · `parametros`

### Relacionamentos-chave

```
organizacoes 1─┬─N unidades ─────────────┬─N vendas ──1─N vendas_itens ──N─1 produtos
               │                          ├─N estoque ──N─1 ingredientes
               ├─N produtos ──1─N produto_ingredientes ──N─1 ingredientes
               ├─N ingredientes           ├─N movimentacoes_estoque
               ├─N fornecedores ──1─N pedidos_compra ──1─N pedidos_compra_itens
               └─N categorias             └─N alertas ──1─N notificacoes
```

### Views prontas (dashboard/CMV)
`vw_produto_custo` · `vw_produto_margem` · `vw_estoque_critico` ·
`vw_faturamento_diario` · `vw_produtos_vendidos`

### Como o CMV é calculado
`custo_produto = Σ (ficha_técnica.quantidade × ingrediente.custo_unitário)`
`CMV% = custo_produto / preço_venda`. Tudo derivado da ficha técnica — nada digitado à mão.

---

## 5. Estrutura de pastas

```
subway-saci/
├── backend/
│   ├── src/
│   │   ├── config/            # supabase client, env, socket
│   │   ├── middlewares/       # auth, tenant (unidade/org), erro
│   │   ├── modules/
│   │   │   ├── produtos/      # routes · controller · service · validation
│   │   │   ├── ingredientes/
│   │   │   ├── cmv/
│   │   │   ├── estoque/
│   │   │   ├── distribuidora/
│   │   │   ├── vendas/
│   │   │   ├── dashboard/
│   │   │   ├── ia/
│   │   │   └── notificacoes/
│   │   ├── realtime/          # socket.io handlers
│   │   ├── jobs/              # tarefas agendadas do agente IA
│   │   ├── shared/            # utils, erros, respostas padrão
│   │   ├── app.js             # monta express + rotas
│   │   └── server.js          # sobe http + socket
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── pages/             # dashboard, produtos, estoque...
│   │   ├── components/
│   │   ├── services/          # chamadas à API
│   │   └── styles/
├── database/
│   ├── schema.sql
│   └── seeds/01_seed_demo.sql
├── automation/n8n/            # exports de workflows
└── docs/ARQUITETURA.md
```

**Anatomia de um módulo** (padrão repetido em todos):
`routes` (rotas) → `controller` (HTTP in/out) → `service` (regra de negócio + Supabase) → `validation` (schema de entrada).

---

## 6. Endpoints principais (REST)

Base: `/api/v1`. Todos exigem auth e escopo de tenant (header/JWT define org+unidade).

| Módulo | Endpoints |
|--------|-----------|
| **Produtos** | `GET/POST /produtos` · `GET/PUT/DELETE /produtos/:id` · `GET/PUT /produtos/:id/ficha-tecnica` |
| **Ingredientes** | `GET/POST /ingredientes` · `GET/PUT/DELETE /ingredientes/:id` |
| **CMV** | `GET /cmv/produto/:id` · `GET /cmv/categoria` · `GET /cmv/periodo?de=&ate=` |
| **Estoque** | `GET /estoque` · `POST /estoque/entrada` · `POST /estoque/perda` · `POST /estoque/inventario` · `GET /estoque/criticos` · `GET /estoque/movimentacoes` |
| **Distribuidora** | `GET/POST /pedidos-compra` · `PUT /pedidos-compra/:id/receber` · `POST /pedidos-compra/:id/divergencia` · `GET/POST /fornecedores` |
| **Vendas** | `POST /vendas` · `GET /vendas` · `POST /webhooks/ifood` · `POST /webhooks/swfast` |
| **Dashboard** | `GET /dashboard/resumo` · `GET /dashboard/faturamento` · `GET /dashboard/ranking` |
| **IA** | `POST /ia/analisar` · `GET /ia/insights` |
| **Notificações** | `GET /alertas` · `PUT /alertas/:id/status` · `POST /notificacoes/enviar` |

---

## 7. Roadmap / MVP em fases

**✅ Fase 0 — Fundação (agora):** schema do banco + arquitetura *(este entregável)*.

**Fase 1 — Cadastros + CMV (MVP núcleo):**
Backend base (Express + Supabase + auth/tenant) → CRUD de ingredientes/produtos →
ficha técnica → cálculo de CMV/margem → tela de produtos.
> *Entregável: cadastrar o cardápio a partir das suas planilhas e ver o CMV de cada item.*

**Fase 2 — Estoque + Vendas:**
Entrada/perda/inventário → registro de vendas → baixa automática (trigger já pronta) →
dashboard com faturamento e estoque crítico.

**Fase 3 — Distribuidora + Automação:**
Pedidos de compra, notas, divergências → agente IA (jobs) → alertas → n8n → WhatsApp.

**Fase 4 — Integrações + Escala:**
Webhooks iFood/SWFast → Realtime → RLS completo → 2ª unidade.

---

## 8. Próximo passo imediato

1. Rodar `database/schema.sql` no SQL Editor do Supabase.
2. Rodar `database/seeds/01_seed_demo.sql`.
3. Validar: `select * from vw_produto_margem where nome = 'BMT 15cm';`
4. Enviar as planilhas (preços balcão, preços iFood, custos/CMV) → mapeamos as colunas
   para `produtos` / `ingredientes` / `produto_ingredientes` e geramos o seed real.
5. Iniciar **Fase 1** (scaffold do backend).
