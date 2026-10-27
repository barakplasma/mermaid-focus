# Mermaid Focus

Progressive disclosure for Mermaid flowcharts. Turn a flowchart into a **guided wizard** or a **connected spotlight** that preserves the graph while hiding unrelated branches. Browser-only, with no backend, build step, or framework dependency.

**Live demo:** https://mermaid-focus.barakplasma.workers.dev/

**Live preview:** [Open the demo](https://mermaid-focus.barakplasma.workers.dev/).

## Two independent rendering modes

The demo offers **Focus plugin** and **Vanilla Mermaid** buttons. Focus is
available for directed `flowchart`/`graph` diagrams; vanilla uses the standard
Mermaid 11 renderer without mounting the plugin on that diagram. Non-flowchart
types automatically use vanilla so a `classDiagram` or `sequenceDiagram`
is never converted into a wizard. Vanilla loading uses jsDelivr and requires
network access; flowchart plugin examples remain self-contained/offline.

The conceptual [Mermaid Focus class diagram](examples/mermaid-focus-architecture.mmd)
is included as a regression test. Open `/?example=class` on the demo.

Spotlight now groups adjacent nodes into **multiple columns**, while keeping
their directed connections and labels. Full Overview groups independent graph
components instead of stacking every disconnected node vertically. Pan,
pinch/wheel zoom, Center and Fit all continue working.

## Stress-testing directed graphs

Switch **Example → Directed-graph torture test** in the demo to inspect a deliberately
non-tree graph, or open `/?example=torture` on the hosted site. The fixture is
[`examples/directed-graph-torture.mmd`](examples/directed-graph-torture.mmd):
30 nodes, 42 directed edges, and 3 dotted annotations. It covers self-loops,
two- and three-node cycles, larger feedback cycles, parallel edges, joins, forks,
long links, deep chains, unreachable components, sinks, and an isolated node.

Use **Jump to node** to explore unreachable components. The `jumpTo(id)` API
resets the navigation history when switching components. See
[coverage and test instructions](docs/torture-test.md) and run
`python tests/torture_smoke.py` after installing Playwright/Chromium.

## Features

- **Spotlight:** Current node + incoming/outgoing connected nodes and labeled arrows, configurable **1–4 hops**.
- **Wizard:** One question and its answer buttons at a time.
- **Overview:** Entire original chart, including branches, loops, and visual annotation edges.
- **Back / Restart / answer navigation**, keyboard-accessible controls, and extra step-by-step guidance.
- **Mermaid source editing** in the demo, with the full emotion-regulation flowchart preloaded.
- **Offline demo:** `public/index.html` has embedded CSS and JavaScript and can be opened without a server.

## Quick start

Open `public/index.html` in Chrome. To serve it instead:

```sh
python3 -m http.server 8080 --directory public
# http://localhost:8080
```

Use the browser plugin directly:

```html
<div id="chart"></div>
<script src="/mermaid-focus.browser.js"></script>
<script>
  MermaidFocus.createMermaidFocus('#chart', {
    source: `flowchart TD
      A{Need to act?}
      A -->|Yes| B[Plan a next step]
      A -->|No| C[Accept and observe]`,
    mode: 'spotlight',
    focusDepth: 1,
  });
</script>
```

The corresponding ES module is `public/mermaid-focus.js`.

## Demo and graph

- `public/index.html`: self-contained v0.4 demo.
- `public/mermaid-focus.browser.js`: classic script / CDN distributable.
- `public/mermaid-focus.js`: ES module version.
- `examples/emotion-regulation.mmd`: full source graph in Mermaid syntax, with 16 nodes, 16 decision connections, and 2 dotted associations.
- `tests/smoke.py`: local smoke test with Playwright and Chromium (optional; install `playwright`).
- `docs/architecture.md`: implementation and known constraints.

The built-in renderer supports a useful subset of Mermaid **flowcharts**, not sequence diagrams or the whole Mermaid syntax. Ondine/pre-rendered SVG remains experimental; see [original architecture notes](docs/architecture.md).

## Deploy to Cloudflare Workers

The repo contains a static-assets Worker configuration. Assuming you have Node.js, Cloudflare credentials, and appropriate account access:

```sh
npx --yes wrangler deploy
```

This creates or updates the `mermaid-focus` Worker in whichever Cloudflare account Wrangler is configured to use. **This will replace the existing Worker with the static-assets version** if you deploy to the same account/name. Preview first with `npx wrangler dev`. For Cloudflare Pages, deploy the `public/` directory as a static site instead.

**Privacy:** A private GitHub repository does **not** make the Cloudflare site private. The existing `workers.dev` demo is intentionally public unless Cloudflare Access or another authentication layer is added.

## Known limitations

- Focused SVG uses a small local layout and is not a faithful Dagre/ELK crop; long loops may curve around the local graph.
- Mermaid styles are mostly ignored by the built-in renderer.
- The hosted Worker was patched incrementally; the `public/` files represent the tested standalone v0.4 package rather than an exact export of the most recent Worker script.
- Do not render untrusted precompiled SVG without sanitization.

## License

MIT. See [LICENSE](LICENSE).
## Continuous deployment

A GitHub Actions workflow deploys changes on `main` to the existing Cloudflare Worker **mermaid-focus**.

1. Create a Cloudflare API token scoped to this account with **Workers Scripts: Edit** (and any additional permissions Wrangler reports for Workers static assets).
2. In [repository Actions secrets](https://github.com/barakplasma/mermaid-focus/settings/secrets/actions), create `CLOUDFLARE_API_TOKEN` and paste the token.
3. Run the [Deploy Mermaid Focus workflow](https://github.com/barakplasma/mermaid-focus/actions/workflows/deploy.yml) manually once to verify access. Subsequently, pushes to `main` that change `public/**`, `wrangler.jsonc`, `package.json`, or the workflow deploy automatically.

The Cloudflare account ID is non-secret and is specified in the workflow. **The secret is not configured yet.** Another option is Cloudflare Workers Builds: in the Cloudflare dashboard, open the existing `mermaid-focus` Worker, go to Settings → Builds → Connect, and grant the Cloudflare GitHub integration access to this private repository. Use one deployment mechanism or disable the other to avoid duplicate deployments.

The currently hosted `workers.dev` demo can differ from the checked-in source if modified directly through the Cloudflare API. After auto-deploy is configured, Git should be the source of truth.
