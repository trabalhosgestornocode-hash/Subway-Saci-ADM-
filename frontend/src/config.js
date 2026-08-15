// Configuração central do frontend (escalável — adicionar itens aqui reflete no app)
export const API_BASE = ""; // mesma origem (backend serve o front)

export const TABELAS = {
  balcao: ["A", "B", "C", "D", "E", "F", "AERO A", "AERO B"],
  ifood: ["A", "B", "C", "D", "E", "F", "G", "H", "Z1", "Z2", "Z3", "Z4"],
};

// Limites de CMV (%) para classificar status.
// Alinhado à planilha de referência da Crescer com Delivery (aba "Base de
// Insumos" e fichas): Saudável < 32% · Atenção 32–40% · Crítico ≥ 40%.
export const CMV_LIMITES = { saudavel: 32, atencao: 40 };

// Comissão por canal (espelha canais_venda no banco) — usada no simulador de preço
export const COMISSAO = { balcao: 0, ifood: 0.27, uber: 0.15, app: 0, outro: 0 };

// Loja no iFood (aba iFood). Cole o link real da loja em `url`.
export const IFOOD_LOJA = {
  nome: "Subway Sanduíches - Saci",
  nota: "⭐ 4.8 · Pedido mínimo R$ 25 · 75–85 min",
  url: "https://www.ifood.com.br/delivery/teresina-pi/subway-sanduiches---saci-saci/a6e54fa0-1369-4039-bcc7-91c4db0339b9", // ex: https://www.ifood.com.br/delivery/.../subway-sanduiches-saci-...
};

// Ordem das seções da sidebar
export const SECOES = ["OPERAÇÃO", "INTEGRAÇÕES", "INTELIGÊNCIA", "SISTEMA"];

// Itens da sidebar. tipo: pagina | construcao | integracao | integracoes
//
// `modulo`: id do módulo contratável (ver backend/src/shared/modulos.js) que
// controla se este item aparece para a empresa logada. Item sem `modulo`
// (Agente de IA, Relatórios, Integrações-hub, Configurações) fica sempre
// visível — a Crescer não gateia infraestrutura do sistema, só as
// funcionalidades de OPERAÇÃO/INTEGRAÇÕES que o SuperAdmin provisiona por
// empresa (ver frontend/src/sessao.js#temModulo e app.js#montarMenu).
// `icon` é um nome do conjunto de ícones SVG compartilhado (ver icons.js),
// não emoji — rebrand visual: sidebar sem emoji, mesmo estilo de traço da
// tela de login. `logo` (imagem) tem prioridade sobre `icon` (ver
// app.js#montarMenu) — usado tanto para logotipo real de integração quanto
// para os ícones de arte própria da unidade em /assets (ícones "neon"
// vermelho/preto pedidos para a seção OPERAÇÃO — autorizado usar todos,
// incluindo os 4 com arte de marca de terceiro, ciente do alcance
// multiempresa do menu).
export const MENU = [
  { id: "dashboard",     label: "Dashboard",       icon: "bar-chart", logo: "/assets/menu-dashboard.png", tipo: "pagina",      secao: "OPERAÇÃO", modulo: "dashboard" },
  { id: "produtos",      label: "Produtos / CMV",  icon: "grid", logo: "/assets/menu-produtos-cmv.png", tipo: "pagina",      secao: "OPERAÇÃO", modulo: "products_cmv" },
  { id: "insumos",       label: "Insumos",         icon: "tag", logo: "/assets/menu-insumos.png", tipo: "insumos",     secao: "OPERAÇÃO", modulo: "ingredients" },
  { id: "estoque",       label: "Estoque",         icon: "package", logo: "/assets/menu-estoque.png", tipo: "construcao",  secao: "OPERAÇÃO", modulo: "inventory" },
  { id: "vendas",        label: "Vendas",          icon: "receipt", logo: "/assets/menu-vendas.png", tipo: "vendas",      secao: "OPERAÇÃO", modulo: "sales" },
  { id: "dashboard-executivo", label: "Dashboard iFood", icon: "trending-up", logo: "/assets/menu-dashboard-ifood.png", tipo: "dashboard-executivo", secao: "OPERAÇÃO", modulo: "ifood_dashboard" },
  { id: "bonificacao-mensal", label: "Bonificação Mensal", icon: "award", logo: "/assets/menu-bonificacao-mensal.png", tipo: "bonificacao-mensal", secao: "OPERAÇÃO", modulo: "monthly_bonus" },
  { id: "parser-food-delivery", label: "Parser Food Delivery", icon: "truck", logo: "/assets/menu-parser-food-delivery.png", tipo: "parser-food-delivery", secao: "OPERAÇÃO", modulo: "parser_food_delivery" },
  { id: "distribuidoras",label: "Distribuidoras",  icon: "truck", logo: "/assets/menu-distribuidoras.png", tipo: "construcao",  secao: "OPERAÇÃO", modulo: "distributors" },
  { id: "martinbrower",  label: "Martin Brower",   icon: "package", tipo: "martinbrower", integ: "martinbrower", secao: "INTEGRAÇÕES", modulo: "martin_brower" },
  { id: "swfast",        label: "SWFast / PDV",    icon: "credit-card", tipo: "integracao",  integ: "swfast",       secao: "INTEGRAÇÕES", modulo: "swfast" },
  { id: "ifood",         label: "iFood",           icon: "truck", tipo: "integracao",  integ: "ifood",        secao: "INTEGRAÇÕES", modulo: "ifood" },
  { id: "cocacola",      label: "Coca-Cola",       icon: "tag", tipo: "integracao",  integ: "cocacola",     secao: "INTEGRAÇÕES", modulo: "coca_cola" },
  { id: "claudiahortifruti", label: "Cláudia Hortifruti", icon: "tag", tipo: "integracao", integ: "claudiahortifruti", secao: "INTEGRAÇÕES", modulo: "hortifruti" },
  { id: "ia",            label: "Agente de IA",    icon: "bot", tipo: "integracao",  integ: "ia",           secao: "INTELIGÊNCIA" },
  { id: "relatorios",    label: "Relatórios",      icon: "pie-chart", tipo: "construcao",  secao: "INTELIGÊNCIA" },
  { id: "integracoes",   label: "Integrações",     icon: "link", tipo: "integracoes", secao: "INTELIGÊNCIA" },
  { id: "configuracoes", label: "Configurações",   icon: "settings", tipo: "configuracoes", secao: "SISTEMA" },
];

