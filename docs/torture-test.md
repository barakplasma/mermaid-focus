# Directed graph torture fixture

Open [the torture diagram in the demo](https://mermaid-focus.barakplasma.workers.dev/?example=torture), or choose **Directed-graph torture test** from the Example selector.

Source: [`examples/directed-graph-torture.mmd`](../examples/directed-graph-torture.mmd).

This is a **deliberately adversarial** graph, not a typical wizard. It contains 30 declared nodes, 42 directed decision edges, and 3 dotted annotation edges. A valid implementation must preserve graph relationships rather than reinterpret it as a tree.

| Property | Where to find it |
| --- | --- |
| Self-loops | A → A; Decision → Decision; LoneLoop → LoneLoop |
| Two- and three-node cycles | A ↔ B; Tri1 → Tri2 → Tri3 → Tri1 |
| Large feedback cycle | Decision → Split, reachable back from Split |
| Parallel edges (same endpoints) | Split → Merge with two different labels |
| Identical answer labels to different targets | Start → Duplicate1 and Start → Duplicate2 |
| Unlabeled edges | Split → Unicode; Chain1 → Chain2 |
| Fan-out and fan-in | Split, Merge |
| Diamond / branch reconvergence | Decision → Left / Right → DiamondJoin |
| Long hop / cross edge | Merge → Chain4, skipping Chain1–Chain3 |
| Long linear chain | Chain1 → Chain2 → Chain3 → Chain4 |
| Dead ends / sinks | TerminalA, TerminalB, RemoteEnd |
| Disconnected graph components | RemoteStart → RemoteEnd, RemoteA ↔ RemoteB |
| Isolated node | Island, with zero incoming and outgoing decision edges |
| Unreachable self-loop component | LoneLoop |
| Long text / Unicode / HTML entity | Long, Unicode |
| Dotted associations | TerminalB -.-> Note; Note -.-> Merge and Island |

**Navigation semantics:** the regular `next(id)` method only traverses an actual outgoing decision edge. The new `jumpTo(id)` API explicitly selects any node for debugging, clears path history and allows exploring components that Start cannot reach. The demo's Jump to node dropdown exposes this, and the focused graph still shows connections up to the selected hop depth. Dotted edges are visual annotations, not navigation choices.

The built-in parser implements a Mermaid **subset**. This fixture uses only supported syntax. It does not claim to cover every possible Mermaid grammar token or every theoretical graph. Run the automated smoke test using:

```bash
python -m pip install playwright
python -m playwright install chromium
python tests/torture_smoke.py
```

This verifies structure, reachability, camera graph rendering at desktop/mobile sizes, navigation through cycles and isolated components, and switching examples without recreating the app.
