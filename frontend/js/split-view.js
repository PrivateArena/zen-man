import { state } from './state.js';

let updateSelectionUICallback = null;
let createTabCallback = null;

export function initSplitView(updateSelectionUI, createTab) {
    updateSelectionUICallback = updateSelectionUI;
    createTabCallback = createTab;
}

export function setActivePane(paneId) {
    state.activePane = paneId;
    
    Object.keys(state.panes).forEach(id => {
        const paneEl = document.getElementById(`pane-${id}`);
        if (paneEl) {
            paneEl.classList.toggle('active-pane', id === paneId);
        }
    });
    
    if (updateSelectionUICallback) {
        updateSelectionUICallback();
    }
    import('./navigation.js').then(m => m.updateDiskSpaceDisplay());
}

export function updateLayout() {
    const container = document.getElementById('panes-container');
    const paneLeft = document.getElementById('pane-left');
    const paneRight = document.getElementById('pane-right');
    const paneLeftBottom = document.getElementById('pane-left-bottom');
    const paneRightBottom = document.getElementById('pane-right-bottom');

    const btn2 = document.getElementById('split-2-btn');
    const btn4 = document.getElementById('split-4-btn');

    if (state.isQuad) {
        container.className = 'panes-container quad-pane';
        paneLeft.style.display = 'flex';
        paneRight.style.display = 'flex';
        paneLeftBottom.style.display = 'flex';
        paneRightBottom.style.display = 'flex';

        if (btn2) btn2.classList.remove('btn-accent');
        if (btn4) btn4.classList.add('btn-accent');

        // Initialize panes if empty
        const activeTab = state.panes[state.activePane]?.tabs.find(t => t.id === state.panes[state.activePane].activeTabId);
        const path = activeTab ? activeTab.currentPath : '/';

        ['left-bottom', 'right-bottom', 'right'].forEach(paneId => {
            if (state.panes[paneId].tabs.length === 0) {
                if (createTabCallback) {
                    createTabCallback(paneId, path);
                }
            }
        });
    } else if (state.isSplit) {
        container.className = 'panes-container split-pane';
        paneLeft.style.display = 'flex';
        paneRight.style.display = 'flex';
        paneLeftBottom.style.display = 'none';
        paneRightBottom.style.display = 'none';

        if (btn2) btn2.classList.add('btn-accent');
        if (btn4) btn4.classList.remove('btn-accent');

        if (state.panes.right.tabs.length === 0) {
            const activeTab = state.panes.left.tabs.find(t => t.id === state.panes.left.activeTabId);
            const path = activeTab ? activeTab.currentPath : '/';
            if (createTabCallback) {
                createTabCallback('right', path);
            }
        }

        if (state.activePane === 'left-bottom' || state.activePane === 'right-bottom') {
            setActivePane('left');
        }
    } else {
        container.className = 'panes-container single-pane';
        paneLeft.style.display = 'flex';
        paneRight.style.display = 'none';
        paneLeftBottom.style.display = 'none';
        paneRightBottom.style.display = 'none';

        if (btn2) btn2.classList.remove('btn-accent');
        if (btn4) btn4.classList.remove('btn-accent');

        setActivePane('left');
    }
}

export function setSplitView(split) {
    state.isSplit = split;
    if (split) {
        state.isQuad = false;
    }
    updateLayout();
}

export function setQuadView(quad) {
    state.isQuad = quad;
    if (quad) {
        state.isSplit = false;
    }
    updateLayout();
}
