// Normalizador da resposta do endpoint loadItens da Martin Brower.
//
// Transforma  payload.data.groups[].itens[]  (aninhado, com campos opcionais)
// numa lista plana e previsível.
//
// PRINCÍPIO: um item torto NUNCA derruba a sincronização. Item inválido vai
// para `rejeitados` com o motivo, e o resto do catálogo segue.
//
// O QUE ESTE MÓDULO DELIBERADAMENTE NÃO FAZ:
//   * não calcula custo por kg a partir de `weight` — weight é peso BRUTO da
//     caixa (ex: "BACON TIRAS CX 4 PCT X 1 KG" tem weight 4.62, não 4.0);
//   * não interpreta a embalagem a partir do texto da descrição;
//   * não usa `perc` do findProxPedidoV2 em regra nenhuma (significado não
//     confirmado);
//   * não decide o que ignorar — isso é do martinbrower.filtros.js.

// --- conversores seguros -------------------------------------------------

// Texto limpo, ou null. Colapsa espaços internos e apara as bordas.
function txt(valor) {
  if (valor == null) return null;
  const s = String(valor).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// Número finito, ou null. Aceita o decimal com vírgula por precaução —
// o portal manda ponto hoje, mas isso custa nada e evita um NaN silencioso.
function num(valor) {
  if (valor == null || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Inteiro finito, ou null (ids do portal).
function int(valor) {
  const n = num(valor);
  return n == null ? null : Math.trunc(n);
}

// Código oficial: SEMPRE string, para preservar zeros à esquerda.
function codigo(valor) {
  if (valor == null) return null;
  const s = String(valor).trim();
  return s === "" ? null : s;
}

// --- item ----------------------------------------------------------------

/**
 * Normaliza UM item de data.groups[].itens[].
 * @returns {{ok: true, produto: object} | {ok: false, motivo: string, bruto: object}}
 */
export function normalizarItem(item, grupoFallback = null) {
  const acp = item?.appClientProduct;
  const p = acp?.product;

  const cod = codigo(p?.code);
  const descricao = txt(p?.description);

  // Sem código ou sem descrição o registro é inútil: não dá para identificar
  // o produto nem para o humano conferir. Rejeita, mas não interrompe.
  if (!cod) return { ok: false, motivo: "item sem código", bruto: item };
  if (!descricao) return { ok: false, motivo: `item ${cod} sem descrição`, bruto: item };

  return {
    ok: true,
    produto: {
      orderId: int(item?.orderHeaderId),
      clientProductId: int(acp?.id),
      productId: int(p?.id),
      codigo: cod,
      codigoInterno: p?.ncode == null ? null : String(p.ncode).trim() || null,
      descricao,
      // preço pode legitimamente vir ausente (item sem preço no pedido):
      // isso NÃO invalida o produto, só não gera histórico.
      preco: num(p?.price),
      peso: num(p?.weight),
      volume: num(p?.volume),
      unidade: txt(p?.unit),
      unidadeDescricao: txt(p?.unitDescription),
      familia: txt(p?.family),
      familiaDescricao: txt(p?.familyDescription),
      grupoId: int(p?.group?.id),
      // group.description pode faltar; o rótulo do grupo pai serve de reserva.
      grupoDescricao: txt(p?.group?.description) ?? txt(grupoFallback),
      multiplo: num(acp?.multiple),
      quantidadeMedia: num(item?.averageQuantity),
      quantidadePedido: num(item?.quantity),
      statusItemId: int(item?.sysStatusItem?.id),
      tipoProduto: txt(acp?.type),
    },
  };
}

// --- catálogo ------------------------------------------------------------

/**
 * Normaliza a resposta completa do loadItens.
 * @param {object} payload resposta crua da API
 * @returns {{produtos: object[], rejeitados: {motivo: string}[], totalBruto: number, grupos: string[]}}
 */
export function normalizarCatalogo(payload) {
  const groups = payload?.data?.groups;
  if (!Array.isArray(groups)) {
    // Estrutura irreconhecível: devolve vazio e deixa o chamador decidir
    // (o sync trata catálogo vazio como MARTIN_BROWER_CATALOG_INVALID).
    return { produtos: [], rejeitados: [], totalBruto: 0, grupos: [] };
  }

  const produtos = [];
  const rejeitados = [];
  const grupos = new Set();
  // Um mesmo código pode aparecer em mais de um grupo: o primeiro vence,
  // senão o upsert se atropelaria dentro do próprio lote.
  const vistos = new Set();
  let totalBruto = 0;

  for (const g of groups) {
    const rotuloGrupo = txt(g?.group);
    if (rotuloGrupo) grupos.add(rotuloGrupo);
    const itens = Array.isArray(g?.itens) ? g.itens : [];

    for (const item of itens) {
      totalBruto += 1;
      let r;
      try {
        r = normalizarItem(item, rotuloGrupo);
      } catch (e) {
        rejeitados.push({ motivo: `falha ao normalizar item: ${e.message}` });
        continue;
      }
      if (!r.ok) { rejeitados.push({ motivo: r.motivo }); continue; }
      if (vistos.has(r.produto.codigo)) {
        rejeitados.push({ motivo: `código ${r.produto.codigo} duplicado no catálogo` });
        continue;
      }
      vistos.add(r.produto.codigo);
      produtos.push(r.produto);
    }
  }

  return { produtos, rejeitados, totalBruto, grupos: [...grupos] };
}

// --- pedido (findProxPedidoV2) -------------------------------------------

// Datas chegam como número: 20260725 e 111000 (hh:mm:ss sem zero à esquerda).
// Convertidas para ISO em horário local do servidor; retorna null se não der.
export function normalizarDataHora(data, hora) {
  const d = int(data);
  if (!d || String(d).length !== 8) return null;
  const s = String(d);
  const ano = Number(s.slice(0, 4));
  const mes = Number(s.slice(4, 6));
  const dia = Number(s.slice(6, 8));
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;

  const h = String(int(hora) ?? 0).padStart(6, "0");
  const hh = Number(h.slice(0, 2));
  const mm = Number(h.slice(2, 4));
  const ss = Number(h.slice(4, 6));
  if (hh > 23 || mm > 59 || ss > 59) return null;

  const dt = new Date(ano, mes - 1, dia, hh, mm, ss);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * Normaliza a resposta do findProxPedidoV2.
 * `perc` é devolvido cru e marcado — NÃO usar em regra de negócio até o
 * significado ser confirmado com a Martin Brower.
 */
export function normalizarPedido(payload) {
  const d = payload?.data;
  return {
    orderId: int(d?.orderId),
    janelaInicio: normalizarDataHora(d?.inicialDate, d?.inicialTime),
    janelaFinal: normalizarDataHora(d?.finalDate, d?.finalTime),
    consultadoEm: normalizarDataHora(d?.actualDate, d?.actualTime),
    financialRestriction: txt(d?.financialRestriction),
    percBruto: num(d?.perc), // informativo apenas — sem uso em regra
  };
}
