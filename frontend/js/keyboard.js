import { state, getActiveTab, getActivePane, getRecentTabs } from './state.js';
import { setSplitView, setQuadView } from './split-view.js';
import { createTab, closeTab, switchTab } from './tabs.js';
import { navigatePaneUp } from './navigation.js';
import { openQuickFind } from './quick-find.js';
import { getIsBatchRenameActive, cancelBatchRename } from './batch-rename.js';
import { 
    triggerClipboard, 
    triggerPaste, 
    triggerRename, 
    triggerDelete, 
    triggerOpen,
    triggerCopyPath,
    triggerCopyName,
    triggerCreateFolder,
    triggerOpenInNewTab
} from './context-menu.js';
import { SHORTCUTS, matchesShortcut } from './shortcuts.js';

let overlayEl = null;
let recentTabsVisible = false;
let currentCycleTabs = [];
let selectedIndex = 0;
let keyupHandler = null;
let currentModifierKey = null;

function ensureOverlayCreated() {
    if (overlayEl) return;
    overlayEl = document.createElement('div');
    overlayEl.id = 'recent-tabs-overlay';
    overlayEl.className = 'recent-tabs-overlay';
    overlayEl.innerHTML = `
        <div class="recent-tabs-container">
            <div class="recent-tabs-title">Recent Tabs</div>
            <div class="recent-tabs-list"></div>
        </div>
    `;
    document.body.appendChild(overlayEl);
}

function renderRecentTabsOverlay() {
    const listEl = overlayEl.querySelector('.recent-tabs-list');
    listEl.innerHTML = '';
    
    currentCycleTabs.forEach((tab, index) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'recent-tab-item' + (index === selectedIndex ? ' selected' : '');
        itemEl.dataset.index = index;
        
        const groupDotHtml = tab.group ? `<span class="recent-tab-group-dot group-${tab.color}"></span>` : '';
        const name = tab.name || 'Root';
        const path = tab.currentPath || '/';
        
        itemEl.innerHTML = `
            <span class="recent-tab-icon">📁</span>
            <div class="recent-tab-details">
                <span class="recent-tab-name">${name}</span>
                <span class="recent-tab-path">${path}</span>
            </div>
            ${groupDotHtml}
        `;
        
        itemEl.addEventListener('mouseover', () => {
            selectedIndex = index;
            updateOverlaySelection();
        });
        
        itemEl.addEventListener('click', () => {
            selectAndClose();
        });
        
        listEl.appendChild(itemEl);
    });
}

function updateOverlaySelection() {
    if (!overlayEl) return;
    const items = overlayEl.querySelectorAll('.recent-tab-item');
    items.forEach((item, index) => {
        item.classList.toggle('selected', index === selectedIndex);
    });
}

function selectAndClose() {
    if (!recentTabsVisible) return;
    recentTabsVisible = false;
    
    if (overlayEl) {
        overlayEl.classList.remove('visible');
    }
    
    if (keyupHandler) {
        window.removeEventListener('keyup', keyupHandler);
        keyupHandler = null;
    }
    
    const tabToSwitch = currentCycleTabs[selectedIndex];
    if (tabToSwitch) {
        switchTab(state.activePane, tabToSwitch.id);
    }
}

function cancelTabCycling() {
    if (!recentTabsVisible) return;
    recentTabsVisible = false;
    if (overlayEl) {
        overlayEl.classList.remove('visible');
    }
    if (keyupHandler) {
        window.removeEventListener('keyup', keyupHandler);
        keyupHandler = null;
    }
}

function triggerTabCycling(modifier) {
    if (!recentTabsVisible) {
        const recentTabs = getRecentTabs(state.activePane);
        if (recentTabs.length <= 1) return;
        
        ensureOverlayCreated();
        recentTabsVisible = true;
        currentCycleTabs = recentTabs;
        selectedIndex = 1; // Start with the second most recent tab
        currentModifierKey = modifier;
        
        renderRecentTabsOverlay();
        overlayEl.classList.add('visible');
        
        keyupHandler = (e) => {
            if (e.key === currentModifierKey) {
                selectAndClose();
            }
        };
        window.addEventListener('keyup', keyupHandler);
    } else {
        selectedIndex = (selectedIndex + 1) % currentCycleTabs.length;
        updateOverlaySelection();
    }
}
window.addEventListener('blur', cancelTabCycling);