// ---------- Insumos / Ficha técnica ----------
// "Categoria" do insumo = enum tipo_insumo do banco (espelha o backend).
export const CATEGORIAS_INSUMO = [
  ["proteina", "Proteína"], ["queijo", "Queijo"], ["molho", "Molho"], ["vegetal", "Vegetal"],
  ["pao", "Pão"], ["embalagem", "Embalagem"], ["bebida", "Bebida"], ["descartavel", "Descartável"],
  ["doce", "Doce"], ["chips", "Chips"], ["outro", "Outro"],
];
export const CATEGORIA_INSUMO_ROTULO = Object.fromEntries(CATEGORIAS_INSUMO);

// Unidades-base suportadas na 1ª versão (unidade, massa, volume).
export const UNIDADES_BASE = [
  ["un", "unidade"], ["g", "grama"], ["kg", "quilograma"], ["ml", "mililitro"], ["l", "litro"],
];
export const UNIDADE_ROTULO = { ...Object.fromEntries(UNIDADES_BASE), fatia: "fatia", porcao: "porção", folha: "folha" };

// Sugestões de forma de compra (campo descritivo — não é unidade de medida).
export const FORMAS_COMPRA = ["caixa", "pacote", "saco", "garrafa", "bandeja", "fardo", "unidade"];

// Status possíveis de integração
export const STATUS_INTEGRACAO = {
  conectado:     { label: "Conectado",              classe: "ok" },
  planejamento:  { label: "Em planejamento",        classe: "warn" },
  futuro:        { label: "Futuramente conectado",  classe: "info" },
  nao_conectado: { label: "Não conectado",          classe: "muted" },
};

// Catálogo de integrações (usado na página Integrações e nas telas individuais).
// `icon` também é nome do conjunto SVG (ver MENU acima) — só aparece quando
// não há `logo` (marca real do parceiro).
export const INTEGRACOES = {
  supabase: {
    nome: "Supabase", icon: "database", status: "conectado",
    desc: "Banco de dados PostgreSQL. Já conectado e servindo os dados do sistema.",
    features: ["Catálogo, insumos e fichas técnicas", "Cálculo de CMV via views", "Base para RLS multi-loja"],
  },
  ifood: {
    nome: "iFood", icon: "truck", logo: "/assets/menu-dashboard-ifood.png", status: "planejamento",
    desc: "Monitora o cardápio do iFood em tempo real (preços e itens publicados). Não recebe pedidos — foco em acompanhar e detectar divergências.",
    features: ["Monitorar cardápio ao vivo", "Conferir preços publicados", "Alertar divergências de preço"],
  },
  swfast: {
    nome: "SWFast / PDV", icon: "credit-card", logo: "/assets/menu-swfast.png", status: "planejamento",
    desc: "Recebe o fechamento de caixa diário da Subway Saci — o que vendeu e como vendeu. Não registra vendas nem faz fechamento: apenas importa e agrega para melhorar o CMV.",
    features: ["Importar fechamento diário", "Mix de produtos vendidos", "CMV real x teórico"],
  },
  martinbrower: {
    nome: "Martin Brower", icon: "package", logo: "/assets/menu-martinbrower.png", status: "futuro",
    desc: "Distribuidora oficial: fonte do custo real de cada insumo comprado, mantendo o CMV sempre preciso e atualizado.",
    features: ["Custo real por insumo", "Atualização automática de custos", "Notas e histórico de compra"],
  },
  cocacola: {
    nome: "Coca-Cola", icon: "tag", logo: "/assets/menu-cocacola.png", status: "futuro",
    desc: "Distribuidora de bebidas (Coca-Cola): custo real de refrigerantes, sucos e água para manter o CMV das bebidas sempre preciso.",
    features: ["Custo real das bebidas", "Atualização de preços de refrigerantes", "Notas e histórico de compra"],
  },
  claudiahortifruti: {
    nome: "Cláudia Hortifruti", icon: "tag", logo: "/assets/menu-claudiahortifruti.png", status: "futuro",
    desc: "Fornecedor de hortifrúti: custo real dos vegetais e frutas usados nos sanduíches e saladas, com controle de perdas de itens frescos.",
    features: ["Custo real de vegetais e frutas", "Controle de perdas de itens frescos", "Notas e histórico de compra"],
  },
  whatsapp: {
    nome: "WhatsApp", icon: "message-circle", status: "planejamento",
    desc: "Notificações automáticas (Evolution API / Baileys) do agente operacional.",
    features: ["Alertas de estoque crítico", "Aviso de CMV/margem", "Resumo diário de faturamento"],
  },
  ia: {
    nome: "Agente de IA", icon: "bot", status: "planejamento",
    desc: "Monitora CMV, margem, ruptura de estoque e gera insights (OpenAI / Claude).",
    features: ["Previsão de ruptura e compra", "Detecção de desperdício e anomalias", "Relatórios e insights automáticos"],
  },
};
