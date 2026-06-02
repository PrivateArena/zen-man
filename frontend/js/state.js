export const state = {
    activePane: 'left', // 'left' or 'right'
    isSplit: false,
    bookmarks: [],
    mounts: [],
    panes: {
        left: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set()
        },
        right: {
            activeTabId: null,
            tabs: [],
            collapsedGroups: new Set()
        }
    },
    isLoading: false,
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
