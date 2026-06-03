import { state, getPaneDom, getActiveTab } from './state.js';
import { renderFiles, updateSelectionUI } from './file-list.js';

let renderTabsCallback = null;
let _autoSaveCallback = null;

export function initNavigation(renderTabs, autoSaveCallback) {
    renderTabsCallback = renderTabs;
    _autoSaveCallback = autoSaveCallback || null;
}

// Navigation helpers
export async function navigateTo(path, recordHistory = true, paneId = state.activePane) {
    const pane = state.panes[paneId];
    if (pane.isLoading) return;
    pane.isLoading = true;
    
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) {
        pane.isLoading = false;
        return;
    }

    const infoEl = getPaneDom(paneId).querySelector('.status-info');
    infoEl.textContent = 'Loading directory...';
    tab.selectedPaths.clear();
    updateSelectionUI(paneId);

    try {
        const response = await fetch(`/api/dir?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        tab.currentPath = data.path;
        tab.name = data.path.split('/').pop() || 'Root';
        tab.loadedEntries = data.entries || [];
        tab.hasMore = data.has_more || false;
        tab.nextCursor = data.cursor || '';
        tab.isLoaded = true;

        if (recordHistory) {
            pushPaneHistory(paneId, tab.currentPath);
        } else {
            updateNavButtons(paneId);
        }

        renderBreadcrumbs(paneId);
        if (renderTabsCallback) {
            renderTabsCallback(paneId);
        }
        if (_autoSaveCallback) _autoSaveCallback();
        
        const fileListEl = getPaneDom(paneId).querySelector('.file-list');
        fileListEl.scrollTop = 0;
        renderFiles(paneId);

        infoEl.textContent = `${tab.loadedEntries.length} items`;
    } catch (err) {
        console.error(err);
        infoEl.textContent = `Error loading directory`;
        
        // Ensure path and basic navigation/breadcrumbs are updated so the UI is not stuck
        tab.currentPath = path;
        tab.isLoaded = true; // Still mark as loaded/attempted so it behaves normally
        renderBreadcrumbs(paneId);
        updateNavButtons(paneId);
        renderFiles(paneId);
        
        alert(`Could not open directory: ${err.message}`);
    } finally {
        pane.isLoading = false;
    }
}

export function renderBreadcrumbs(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const path = tab.currentPath;
    const parts = path.split('/').filter(Boolean);
    
    let html = `<span class="breadcrumb-segment" data-path="/">Root</span>`;
    let currentAccumulated = '';
    
    parts.forEach(part => {
        currentAccumulated += '/' + part;
        const target = currentAccumulated;
        html += `
            <span class="breadcrumb-separator">/</span>
            <span class="breadcrumb-segment" data-path="${target}">${part}</span>
        `;
    });
    
    const container = getPaneDom(paneId).querySelector('.breadcrumbs');
    container.innerHTML = html;
    
    container.querySelectorAll('.breadcrumb-segment').forEach(seg => {
        seg.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetPath = seg.getAttribute('data-path');
            navigateTo(targetPath, true, paneId);
        });
    });
}

// Nav stack history actions
export function pushPaneHistory(paneId, path) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    if (tab.historyIndex < tab.history.length - 1) {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
    }
    tab.history.push(path);
    tab.historyIndex = tab.history.length - 1;
    updateNavButtons(paneId);
}

export function navigatePaneHistory(paneId, direction) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    const nextIndex = tab.historyIndex + direction;
    if (nextIndex >= 0 && nextIndex < tab.history.length) {
        tab.historyIndex = nextIndex;
        navigateTo(tab.history[tab.historyIndex], false, paneId);
    }
}

export function navigatePaneUp(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab || !tab.currentPath || tab.currentPath === '/') return;

    const parts = tab.currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    navigateTo(parentPath, true, paneId);
}

export function updateNavButtons(paneId) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    const paneEl = getPaneDom(paneId);
    if (!tab) return;

    paneEl.querySelector('.nav-back').disabled = tab.historyIndex <= 0;
    paneEl.querySelector('.nav-forward').disabled = tab.historyIndex >= tab.history.length - 1;
    paneEl.querySelector('.nav-up').disabled = !tab.currentPath || tab.currentPath === '/';
}

export function setPaneViewMode(paneId, mode) {
    const pane = state.panes[paneId];
    const tab = pane.tabs.find(t => t.id === pane.activeTabId);
    if (!tab) return;

    tab.viewMode = mode;
    const paneEl = getPaneDom(paneId);
    
    const cycleBtn = paneEl.querySelector('.btn-cycle-view');
    if (cycleBtn) {
        if (mode === 'list') {
            cycleBtn.innerHTML = '&#9776;'; // Show list icon (☰) when in list mode
            cycleBtn.title = 'Switch to Grid View';
        } else {
            cycleBtn.innerHTML = '&#9830;'; // Show grid icon (♦) when in grid mode
            cycleBtn.title = 'Switch to List View';
        }
    }
    
    const fileListEl = paneEl.querySelector('.file-list');
    fileListEl.className = mode === 'list' ? 'file-list list-view' : 'file-list grid-view';
    fileListEl.scrollTop = 0;
    
    renderFiles(paneId);
}

export function enablePaneAddressBarEdit(paneId) {
    const paneEl = getPaneDom(paneId);
    const breadcrumbs = paneEl.querySelector('.breadcrumbs');
    const addressBar = paneEl.querySelector('.address-bar');
    const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);

    breadcrumbs.style.display = 'none';
    addressBar.style.display = 'block';
    addressBar.value = tab ? tab.currentPath : '/';
    addressBar.focus();
    addressBar.select();
}

export function disablePaneAddressBarEdit(paneId) {
    const paneEl = getPaneDom(paneId);
    paneEl.querySelector('.breadcrumbs').style.display = 'flex';
    paneEl.querySelector('.address-bar').style.display = 'none';
}
