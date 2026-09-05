# Central de Demandas do Desenvolvimento

Implementada no Painel Administrativo, em **Desenvolvimento → Agenda de Demandas**. Nenhum push, deploy ou acesso a dados de produção foi realizado. A migration foi executada apenas em PostgreSQL local descartável.

## Diagnóstico e decisões (fases A e B)

- Backend: Node/Express com módulos `routes → controller → service → repo`, cliente Supabase `service_role`, `asyncHandler` e `ApiError`. Frontend: SPA em ES modules, HTML/CSS nativos, sem bundler. Testes usam `node:test` e injeção de dependências.
- `app.js` aplica `requireAuth`; `routes.js` aplica troca obrigatória de senha; `administrativoRouter` aplica `requirePainelAdministrativo`, MFA configurável e rate limit. O módulo novo está montado dentro dessa cadeia.
- O painel é global/cross-tenant, separado tanto do ambiente operacional quanto do SuperAdmin. Não possui `req.tenant` nem envia `x-context-token`. Um vínculo operacional de administrador de organização não concede acesso à agenda.
- A administração técnica usa `req.user.superadmin`, já resolvido pelo mecanismo existente. Não foi criada outra tabela de administradores nem usado e-mail hardcoded. O responsável técnico administra a agenda com seu acesso SuperAdmin existente.
- Pessoas (criador, responsável, autor de evento) vêm de `perfis`, `painel_administrativo_usuarios` e `plataforma_admins` — as tabelas que já existem. A agenda não tem cadastro próprio de usuários.
- Categorias e tipos são catálogos estáticos de domínio, com listas no backend e constraints no banco; o frontend recebe os catálogos da API. Não há CRUD de categorias nesta versão. A mesma decisão evita uma infraestrutura paralela de catálogos.
- A estrutura usa **072** e **073**. Criadas originalmente como 069/070; renumeradas para ficarem depois de `071_restringir_rpc_pin.sql`, que `main` renumerou de 068 ao resolver a colisão com `068_dashboard_ifood_desbloqueios.sql`. Não há dependência funcional entre a Agenda e a 071/068 — a ordem é organizacional. A consolidação de schema existente não foi reescrita.
- Riscos tratados: exposição de notas, autorização somente visual, códigos reutilizados, foco duplicado, sobrescrita concorrente, histórico fora da transação, truncamento silencioso e regressões em transferência/exclusão de unidades.

## 1. Arquivos criados

| Arquivo | Responsabilidade |
|---|---|
| `backend/src/modules/desenvolvimento/desenvolvimento.domain.js` | Catálogos, validação, datas e indicadores |
| `backend/src/modules/desenvolvimento/desenvolvimento.repo.js` | Projeções de leitura, filtros, paginação e histórico |
| `backend/src/modules/desenvolvimento/desenvolvimento.service.js` | Autorizações, relações, CRUD, resumo e catálogos |
| `backend/src/modules/desenvolvimento/desenvolvimento.controller.js` | Contratos HTTP e dependências de teste |
| `backend/src/modules/desenvolvimento/desenvolvimento.routes.js` | Rotas protegidas |
| `database/migrations/072_desenvolvimento_demandas.sql` | Estrutura, constraints, triggers, RLS e auditoria |
| `frontend/src/desenvolvimento.js` | Orquestração, filtros, formulários e detalhes |
| `frontend/src/desenvolvimentoUi.js` | Cards, board, calendário, roadmap e timeline |
| `frontend/src/desenvolvimento.css` | Estilos responsivos usando os tokens existentes |
| `backend/test/desenvolvimento.test.js` | Domínio, service/repo e HTTP real com banco fake |
| `backend/test/desenvolvimento-postgres.test.js` | Migration e integridade em PostgreSQL real descartável |
| `frontend/test/desenvolvimento.test.js` | Renderização, escape HTML, calendário, board e roadmap |
| `backend/scripts/desenvolvimento-preview.mjs` | Preview manual em loopback com fixtures em memória |
| `docs/desenvolvimento-agenda-entrega.md` | Diagnóstico, entrega, validação e operação |

## 2. Arquivos alterados

