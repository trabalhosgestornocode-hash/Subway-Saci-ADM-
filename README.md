# 🥪 Subway Saci — Sistema de Gestão Inteligente

ERP operacional para franquia Subway, com foco em **CMV automático por ficha técnica**,
produtos, preços por canal e inteligência de negócio. Multi-tenant (preparado para
múltiplas unidades) e com **autenticação real** (Supabase Auth).

> Sistema administrativo — acesso restrito à equipe. Não é uma vitrine pública.

## ✨ O que já funciona
- **CMV real** calculado da ficha técnica (BOM recursivo, validado ao centavo)
- Catálogo com **preços por canal/tabela** (balcão e iFood) e **lucro líquido** (com comissão)
- Painel SaaS: dashboard com gráficos, tabela de produtos, ficha técnica, **simulador de preço**, edição
- **Login seguro** (Supabase Auth + JWT; API protegida no backend, não só na tela)

## 🧱 Stack
Node.js + Express · HTML/CSS/JS puro (sem build) · Supabase (PostgreSQL + Auth) · Chart.js

## 📂 Estrutura
```
├── backend/        API Express + Supabase (serve também o frontend)
│   ├── src/        config, middlewares (auth), modules (produtos/cmv/dashboard)
│   └── scripts/    criar-admin.js
├── frontend/       painel em módulos ES (login, dashboard, produtos, integrações)
├── database/       schema.sql · migrations · seeds
├── docs/           ARQUITETURA · SETUP_SUPABASE · DEPLOY
└── render.yaml     blueprint de deploy (Render)
```

## 🚀 Rodar localmente
**1. Banco (Supabase)** — no SQL Editor, rode em ordem:
`database/schema.sql` → `database/migrations/001_rls_lockdown.sql` → `database/seeds/02_seed_real.sql` → `03_seed_precos.sql` → `04_seed_catalogo.sql`

**2. Backend**
```bash
cd backend
cp .env.example .env      # preencha as chaves do Supabase
npm install
npm run dev               # http://localhost:3001
```

**3. Primeiro usuário admin**
```bash
node --env-file=.env scripts/criar-admin.js seu@email.com SuaSenhaForte "Seu Nome"
```
Abra `http://localhost:3001` e entre com esse e-mail/senha.

## ☁️ Deploy (Render)
Veja **[docs/DEPLOY.md](docs/DEPLOY.md)**. Resumo: conecte o repositório, o `render.yaml`
provisiona um Web Service (o backend serve a API + o frontend). As chaves do Supabase
são definidas no painel do Render — **nunca no código**.

## 🔒 Segurança
- Autenticação real via Supabase Auth (senha com hash, JWT com expiração/refresh)
- Toda rota `/api/v1/*` exige token válido; usuário inativo é bloqueado
- O `.env` (com a chave secreta) **nunca** é versionado (está no `.gitignore`)
