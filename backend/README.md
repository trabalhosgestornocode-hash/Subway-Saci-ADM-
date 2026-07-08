# Subway Saci — Backend (Fase 1)

API Node.js + Express conectada ao Supabase. Módulos: **produtos**, **cmv**, **dashboard**.

## Rodar

```bash
cd backend
cp .env.example .env      # e preencha SUPABASE_SERVICE_ROLE_KEY (chave secreta)
npm install
npm run dev
```
Sobe em `http://localhost:3001`. Requer Node 20.6+.

> ⚠️ A `SUPABASE_SERVICE_ROLE_KEY` é a chave **secreta** (`sb_secret_...`), pega em
> Project Settings → API. Ela ignora o RLS — vive só no `.env`, nunca no git/frontend.

## Endpoints (base `/api/v1`)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Status do serviço |
| GET | `/api/v1/produtos?vendavel=true&tipo=sanduiche` | Lista produtos |
| GET | `/api/v1/produtos/:id` | Produto + ficha técnica + preços |
| GET | `/api/v1/cmv?canal=balcao&tabela=A` | Margem/CMV por produto |
| GET | `/api/v1/cmv/produto/:id` | Margem de 1 produto (todos canais) |
| GET | `/api/v1/dashboard/resumo` | Faturamento, estoque crítico, top produtos |

## Multi-tenant (dev)
A organização/unidade vêm dos headers `x-organizacao-id` / `x-unidade-id`;
sem eles, usa `DEFAULT_ORG_ID` / `DEFAULT_UNIDADE_ID` do `.env`.
No futuro, virão do JWT do usuário (Supabase Auth).

## Testes rápidos
```bash
curl http://localhost:3001/health
curl "http://localhost:3001/api/v1/produtos?vendavel=true"
curl "http://localhost:3001/api/v1/cmv?canal=balcao&tabela=A"
```

## Arquitetura
Cada módulo segue: `routes` → `controller` (HTTP) → `service` (regra + Supabase).
O cliente Supabase (`src/config/supabase.js`) usa a service_role e ignora RLS;
o isolamento por tenant é feito no `middlewares/tenant.js` + filtros por `organizacao_id`.
