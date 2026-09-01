// Testes da renderização do Plano de Ação (dashboardExecutivoPlano.js) —
// unit, puro (só string HTML, sem DOM). Os objetos `diagnostico` são fixtures
// no MESMO formato que dashboardExecutivo.diagnostico.js#gerarDiagnostico
// entrega (ver dashboard-executivo-diagnostico.test.js no backend).
//
// Rodar: node --test frontend/test/dashboardExecutivoPlano.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planoAcaoHtml, fmtPp, recuperacaoDetalheHtml } from "../src/dashboardExecutivoPlano.js";

// Stub do botão do Agente (o real vem de agentePainel.js com o gate de módulo).
const deps = { botaoDiagnosticoHtml: (ap, tipo) => `<button data-attention-point="${ap}" data-diagnostico-tipo="${tipo ?? ""}">agente</button>` };

const TERMOS_NEGATIVOS = /(acima|ultrapass|excesso|reduz(?!ida)|estour|fora da meta|crítico|problema|piora)/i;

const critical = (over = {}) => ({
  diagnosticoId: "taxas_entregadores_fora_da_meta", tipo: "CRITICAL", categoria: "taxas_entregadores",
  titulo: "Taxas de Entregadores acima do limite",
  situacao: "15.7% do faturamento", meta: { ideal: 12, limite: 15 },
  diferenca: { pp: 3.7, reais: 350 },
  impacto: "Para retornar ao limite de 15.0%, é necessário reduzir aproximadamente R$ 350,00.",
  explicacao: "Taxas de Entregadores está em 15.7% do faturamento e ultrapassou o limite máximo de 15.0%.",
  acaoRecomendada: "Reveja os repasses a entregadores no período e os dias de maior volume.",
  objetivo: { proximo: "≤ 15.0%", ideal: "aproximar de 12.0%" },
  descricao: "…", cta: { label: "Analisar Taxas de Entregadores", aba: "indicadores" },
  ordenacao: { temImpacto: true, excessoReais: 350, distanciaLimitePp: 0.7 }, prioridade: 1, ...over,
});

const warning = (over = {}) => ({
  diagnosticoId: "servicos_promocoes_atencao", tipo: "WARNING", categoria: "servicos_promocoes",
  titulo: "Serviços e Promoções acima da faixa ideal",
  situacao: "6.2% do faturamento", meta: { ideal: 5, limite: 7 },
  diferenca: { pp: 1.2, reais: 600 },
  impacto: "Para voltar à meta ideal de 5.0%, seria necessário reduzir aproximadamente R$ 600,00.",
  explicacao: "Serviços e Promoções está em 6.2% do faturamento — acima da meta ideal de 5.0%, mas ainda dentro do limite de 7.0%.",
  acaoRecomendada: "Reveja o retorno das campanhas ativas.",
  objetivo: { proximo: "≤ 5.0%", ideal: null },
  descricao: "…", cta: { label: "Analisar Serviços e Promoções", aba: "indicadores" },
  ordenacao: { temImpacto: true, excessoReais: 600, distanciaLimitePp: -0.8 }, prioridade: 2, ...over,
});

const healthy = (over = {}) => ({
  diagnosticoId: "taxas_comissoes_dentro_da_meta", tipo: "HEALTHY", categoria: "taxas_comissoes",
  titulo: "Manter Taxas e Comissões sob controle",
  situacao: "12.0% do faturamento", status: "Dentro da meta", meta: { ideal: 13, limite: 13 },
  diferenca: { pp: 1 },
  explicacao: "O indicador está em 12.0%, dentro da faixa saudável (meta ideal 13.0%), e atualmente não exige correção.",
  comoPreservar: "Acompanhe mudanças nas taxas do iFood e no mix de canais.",
  objetivo: { proximo: null, ideal: "permanecer ≤ 13.0%" },
  cta: { label: "Analisar Taxas e Comissões", aba: "indicadores" }, ...over,
});

