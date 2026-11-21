const SOURCES = [
    { id: 'wand', label: '魔法棒', roots: ['#extensionsMenu'], selector: '.list-group-item[id]' },
    { id: 'options', label: '左下菜单', roots: ['#options'], selector: 'a[id], button[id], .menu_button[id]' },
];
const q = (selector, root = document) => root.querySelector(selector);
const ctx = () => SillyTavern.getContext();
const sourceDef = id => SOURCES.find(source => source.id === id);
const sourceLabel = id => sourceDef(id || 'wand')?.label || '魔法棒';
const shortcutKey = item => `${item.source || 'wand'}:${item.id}`;

function db() {
    const value = ctx().extensionSettings.jellyfish ??= { shortcuts: [] };
    if (!Array.isArray(value.shortcuts)) value.shortcuts = [];
    value.shortcuts = value.shortcuts.filter(item => item && typeof item.id === 'string' && item.id && item.source !== 'extensions');
    return value;
}

function save() {
    ctx().saveSettingsDebounced();
}

function node(tag, text = '', className = '') {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    if (tag === 'button') element.type = 'button';
    return element;
}

function notify(message, error = false) {
    if (globalThis.toastr) toastr[error ? 'error' : 'info'](message, 'JellyFish', { escapeHtml: true });
    else console[error ? 'error' : 'info']('JellyFish', message);
}

function isSuppressed(element, root) {
    for (let current = element; current && current !== root; current = current.parentElement) {
        if (current.hidden || current.classList.contains('displayNone') || current.style.display === 'none') return true;
    }
    return false;
}

function originalAction(saved) {
    const source = sourceDef(saved.source || 'wand');
    if (!source) return null;
    for (const selector of source.roots) {
        const root = q(selector);
        if (!root) continue;
        const element = [...root.querySelectorAll(source.selector)].find(item => item.id === saved.id && !isSuppressed(item, root));
        if (element) return element;
    }
    return null;
}

function actionInfo(element, source) {
    const icon = element.querySelector('.extensionsMenuExtensionButton, .fa-solid, .fa-regular, .fa-brands');
    const iconClass = icon
        ? [...icon.classList].filter(name => !['extensionsMenuExtensionButton', 'fa-fw'].includes(name)).join(' ')
        : 'fa-solid fa-puzzle-piece';
    const label = (element.textContent || '').replace(/\s+/g, ' ').trim() || element.title || element.id;
    return {
        id: element.id,
        source: source || SOURCES.find(item => item.roots.some(selector => element.closest(selector)))?.id || 'wand',
        label,
        icon: iconClass || 'fa-solid fa-puzzle-piece',
    };
}

function availableActions() {
    const seen = new Set();
    const items = [];
    for (const source of SOURCES) {
        for (const selector of source.roots) {
            const root = q(selector);
            if (!root) continue;
            for (const element of root.querySelectorAll(source.selector)) {
                if (isSuppressed(element, root)) continue;
                const info = actionInfo(element, source.id);
                if (seen.has(shortcutKey(info))) continue;
                seen.add(shortcutKey(info));
                items.push(info);
            }
        }
    }
    return items;
}

function appendIcon(button, iconClass) {
    const icon = node('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
}

let bar;
let shortcutHost;
let panel;
let panelRefresh;
let scheduled = false;

function renderShortcuts() {
    if (!shortcutHost) return;
    shortcutHost.replaceChildren();
    for (const saved of db().shortcuts) {
        const original = originalAction(saved);
        const info = original ? actionInfo(original) : saved;
        const button = node('button', '', 'jf-shortcut');
        button.dataset.shortcutId = saved.id;
        button.title = original ? info.label : `未检测到：${info.label || saved.id}`;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-disabled', String(!original));
        button.disabled = !original;
        appendIcon(button, info.icon || 'fa-solid fa-puzzle-piece');
        button.append(node('span', info.label || saved.id, 'jf-label'));
        button.addEventListener('click', () => {
            const target = originalAction(saved);
            if (!target) {
                notify(`${sourceLabel(saved.source)}里还没有“${info.label || saved.id}”，请确认原扩展已加载`, true);
                return;
            }
            target.click();
        });
        shortcutHost.append(button);
    }
}

function jump(bottom) {
    const chat = q('#chat');
    if (!chat) return;
    const bounds = chat.getBoundingClientRect();
    const line = bounds.top + Math.min(70, bounds.height * 0.18);
    const messages = [...chat.querySelectorAll('.mes[mesid]')];
    const current = messages.find(element => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > line && rect.top < bounds.bottom;
    });
    if (!current) return;
    const rect = current.getBoundingClientRect();
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    chat.scrollBy({
        top: bottom ? rect.bottom - bounds.bottom : rect.top - bounds.top,
        behavior: reduced ? 'auto' : 'smooth',
    });
}

function reorder(index, offset) {
    const shortcuts = db().shortcuts;
    const next = index + offset;
    if (next < 0 || next >= shortcuts.length) return;
    [shortcuts[index], shortcuts[next]] = [shortcuts[next], shortcuts[index]];
    save();
    renderShortcuts();
    panelRefresh?.();
}

function removeShortcut(index) {
    db().shortcuts.splice(index, 1);
    save();
    renderShortcuts();
    panelRefresh?.();
}

function addShortcut(info) {
    if (db().shortcuts.some(item => shortcutKey(item) === shortcutKey(info))) return;
    db().shortcuts.push(info);
    save();
    renderShortcuts();
    panelRefresh?.();
}

