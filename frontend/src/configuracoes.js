// Página de Configurações — cards clicáveis + painéis internos de edição.
// Persistência 100% no dispositivo (localStorage): não altera backend/auth/DB.
// O tema (claro/escuro) é INDIVIDUAL — vale só para o navegador de quem escolheu.
import { el, escapeHtml, toast } from "./utils.js";
import { state } from "./state.js";
import { TABELAS, CMV_LIMITES } from "./config.js";
import { obterUsuarios, criarUsuario, atualizarUsuario, excluirUsuario } from "./api.js";

// Perfis da UI <-> enum papel_usuario do banco (migration 003)
const PAPEL_LABEL = { desenvolvedor: "Desenvolvedor", admin: "Administrador", gerente: "Gestor", financeiro: "Financeiro", operador: "Operacional", leitura: "Somente leitura" };
const PAPEL_ENUM = Object.fromEntries(Object.entries(PAPEL_LABEL).map(([k, v]) => [v, k]));
const PERFIS = Object.values(PAPEL_LABEL);

function gerarSenha() {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#!$";
  const arr = crypto.getRandomValues(new Uint32Array(14));
  return [...arr].map((n) => cs[n % cs.length]).join("");
}

// ---------- persistência local ----------
const LS_CFG = "saci-config";
const LS_TEMA = "saci-tema";

