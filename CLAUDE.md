## graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when `graphify-out/graph.json` exists.
- Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts.
- These commands return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw grep output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture reviews or when `query`, `path`, and `explain` do not provide enough context.
- Do not use broad `Grep`, `Glob`, `find`, `rg`, recursive scans, or repository-wide source reads before querying Graphify.
- Do not read entire large files unless the graph query identifies the whole file as necessary.
- After Graphify identifies relevant files, read only the specific files and line ranges needed to verify the implementation.
- Treat Graphify as the navigation layer and source files as the final source of truth.
- If the first query is insufficient, refine the Graphify query before falling back to broader source exploration.
- After modifying code, run `graphify update .` to keep the graph current using local AST extraction without API cost.

Required workflow:

`Graphify query → identify relevant symbols/files → read focused source ranges → modify → test → graphify update .`