const dataPending = (over = {}) => ({
  diagnosticoId: "dias_pendentes", tipo: "DATA_PENDING", categoria: "dados",
  titulo: "Regularizar 1 dia", situacao: "1 dia sem lançamento no período",
  meta: null, diferenca: null, impacto: null,
  explicacao: "Existem 1 dia sem lançamento neste mês (31/08).",
  acaoRecomendada: "Lance os dias pendentes (31/08).",
  objetivo: { proximo: "regularizar os lançamentos pendentes", ideal: null },
  descricao: "…", cta: { label: "Regularizar 1 dia", aba: "lancamentos" },
  ordenacao: { temImpacto: false, excessoReais: null, distanciaLimitePp: null }, prioridade: 3, ...over,
});

const diag = (over = {}) => ({
  pontosFortes: [], pontosAtencao: [], alertas: [],
  acoes: [], manutencao: [],
  semDadosSuficientes: false,
  confiabilidade: { nivel: "alta", motivo: "Mês com todos os dias regularizados." },
  resumo: { estado: "SAUDAVEL", manchete: "Operação saudável", contadores: { criticos: 0, atencoes: 0, saudaveis: 0, dadosPendentes: 0 }, texto: "Tudo certo." },
  ...over,
});

describe("Resumo operacional", () => {
  test("renderiza manchete, chips por contador e texto", () => {
    const html = planoAcaoHtml(diag({
      resumo: { estado: "CRITICO", manchete: "Operação com pontos críticos", contadores: { criticos: 2, atencoes: 1, saudaveis: 3, dadosPendentes: 1 }, texto: "Frase determinística." },
    }), deps);
    assert.match(html, /dex-plano-resumo-critico/);
    assert.match(html, /Operação com pontos críticos/);
    assert.match(html, /2 críticos/);
    assert.match(html, /1 atenção/);
    assert.match(html, /3 saudáveis/);
    assert.match(html, /1 pendência de dados/);
    assert.match(html, /Frase determinística\./);
  });

  test("contador zerado não vira chip", () => {
    const html = planoAcaoHtml(diag({
      resumo: { estado: "SAUDAVEL", manchete: "Operação saudável", contadores: { criticos: 0, atencoes: 0, saudaveis: 4, dadosPendentes: 0 }, texto: "x" },
    }), deps);
    assert.ok(!/crítico/.test(html));
    assert.match(html, /4 saudáveis/);
  });
});

describe("Confiabilidade — reaproveita o texto do domínio, sem duplicar regra", () => {
  test("nivel media/baixa -> linha de confiabilidade com o motivo", () => {
    const html = planoAcaoHtml(diag({ confiabilidade: { nivel: "media", motivo: "1 dia(s) pendente(s)" } }), deps);
    assert.match(html, /dex-plano-conf/);
    assert.match(html, /Análise baseada nos dados disponíveis — 1 dia\(s\) pendente\(s\)\./);
  });

  test("nivel alta -> nenhuma linha de confiabilidade", () => {
    const html = planoAcaoHtml(diag({ confiabilidade: { nivel: "alta", motivo: "Mês com todos os dias regularizados." } }), deps);
    assert.ok(!/dex-plano-conf/.test(html));
  });
});

describe("Card CRITICAL — completo", () => {
  const html = planoAcaoHtml(diag({ acoes: [critical()], resumo: { estado: "CRITICO", manchete: "x", contadores: {}, texto: "y" } }), deps);

  test("bloco 'Prioridades agora' + card numerado + badge Prioridade", () => {
    assert.match(html, /Prioridades agora/);
    assert.match(html, /dex-acao alerta dex-acao-critical/);
    assert.match(html, /<div class="dex-acao-num">1<\/div>/);
    assert.match(html, /Prioridade<\/span>/);
  });

  test("mostra atual, meta ideal, limite, diferença, impacto, ação e objetivos", () => {
    assert.match(html, /15\.7% do faturamento/);
    assert.match(html, /Meta ideal <b>12\.0%<\/b>/); // fmtPct(12)
    assert.match(html, /Limite <b>15\.0%<\/b>/);
    assert.match(html, /3\.7 p\.p\. acima da meta ideal/);
    assert.match(html, /<b>Impacto:<\/b>/);
    assert.match(html, /<b>O que fazer agora:<\/b>/);
    assert.match(html, /<b>Próximo objetivo:<\/b> ≤ 15\.0%/);
    assert.match(html, /<b>Objetivo ideal:<\/b> aproximar de 12\.0%/);
  });

  test("CTA de aba + botão do Agente com a classificação do card", () => {
    assert.match(html, /data-cta-aba="indicadores"/);
    assert.match(html, /data-attention-point="taxas_entregadores" data-diagnostico-tipo="CRITICAL"/);
  });
});

