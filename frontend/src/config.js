// Configuração central do frontend (escalável — adicionar itens aqui reflete no app)
export const API_BASE = ""; // mesma origem (backend serve o front)

export const TABELAS = {
  balcao: ["A", "B", "C", "D", "E", "F", "AERO A", "AERO B"],
  ifood: ["A", "B", "C", "D", "E", "F", "G", "H", "Z1", "Z2", "Z3", "Z4"],
};

// Limites de CMV (%) para classificar status
export const CMV_LIMITES = { saudavel: 28, atencao: 35 };

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
export const MENU = [
  { id: "dashboard",     label: "Dashboard",       icon: "📊", tipo: "pagina",      secao: "OPERAÇÃO" },
  { id: "produtos",      label: "Produtos / CMV",  icon: "🥪", tipo: "pagina",      secao: "OPERAÇÃO" },
  { id: "estoque",       label: "Estoque",         icon: "📦", tipo: "construcao",  secao: "OPERAÇÃO" },
  { id: "vendas",        label: "Vendas",          icon: "🧾", tipo: "construcao",  secao: "OPERAÇÃO" },
  { id: "distribuidoras",label: "Distribuidoras",  icon: "🚚", tipo: "construcao",  secao: "OPERAÇÃO" },
  { id: "martinbrower",  label: "Martin Brower",   icon: "🏭", tipo: "integracao",  integ: "martinbrower", secao: "INTEGRAÇÕES" },
  { id: "swfast",        label: "SWFast / PDV",    icon: "💳", tipo: "integracao",  integ: "swfast",       secao: "INTEGRAÇÕES" },
  { id: "ifood",         label: "iFood",           icon: "🛵", tipo: "integracao",  integ: "ifood",        secao: "INTEGRAÇÕES" },
  { id: "cocacola",      label: "Coca-Cola",       icon: "🥤", tipo: "integracao",  integ: "cocacola",     secao: "INTEGRAÇÕES" },
  { id: "claudiahortifruti", label: "Cláudia Hortifruti", icon: "🍓", tipo: "integracao", integ: "claudiahortifruti", secao: "INTEGRAÇÕES" },
  { id: "ia",            label: "Agente de IA",    icon: "🤖", tipo: "integracao",  integ: "ia",           secao: "INTELIGÊNCIA" },
  { id: "relatorios",    label: "Relatórios",      icon: "📈", tipo: "construcao",  secao: "INTELIGÊNCIA" },
  { id: "integracoes",   label: "Integrações",     icon: "🔌", tipo: "integracoes", secao: "INTELIGÊNCIA" },
  { id: "configuracoes", label: "Configurações",   icon: "⚙️", tipo: "configuracoes", secao: "SISTEMA" },
];

// Status possíveis de integração
export const STATUS_INTEGRACAO = {
  conectado:     { label: "Conectado",              classe: "ok" },
  planejamento:  { label: "Em planejamento",        classe: "warn" },
  futuro:        { label: "Futuramente conectado",  classe: "info" },
  nao_conectado: { label: "Não conectado",          classe: "muted" },
};

// Catálogo de integrações (usado na página Integrações e nas telas individuais)
export const INTEGRACOES = {
  supabase: {
    nome: "Supabase", icon: "🗄️", status: "conectado",
    desc: "Banco de dados PostgreSQL. Já conectado e servindo os dados do sistema.",
    features: ["Catálogo, insumos e fichas técnicas", "Cálculo de CMV via views", "Base para RLS multi-loja"],
  },
  ifood: {
    nome: "iFood", icon: "🛵", logo: "/assets/logo-ifood.jpeg", status: "planejamento",
    desc: "Monitora o cardápio do iFood em tempo real (preços e itens publicados). Não recebe pedidos — foco em acompanhar e detectar divergências.",
    features: ["Monitorar cardápio ao vivo", "Conferir preços publicados", "Alertar divergências de preço"],
  },
  swfast: {
    nome: "SWFast / PDV", icon: "💳", logo: "/assets/logo-sw.jpeg", status: "planejamento",
    desc: "Recebe o fechamento de caixa diário da Subway Saci — o que vendeu e como vendeu. Não registra vendas nem faz fechamento: apenas importa e agrega para melhorar o CMV.",
    features: ["Importar fechamento diário", "Mix de produtos vendidos", "CMV real x teórico"],
  },
  martinbrower: {
    nome: "Martin Brower", icon: "🏭", logo: "/assets/logo-mb.jpeg", status: "futuro",
    desc: "Distribuidora oficial: fonte do custo real de cada insumo comprado, mantendo o CMV sempre preciso e atualizado.",
    features: ["Custo real por insumo", "Atualização automática de custos", "Notas e histórico de compra"],
  },
  cocacola: {
    nome: "Coca-Cola", icon: "🥤", logo: "/assets/logo-cocacola.png", status: "futuro",
    desc: "Distribuidora de bebidas (Coca-Cola): custo real de refrigerantes, sucos e água para manter o CMV das bebidas sempre preciso.",
    features: ["Custo real das bebidas", "Atualização de preços de refrigerantes", "Notas e histórico de compra"],
  },
  claudiahortifruti: {
    nome: "Cláudia Hortifruti", icon: "🍓", logo: "/assets/logo-claudia.svg", status: "futuro",
    desc: "Fornecedor de hortifrúti: custo real dos vegetais e frutas usados nos sanduíches e saladas, com controle de perdas de itens frescos.",
    features: ["Custo real de vegetais e frutas", "Controle de perdas de itens frescos", "Notas e histórico de compra"],
  },
  whatsapp: {
    nome: "WhatsApp", icon: "💬", status: "planejamento",
    desc: "Notificações automáticas (Evolution API / Baileys) do agente operacional.",
    features: ["Alertas de estoque crítico", "Aviso de CMV/margem", "Resumo diário de faturamento"],
  },
  ia: {
    nome: "Agente de IA", icon: "🤖", status: "planejamento",
    desc: "Monitora CMV, margem, ruptura de estoque e gera insights (OpenAI / Claude).",
    features: ["Previsão de ruptura e compra", "Detecção de desperdício e anomalias", "Relatórios e insights automáticos"],
  },
};
