# Architecture

The built-in flowchart parser converts Mermaid text into `nodes` and directed `edges`.
The wizard advances along outgoing edges using the displayed edge label as the answer text.

Spotlight computes a local directed neighborhood around the current node, including both
incoming and outgoing connections. It renders that subset as SVG with node boxes,
edge labels, and arrowheads. `focusDepth` controls how many hops to show.
The overview uses the full diagram, including support/annotation edges.

The diagram and navigation state remain client-side. The HTML demo embeds its runtime so
it also opens under `file://` without importing an ES module.

There are two build forms: a classic browser script exposing `window.MermaidFocus`
and an ES module exporting `createMermaidFocus`. They currently contain equivalent
implementations; if development continues, consider centralizing source and generating
both bundles via a build script.

The original example was adapted from a Lindsay Braman emotion-regulation flowchart.
The textual guidance is educational, not clinical advice.
