"""Optional UI smoke test: pip install playwright; playwright install chromium."""
from pathlib import Path
import shutil
from playwright.sync_api import sync_playwright

HOME = Path(__file__).resolve().parents[1] / 'public' / 'index.html'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=shutil.which('chromium') or shutil.which('google-chrome'), args=['--no-sandbox']) if (shutil.which('chromium') or shutil.which('google-chrome')) else p.chromium.launch(headless=True)
    for width in (390, 1140):
        page = browser.new_page(viewport={'width': width, 'height': 850})
        problems = []
        page.on('pageerror', lambda error: problems.append(str(error)))
        page.set_content(HOME.read_text(), wait_until='load')
        page.wait_for_function('window.focusDemo && window.focusDemo.getGraph()')
        graph = page.evaluate('window.focusDemo.getGraph()')
        assert len(graph['nodes']) == 16, f'Expected 16 nodes: {len(graph["nodes"])}'
        assert len(graph['edges']) == 16, f'Expected 16 directed paths: {len(graph["edges"])}'
        assert page.locator('#wizard').locator('select.mf-depth').count() == 1
        page.locator('#wizard').locator('select.mf-depth').select_option('2')
        assert page.evaluate('window.focusDemo.getState().focusDepth') == 2
        before = page.evaluate('window.focusDemo.getCamera().w')
        page.locator('#wizard').locator('button.mf-zoom-in').click()
        assert page.evaluate('window.focusDemo.getCamera().w') < before
        page.locator('#wizard').locator('button.mf-fit-node').click()
        assert page.evaluate('window.focusDemo.getCamera().w') > 0
        page.locator('#wizard').locator('button.mf-answer').first.click()
        assert page.evaluate('window.focusDemo.getState().path.length') == 1
        page.locator('#wizard').locator('button.mf-overview-button').click()
        assert not problems, problems
        page.close()
    browser.close()
print('Smoke tests passed')
