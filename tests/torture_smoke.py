"""Torture fixture/browser smoke test.

Run with:
    pip install playwright
    playwright install chromium
    python tests/torture_smoke.py

This suite deliberately checks unreachable nodes, parallel edges, cycles and terminal
states instead of assuming a directed graph is a tree.
"""
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "public" / "index.html").resolve()
SOURCE = (ROOT / "examples" / "directed-graph-torture.mmd").read_text(encoding="utf-8")


def validate_graph(graph):
    nodes = graph["nodes"]
    edges = graph["edges"]
    by_id = {node["id"]: node for node in nodes}
    assert len(nodes) == 30, len(nodes)
    assert len(edges) == 42, len(edges)
    assert len(by_id) == len(nodes), "Node IDs must remain distinct"

    def outgoing(node):
        return [e for e in edges if e["start"] == node]

    def incoming(node):
        return [e for e in edges if e["end"] == node]

    assert len([e for e in edges if e["start"] == "Split" and e["end"] == "Merge"]) == 2, "Parallel edges lost"
    assert {e["label"] for e in edges if e["start"] == "Split" and e["end"] == "Merge"} == {"parallel one", "parallel two"}
    assert sum(e["start"] == e["end"] for e in edges) == 3, "Self-loops lost"
    assert all(not outgoing(x) for x in ("TerminalA", "TerminalB", "RemoteEnd"))
    assert not outgoing("Island") and not incoming("Island"), "Isolated node must have degree zero"
    assert by_id["Duplicate1"]["label"] == by_id["Duplicate2"]["label"]
    assert any(e["start"] == "A" and e["end"] == "B" for e in edges)
    assert any(e["start"] == "B" and e["end"] == "A" for e in edges)
    assert any(e["start"] == "Tri3" and e["end"] == "Tri1" for e in edges)
    assert any(e["start"] == "Decision" and e["end"] == "Split" for e in edges)
    assert all(e["start"] != "Note" for e in edges), "Dotted associations must not become wizard choices"
    assert any("café" in n["label"] for n in nodes)
    assert any("Lorem ipsum" in n["label"] for n in nodes)

    reached = {"Start"}
    queue = ["Start"]
    for u in queue:
        for e in outgoing(u):
            if e["end"] not in reached:
                reached.add(e["end"])
                queue.append(e["end"])
    assert "RemoteStart" not in reached
    assert "RemoteA" not in reached
    assert "Island" not in reached
    assert "LoneLoop" not in reached


with sync_playwright() as p:
    binary = shutil.which("chromium") or shutil.which("google-chrome")
    browser = p.chromium.launch(headless=True, executable_path=binary, args=["--no-sandbox"]) if binary else p.chromium.launch(headless=True)
    for width in (390, 1140):
        page = browser.new_page(viewport={"width": width, "height": 850})
        exceptions = []
        page.on("pageerror", lambda error: exceptions.append(str(error)))
        page.goto(HTML.as_uri() + "?example=torture")
        page.wait_for_function("window.focusDemo && window.focusDemo.getGraph()?.nodes.length === 30")
        assert page.locator("#example").input_value() == "torture"
        assert page.locator("#source").input_value() == SOURCE
        assert page.locator("#jump option").count() == 30
        validate_graph(page.evaluate("window.focusDemo.getGraph()"))
        assert page.evaluate("window.focusDemo.getState().current") == "Start"
        assert page.evaluate("window.focusDemo.next('Island')") is False
        assert page.evaluate("window.focusDemo.jumpTo('Invalid')") is False

        for target in ("Island", "LoneLoop", "RemoteStart", "RemoteA", "TerminalB", "A", "Tri3", "Start"):
            page.locator("#jump").select_option(target)
            assert page.evaluate("window.focusDemo.getState().current") == target
            page.evaluate("window.focusDemo.setFocusDepth(4)")
            assert page.evaluate("window.focusDemo.getState().focusDepth") == 4
            assert page.locator("#wizard").locator("svg").count() >= 1

        assert page.evaluate("window.focusDemo.jumpTo('RemoteA')") is True
        assert page.evaluate("window.focusDemo.next('RemoteB')") is True
        assert page.evaluate("window.focusDemo.next('RemoteA')") is True
        assert page.evaluate("window.focusDemo.getState().path.length") == 2
        assert page.evaluate("window.focusDemo.jumpTo('Island')") is True
        assert page.evaluate("window.focusDemo.getState().path.length") == 0
        assert page.evaluate("window.focusDemo.getState().terminal") is True

        # Verify switching fixtures on the same app instance resets the navigation.
        page.locator("#example").select_option("emotion")
        page.wait_for_function("window.focusDemo.getGraph()?.nodes.length === 16")
        assert page.evaluate("window.focusDemo.getState().current") == "Start"
        page.locator("#example").select_option("torture")
        page.wait_for_function("window.focusDemo.getGraph()?.nodes.length === 30")
        assert not exceptions, f"{width}px browser errors: {exceptions}"
        page.close()
        print(f"{width}px: 30 nodes / 42 directed edges / graph navigation OK")
    browser.close()
print("Torture fixture smoke test passed")