- `backend/src/modules/administrativo/administrativo.routes.js`: montagem do submódulo depois dos gates existentes.
- `frontend/src/painelAdmApi.js`: chamadas de leitura e escrita com o Bearer existente.
- `frontend/src/painelAdmViews.js`: área de navegação, view e card do dashboard.
- `frontend/src/painelAdm.js`: seção Desenvolvimento no menu e ocultação do período gerencial dentro da agenda.
- `frontend/index.html`: carregamento do CSS do módulo.
- `frontend/test/painelAdm.test.js`: expectativa do menu inclui a nova área e preserva a ordem anterior.
- `backend/test/sessao-perfil.test.js`: dois testes antigos passaram a injetar consulta de perfis e emissão de prova. Antes, apesar de se declararem unitários, tentavam acessar a rede. Nenhuma alteração no código de autenticação.

## 3–4. Migration e tabelas

Migration: **072_desenvolvimento_demandas.sql**, transacional, para execução única pelo processo normal de migrations.

Tabelas:

- `desenvolvimento_demandas`;
- `desenvolvimento_demanda_atualizacoes`.

`numero` é identity; `codigo` é gerado como DEV-001, DEV-002 etc., sem truncar após 999. Exclusões não reutilizam números; rollback pode deixar lacunas, deliberadamente. Há índices de status, prioridade/ordem, categoria, previsão, organização, unidade, criação, conclusão e histórico, além do índice único de foco.

Organizações/unidades são FKs para os cadastros existentes. Uma transferência de unidade atualiza o escopo das demandas; uma exclusão normaliza a demanda para organização ou plataforma. O registro e a auditoria sobrevivem. Dependência referencia outra demanda; a exclusão de uma demanda referenciada é rejeitada até a dependência ser removida.

## 5. Endpoints

Base: `/api/v1/administrativo/desenvolvimento`.

| Método | Caminho | Acesso |
|---|---|---|
| GET | `/catalogos` | Painel Administrativo |
| GET | `/resumo` | Painel Administrativo |
| GET | `/atualizacoes` | Painel Administrativo |
| GET | `/demandas` | Painel Administrativo |
| GET | `/demandas/:id` | Painel Administrativo |
| POST | `/demandas` | Painel Administrativo |
| PATCH | `/demandas/:id` | Painel Administrativo |
| POST | `/demandas/:id/atualizacoes` | Painel Administrativo (visibilidade `INTERNAL` só SuperAdmin) |
| DELETE | `/demandas/:id` | SuperAdmin |

Respostas seguem `{ data: ... }`. PATCH e DELETE exigem `versao`; edição concorrente retorna 409. DELETE recebe `{versao}` no corpo e usa uma função transacional restrita ao service_role para registrar o autor correto.

Filtros: `busca`, `status`, `prioridade`, `categoria`, `tipo`, `organizacao_id`, `unidade_id`, `responsavel_usuario_id`, `minhas`, `sem_responsavel`, `de`, `ate`, `campo_periodo`, `atrasadas`, `pagina`, `limite`. `minhas=true` resolve o responsável a partir da sessão — o cliente não escolhe de quem são as demandas. Pesquisa cobre código/título/descrição. `campo_periodo=marcos` considera a união entre início previsto, previsão e conclusão. Páginas têm 60 itens na UI, até 100 na API; total e paginação permanecem visíveis.

## 6. Permissões e segurança

