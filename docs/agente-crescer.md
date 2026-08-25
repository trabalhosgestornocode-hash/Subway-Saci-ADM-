# Agente Crescer

Assistente analítico da plataforma: consulta módulos já existentes do Crescer
com Delivery através de **tools controladas**, cruza informações e explica —
nunca calcula sozinho e nunca escreve no banco (Fase 1/1.5/2A: **somente
leitura**).

Estado atual: dashboard executivo + diagnóstico + produtos/CMV + insumos +
parser food delivery integrados (10 tools); Tool Registry com filtro prévio
por acesso pronto (Etapa B); composição de custo por produto
(`consultar_produto_cmv`) e cruzamento produto↔insumo (`consultar_insumo`)
prontos (Etapa C); resumo agregado mensal, listagem e explicação individual
de cancelamentos prontos (Etapa D); Page Context conectado ponta a ponta +
painel global persistente + botões/sugestões contextuais prontos (Etapa F);
ações de navegação sugeridas (`actions: navigate`) prontas (Etapa F.1).
Bonificação Mensal, Vendas e Martin Brower foram **avaliados e
deliberadamente deixados de fora** (Etapa E — dados/configuração não
confiáveis o suficiente ainda, ver
[Critério de elegibilidade de um módulo](#critério-de-elegibilidade-de-um-módulo)) —
não é um "ainda não chegamos lá" do roadmap, é uma decisão de produto.

---

## Princípio central (nunca violar)

```
Usuário → Crescer com Delivery → Agente Crescer → Orquestrador → Tools autorizadas → Services oficiais → Banco/APIs
```

Nunca:

```
Claude → SQL livre → Supabase
```

**Código calcula. Services determinam regra de negócio. Tools fornecem dados
confiáveis. Claude investiga, cruza, interpreta e explica. Usuário decide.**
Nenhuma tool deste módulo lê `supabase` diretamente para regra de negócio —
cada uma chama um `service` já existente de outro módulo (mesma função que já
alimenta a tela correspondente).

---

## Critério de elegibilidade de um módulo

> **Uma funcionalidade existente no sistema não se torna automaticamente uma
> capacidade do Agente Crescer.**

O Crescer com Delivery tem módulos com maturidades diferentes. O Agente só
deve consultar módulos cujos dados sejam confiáveis o bastante para embasar
uma resposta a um franqueado ou consultor — mais tools não é o objetivo;
tools confiáveis são. Antes de um módulo ganhar uma tool nova, ele precisa
passar pelos critérios abaixo (avalie pelo menos estes; nem todos se aplicam
a todo módulo, mas qualquer item crítico que falhe mantém o módulo de fora):

1. **O módulo está funcional?** (rotas/service em produção, não um esqueleto)
2. **Os dados estão completos?** (não há uma migration pendente que deixa
   colunas inteiras vazias, ou uma etapa de configuração que a maioria das
   empresas nunca preencheu)
3. **Os dados representam a realidade operacional atual?** (não são um
   snapshot congelado de um momento antigo, nem dados de teste)
4. **Há regras de negócio determinísticas confiáveis?** (um motor/cálculo
   testado que decide, não um campo que a IA teria que interpretar sozinha)
5. **Ausência de dado é distinguível de valor zero?** (mesmo princípio já
   aplicado em todas as tools existentes: `null`/`sem_custo` nunca vira `0`)
6. **Existe timestamp/período suficiente para avaliar atualidade?** (dá pra
   saber se o dado é de agora ou de 3 meses atrás)
7. **O tenant/permissões estão corretamente implementados?** (o módulo
   respeita `organizacaoId`/`unidadeId`/papel como os demais)
8. **A informação gerada seria segura para orientar uma decisão real?** (um
   franqueado agindo em cima da resposta não seria prejudicado se o dado
   estiver parcial)

Se qualquer item crítico falhar, **o módulo fica fora do Agente até ser
corrigido** — não ganha uma tool "desabilitada para usar depois", nem uma
tool que devolve dado parcial com um aviso: simplesmente não existe ainda.
Isso evita enviar definições inúteis ao modelo (tokens, confusão, superfície
de erro) e, principalmente, evita respostas de IA embasadas em dados ruins.

Esta tabela é **decisão/documentação técnica, não regra hardcoded de
produto** — não crie um gate automático de "score de elegibilidade" no
código a partir dela a menos que isso vire necessário de verdade; ela existe
para orientar a decisão humana de priorização de cada etapa.

### Matriz de elegibilidade (Etapa E)

| Módulo | Situação | Elegível para IA agora? | Motivo |
|---|---|---:|---|
| Dashboard Executivo | confiável | sim | já integrado |
| Diagnóstico | confiável | sim | já integrado |
| Dashboard Diário | confiável | sim | já integrado |
| Produtos / CMV | confiável | sim | já integrado |
| Fichas Técnicas | confiável | sim | já integrado (via `consultar_produto_cmv`) |
| Insumos | confiável | sim | já integrado |
| Parser Food Delivery / Conciliação | confiável | sim | já integrado |
| Bonificação Mensal | dados/configuração pendentes | não | aguardar saneamento |
| Vendas / Canal de Vendas | dados/configuração pendentes | não | aguardar saneamento |
| Martin Brower | sincronização ainda não suficientemente confiável | não | reavaliar depois (sync via Playwright atrás de flag, sem timestamp claro de atualidade) |

### Comportamento do Agente diante de um módulo não elegível

Se o usuário perguntar algo que dependa de um módulo fora desta lista e não
houver outra fonte confiável para responder, o Agente é **transparente sobre
a limitação do Agente**, nunca sobre a plataforma:

- Correto: *"Ainda não tenho uma fonte confiável habilitada para analisar
  essa informação dentro do Agente Crescer."*
- Errado: *"O Crescer não possui esse recurso."* — o recurso pode existir na
  plataforma normalmente (ex.: a tela de Bonificação Mensal funciona); ele só
  ainda não foi habilitado como fonte para o Agente. Ver item correspondente
  no system prompt (`agente.prompt.js`).

Quando um módulo destes for saneado, ele entra pelo mesmo caminho de sempre:
[Como adicionar uma tool nova](#como-adicionar-uma-tool-nova), através do
Tool Registry já existente — nenhuma infraestrutura nova é necessária.

---

## Arquitetura de arquivos

```
backend/src/modules/agente/
├── agente.routes.js         POST /mensagem, GET /conversas/:id
├── agente.controller.js     lê req.tenant/req.acesso — nunca do corpo
├── agente.service.js        orquestração: loop de tool use, custo, auditoria
├── agente.provider.js       única porta pro SDK Anthropic
├── agente.prompt.js         system prompt (sem lógica de negócio)
├── agente.tools.js          REGISTRY central + dispatcher (ver abaixo)
├── agenteAcesso.js          garantirAcessoModulo/garantirPermissao (executor)
├── agente.pageContext.js    sanitização de pageContext (lista branca)
├── agente.conversas.service.js  persistência de conversa/mensagens
├── agente.usage.js          soma de usage (tokens) de um loop inteiro
├── agente.pricing.js        tabela de preço por modelo -> custo estimado
├── agente.uso.service.js    grava/lê agente_uso (1 linha por interação)
└── tools/
    ├── dashboardExecutivo.tool.js
    ├── diagnostico.tool.js
    ├── dashboardDia.tool.js
    ├── produtoCmv.tool.js
    ├── produtosCmvRanking.tool.js
    ├── produtosCmvBusca.js       (busca+desambiguação pura, sem I/O — reaproveitada por insumo.tool.js)
    ├── insumo.tool.js            (Etapa C)
    ├── insumosRanking.tool.js    (Etapa C)
    ├── parserResumo.tool.js      (Etapa D)
    ├── parserCancelamentos.tool.js (Etapa D)
    └── parserCancelamento.tool.js  (Etapa D)
```

`produtos/custo.js` ganhou uma função pura nova na Etapa C —
`usoDiretoDeInsumo(produtoId, insumoId, grafo)` — usada tanto por
`insumo.tool.js` (produtos afetados por um insumo) quanto, indiretamente, por
`consultar_produto_cmv` (que já usava `componentesDiretos`/`custo_aplicado`
do mesmo arquivo, só não expunha esses campos até agora).

`parser-food-delivery/parserFoodDelivery.calc.js` ganhou 5 funções puras na
Etapa D — `somarResumosPeriodo`, `limitesDoMes`, `inicioMesSeguinte`,
`resolverCandidatoPedido` e `explicarCancelamento` — usadas por
`parserFoodDelivery.service.js#resumoCancelamentosPeriodo`/
`listarCancelamentosPeriodo`/`consultarCancelamento`. **Regra que não
muda**: a classificação de cada cancelamento continua vindo SEMPRE do motor
determinístico (`parserFoodDelivery.classificacao.js`), decidida no momento
da importação — estas funções só leem/somam/filtram/explicam o que já foi
decidido, nunca reclassificam.

Estrutura deliberadamente **plana** — sem pasta `core/` própria. Os arquivos
de infraestrutura (`agenteAcesso.js`, `agente.prompt.js`, `agente.provider.js`,
`agente.pageContext.js`) cumprem esse papel soltos. Revisar isso só quando o
módulo crescer visivelmente além do que existe hoje (regra: evoluir
incrementalmente, nunca reestruturar por espírito de arquitetura).

---

## Tool Registry

`agente.tools.js` exporta `REGISTRO`: um array com **metadados declarados**
por tool, não só o dispatcher.

```js
{
  definicao: {...},        // formato Anthropic (name/description/input_schema)
  executar: async (input, contexto, deps) => {...},
  access: { module: MODULOS.IFOOD_DASHBOARD, permission: PERMISSOES.DASHBOARD_EXECUTIVO_VER },
  mode: "read",             // "read" | "write" (nenhuma "write" ainda)
  risk: "low",               // "low" | "medium" | "high"
}
```

`FERRAMENTAS` (catálogo completo, sem filtro) continua existindo para
documentação/testes. **Nunca envie `FERRAMENTAS` direto para a Anthropic** —
use `ferramentasDisponiveis(acesso)`.

### Defesa em profundidade (2 camadas, sempre as duas)

1. **Filtro prévio do catálogo** — `ferramentasDisponiveis(acesso)`, chamado
   uma vez por interação em `agente.service.js`, antes do loop de tool use.
   Só inclui uma tool se `acesso.modulos` tiver o `access.module` **e**
   `acesso.permissoes` tiver o `access.permission` (bypass total quando
   `acesso.impersonando`, mesma regra do resto do sistema). Isso é o que o
   pedido chama de "o Agente não deve enxergar tools que não pode usar":
   reduz tokens, reduz confusão do modelo, reduz superfície de tentativa
   inútil.
2. **Validação no executor** — `garantirAcessoModulo`/`garantirPermissao`
   (`agenteAcesso.js`), chamadas nas duas primeiras linhas de todo
   `executar()`. Continua rodando **sempre**, mesmo que o filtro do item 1
   tenha um bug ou seja contornado — é a camada que realmente impede o
   acesso, não só uma otimização de UX.

Nunca remova a camada 2 achando que a camada 1 já resolve.

---

## Segurança de tenant (dentro de cada tool)

Toda tool recebe `(input, contexto, deps)`:

- `input` — só o que **Claude** controla (validado pelo `input_schema`, com
  `additionalProperties: false` sempre).
- `contexto` — `{ organizacaoId, unidadeId, acesso }`, montado **sempre** por
  `agente.service.js` a partir de `req.tenant`/`req.acesso` (Context Token,
  já validado por `requireContexto`). Nenhuma tool lê `input.organizacaoId`
  ou `input.unidadeId` para nada — mesmo que um input malicioso tente
  incluir essas chaves.
- `deps` — funções do service oficial, injetáveis só para teste (nunca usado
  em produção; o default já é o service real).

---

## Page Context

O frontend envia, no corpo de `POST /agente/mensagem`, um `pageContext`
opcional descrevendo em que tela o usuário estava (ver
`frontend/src/agentePageContext.js#obterPageContextAtual` — a Etapa F
conectou o frontend real a esta fundação):

```json
{
  "mensagem": "o que pesa mais no custo dele?",
  "conversationId": "...",
  "pageContext": {
    "module": "products_cmv",
    "view": "produto",
    "productName": "BMT 15 cm"
  }
}
```

**Catálogo de módulos** (`agente.pageContext.js#PAGINAS`) — só os 4 com tool
real (Etapa E: Vendas/Bonificação/Martin Brower não entram aqui até serem
saneados):

| `module` | Rótulo | Campo de "item aberto" |
|---|---|---|
| `dashboard_executivo` | Dashboard Executivo | — (usa `view`/`year`/`month`) |
| `products_cmv` | Produtos / CMV | `productName` |
| `ingredients` | Insumos | `ingredientName` |
| `parser_food_delivery` | Parser Food Delivery | `orderNumber` |

**Regras invioláveis** (impostas em `agente.pageContext.js#sanitizarPageContext`,
chamado sempre em `agente.service.js`, nunca no controller):

- **Lista branca de campos.** `module` (um dos 4 acima), `view` (token
  simples), `year`, `month`, e o campo de "item aberto" — mas **só o do
  módulo correspondente** (`orderNumber` mandado junto de `module:
  "products_cmv"` é descartado, nunca misturado). Qualquer outra chave é
  descartada — **inclusive** `organizacaoId`, `unidadeId`, `userId`, `role`,
  `permissoes`/`permissions`, mesmo que venham junto de um `module` válido.
- **Nunca decide tenant/módulo/permissão.** Esses três continuam vindo
  exclusivamente de `req.tenant`/`req.acesso`. `pageContext` só afeta o
  **texto do system prompt** (`descreverPageContext`).
- **Nunca é prova de dado.** O prompt deixa explícito: "informativo — NUNCA é
  fonte de dado" — se a pergunta depender de números, a tool correspondente é
  sempre chamada, mesmo que o pageContext pareça já responder.
- **Falha aberta e silenciosa.** `module` desconhecido, corpo malformado ou
  ausente vira `null` — nunca lança erro, nunca derruba a mensagem.

### Frontend (Etapa F)

- `agentePageContext.js#derivarPageContext` — PURA, recebe um retrato já
  coletado do estado real (rota + `state.detalheAberto`/
  `state.periodoDashboardExecutivo`/`state.contextoParser`) e monta o
  pageContext. `obterPageContextAtual()` é o único ponto que lê `state` de
  verdade — nenhuma outra parte do frontend deveria montar pageContext à mão.
- **Mapeamento CENTRALIZADO**: `ROTA_PARA_MODULO` é o único lugar que
  traduz `state.rota` → `module` — nunca espalhar esse `if` por outros
  arquivos.
- Cada view escreve SÓ o que é dela em `state` (nunca lê de volta): 
  `dashboardExecutivo.js#carregarConteudo` escreve `state.periodoDashboardExecutivo`;
  `parserFoodDelivery.js#renderAbaAtual` escreve `state.contextoParser`;
  `produtoModal.js`/`insumoModal.js`/`parserFoodDelivery.js#abrirDrawerCancelamento`
  escrevem `state.detalheAberto.{produto,insumo,pedido}` (só o NOME, nunca
  id/custo/preço) ao abrir, e limpam ao fechar. Essa indireção por `state`
  (em vez de `agentePageContext.js` importar as views direto) existe para
  evitar um import circular com `agentePainel.js` (que essas mesmas views
  importam, para os botões contextuais).

---

## Painel global (Etapa F)

**Um único motor de chat, duas superfícies.** `frontend/src/agenteChat.js`
concentra TODA a lógica (estado, envio, rehidratação, render de bolhas,
Markdown seguro, tools consultadas, limpar) como estado module-level
singleton — nunca duas conversas. `montarChatAgente(root, opts)` desenha
esse estado dentro de qualquer `root`; quem usa isso:

- `agente.js#renderAgente()` — modo **página** (rota "ia" do menu, dentro de
  `#view`, recriado a cada visita — igual sempre foi).
- `agentePainel.js#montarPainelGlobal()` — modo **painel**: um `<aside>`
  criado 1x em `document.body` (fora de `#view`, que é destruído a cada
  navegação — ver `router.js#renderRotaAtual`) e **nunca recriado**. Abrir/
  fechar só alterna uma classe CSS — por isso a conversa, o texto em
  digitação e o estado aberto/fechado sobrevivem a qualquer troca de rota.

Como as duas instâncias leem o MESMO `historico`/`conversationId`
(module-level em `agenteChat.js`), abrir a página cheia depois de conversar
no painel (ou vice-versa) mostra exatamente a mesma conversa — sem
rehidratar de novo se já estava em memória.

**Sincronização de contexto** (nunca recria o painel, só atualiza texto):
`router.js` chama `sincronizarContextoPainel()` após toda navegação; os
modais/drawers de detalhe (`produtoModal.js`, `insumoModal.js`,
`parserFoodDelivery.js#abrirDrawerCancelamento`/`fecharPfdDrawer`) chamam a
mesma função ao abrir/fechar. Ela só recalcula o indicador visual
("Analisando: Dashboard Executivo · Agosto/2026" / "Contexto: BMT 15 cm") e
as sugestões — nunca o log de mensagens.

**Troca de tenant**: `agenteChat.js` registra um `registrarResetDeContexto`
próprio (mesmo hook de `contextoEscopo.js` que todo módulo com estado usa) —
zera `historico`/`conversationId` sempre que a organização/unidade muda.
`agentePainel.js` registra outro para fechar o painel nesse momento (a
conversa nova reabre limpa). **Nunca** confundir isso com Page Context:
troca de tenant é sempre resolvida por `contextoEscopo.js`; Page Context é
só a tela atual.

**Botões contextuais**: `agentePainel.js#botaoContextualHtml(chave)` gera o
HTML (`✦ Analisar produto`, `✦ Investigar cancelamentos`...) e
`ligarBotoesContextuais(root)` liga o clique — abre o painel, sincroniza o
contexto (já reflete a tela, porque `state.detalheAberto`/etc. já foi
escrito antes do clique) e pré-preenche o campo de texto **sem enviar
sozinho**. Rótulos centralizados em `agenteSugestoes.js#rotuloBotaoContextual`.

**Sugestões contextuais**: `agenteSugestoes.js#obterSugestoes(pageContext)` —
catálogo único por `module`/`view`, no máximo 4 por contexto.

**Overlay**: desktop nunca bloqueia a tela por trás (`pointer-events: none`
no overlay, só o drawer em si é clicável — dá pra usar o resto do Crescer
com o painel aberto); mobile vira um overlay normal, full-width. Ver
`styles.css` (`.agente-painel-overlay`/`.agente-painel`), mesmo padrão
técnico do `.bm-drawer` já usado em Bonificação Mensal/Parser, adaptado para
NUNCA remover o DOM ao fechar (é a mesma conversa, não conteúdo novo).

---

## Ações de navegação (Etapa F.1)

O Agente pode, depois de uma análise, oferecer um atalho de navegação —
nunca uma URL, nunca uma rota livre. `POST /agente/mensagem` agora também
devolve `actions` (sempre um array, vazio quando não há sugestão):

```json
{
  "resposta": "Existem 8 cancelamentos que precisam de revisão.",
  "conversationId": "...",
  "actions": [{ "type": "navigate", "target": "parser_cancelamentos", "label": "Abrir Cancelamentos", "params": {} }],
  "metadata": { "toolsUtilizadas": ["consultar_parser_resumo"] }
}
```

### Backend — Action Registry

`agente.acoes.js#ACOES_NAVEGACAO` é a whitelist central (8 targets:
`dashboard_executivo`, `products_cmv`, `product_detail`, `ingredients`,
`ingredient_detail`, `parser`, `parser_cancelamentos`, `parser_order`).
Cada entrada declara `modulo`, `permissao`, `paramsPermitidos`,
`paramsObrigatorios` e `rotulo` (função — o `label` do botão é **sempre**
gerado aqui, nunca pelo texto do Claude). `resolverAcao({target, params,
acesso})` é pura, nunca lança — devolve `null` (== "não sugere nada") pra
target inválido, sem acesso ao módulo/permissão do destino, ou parâmetro
obrigatório ausente.

A tool `sugerir_navegacao` (`tools/navegacao.tool.js`) é a ÚNICA forma de
Claude propor uma action: `input_schema.target` é um `enum` fechado (os 8
targets); `productName`/`ingredientName`/`orderNumber` são os únicos
parâmetros aceitos, e `resolverAcao` filtra pra só o que aquele target
específico permite. Registrada com `access: {module: MODULOS.AGENTE_IA,
permission: null}` — é a única tool cujo acesso não é "módulo + permissão
únicos", porque ela é um *dispatcher* pra vários destinos, cada um
revalidado individualmente dentro de `resolverAcao`.

`agente.service.js` intercepta `sugerir_navegacao` no loop de tool use:
NUNCA entra em `toolsUtilizadas`/"Consultou" (não é fonte de dado); a action
resolvida (se houver) vai pra `acoesSugeridas`, capada em
`MAX_ACOES_SUGERIDAS = 3`.

### Persistência

Migration 050 — `agente_mensagens.acoes jsonb` (mesmo padrão de
`tools_utilizadas`). Actions reaparecem ao reidratar a conversa (F5). **Uma
action salva nunca é fonte de autorização**: `resolverAcao` só roda no
momento de SUGERIR; clicar numa action antiga sempre executa o resolver do
FRONTEND, que chama código real do Crescer (`irPara`, `abrirProdutoModal`
etc.) — esse código sempre reflete o acesso/tenant ATUAIS, nunca o de quando
a mensagem foi salva. Degrada graciosamente se a migration ainda não rodou
(mesmo padrão de `insumos.service.js#RE_COLUNA_AUSENTE`).

### Frontend — resolução sem import circular

`agenteAcoesResolvedores.js` é uma folha pura (zero imports) — só
`registrarResolverAcao(target, fn)`/`obterResolverAcao(target)`, mesmo
padrão de `contextoEscopo.js#registrarResetDeContexto`. Existe porque
`agenteChat.js` (usado por `agentePainel.js`, que as views de
produto/insumo/parser já importam pro botão contextual) não pode importar
essas views de volta pra navegar — seria um ciclo. `app.js` (o topo do
grafo — nada o importa de volta) registra os 8 resolvers uma vez, cada um
chamando SÓ código real do Crescer:

| target | resolver chama |
|---|---|
| `dashboard_executivo` / `products_cmv` / `ingredients` / `parser` | `irPara(rota)` |
| `product_detail` | `irPara("produtos")` + `produtoModal.js#abrirProdutoPorNome` (busca em `state.linhas`, já carregado) |
| `ingredient_detail` | `irPara("insumos")` + `insumoModal.js#abrirInsumoPorNome` (busca via `listarInsumos({busca})`) |
| `parser_cancelamentos` / `parser_order` | `irPara(...)` + espera `parserFoodDelivery.js#aguardarCarregamentoParser()` (router é fire-and-forget) + abre a aba/pedido |

Nenhum resolver nunca constrói uma URL — todos usam o mecanismo de
navegação/abertura de modal que a tela já tinha. Se o nome/número não bater
com nada carregado, avisa (`toast`) e não abre nada — nunca inventa.

Clique no botão: `agenteChat.js` liga cada `.agente-acao-btn` renderizado ao
objeto `action` real (nunca reconstrói a partir de atributos HTML),
`obterResolverAcao(action.target)` executa, e então: **desktop/página** —
mantém aberto, só atualiza o indicador de contexto; **mobile** (painel,
`window.innerWidth <= 620`) — fecha o painel após navegar.

### O que NÃO existe nesta etapa

Sem streaming/SSE (contrato continua request/response único). Sem ações de
escrita — `sugerir_navegacao` é estritamente `navigate`, nunca cria/altera/
exclui nada. Auditoria de CLIQUE (quem clicou, quando) é **pendência
documentada**, não implementada: exigiria um endpoint novo só pra isso; a
sugestão em si já é auditada (dentro de `AGENTE_MENSAGEM_ENVIADA`, via
`toolsUtilizadas`/`acoesSugeridas` — mas não há registro de qual botão foi
efetivamente clicado).

---

## Diagnóstico Investigativo (Fase H)

**Não é uma tabela nova, nem um novo tipo de dado.** É um MODO de resposta
que Claude escolhe usar só quando a pergunta é genuinamente diagnóstica
("por que", "o que está causando", "o que eu devo fazer", "investigue") —
perguntas simples e diretas ("quanto gastei com entregadores?") continuam
recebendo uma resposta curta, sem nenhuma estrutura de investigação. Nada
disto é persistido automaticamente: é comportamento de prompt
(`agente.prompt.js`, seção "DIAGNÓSTICO INVESTIGATIVO", itens 43-53) sobre
tools que já existiam.

### Relação com o diagnóstico determinístico

`dashboardExecutivo.diagnostico.js#gerarDiagnostico` continua sendo a ÚNICA
fonte de verdade sobre severidade/pontos fortes/atenção/alertas — Claude
nunca recalcula nem re-decide se algo é um problema. A investigação sempre
COMEÇA por `consultar_diagnostico` e nunca pode contradizer a severidade
oficial (ex.: dizer "está tudo bem" quando o motor marcou alerta), a não ser
que as próprias ferramentas revelem uma inconsistência nos dados — e mesmo
assim a resposta descreve a inconsistência, nunca substitui a decisão do
motor por uma opinião do modelo.

### Investigação progressiva

Sequência esperada: (1) confirmar o achado via `consultar_diagnostico`; (2)
só então buscar o "porquê" com as ferramentas específicas do indicador —
`consultar_evolucao_diaria_financeiro` (Etapa H, nova) para achar os dias
que mais pesaram na variação do Financeiro acumulado; `consultar_produto_cmv`/
`listar_produtos_cmv` + `consultar_insumo` para CMV, sempre respeitando as
regras de causalidade já existentes (itens 25 e 30 do prompt — CMV alto de
um produto ≠ causa do CMV total sem o volume vendido; insumo com grande
participação no custo ≠ insumo "que ficou mais caro" sem `ultimaAlteracaoPreco`
real). O prompt orienta a parar assim que houver evidência suficiente e a
nunca repetir a mesma ferramenta com os mesmos parâmetros na mesma pergunta.

### Estrutura da resposta

Fato (números reais das ferramentas) → Interpretação (o que isso
provavelmente significa, respeitando causalidade) → Limitações (o que não
dá pra afirmar com os dados disponíveis) → Recomendação (quando fizer
sentido). Não precisa ser cabeçalho literal toda resposta — é a ordem do
raciocínio, não um template rígido.

Regras de recomendação:
- **Concreta, nunca genérica** — "revise os cancelamentos dos dias 11, 12 e
  18" é válido; "melhore a operação" não é. Sem dado específico o bastante,
  isso vira uma limitação, não uma recomendação vaga.
- **Sem ROI inventado** — nunca "essa ação vai economizar R$X"; só fatos já
  calculados ("o excesso atual é R$X").
- **Prioridade só de critério objetivo** já presente nos dados (severidade,
  distância da meta, impacto em R$, ocorrências) — sem isso, linguagem
  qualitativa ("parece o ponto a revisar primeiro"), nunca um número
  inventado.
- **Confiabilidade da base em linguagem qualitativa** — "base suficiente" /
  "base parcial" / "base insuficiente", nunca um percentual (não existe em
  nenhuma ferramenta).

### `consultar_evolucao_diaria_financeiro` (tool nova)

Ranking dos dias do mês com **maior `|variação|`** no Financeiro acumulado
do Dashboard Executivo — reaproveita `snapshotsFinanceiros` já calculado por
`dashboardExecutivo.service.js#obterMes` (nunca recalcula). Módulo/permissão:
`IFOOD_DASHBOARD` / `DASHBOARD_EXECUTIVO_VER` (mesmo das outras tools do
Dashboard). Cap de `MAX_DIAS_TOOL = 10` dias por chamada; visão agregada
("todas as unidades") devolve `semDados: true` em vez de inventar uma série.

### Pontos de atenção integrados (Page Context)

`agente.pageContext.js#ATTENTION_POINTS` é uma lista fechada de 7 categorias
— as únicas que hoje são achados REAIS do motor determinístico:
`taxas_comissoes`, `servicos_promocoes`, `taxas_entregadores`,
`total_deducoes`, `faturamento`, `dias_pendentes`,
`detalhamento_financeiro_ausente`. **CMV agregado e cancelamentos não
entram** — não existe achado determinístico pra eles em nenhum motor hoje
(seguem só como tema de conversa livre/botão contextual comum, sem
`attentionPoint`).

No Dashboard Executivo, cada card do Plano de Ação com achado correspondente
ganha um botão `✦ Diagnosticar com Agente Crescer`
(`agentePainel.js#botaoDiagnosticoHtml`, mesma mecânica de
`botaoContextualHtml`). O `attentionPoint` vem de `achado.categoria` — exceto
`dias_pendentes`/`detalhamento_financeiro_ausente`, que compartilham a
categoria `"dados"` no motor; nesses dois o `achado.id` (estável, sem sufixo)
é que bate com o valor esperado. Clique grava a intenção em
`state.detalheAberto.attentionPoint` (mesma ponte de estado de
`productName`/`ingredientName`/`orderNumber`, ver seção Page Context acima),
`derivarPageContext` transforma isso em `{view: "diagnostico", attentionPoint}`,
e `agenteSugestoes.js` troca as 4 sugestões padrão do módulo por 4 sugestões
de investigação ("Por que esse indicador está ruim?", "O que mais está
causando isso?", "O que devo fazer primeiro?", "Quais dados sustentam esse
diagnóstico?"). **`attentionPoint` nunca é prova de dado** — o prompt
(item 51) exige sempre confirmar com `consultar_diagnostico` antes de
responder, mesmo que o nome pareça autoexplicativo. O painel nunca envia a
primeira mensagem sozinho — só pré-preenche o campo de texto (mesma regra da
Etapa F para todos os botões contextuais).

### Módulos fora de escopo (reforço)

Bonificação Mensal, Vendas e Martin Brower continuam de fora de qualquer
investigação (mesma regra da Etapa E) — se a causa provável estiver num
desses módulos, o prompt orienta reportar isso como limitação, nunca tentar
concluir sem esses dados.

### O que NÃO existe nesta fase

Sem execução automática de plano, sem alteração de preço/ficha/insumo, sem
reclassificação do Parser, sem tarefas persistentes/status de plano, sem
acompanhamento automático (alertas, n8n, WhatsApp), sem multi-agente, sem
RAG. **Etapa H.1** (baseline + comparação "melhorou/piorou/sem mudança" ao
longo do tempo) é arquiteturalmente mantida possível (nada aqui bloqueia),
mas **não foi implementada** — não existe nenhuma tabela de histórico de
diagnóstico.

---

## Conversa e contexto conversacional

`agente.conversas.service.js` persiste 1 linha por mensagem
(`agente_mensagens`) e revalida **usuário + organização + unidade** sempre
que uma conversa existente é reaproveitada — qualquer divergência (outro
tenant, id inventado, conversa apagada) vira silenciosamente "conversa nova",
nunca um erro que revele a diferença.

Só o **texto final** de cada turno entra no histórico reenviado a Claude —
nunca os blocos brutos de `tool_use`/`tool_result` (esses só existem durante
o loop da requisição atual).

---

## Medição de uso/custo e auditoria

Uma interação pode disparar várias chamadas à Anthropic (1 por iteração do
loop de tool use, `MAX_TOOL_ITERATIONS = 6`). `agente.usage.js` soma tudo;
`agente.pricing.js` calcula o custo com a tabela de preço vigente; 1 linha
sai em `agente_uso` (`agente.uso.service.js`), sempre — inclusive quando a
interação falha (o `finally` de `processarMensagem` garante isso).

`shared/auditoria.js#auditar` grava `AGENTE_MENSAGEM_ENVIADA` com metadados
(tools usadas, tokens, custo, duração, sucesso, `paginaContexto` — só o id da
página, nunca o objeto inteiro) — **nunca o texto da mensagem/resposta**.

---

## Read vs. write

Toda tool hoje é `mode: "read"`. Antes de adicionar uma tool `write`:

- precisa de aprovação explícita de escopo (não é uma decisão de código);
- a confirmação **nunca** pode vir do modelo dizendo "o usuário confirmou" —
  tem que vir de um passo real do frontend, revalidado pelo backend;
- a ação sensível passa pelo mesmo `service` oficial que a tela usa (nunca
  uma query nova só para a IA).

---

## Como adicionar uma tool nova

1. Identifique o **service oficial** já existente que responde a pergunta
   (nunca escreva uma query nova só para a tool).
2. Defina o **input mínimo** que só Claude precisa fornecer — nunca
   `organizacaoId`/`unidadeId`/dados de tenant no `input_schema`.
3. No `executar(input, contexto, deps)`: comece **sempre** com
   `garantirAcessoModulo(acesso, MODULOS.X)` e `garantirPermissao(acesso,
   PERMISSOES.Y)`.
4. `contexto.organizacaoId`/`contexto.unidadeId` — nunca leia o equivalente
   de `input`, mesmo que um input malicioso tente incluir essas chaves.
5. **Normalize o retorno** — dados estruturados (`{ nome, cmv: 31.2 }`), nunca
   texto pronto (`{ mensagem: "O CMV é..." }"`). Claude interpreta o dado.
6. **Limite o payload** — trave rankings/listas em um máximo (ver
   `MAX_PRODUTOS_TOOL` em `produtosCmvRanking.tool.js`), mesmo que o modelo
   peça mais.
7. Registre em `REGISTRO` (`agente.tools.js`) com `access`/`mode`/`risk`.
8. Escreva testes (ver `test/agente-tools.test.js`): tenant nunca vem do
   input; módulo/permissão ausente bloqueia sem chamar o service; argumentos
   inválidos são rejeitados antes de tocar o service; o schema tem
   `additionalProperties: false`.
9. Atualize `agente.prompt.js` só se houver uma regra de interpretação nova
   (nunca lógica de cálculo — isso mora no service).
10. `npm test` verde, depois `graphify update .`.

---

## Testes

| Arquivo | Cobre |
|---|---|
| `test/agente-tools.test.js` | dispatch, `agenteAcesso`, `REGISTRO`, `ferramentasDisponiveis` (filtro prévio) |
| `test/agente-service.test.js` | loop de tool use, custo/usage, conversa/tenant, catálogo filtrado, pageContext |
| `test/agente-pageContext.test.js` | lista branca do pageContext — malformado, malicioso, fora de faixa |
| `test/agente-produtos-cmv-busca.test.js`, `agente-produtos-cmv-tools.test.js` | busca/desambiguação de produto, composição de custo (`custoAplicado`/`participacaoPctNoCusto`) |
| `test/agente-insumos-tools.test.js` | busca/desambiguação de insumo, produtos afetados (direto vs. indireto), histórico de preço, ranking |
| `test/produtos-custo.test.js` | `usoDiretoDeInsumo` (pura) |
| `test/agente-parser-tools.test.js` | camada das 3 tools do Parser — acesso, tenant, unidade obrigatória, filtros inválidos ignorados |
| `test/parser-food-delivery-calc.test.js` | `somarResumosPeriodo`, `limitesDoMes`/`inicioMesSeguinte`, `resolverCandidatoPedido`, `explicarCancelamento` (todas puras) |
| `test/agente-conversas-isolamento.test.js` | isolamento de conversa entre tenants/usuários |
| `test/agente-pricing.test.js`, `agente-usage.test.js`, `agente-uso-agregacao.test.js` | custo/medição |

**Frontend** (`node --test frontend/test/`, mesma convenção do backend — só
funções puras, sem DOM/browser):

| Arquivo | Cobre |
|---|---|
| `frontend/test/agentePageContext.test.js` | `derivarPageContext`/`descreverContextoPainel` — os 4 módulos, item aberto, rota sem integração, nunca tenant |
| `frontend/test/agenteSugestoes.test.js` | catálogo de sugestões por módulo/view, máximo 4, `rotuloBotaoContextual` |
| `frontend/test/agenteAcoesResolvedores.test.js` | registro de resolvers de navegação (Etapa F.1) |
| `frontend/test/markdown.test.js` | Markdown seguro (XSS) do agente — pré-existente |

**Backend — Etapa F.1:**

| Arquivo | Cobre |
|---|---|
| `test/agente-acoes.test.js` | `resolverAcao` — target válido/inválido, módulo/permissão, parâmetros por target, impersonação, segurança (URL/rota injetada, tenant nos params) |
| `test/agente-navegacao-tool.test.js` | contrato da tool `sugerir_navegacao` — schema, nunca lança |
| `test/agente-tools.test.js` / `agente-service.test.js` (ampliados) | catálogo com 11 tools, `permission: null`, actions no contrato/persistência/reidratação, exclusão de "Consultou", limite de 3 |