describe("Card WARNING — intermediário, sem linguagem de limite estourado", () => {
  const html = planoAcaoHtml(diag({ acoes: [warning()], resumo: { estado: "ATENCAO", manchete: "x", contadores: {}, texto: "y" } }), deps);

  test("bloco 'Acompanhar de perto' + badge Acompanhar", () => {
    assert.match(html, /Acompanhar de perto/);
    assert.match(html, /dex-acao atencao dex-acao-warning/);
    assert.match(html, /Acompanhar<\/span>/);
  });

  test("mostra meta ideal e limite, mas a explicação diz que segue dentro do limite", () => {
    assert.match(html, /Limite <b>7\.0%<\/b>/);
    assert.match(html, /ainda dentro do limite/i);
  });
});

describe("Card HEALTHY — compacto, preservação, expansão 'Como manter'", () => {
  const html = planoAcaoHtml(diag({ manutencao: [healthy()], resumo: { estado: "SAUDAVEL", manchete: "x", contadores: {}, texto: "y" } }), deps);

  test("bloco 'Manter o que está funcionando' + badge Saudável + sem número", () => {
    assert.match(html, /Manter o que está funcionando/);
    assert.match(html, /dex-acao forte dex-acao-healthy/);
    assert.match(html, /Saudável<\/span>/);
    assert.match(html, /dex-acao-ic/); // ícone no lugar do número
    assert.ok(!/class="dex-acao-num"/.test(html)); // (dex-acao-numeros contém a substring, por isso a âncora)
  });

  test("botão 'Como manter este resultado' com data-cta-expandir + bloco detalhe escondido", () => {
    assert.match(html, /data-cta-expandir/);
    assert.match(html, /Como manter este resultado/);
    assert.match(html, /<div class="dex-acao-detalhe" hidden>/);
    assert.match(html, /<b>Para preservar:<\/b>/);
  });

  test("linguagem reconhece que o resultado é POSITIVO, sem termos negativos", () => {
    assert.match(html, /Dentro da meta/);
    assert.match(html, /1\.0 p\.p\. abaixo da meta ideal/);
    // titulo + explicacao + comoPreservar não podem soar como problema
    assert.ok(!/ultrapass|fora da meta|precisa de intervenção|está alto/i.test(html.replace(/dex-acao-detalhe/g, "")));
  });

  test("botão do Agente presente e marcado como HEALTHY", () => {
    assert.match(html, /data-attention-point="taxas_comissoes" data-diagnostico-tipo="HEALTHY"/);
  });
});

describe("Card DATA_PENDING — informativo, separado de performance", () => {
  const html = planoAcaoHtml(diag({ acoes: [dataPending()], resumo: { estado: "ATENCAO", manchete: "x", contadores: {}, texto: "y" } }), deps);

  test("bloco 'Qualidade dos dados' + badge Dados pendentes, sem impacto financeiro", () => {
    assert.match(html, /Qualidade dos dados/);
    assert.match(html, /dex-acao dados dex-acao-data-pending/);
    assert.match(html, /Dados pendentes<\/span>/);
    assert.ok(!/<b>Impacto:<\/b>/.test(html));
    assert.ok(!/Meta ideal/.test(html)); // meta null -> não renderiza
  });
});

