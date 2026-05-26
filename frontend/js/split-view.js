import { state } from './state.js';

let updateSelectionUICallback = null;
let createTabCallback = null;

export function initSplitView(updateSelectionUI, createTab) {
    updateSelectionUICallback = updateSelectionUI;
    createTabCallback = createTab;
}

export function setActivePane(paneId) {
    state.activePane = paneId;
    
    document.getElementById('pane-left').classList.toggle('active-pane', paneId === 'left');
    document.getElementById('pane-right').classList.toggle('active-pane', paneId === 'right');
    
    if (updateSelectionUICallback) {
        updateSelectionUICallback();
    }
}

export function setSplitView(split) {
    state.isSplit = split;
    const container = document.getElementById('panes-container');
    const rightPane = document.getElementById('pane-right');
    const btn = document.getElementById('split-toggle-btn');

    if (split) {
        container.className = 'panes-container split-pane';
        rightPane.style.display = 'flex';
        btn.textContent = 'Single Pane (F3)';
        
        // If right pane doesn't have any tab, duplicate left active path
        if (state.panes.right.tabs.length === 0) {
            const leftTab = state.panes.left.tabs.find(t => t.id === state.panes.left.activeTabId);
            const path = leftTab ? leftTab.currentPath : '/';
            if (createTabCallback) {
                createTabCallback('right', path);
            }
        }
    } else {
        container.className = 'panes-container single-pane';
        rightPane.style.display = 'none';
        btn.textContent = 'Split View (F3)';
        setActivePane('left');
    }
}