function loadCfg() { try { return JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch { return {}; } }
function saveCfg(chave, dados) {
  const c = loadCfg();
  c[chave] = { ...(c[chave] || {}), ...dados };
  localStorage.setItem(LS_CFG, JSON.stringify(c));
  return c[chave];
}
const cfg = (chave) => loadCfg()[chave] || {};

// ---------- tema (individual, por dispositivo) ----------
export function aplicarTemaSalvo() {
  const t = localStorage.getItem(LS_TEMA) === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
  return t;
}
function definirTema(t) {
  localStorage.setItem(LS_TEMA, t);
  document.documentElement.setAttribute("data-theme", t);
}
const temaAtual = () => (localStorage.getItem(LS_TEMA) === "dark" ? "dark" : "light");

// ---------- helpers de UI ----------
const campo = (label, id, valor = "", { tipo = "text", ph = "", extra = "" } = {}) => `
  <label class="cfg-campo">
    <span>${label}</span>
    <input id="${id}" type="${tipo}" value="${escapeHtml(valor)}" placeholder="${escapeHtml(ph)}" ${extra} />
  </label>`;

const select = (label, id, opcoes, valorAtual = "") => `
  <label class="cfg-campo">
    <span>${label}</span>
    <select id="${id}">${opcoes.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${escapeHtml(v)}" ${v === valorAtual ? "selected" : ""}>${escapeHtml(l)}</option>`;
    }).join("")}</select>
  </label>`;

const toggle = (label, id, on, desc = "") => `
  <label class="cfg-toggle">
    <span class="cfg-toggle-txt"><b>${label}</b>${desc ? `<small>${escapeHtml(desc)}</small>` : ""}</span>
    <span class="cfg-switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></span>
  </label>`;

const chips = (arr) => `<div class="cfg-chips">${arr.map((c) => `<span class="cfg-chip">${escapeHtml(c)}</span>`).join("")}</div>`;

const painel = (titulo, corpo, sub = "") =>
  `<div class="cfg-panel"><div class="cfg-panel-head"><h3>${titulo}</h3>${sub ? `<p>${escapeHtml(sub)}</p>` : ""}</div><div class="cfg-panel-body">${corpo}</div></div>`;

const barraSalvar = () =>
  `<div class="cfg-acoes"><button class="btn btn-primary" data-salvar>Salvar alterações</button></div>`;

function ligarSalvar(root, coletar, chave) {
  const btn = root.querySelector("[data-salvar]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    saveCfg(chave, coletar());
    toast("Configurações salvas neste dispositivo.");
  });
}
const val = (root, id) => root.querySelector("#" + id)?.value ?? "";
const chk = (root, id) => !!root.querySelector("#" + id)?.checked;

// ======================= SEÇÕES =======================
const SECOES = [
  { id: "unidade",      icon: "🏪", titulo: "Dados da Unidade",        desc: "Nome, CNPJ, endereço, responsável e contato da loja." },
  { id: "cmv",          icon: "🎯", titulo: "Metas e Limites de CMV",  desc: "Faixas de CMV, metas de faturamento e margem mínima." },
  { id: "precos",       icon: "🏷️", titulo: "Tabelas de Preço",        desc: "Canal padrão, tabela ativa e recálculo automático." },
  { id: "usuarios",     icon: "👥", titulo: "Usuários e Permissões",   desc: "Equipe, perfis de acesso, último login e status." },
  { id: "seguranca",    icon: "🔒", titulo: "Segurança",               desc: "Senha forte, bloqueio, sessão e registro de acessos." },
  { id: "notificacoes", icon: "🔔", titulo: "Notificações",            desc: "Alertas no sistema, WhatsApp e e-mail." },
  { id: "aparencia",    icon: "🎨", titulo: "Aparência",               desc: "Tema claro ou escuro — preferência deste dispositivo." },
  { id: "backup",       icon: "💾", titulo: "Backup e Manutenção",     desc: "Exportar dados, importar planilha e backups." },
];

export function renderConfiguracoes() {
  const view = el("#view");
  if (!view) return;
  view.innerHTML = `
    <p class="secao-titulo">⚙️ Configurações <small>Subway Saci · unidade ${escapeHtml(state.unidade || "Matriz")}</small></p>
    <div class="cfg-grid">
      ${SECOES.map((s) => `
        <button class="cfg-card" data-sec="${s.id}">
          <span class="cfg-card-ico">${s.icon}</span>
          <span class="cfg-card-txt">
            <span class="cfg-card-titulo">${s.titulo}</span>
            <span class="cfg-card-desc">${s.desc}</span>
          </span>
          <span class="cfg-card-seta" aria-hidden="true">→</span>
        </button>`).join("")}
    </div>`;
  view.querySelectorAll(".cfg-card").forEach((b) => b.addEventListener("click", () => abrirSecao(b.dataset.sec)));
}

function abrirSecao(id) {
  const s = SECOES.find((x) => x.id === id);
  if (!s) return renderConfiguracoes();
  const view = el("#view");
  view.innerHTML = `
    <div class="cfg-detalhe-head">
      <button class="btn btn-ghost btn-sm" id="cfg-voltar">← Configurações</button>
      <h2 class="cfg-detalhe-titulo"><span>${s.icon}</span> ${s.titulo}</h2>
    </div>
    <div class="cfg-detalhe" id="cfg-detalhe"></div>`;
  el("#cfg-voltar").addEventListener("click", renderConfiguracoes);
  (DETALHES[id] || (() => {}))(el("#cfg-detalhe"));
}

// ======================= DETALHES DE CADA SEÇÃO =======================
const DETALHES = {
  // 1. Dados da Unidade
  unidade(root) {
    const d = cfg("unidade");
    root.innerHTML = painel("Identificação da loja", `
      <div class="cfg-form-grid">
        ${campo("Nome da unidade", "u-nome", d.nome ?? "Subway Saci — Saci")}
        ${campo("CNPJ", "u-cnpj", d.cnpj ?? "", { ph: "00.000.000/0000-00" })}
        ${campo("Endereço", "u-end", d.endereco ?? "", { ph: "Rua, nº — bairro, cidade" })}
        ${campo("Responsável", "u-resp", d.responsavel ?? "")}
        ${campo("E-mail", "u-email", d.email ?? (state.usuario || ""), { tipo: "email" })}
        ${campo("Telefone", "u-tel", d.telefone ?? "", { ph: "(00) 00000-0000" })}
        ${select("Status da unidade", "u-status", [["ativa", "🟢 Ativa"], ["inativa", "⚪ Inativa"]], d.status ?? "ativa")}
      </div>
    ` ) + barraSalvar();
    ligarSalvar(root, () => ({
      nome: val(root, "u-nome"), cnpj: val(root, "u-cnpj"), endereco: val(root, "u-end"),
      responsavel: val(root, "u-resp"), email: val(root, "u-email"), telefone: val(root, "u-tel"), status: val(root, "u-status"),
    }), "unidade");
  },

  // 2. Metas e Limites de CMV
  cmv(root) {
    const d = cfg("cmv");
    root.innerHTML = painel("Faixas de CMV (%)", `
      <div class="cfg-form-grid">
        ${campo("CMV saudável (até)", "c-sau", d.saudavel ?? CMV_LIMITES.saudavel, { tipo: "number", extra: 'min="0" max="100" step="0.5"' })}
        ${campo("CMV de atenção (até)", "c-ate", d.atencao ?? CMV_LIMITES.atencao, { tipo: "number", extra: 'min="0" max="100" step="0.5"' })}
        ${campo("CMV crítico (acima de)", "c-cri", d.critico ?? CMV_LIMITES.atencao, { tipo: "number", extra: 'min="0" max="100" step="0.5"' })}
      </div>`, "Classificam cada produto como saudável, atenção ou crítico.")
      + painel("Metas da operação", `
      <div class="cfg-form-grid">
        ${campo("Meta de faturamento diário (R$)", "c-fatd", d.fatDia ?? "", { tipo: "number", extra: 'min="0" step="1"' })}
        ${campo("Meta de faturamento mensal (R$)", "c-fatm", d.fatMes ?? "", { tipo: "number", extra: 'min="0" step="1"' })}
        ${campo("Margem mínima desejada (%)", "c-mar", d.margem ?? "", { tipo: "number", extra: 'min="0" max="100" step="0.5"' })}
      </div>`) + barraSalvar();
    ligarSalvar(root, () => ({
      saudavel: val(root, "c-sau"), atencao: val(root, "c-ate"), critico: val(root, "c-cri"),
      fatDia: val(root, "c-fatd"), fatMes: val(root, "c-fatm"), margem: val(root, "c-mar"),
    }), "cmv");
  },

  // 3. Tabelas de Preço
  precos(root) {
    const d = cfg("precos");
    const canal = d.canal ?? state.canal ?? "balcao";
    root.innerHTML = painel("Canal e tabela ativa", `
      <div class="cfg-form-grid">
        ${select("Canal padrão", "p-canal", [["balcao", "Balcão"], ["ifood", "iFood"]], canal)}
        ${select("Tabela ativa", "p-tab", TABELAS[canal] || TABELAS.balcao, d.tabela ?? state.tabela ?? "A")}
      </div>`)
      + painel("Tabelas disponíveis", `
        <div class="cfg-sub"><b>Balcão</b>${chips(TABELAS.balcao)}</div>
        <div class="cfg-sub"><b>iFood</b>${chips(TABELAS.ifood)}</div>
        <div class="cfg-meta">Última atualização de preços: <b>${escapeHtml(d.atualizado ?? "—")}</b></div>`)
      + painel("Automação", toggle("Recalcular CMV automaticamente", "p-recalc", d.recalc !== false, "Quando o custo ou o preço de um produto mudar."))
      + barraSalvar();
    // trocar o canal atualiza as opções de tabela
    root.querySelector("#p-canal").addEventListener("change", (e) => {
      const sel = root.querySelector("#p-tab");
      sel.innerHTML = (TABELAS[e.target.value] || []).map((t) => `<option>${t}</option>`).join("");
    });
    ligarSalvar(root, () => ({
      canal: val(root, "p-canal"), tabela: val(root, "p-tab"), recalc: chk(root, "p-recalc"),
    }), "precos");
  },

  // 4. Usuários e Permissões (real — Supabase Auth via backend)
  usuarios(root) {
    root.innerHTML = `<div class="cfg-panel"><div class="cfg-panel-body"><div class="estado"><div class="spinner"></div>Carregando usuários…</div></div></div>`;
    carregar();

    async function carregar() {
      try {
        const { data } = await obterUsuarios();
        desenhar(data || []);
      } catch (e) {
        root.innerHTML = painel("Usuários e Permissões",
          `<div class="estado-mini">Não foi possível carregar os usuários: ${escapeHtml(e.message)}<br>Apenas Administrador/Desenvolvedor têm acesso a esta seção.</div>`);
      }
    }

    function linhaUsuario(u) {
      const label = PAPEL_LABEL[u.papel] || u.papel || "—";
      const nome = u.nome || u.email || "—";
      return `
        <div class="cfg-user" data-id="${escapeHtml(u.id)}">
          <span class="cfg-user-av">${escapeHtml((nome[0] || "?").toUpperCase())}</span>
          <div class="cfg-user-info"><b>${escapeHtml(nome)}</b><small>${escapeHtml(u.email || "")}</small></div>
          <select class="cfg-user-perfil" data-id="${escapeHtml(u.id)}">${PERFIS.map((p) => `<option ${p === label ? "selected" : ""}>${p}</option>`).join("")}</select>
          <span class="pill ${u.ativo ? "ok" : "muted"}">${u.ativo ? "Ativo" : "Inativo"}</span>
          <button class="cfg-user-del" data-del="${escapeHtml(u.id)}" title="Excluir usuário" aria-label="Excluir ${escapeHtml(nome)}">🗑️</button>
        </div>`;
    }

    function desenhar(lista) {
      root.innerHTML = painel("Equipe da unidade", `
          <div class="cfg-users">
            ${lista.length ? lista.map(linhaUsuario).join("") : `<div class="estado-mini">Nenhum usuário cadastrado ainda.</div>`}
          </div>
          <div class="cfg-legenda">Perfis: ${PERFIS.map((p) => `<span class="cfg-chip">${p}</span>`).join("")}</div>
        `, "Perfil 'Desenvolvedor' tem acesso total (todas as permissões de Administrador).")
        + painel("Criar usuário", `
          <div class="cfg-form-grid">
            ${campo("Nome", "u-nome")}
            ${campo("E-mail", "u-email", "", { tipo: "email", ph: "email@subwaysaci.com" })}
            <label class="cfg-campo"><span>Senha</span>
              <span class="cfg-senha-wrap"><input id="u-senha" type="text" placeholder="mínimo 8 caracteres"><button type="button" class="btn btn-ghost btn-sm" id="u-gerar">Gerar</button></span>
            </label>
            ${select("Perfil", "u-perfil", PERFIS, "Operacional")}
          </div>
          <div class="cfg-acoes cfg-acoes--start"><button class="btn btn-primary" id="u-add">+ Criar usuário</button></div>
        `, "A conta é criada no Supabase Auth e já pode fazer login com a senha definida. Anote e repasse a senha.");

      root.querySelector("#u-gerar").addEventListener("click", () => { root.querySelector("#u-senha").value = gerarSenha(); });
      root.querySelector("#u-add").addEventListener("click", criar);
      root.querySelectorAll(".cfg-user-del").forEach((b) => b.addEventListener("click", () => excluir(b.dataset.del, lista)));
      root.querySelectorAll(".cfg-user-perfil").forEach((s) => s.addEventListener("change", () => trocarPerfil(s.dataset.id, PAPEL_ENUM[s.value])));
    }

    async function criar() {
      const nome = val(root, "u-nome");
      const email = val(root, "u-email").trim();
      const senha = val(root, "u-senha");
      const papel = PAPEL_ENUM[val(root, "u-perfil")];
      if (!email) return toast("Informe o e-mail do usuário.");
      if (!senha || senha.length < 8) return toast("A senha precisa de ao menos 8 caracteres.");
      const btn = root.querySelector("#u-add");
      btn.disabled = true; btn.textContent = "Criando…";
      try {
        await criarUsuario({ nome, email, senha, papel });
        toast(`Usuário criado — já pode fazer login.`);
        carregar();
      } catch (e) {
        toast("Erro: " + e.message);
        btn.disabled = false; btn.textContent = "+ Criar usuário";
      }
    }

    async function excluir(id, lista) {
      const u = (lista || []).find((x) => x.id === id);
      if (!confirm(`Excluir o usuário "${u?.nome || u?.email || id}"? Isso remove o acesso no Supabase Auth.`)) return;
      try { await excluirUsuario(id); toast("Usuário excluído."); carregar(); }
      catch (e) { toast("Erro: " + e.message); }
    }

    async function trocarPerfil(id, papel) {
      try { await atualizarUsuario(id, { papel }); toast("Perfil atualizado."); }
      catch (e) { toast("Erro: " + e.message); carregar(); }
    }
  },

  // 5. Segurança
  seguranca(root) {
    const d = cfg("seguranca");
    root.innerHTML = painel("Acesso e senhas", `
      ${toggle("Senha forte obrigatória", "s-forte", d.forte !== false, "Mínimo de 8 caracteres, com letras e números.")}
      ${toggle("Troca de senha no primeiro acesso", "s-troca", d.troca === true)}
      ${toggle("Bloquear após tentativas incorretas", "s-bloq", d.bloqueio !== false)}
      <div class="cfg-form-grid">
        ${campo("Bloquear após (tentativas)", "s-tent", d.tentativas ?? 5, { tipo: "number", extra: 'min="1" max="10"' })}
        ${campo("Tempo de sessão (minutos)", "s-sessao", d.sessao ?? 60, { tipo: "number", extra: 'min="5" step="5"' })}
      </div>`)
      + painel("Sessão e auditoria", `
      ${toggle("Logout automático por inatividade", "s-inativ", d.inatividade !== false)}
      ${toggle("Registrar acessos (log de login)", "s-log", d.log !== false, "Guarda quem entrou e quando.")}`)
      + barraSalvar();
    ligarSalvar(root, () => ({
      forte: chk(root, "s-forte"), troca: chk(root, "s-troca"), bloqueio: chk(root, "s-bloq"),
      tentativas: val(root, "s-tent"), sessao: val(root, "s-sessao"),
      inatividade: chk(root, "s-inativ"), log: chk(root, "s-log"),
    }), "seguranca");
  },

  // 6. Notificações
  notificacoes(root) {
    const d = cfg("notificacoes");
    const tipos = [
      ["estoque", "Estoque crítico"], ["cmv", "CMV alto"],
      ["margem", "Margem baixa"], ["fat", "Faturamento abaixo da meta"],
    ];
    const canais = [["sis", "Sistema"], ["wpp", "WhatsApp"], ["email", "E-mail"]];
    root.innerHTML = painel("Quais alertas você quer receber", `
      <div class="cfg-notif">
        <div class="cfg-notif-head"><span></span>${canais.map((c) => `<span>${c[1]}</span>`).join("")}</div>
        ${tipos.map(([tk, tl]) => `
          <div class="cfg-notif-row">
            <span class="cfg-notif-lbl">${tl}</span>
            ${canais.map(([ck]) => {
              const id = `n-${tk}-${ck}`;
              const on = d[`${tk}_${ck}`] ?? (ck === "sis");
              return `<span class="cfg-switch cfg-switch--mini"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></span>`;
            }).join("")}
          </div>`).join("")}
      </div>`)
      + painel("Destinatários", `
      <div class="cfg-form-grid">
        ${campo("E-mail para alertas", "n-email", d.email ?? (state.usuario || ""), { tipo: "email" })}
        ${campo("WhatsApp para alertas", "n-wpp", d.wpp ?? "", { ph: "(00) 00000-0000" })}
      </div>`) + barraSalvar();
    ligarSalvar(root, () => {
      const o = { email: val(root, "n-email"), wpp: val(root, "n-wpp") };
      tipos.forEach(([tk]) => canais.forEach(([ck]) => (o[`${tk}_${ck}`] = chk(root, `n-${tk}-${ck}`))));
      return o;
    }, "notificacoes");
  },

  // 7. Aparência (tema individual)
  aparencia(root) {
    const desenhar = () => {
      const atual = temaAtual();
      root.innerHTML = painel("Tema desta conta neste dispositivo", `
        <div class="cfg-tema-grid">
          <button class="cfg-tema-op ${atual === "light" ? "ativo" : ""}" data-tema="light">
            <span class="cfg-tema-prev cfg-tema-prev--light"><i></i><i></i><i></i></span>
            <b>Claro</b>
          </button>
          <button class="cfg-tema-op ${atual === "dark" ? "ativo" : ""}" data-tema="dark">
            <span class="cfg-tema-prev cfg-tema-prev--dark"><i></i><i></i><i></i></span>
            <b>Escuro</b>
          </button>
        </div>
        <div class="cfg-meta">🔒 Esta escolha é <b>individual</b>: fica salva só neste navegador/dispositivo e não muda o tema dos outros usuários.</div>
      `);
      root.querySelectorAll(".cfg-tema-op").forEach((b) => b.addEventListener("click", () => {
        definirTema(b.dataset.tema);
        toast(`Tema ${b.dataset.tema === "dark" ? "escuro" : "claro"} aplicado neste dispositivo.`);
        desenhar();
      }));
    };
    desenhar();
  },

  // 8. Backup e Manutenção
  backup(root) {
    const d = cfg("backup");
    root.innerHTML = painel("Dados", `
      <div class="cfg-botoes">
        <button class="btn btn-ghost" id="b-export">⬇️ Exportar dados (JSON)</button>
        <label class="btn btn-ghost cfg-file">⬆️ Importar planilha<input type="file" id="b-import" accept=".csv,.xlsx,.json" hidden></label>
        <button class="btn btn-ghost" id="b-backup">💾 Backup manual</button>
      </div>
      <div class="cfg-meta">Último backup: <b id="b-ultimo">${escapeHtml(d.ultimo ?? "nenhum ainda")}</b></div>`)
      + painel("Manutenção", `
      <div class="cfg-botoes">
        <button class="btn btn-ghost cfg-btn-perigo" id="b-limpar">🧹 Limpar dados de teste</button>
      </div>
      <div class="cfg-meta">Remove as configurações salvas neste dispositivo (não afeta o banco de dados).</div>`);

    root.querySelector("#b-export").addEventListener("click", () => {
      const dump = { exportadoEm: new Date().toISOString(), config: loadCfg(), produtosCarregados: state.linhas?.length ?? 0, produtos: state.linhas ?? [] };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `subway-saci-dados-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(a.href);
      toast("Exportação gerada.");
    });
    root.querySelector("#b-import").addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) toast(`"${f.name}" recebido — importação será ligada ao backend.`);
    });
    root.querySelector("#b-backup").addEventListener("click", () => {
      const quando = new Date().toLocaleString("pt-BR");
      saveCfg("backup", { ultimo: quando });
      const lbl = root.querySelector("#b-ultimo"); if (lbl) lbl.textContent = quando;
      toast("Backup local realizado.");
    });
    root.querySelector("#b-limpar").addEventListener("click", () => {
      if (confirm("Limpar todas as configurações salvas neste dispositivo? O tema e as preferências voltam ao padrão.")) {
        localStorage.removeItem(LS_CFG);
        toast("Configurações locais limpas.");
        abrirSecao("backup");
      }
    });
  },
};
