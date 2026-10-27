"""Renderer isolation and multi-column layout smoke tests.
Install: pip install playwright && playwright install chromium
Run: python tests/renderer_smoke.py
"""
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
URL=(ROOT / "public/index.html").as_uri()
STUB="""export default {
  initialize(){},
  async render(id,source){
    const kind=source.trim().split(/\\s+/)[0];
    return {svg:'<svg xmlns="http://www.w3.org/2000/svg" data-vanilla-kind="'+kind+'" viewBox="0 0 720 300"><text x="20" y="80">Vanilla '+kind+'</text></svg>'};
  }
}"""
CDN="https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.esm.min.mjs"

with sync_playwright() as p:
    binary=shutil.which("chromium") or shutil.which("google-chrome")
    kwargs={"headless":True}
    if binary:
        kwargs.update({"executable_path":binary,"args":["--no-sandbox"]})
    browser=p.chromium.launch(**kwargs)
    for width in (390,1140):
        page=browser.new_page(viewport={"width":width,"height":870})
        problems=[]
        page.on("pageerror",lambda error: problems.append(str(error)))
        page.route(CDN,lambda route:route.fulfill(status=200,headers={"content-type":"application/javascript","access-control-allow-origin":"*"},body=STUB))
        page.goto(URL+"?example=class")
        page.wait_for_selector('#vanilla-surface svg[data-vanilla-kind="classDiagram"]')
        assert page.locator("#wizard").is_hidden()
        assert page.locator("#vanilla-button").get_attribute("aria-pressed")=="true"
        assert page.locator("#source").input_value().strip().startswith("classDiagram")
        assert page.evaluate("window.focusDemo === undefined"), "Do not initialize flowchart plugin on class diagram"
        page.locator("#focus-button").click()
        assert page.locator("#vanilla").is_visible(), "Non-flowchart must not be routed to wizard"
        assert page.locator("#render-mode").input_value()=="vanilla"

        page.locator("#example").select_option("torture")
        page.locator("#focus-button").click()
        page.wait_for_function('window.focusDemo && window.focusDemo.getGraph()?.nodes.length === 30')
        assert page.locator("#wizard").is_visible()
        page.locator("#jump").select_option("Merge")
        page.evaluate("window.focusDemo.setFocusDepth(2)")
        page.wait_for_function('document.querySelector("#wizard").shadowRoot.querySelectorAll("svg .mf-focus-node").length >= 10')
        xvals=page.evaluate('''() => Array.from(document.querySelector('#wizard').shadowRoot.querySelectorAll('svg .mf-focus-node rect')).map(r=>Number(r.getAttribute('x')))''')
        assert len(set(xvals))>=3, f"Spotlight should have multiple columns, got {xvals}"
        # A zoomed-in viewBox can be narrow; test the actual rendered node spread.
        assert max(xvals)-min(xvals) > 500, f"Graph is still effectively one column: {xvals}"
        page.evaluate('window.focusDemo.fitAll()')
        assert page.evaluate('window.focusDemo.getCamera().w > 650')

        page.locator("#vanilla-button").click()
        page.wait_for_selector('#vanilla-surface svg[data-vanilla-kind="flowchart"]')
        assert page.locator("#wizard").is_hidden(), "Vanilla diagram should have no spotlight wrapper"

        # A second unsupported Mermaid diagram must also stay in vanilla.
        page.locator("details summary").click()
        page.locator("#source").fill('sequenceDiagram\n    Alice->>Bob: Hello')
        page.locator("#apply").click()
        page.wait_for_selector('#vanilla-surface svg[data-vanilla-kind="sequenceDiagram"]')
        assert page.locator("#render-mode").input_value()=="vanilla"
        assert not problems, f"{width}px errors: {problems}"
        print(f"{width}px layout, vanilla class/sequence/flowchart isolation passed")
        page.close()
    browser.close()