function getSelectedDir() {
    const tab = getActiveTab();
    if (!tab || tab.selectedPaths.size !== 1) return null;
    const path = [...tab.selectedPaths][0];
    const entry = tab.loadedEntries.find(e => {
        const fullPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + e.name;
        return fullPath === path;
    });
    return (entry && entry.is_dir) ? path : null;
}

// Keyboard Shortcuts Router
export function handleKeyboardShortcuts(e) {
    if (getIsBatchRenameActive()) {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelBatchRename();
            return;
        }
    }

    if (recentTabsVisible) {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelTabCycling();
            return;
        }
        if (currentModifierKey === 'Shift' && e.key === 'Tab') {
            e.preventDefault();
            triggerTabCycling('Shift');
            return;
        }
        if (currentModifierKey === 'Alt' && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            triggerTabCycling('Alt');
            return;
        }
    }

    if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        triggerTabCycling('Shift');
        return;
    }

    if (e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        triggerTabCycling('Alt');
        return;
    }

    if (document.activeElement.tagName === 'INPUT') return;

    if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycleTabs(e.shiftKey ? -1 : 1);
        return;
    }

    const handlers = {
        'quick-find': () => openQuickFind(),
        'split-view': () => setSplitView(!state.isSplit),
        'quad-view': () => setQuadView(!state.isQuad),
        'toggle-sidebar': () => {
            const sidebar = document.querySelector('.sidebar');
            if (sidebar) sidebar.classList.toggle('visible');
        },
        'new-tab': () => {
            const tab = getActiveTab();
            const path = tab ? tab.currentPath : '/';
            createTab(state.activePane, path);
        },
        'close-tab': () => {
            const tab = getActiveTab();
            if (tab) closeTab(state.activePane, tab.id);
        },
        'copy': () => triggerClipboard('copy'),
        'cut': () => triggerClipboard('cut'),
        'paste': () => triggerPaste(),
        'copy-name': () => triggerCopyName(),
        'copy-path': () => triggerCopyPath(),
        'open-in-new-tab': () => {
            e.preventDefault();
            if (getSelectedDir()) triggerOpenInNewTab();
        },
        'cut-inside': () => {
            e.preventDefault();
            if (getSelectedDir()) triggerClipboard('cut', true);
        },
        'copy-inside': () => {
            e.preventDefault();
            if (getSelectedDir()) triggerClipboard('copy', true);
        },
        'paste-inside': () => {
            e.preventDefault();
            const dir = getSelectedDir();
            if (dir) triggerPaste(dir);
        },
        'rename': () => triggerRename(),
        'delete': () => triggerDelete(),
        'navigate-up': () => navigatePaneUp(state.activePane),
        'open': () => triggerOpen(),
        'create-folder': () => triggerCreateFolder()
    };

    const NO_PREVENT_DEFAULT = ['copy', 'cut', 'paste', 'rename', 'delete', 'navigate-up', 'open'];

    for (const [action, shortcutStr] of Object.entries(SHORTCUTS)) {
        if (matchesShortcut(e, shortcutStr)) {
            if (!NO_PREVENT_DEFAULT.includes(action)) {
                e.preventDefault();
            }
            const handler = handlers[action];
            if (handler) {
                handler();
            }
            return;
        }
    }
}

export function cycleTabs(dir) {
    const pane = getActivePane();
    if (pane.tabs.length <= 1) return;
    const index = pane.tabs.findIndex(t => t.id === pane.activeTabId);
    const nextIndex = (index + dir + pane.tabs.length) % pane.tabs.length;
    switchTab(state.activePane, pane.tabs[nextIndex].id);
}
