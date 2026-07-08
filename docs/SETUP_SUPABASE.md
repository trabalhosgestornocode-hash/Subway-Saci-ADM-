# Setup do Supabase — Subway Saci

Guia para criar o banco do zero e rodar o schema + seed.

## 1. Criar conta e projeto
1. Acesse **https://supabase.com** → **Start your project** → entre com GitHub ou e-mail.
2. **New project**:
   - **Name:** `subway-saci`
   - **Database Password:** gere uma senha forte e **GUARDE** (vai no `.env` do backend).
   - **Region:** **South America (São Paulo)** — menor latência no Brasil.
   - **Plan:** Free (suficiente para o MVP).
3. Clique **Create new project** e aguarde ~2 min (provisionamento).

## 2. Rodar o schema
1. No menu lateral: **SQL Editor** → **+ New query**.
2. Abra `database/schema.sql`, copie **tudo**, cole no editor.
3. Clique **Run** (ou Ctrl+Enter). Deve terminar sem erros (cria ~22 tabelas, tipos, funções e views).

> Observação: o schema usa `auth.users` e `auth.uid()` — já existem no Supabase por padrão, não precisa configurar nada.

## 3. Rodar o seed (dados reais)
1. **+ New query** de novo.
2. Abra `database/seeds/02_seed_real.sql`, copie tudo, cole e **Run**.
3. Isso insere organização, unidade, 97 insumos, 35 produtos e as fichas técnicas.

## 4. Validar
Rode no SQL Editor:
```sql
-- Custo calculado (com pão) de cada produto vendável:
select nome, tamanho, custo_cache from produtos where vendavel order by nome;

-- CMV e lucro (precisa dos preços do Stage 2 para ficar completo):
select * from vw_produto_margem limit 20;
```
O `custo_cache` do BMT 15cm deve dar **~7,46**.

## 5. Pegar as credenciais (para o backend depois)
Menu: **Project Settings** (engrenagem) → **API**. Anote:

| Onde usar | Chave |
|---|---|
| Backend (Express) — **SECRETA** | `service_role` key |
| Frontend / público | `anon` `public` key |
| Ambos | **Project URL** (ex: `https://xxxx.supabase.co`) |

Menu **Project Settings → Database** → **Connection string** (opcional, para migrations via CLI).

### `.env` do backend (criaremos na Fase 1)
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...   # NUNCA vai pro frontend nem pro git
SUPABASE_ANON_KEY=...
```

⚠️ **Nunca** exponha a `service_role` key no frontend nem faça commit dela. Ela ignora o RLS e tem acesso total.

## Reexecutar do zero (se precisar)
Os `CREATE TYPE` não são idempotentes. Para recomeçar, rode antes:
```sql
drop schema public cascade; create schema public;
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
```
Depois rode `schema.sql` e o seed de novo.