- Usuários sem login recebem 401; sem acesso global ao painel, 403.
- Qualquer usuário autorizado do Painel Administrativo cria, edita, move status/prioridade/progresso/previsão, troca o responsável, conclui, reabre, arquiva, ordena, define foco e publica atualizações **públicas**.
- Só o SuperAdmin exclui definitivamente, lê e escreve `nota_interna`/`link_tecnico` e publica atualizações `INTERNAL`. Para tirar uma demanda das visualizações ativas sem SuperAdmin, use o status Arquivada.
- A autorização existe no router e no service; o frontend só esconde o que a API já recusa. A exclusão também passa pelo MFA de SuperAdmin se a política existente estiver habilitada.
- Autoria nunca vem do cliente: `criado_por` e `atualizado_por` são preenchidos com `req.user.id`, e o autor de uma atualização também. Enviar essas chaves no corpo é rejeitado como campo não permitido.
- O responsável precisa ser conta com acesso ativo ao painel (ou SuperAdmin ativo). Validado no service **e** por gatilho da migration 073 — nenhuma via de escrita escapa. A guarda do banco só dispara quando o responsável muda, para que revogar um acesso não trave a edição de demandas antigas.
- Projeções públicas nunca selecionam `nota_interna` ou `link_tecnico`. Histórico de gestores inclui predicado `visibilidade=PUBLIC` no banco, inclusive em atualizações recentes.
- RLS habilitado; acesso direto de `anon`/`authenticated` revogado nas duas tabelas. A função de exclusão não é executável por esses papéis.
- Inputs têm whitelist; campos desconhecidos, autoria/código enviados pelo cliente, enums inválidos, UUIDs inválidos, progresso fora de 0–100, datas impossíveis e URLs técnicas não HTTP/HTTPS são rejeitados.
- O frontend escapa conteúdo dinâmico e não interpreta descrições como HTML.
- Nenhum UUID chega à interface como rótulo. Nomes resolvem por `perfis.nome` → `perfis.email` → e-mail do Auth → "Usuário sem cadastro"; sem responsável exibe "Sem responsável" e sem autor, "Sistema". A mesma ordem existe em SQL (`desenvolvimento_nome_usuario`) para o texto do histórico.

## 6.1 Responsável (migration 073)

`responsavel_usuario_id` é nulo por padrão — demandas antigas continuam válidas e nenhuma migration atribui dono a ninguém. Trocar o responsável gera um evento `ASSIGN` no histórico com os dois nomes resolvidos no momento da escrita ("Responsável alterado de Maria Silva para João Pedro."), então o registro continua legível mesmo se a conta for removida depois. A lista de responsáveis oferecida pelo formulário é exatamente a união consultada por `requirePainelAdministrativo`. A auditoria passou a gravar o `ator_tipo` real do autor em vez de `superadmin` fixo.

## 7. Foco atual

Um índice único parcial permite no máximo uma demanda em foco. Para trocar, remova o foco anterior e marque a próxima. Tentativa concorrente de definir outro foco recebe 409; não há normalização apenas visual. Conclusão e arquivamento removem o foco automaticamente.

## 8. Histórico e auditoria

Criação, status, progresso, previsão, prioridade, bloqueio/desbloqueio, conclusão, reabertura e atualização pública geram histórico automático. Alterações técnicas geram evento interno. Atualizações manuais oferecem tipo e visibilidade explícitos, autoria e horário.

Triggers gravam histórico e `plataforma_auditoria` na mesma transação da demanda. Exclusão preserva o log geral com antes/depois, removendo o histórico próprio da demanda. Notas e links técnicos não são copiados para o log geral. Atualizações manuais também avançam a versão e a data da última alteração. A timeline possui paginação própria.

## 9. Previsões

Datas civis usam `America/Sao_Paulo` no backend. Previsão passada: Atrasada. Hoje e até dois dias à frente: Atenção. Depois disso: No prazo. Ausente: Sem previsão. Conclusão: Concluída. Arquivamento sem conclusão: Arquivada. A interface identifica explicitamente a previsão como atual e sujeita a atualização.

Concluir ajusta progresso para 100% e preenche a conclusão, se ausente. Entrar em desenvolvimento preenche início real, se ausente. Reabrir uma demanda concluída remove a conclusão e reinicia progresso em 0% quando ainda estava em 100%.

## 10–13. Interface e integração

