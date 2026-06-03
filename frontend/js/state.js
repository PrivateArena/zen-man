export const state = {
    activePane: 'left', // 'left', 'right', 'left-bottom', 'right-bottom'
    isSplit: false,
    isQuad: false,
    bookmarks: [],
    mounts: [],
    panes: {
        left: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set(),
            isLoading: false
        },
        right: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set(),
            isLoading: false
        },
        'left-bottom': {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set(),
            isLoading: false
        },
        'right-bottom': {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set(),
            isLoading: false
        }
    },
    clipboard: {
        op: null,
        items: []
    }
};

export const dragTabState = {
    source: null
};

export function getActivePane() {
    return state.panes[state.activePane];
}

export function getActiveTab() {
    const pane = getActivePane();
    return pane.tabs.find(t => t.id === pane.activeTabId);
}

export function getPaneDom(paneId) {
    return document.getElementById(`pane-${paneId}`);
}

export function getPaneTab(paneId, tabId) {
    return state.panes[paneId].tabs.find(t => t.id === tabId);
}

export function updateMru(paneId, tabId) {
    const pane = state.panes[paneId];
    if (!pane.mruTabIds) {
        pane.mruTabIds = [];
    }
    pane.mruTabIds = pane.mruTabIds.filter(id => id !== tabId);
    pane.mruTabIds.unshift(tabId);
    
    // Clean up non-existent tabs
    const tabIds = new Set(pane.tabs.map(t => t.id));
    pane.mruTabIds = pane.mruTabIds.filter(id => tabIds.has(id));
}

export function getRecentTabs(paneId) {
    const pane = state.panes[paneId];
    if (!pane.mruTabIds) {
        pane.mruTabIds = [];
    }
    
    // Clean up non-existent tabs
    const tabIds = new Set(pane.tabs.map(t => t.id));
    pane.mruTabIds = pane.mruTabIds.filter(id => tabIds.has(id));
    
    // Add any missing tab IDs in order they exist in tabs array
    pane.tabs.forEach(t => {
        if (!pane.mruTabIds.includes(t.id)) {
            pane.mruTabIds.push(t.id);
        }
    });
    
    // Return max 5 recent tab objects
    return pane.mruTabIds.slice(0, 5).map(id => pane.tabs.find(t => t.id === id)).filter(Boolean);
}
