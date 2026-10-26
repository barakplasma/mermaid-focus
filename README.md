# Mermaid Focus

Progressive disclosure for Mermaid flowcharts. Turn a flowchart into a **guided wizard** or a **connected spotlight** that preserves the graph while hiding unrelated branches. Browser-only, with no backend, build step, or framework dependency.

**Live demo:** https://mermaid-focus.barakplasma.workers.dev/

**Live preview:** [Open the demo](https://mermaid-focus.barakplasma.workers.dev/).

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