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
    triggerCopyName
} from './context-menu.js';

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

    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openQuickFind();
    }
    else if (e.key === 'F3') {
        e.preventDefault();
        setSplitView(!state.isSplit);
    }
    else if (e.key === 'F4') {
        e.preventDefault();
        setQuadView(!state.isQuad);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const sidebar = document.querySelector('.sidebar');
        sidebar.classList.toggle('visible');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const tab = getActiveTab();
        const path = tab ? tab.currentPath : '/';
        createTab(state.activePane, path);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const tab = getActiveTab();
        if (tab) {
            closeTab(state.activePane, tab.id);
        }
    }
    else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycleTabs(e.shiftKey ? -1 : 1);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        triggerClipboard('copy');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
        triggerClipboard('cut');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        triggerPaste();
    }
    else if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        triggerCopyName();
    }
    else if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        triggerCopyPath();
    }
    else if (e.key === 'F2') {
        triggerRename();
    }
    else if (e.key === 'Delete') {
        triggerDelete();
    }
    else if (e.key === 'Backspace') {
        navigatePaneUp(state.activePane);
    }
    else if (e.key === 'Enter') {
        triggerOpen();
    }
}

export function cycleTabs(dir) {
    const pane = getActivePane();
    if (pane.tabs.length <= 1) return;
    const index = pane.tabs.findIndex(t => t.id === pane.activeTabId);
    const nextIndex = (index + dir + pane.tabs.length) % pane.tabs.length;
    switchTab(state.activePane, pane.tabs[nextIndex].id);
}