- **Visão Geral:** seis indicadores calculados no backend, foco, próximas cinco planejadas por prioridade/ordem e oito atualizações recentes.
- **Board:** seis colunas de status; cards com prioridade, categoria, progresso e previsão. SuperAdmin usa “Mover para”, que persiste na API. Bloqueio sem motivo abre o formulário. No celular as colunas ficam empilhadas. Arquivadas são consultáveis pelo filtro.
- **Agenda:** mês, semana e lista cronológica; múltiplos marcos por demanda. Mês/semana consultam os marcos do período visível no servidor. Não depende do período gerencial do painel e permite datas futuras.
- **Roadmap:** agrupamento por mês da previsão/início, com grupo Sem previsão. Respeita filtros e paginação.
- **Histórico:** concluídas, data, resumo de entrega, impacto e detalhe; filtros por período, categoria, organização e unidade.
- **Detalhes:** descrição, objetivo, impacto, execução, escopo, dependência e timeline. Informações técnicas e ações de escrita são exclusivas do administrador.
- **Dashboard principal:** card “Desenvolvimento da Plataforma” com andamento, entregas no mês atual, próxima previsão, foco e navegação para a agenda. Falha do módulo não impede renderizar o dashboard existente.
- **Responsividade:** tokens de cores/superfícies existentes, filtros recolhíveis, formulários responsivos e dialog nativo. Sem biblioteca nova de calendário ou drag-and-drop.

## 14–16. Testes e resultados

Foram adicionados **25 testes**: 13 de backend/domínio/HTTP, quatro de renderização e oito com PostgreSQL real.

Execuções finais:

- `node --test backend/test/ frontend/test/`: **2.120 testes, 2.112 aprovados, zero falhas, oito pulados**. Os oito pulados são os novos testes de PostgreSQL, habilitados separadamente.
- `DEV_POSTGRES_TEST=1`, PostgreSQL 17 em loopback descartável: **8/8 aprovados**. Executou a migration real e verificou códigos, foco único/rollback, conclusão/reabertura, FKs/constraints, transferências/exclusões, RLS/privilégios, histórico e service_role.
- `node --check` nos novos módulos e preview: aprovado; `git diff --check`: aprovado.
- Não há scripts de lint/build no projeto. O frontend é servido como ES modules; não foi inventado um build paralelo.
- Navegador com fixtures locais: Visão Geral, Board, Agenda, Roadmap, Histórico, abertura de detalhes e criação via formulário. Console sem erros; sem overflow horizontal nas larguras verificadas de celular e notebook.

A suíte foi executada com URL Supabase apontando a loopback inválido e chaves fictícias, sem carregar `.env`. Testes que dependem de Supabase remoto mantiveram seus próprios gates de ambiente; não houve execução de integração remota nem alteração em produção. PostgreSQL local verificou a migration sobre fixtures dos contratos das tabelas relacionadas, não uma cópia integral dos dados/schema de produção.

## 17–20. Riscos, pendências e liberação

- **Pronto para revisão e commit** da feature. Nenhum commit foi criado automaticamente.
- **Deploy depende de homologação** com autenticação real e aplicação ordenada das migrations no ambiente de destino. Confirmar ali que a 071 e anteriores já foram aplicadas.
- Migrations desta feature: **072** e **073**. Estado verificado em 2026-09-05 no catálogo do PostgreSQL do Supabase em uso: **ambas já aplicadas ali** sob os números antigos (069 e 070). A 072 **não é idempotente** e não deve ser reexecutada onde já rodou; a 073 é idempotente e pode ser reexecutada com segurança. Confirme ambiente a ambiente — não foi verificado nenhum outro banco.
- Antes da liberação, executar smoke com uma conta SuperAdmin e uma conta somente do painel no ambiente de homologação, incluindo o transporte PostgREST real.
- Board, calendário, roadmap e histórico são paginados, com total explícito. Indicadores da visão geral são calculados sobre toda a base, sem limite da página.
- Dependência é uma relação única por demanda nesta versão. Categorias são estáticas. Não há drag-and-drop, Gantt, anexos nem notificações, que não são necessários para os fluxos implementados.
- A versão atual das previsões aparece na agenda; alterações anteriores ficam na timeline. Não são promessas fixas de entrega.
- Os dados de demonstração ficam somente no script de preview em memória. Migration não insere demandas fictícias.

Preview de desenvolvimento: `node backend/scripts/desenvolvimento-preview.mjs`; endereço `http://127.0.0.1:55470`. Não disponibilizar o preview como rota pública: ele existe exclusivamente para QA local.
