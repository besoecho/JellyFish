"""Offline Chromium integration test. Requires Python Playwright and Chromium."""
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HTML = """
<meta charset=utf-8><link rel=stylesheet href=/style.css>
<style>
html,body{margin:0} #chat{height:240px;overflow-y:auto;border:1px solid #888}
.mes{height:500px;box-sizing:border-box;border-bottom:1px solid #ccc}
#extensionsMenu{display:none}
</style>
<div id=chat>
    <div class=mes mesid=0>第一楼层</div>
    <div class=mes mesid=1>第二楼层</div>
</div>
<div id=extensionsMenu>
    <div class=extension_container>
        <div id=alpha_action class="list-group-item flex-container">
            <div class="fa-solid fa-star extensionsMenuExtensionButton"></div><span>Alpha 功能</span>
        </div>
        <div id=beta_action class="list-group-item flex-container">
            <div class="fa-solid fa-flask extensionsMenuExtensionButton"></div><span>Beta 功能</span>
        </div>
    </div>
</div>
<script>
window.calls=[];
window.notices=[];
const c={extensionSettings:{},saveSettingsDebounced(){this.saved=(this.saved||0)+1;}};
window.SillyTavern={getContext:()=>c};
window.toastr={info:(m)=>notices.push(m),error:(m)=>notices.push(m)};
for(const [id,name] of [['alpha_action','alpha'],['beta_action','beta']]) {
    document.getElementById(id).addEventListener('click',()=>calls.push(name));
}
</script>
<script type=module src=/index.js></script>
"""


class Server(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/fixture':
            payload = HTML.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', len(payload))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:' + str(server.server_port)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 390, 'height': 844}, has_touch=True, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/fixture')

    expect(page.locator('#jf-bar')).to_be_visible()
    assert page.locator('#jf-bar + #chat').count() == 1
    expect(page.get_by_role('button', name='当前楼层回顶')).to_be_visible()
    expect(page.get_by_role('button', name='当前楼层到底部')).to_be_visible()

    page.get_by_role('button', name='JellyFish 设置').click()
    expect(page.locator('.jf-panel[open]')).to_be_visible()
    page.get_by_role('button', name='添加 Alpha 功能').click()
    page.get_by_role('button', name='添加 Beta 功能').click()
    expect(page.locator('.jf-shortcut')).to_have_count(2)
    assert page.evaluate("c.extensionSettings.jellyfish.shortcuts.map(x=>x.id).join(',')") == 'alpha_action,beta_action'
    page.get_by_role('button', name='后移 Alpha 功能').click()
    assert page.evaluate("c.extensionSettings.jellyfish.shortcuts.map(x=>x.id).join(',')") == 'beta_action,alpha_action'
    page.locator('.jf-panel').get_by_role('button', name='关闭', exact=True).click()

    expect(page.locator('.jf-shortcut')).to_have_count(2)
    assert page.locator('.jf-shortcut').evaluate_all("nodes=>nodes.map(x=>x.dataset.shortcutId).join(',')") == 'beta_action,alpha_action'
    page.locator('[data-shortcut-id=alpha_action]').click()
    assert page.evaluate('calls.join(",")') == 'alpha'
    expect(page.locator('#extensionsMenu')).to_be_hidden()

    page.get_by_role('button', name='JellyFish 设置').click()
    page.get_by_role('button', name='移除 Beta 功能').click()
    page.locator('.jf-panel').get_by_role('button', name='关闭', exact=True).click()
    expect(page.locator('.jf-shortcut')).to_have_count(1)
    assert page.evaluate('c.saved') >= 4

    # Removing the original extension marks the shortcut missing without deleting its configuration.
    page.evaluate("document.getElementById('alpha_action').remove()")
    expect(page.locator('[data-shortcut-id=alpha_action]')).to_have_attribute('aria-disabled', 'true')
    expect(page.locator('[data-shortcut-id=alpha_action]')).to_be_disabled()
    assert page.evaluate('calls.length') == 1

    # A late third-party wand entry is discovered without reloading JellyFish.
    page.evaluate("""() => {
        const item=document.createElement('div');item.id='late_action';item.className='list-group-item';
        item.innerHTML='<div class="fa-solid fa-moon extensionsMenuExtensionButton"></div><span>晚加载功能</span>';
        item.onclick=()=>calls.push('late');document.querySelector('#extensionsMenu .extension_container').append(item);
    }""")
    page.get_by_role('button', name='JellyFish 设置').click()
    page.get_by_role('button', name='添加 晚加载功能').click()
    page.locator('.jf-panel').get_by_role('button', name='关闭', exact=True).click()
    page.locator('[data-shortcut-id=late_action]').click()
    assert page.evaluate('calls.at(-1)') == 'late'
    expect(page.locator('.jf-shortcut')).to_have_count(2)

    # Down scrolls the current floor, not necessarily the latest floor; up returns its top to the chat top.
    page.get_by_role('button', name='当前楼层到底部').click()
    assert page.locator('#chat').evaluate('e=>e.scrollTop') > 200
    page.evaluate("document.getElementById('chat').scrollTop=520")
    expected_scroll = page.evaluate("""() => {const chat=document.getElementById('chat'),mes=chat.querySelector('.mes[mesid="1"]');
        return chat.scrollTop+mes.getBoundingClientRect().top-chat.getBoundingClientRect().top;}""")
    page.get_by_role('button', name='当前楼层回顶').click()
    actual_scroll = page.locator('#chat').evaluate('e=>e.scrollTop')
    assert abs(actual_scroll - expected_scroll) <= 1, (actual_scroll, expected_scroll)

    # The fixed navigation buttons remain visible and clickable on the narrow viewport.
    for name in ['当前楼层回顶', '当前楼层到底部']:
        button = page.get_by_role('button', name=name)
        box = button.bounding_box()
        assert box and 0 <= box['x'] and box['x'] + box['width'] <= 390
        assert button.evaluate("e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===e||e.contains(hit);}")

    assert not errors, errors
    browser.close()

server.shutdown()
print('PASS · wand discovery, native action click, add, remove, reorder, persistence, late loading, missing target, current-floor jumps')