function listRow(info, missing = false) {
    const row = node('div', '', 'jf-row');
    const name = node('div', '', 'jf-row-name');
    appendIcon(name, info.icon || 'fa-solid fa-puzzle-piece');
    name.append(node('span', info.label || info.id));
    name.append(node('small', sourceLabel(info.source)));
    if (missing) name.append(node('small', '未检测到原入口'));
    row.append(name);
    return row;
}

function openSettings() {
    if (panel?.open) {
        panel.focus();
        return;
    }
    panel = node('dialog', '', 'jf-panel');
    panel.setAttribute('aria-labelledby', 'jf-panel-title');
    const header = node('header');
    const title = node('strong', 'JellyFish');
    title.id = 'jf-panel-title';
    const close = node('button', '关闭');
    close.addEventListener('click', () => panel.close());
    header.append(title, close);

    const body = node('section');
    const selectedTitle = node('h3', '横栏里的快捷功能');
    const selected = node('div', '', 'jf-list');
    const availableTitle = node('h3', '可添加的功能');
    const available = node('div', '', 'jf-list');
    const refresh = node('button', '刷新列表', 'jf-refresh');
    const note = node('p', '可添加魔法棒和左下菜单中的可点击功能。调整顺序或删除只会改变 JellyFish，不会修改原功能。', 'jf-note');
    availableTitle.append(refresh);
    body.append(note, selectedTitle, selected, availableTitle, available);
    panel.append(header, body);

    function renderPanel() {
        const shortcuts = db().shortcuts;
        const availableItems = availableActions();
        selected.replaceChildren();
        available.replaceChildren();

        if (!shortcuts.length) selected.append(node('p', '还没有添加快捷功能。', 'jf-empty'));
        shortcuts.forEach((saved, index) => {
            const original = originalAction(saved);
            const info = original ? actionInfo(original) : saved;
            const row = listRow(info, !original);
            const controls = node('div', '', 'jf-row-actions');
            const up = node('button', '↑');
            up.title = '前移';
            up.setAttribute('aria-label', `前移 ${info.label || saved.id}`);
            up.disabled = index === 0;
            up.addEventListener('click', () => reorder(index, -1));
            const down = node('button', '↓');
            down.title = '后移';
            down.setAttribute('aria-label', `后移 ${info.label || saved.id}`);
            down.disabled = index === shortcuts.length - 1;
            down.addEventListener('click', () => reorder(index, 1));
            const remove = node('button', '移除');
            remove.setAttribute('aria-label', `移除 ${info.label || saved.id}`);
            remove.addEventListener('click', () => removeShortcut(index));
            controls.append(up, down, remove);
            row.append(controls);
            selected.append(row);
        });

        const unused = availableItems.filter(info => !shortcuts.some(item => shortcutKey(item) === shortcutKey(info)));
        if (!unused.length) {
            available.append(node('p', availableItems.length ? '所有已检测到的功能都已添加。' : '暂未检测到可添加功能，请等扩展加载后刷新。', 'jf-empty'));
        }
        for (const source of SOURCES) {
            const group = unused.filter(info => info.source === source.id);
            if (!group.length) continue;
            available.append(node('h4', source.label, 'jf-source-title'));
            for (const info of group) {
                const row = listRow(info);
                const add = node('button', '添加');
                add.setAttribute('aria-label', `添加 ${info.label}`);
                add.addEventListener('click', () => addShortcut(info));
                row.append(add);
                available.append(row);
            }
        }
    }

    refresh.addEventListener('click', renderPanel);
    panelRefresh = renderPanel;
    panel.addEventListener('close', () => {
        panelRefresh = null;
        panel.remove();
        panel = null;
    });
    document.body.append(panel);
    renderPanel();
    panel.showModal();
}

function later() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        renderShortcuts();
        panelRefresh?.();
    });
}

function init() {
    const chat = q('#chat');
    if (!chat || q('#jf-bar')) return;

    bar = node('div');
    bar.id = 'jf-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'JellyFish');

    const settingsButton = node('button', '', 'jf-settings');
    settingsButton.title = 'JellyFish 设置';
    settingsButton.setAttribute('aria-label', 'JellyFish 设置');
    const medusa = node('span', '', 'jf-medusa');
    medusa.setAttribute('aria-hidden', 'true');
    settingsButton.append(medusa);
    settingsButton.addEventListener('click', openSettings);

    shortcutHost = node('div', '', 'jf-shortcuts');
    shortcutHost.setAttribute('role', 'group');
    shortcutHost.setAttribute('aria-label', 'JellyFish 快捷功能');

    const jumps = node('div', '', 'jf-jumps');
    for (const [label, icon, bottom] of [['当前楼层回顶', 'fa-solid fa-arrow-up', false], ['当前楼层到底部', 'fa-solid fa-arrow-down', true]]) {
        const button = node('button');
        button.title = label;
        button.setAttribute('aria-label', label);
        appendIcon(button, icon);
        button.addEventListener('click', () => jump(bottom));
        jumps.append(button);
    }

    bar.append(settingsButton, shortcutHost, jumps);
    chat.before(bar);
    renderShortcuts();

    const observer = new MutationObserver(later);
    for (const source of SOURCES) {
        for (const selector of source.roots) {
            const root = q(selector);
            if (root) observer.observe(root, { childList: true, subtree: true });
        }
    }
    setTimeout(later, 1500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
