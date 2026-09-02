// Catálogo de integrações do sistema — a "fotografia" da arquitetura de dados
// da plataforma (bancos, PDVs, distribuidoras, fornecedores, notificações e
// integrações futuras).
//
// POR QUE MORA NO BACKEND (e não mais em frontend/src/config.js):
//   Esta lista é informação interna/estratégica — mostra de que o sistema
//   depende e para onde ele vai. Franqueados e perfis operacionais não devem
//   conseguir inspecioná-la, nem pelo bundle. Servida só por
//   GET /api/v1/inteligencia/integracoes, atrás de requireModulo('inteligencia').
//
//   O frontend NÃO tem cópia, JSON estático nem fallback local desta lista —
//   sem o módulo, a resposta é 403 e a página nem carrega.
//
// `chave` é o id estável (usado pelo front só para renderizar o card e casar
// com o item de menu da seção operacional "INTEGRAÇÕES", quando existir).
// `status` é uma das chaves de STATUS_INTEGRACAO (rótulo/estilo ficam no front).

/** @typedef {'conectado'|'planejamento'|'futuro'|'nao_conectado'} StatusIntegracao */

/**
 * @typedef {object} Integracao
 * @property {string} chave
 * @property {string} nome
 * @property {string} icon            nome do conjunto SVG do front (fallback quando não há logo)
 * @property {string|null} logo       caminho de imagem em /assets, quando há marca própria
 * @property {StatusIntegracao} status
 * @property {string} desc
 * @property {string[]} features
 */

/** @type {Integracao[]} */
export const INTEGRACOES = [
  {
    chave: "supabase",
    nome: "Supabase",
    icon: "database",
    logo: null,
    status: "conectado",
    desc: "Banco de dados PostgreSQL. Já conectado e servindo os dados do sistema.",
    features: [
      "Catálogo, insumos e fichas técnicas",
      "Cálculo de CMV via views",
      "Base para RLS multi-loja",
    ],
  },
  {
    chave: "ifood",
    nome: "iFood",
    icon: "truck",
    logo: "/assets/menu-dashboard-ifood.png",
    status: "planejamento",
    desc: "Monitora o cardápio do iFood em tempo real (preços e itens publicados). Não recebe pedidos — foco em acompanhar e detectar divergências.",
    features: [
      "Monitorar cardápio ao vivo",
      "Conferir preços publicados",
      "Alertar divergências de preço",
    ],
  },
  {
    chave: "swfast",
    nome: "SWFast / PDV",
    icon: "credit-card",
    logo: "/assets/menu-swfast.png",
    status: "planejamento",
    desc: "Recebe o fechamento de caixa diário — o que vendeu e como vendeu. Não registra vendas nem faz fechamento: apenas importa e agrega para melhorar o CMV.",
    features: [
      "Importar fechamento diário",
      "Mix de produtos vendidos",
      "CMV real x teórico",
    ],
  },
  {
    chave: "martinbrower",
    nome: "Martin Brower",
    icon: "package",
    logo: "/assets/menu-martinbrower.png",
    status: "futuro",
    desc: "Distribuidora oficial: fonte do custo real de cada insumo comprado, mantendo o CMV sempre preciso e atualizado.",
    features: [
      "Custo real por insumo",
      "Atualização automática de custos",
      "Notas e histórico de compra",
    ],
  },
  {
    chave: "cocacola",
    nome: "Coca-Cola",
    icon: "tag",
    logo: "/assets/menu-cocacola.png",
    status: "futuro",
    desc: "Distribuidora de bebidas (Coca-Cola): custo real de refrigerantes, sucos e água para manter o CMV das bebidas sempre preciso.",
    features: [
      "Custo real das bebidas",
      "Atualização de preços de refrigerantes",
      "Notas e histórico de compra",
    ],
  },
  {
    chave: "claudiahortifruti",
    nome: "Cláudia Hortifruti",
    icon: "tag",
    logo: "/assets/menu-claudiahortifruti.png",
    status: "futuro",
    desc: "Fornecedor de hortifrúti: custo real dos vegetais e frutas usados nos sanduíches e saladas, com controle de perdas de itens frescos.",
    features: [
      "Custo real de vegetais e frutas",
      "Controle de perdas de itens frescos",
      "Notas e histórico de compra",
    ],
  },
  {
    chave: "whatsapp",
    nome: "WhatsApp",
    icon: "message-circle",
    logo: null,
    status: "planejamento",
    desc: "Notificações automáticas (Evolution API / Baileys) do agente operacional.",
    features: [
      "Alertas de estoque crítico",
      "Aviso de CMV/margem",
      "Resumo diário de faturamento",
    ],
  },
];

/** Cópia por `chave` — usada pelo controller ao servir um card específico. */
export const INTEGRACOES_POR_CHAVE = Object.fromEntries(INTEGRACOES.map((i) => [i.chave, i]));