describe("Campos null/undefined não renderizam", () => {
  test("CRITICAL sem impacto e sem objetivo.ideal", () => {
    const html = planoAcaoHtml(diag({
      acoes: [critical({ impacto: null, objetivo: { proximo: "≤ 15.0%", ideal: null } })],
      resumo: { estado: "CRITICO", manchete: "x", contadores: {}, texto: "y" },
    }), deps);
    assert.ok(!/<b>Impacto:<\/b>/.test(html));
    assert.ok(!/Objetivo ideal/.test(html));
    assert.match(html, /Próximo objetivo/); // esse continua
  });

  test("indicador sem meta -> não renderiza 'Meta ideal'/'Limite'", () => {
    const html = planoAcaoHtml(diag({
      acoes: [critical({ meta: null, diferenca: { pp: null, reais: -400 } })],
      resumo: { estado: "CRITICO", manchete: "x", contadores: {}, texto: "y" },
    }), deps);
    assert.ok(!/Meta ideal/.test(html));
    assert.ok(!/Limite </.test(html));
  });
});

describe("Cenários de composição do Plano", () => {
  test("só positivos -> sem 'Prioridades agora', com 'Manter o que está funcionando'", () => {
    const html = planoAcaoHtml(diag({
      manutencao: [healthy(), healthy({ diagnosticoId: "servicos_promocoes_dentro_da_meta", categoria: "servicos_promocoes", titulo: "Manter Serviços e Promoções sob controle" })],
      resumo: { estado: "SAUDAVEL", manchete: "Operação saudável", contadores: { criticos: 0, atencoes: 0, saudaveis: 2, dadosPendentes: 0 }, texto: "preserve" },
    }), deps);
    assert.ok(!/Prioridades agora/.test(html));
    assert.ok(!/Acompanhar de perto/.test(html));
    assert.match(html, /Manter o que está funcionando/);
    assert.ok(!/Nenhuma ação prioritária/.test(html)); // nunca mais a frase antiga
  });

  test("misto -> os quatro blocos, numeração contínua só em CRITICAL+WARNING", () => {
    const html = planoAcaoHtml(diag({
      acoes: [critical(), warning(), dataPending()],
      manutencao: [healthy()],
      resumo: { estado: "CRITICO", manchete: "x", contadores: { criticos: 1, atencoes: 1, saudaveis: 1, dadosPendentes: 1 }, texto: "y" },
    }), deps);
    assert.match(html, /Prioridades agora/);
    assert.match(html, /Acompanhar de perto/);
    assert.match(html, /Manter o que está funcionando/);
    assert.match(html, /Qualidade dos dados/);
    assert.match(html, /<div class="dex-acao-num">1<\/div>/); // CRITICAL
    assert.match(html, /<div class="dex-acao-num">2<\/div>/); // WARNING
    assert.ok(!/<div class="dex-acao-num">3<\/div>/.test(html)); // DATA_PENDING não numera
  });

  test("semDadosSuficientes -> mensagem clara + resumo, nunca cards", () => {
    const html = planoAcaoHtml(diag({
      semDadosSuficientes: true,
      resumo: { estado: "DADOS_INSUFICIENTES", manchete: "Ainda sem dados neste mês", contadores: { criticos: 0, atencoes: 0, saudaveis: 0, dadosPendentes: 0 }, texto: "Ainda não há lançamentos suficientes neste mês para gerar um plano de ação." },
    }), deps);
    assert.match(html, /Ainda sem dados neste mês/);
    assert.match(html, /Ainda não há lançamentos suficientes/);
    assert.ok(!/dex-acao /.test(html));
  });
});

describe("helpers exportados", () => {
  test("fmtPp formata e trata null", () => {
    assert.equal(fmtPp(null), "—");
    assert.equal(fmtPp(3.75), "3.8 p.p.");
  });
  test("recuperacaoDetalheHtml monta a grade de recuperação", () => {
    const html = recuperacaoDetalheHtml({ referencia: 80000, atual: 40000, faltante: 40000, diasRestantes: 10, mediaAtual: 2000, mediaNecessaria: 4000, cenarios: { conservador: 2000, parcial: 2200, forte: 2400 } });
    assert.match(html, /Faturamento de referência/);
    assert.match(html, /Cenário conservador/);
  });
});
