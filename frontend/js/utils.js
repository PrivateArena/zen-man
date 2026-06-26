export function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

export function positionElementSmartly(menuElement, clientX, clientY) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const menuWidth = menuElement.offsetWidth;
    const menuHeight = menuElement.offsetHeight;

    let x = clientX;
    let y = clientY;

    if (x + menuWidth > viewportWidth) {
        x = clientX - menuWidth;
    }
    if (y + menuHeight > viewportHeight) {
        y = clientY - menuHeight;
    }

    // Clamp within viewport boundaries
    x = Math.max(0, Math.min(x, viewportWidth - menuWidth));
    y = Math.max(0, Math.min(y, viewportHeight - menuHeight));

    menuElement.style.left = `${x}px`;
    menuElement.style.top  = `${y}px`;
}

export function parseVfsPath(path) {
    if (!path) return null;
    
    const normalized = path.replace(/\\/g, '/');
    const zipIdx = normalized.toLowerCase().indexOf('.zip');
    const rarIdx = normalized.toLowerCase().indexOf('.rar');
    const szIdx = normalized.toLowerCase().indexOf('.7z');
    
    const indices = [zipIdx, rarIdx, szIdx].filter(idx => idx !== -1);
    if (indices.length === 0) {
        return null;
    }
    
    const firstArchiveIdx = Math.min(...indices);
    const archiveHostEnd = firstArchiveIdx + 4;
    const archive = path.substring(0, archiveHostEnd);
    let remaining = path.substring(archiveHostEnd);
    
    if (remaining.startsWith('/')) {
        remaining = remaining.substring(1);
    }
    
    let nested = '';
    let internalPath = remaining;
    
    const nestedZipIdx = remaining.toLowerCase().indexOf('.zip');
    const nestedRarIdx = remaining.toLowerCase().indexOf('.rar');
    const nestedSzIdx = remaining.toLowerCase().indexOf('.7z');
    
    const nestedIndices = [nestedZipIdx, nestedRarIdx, nestedSzIdx].filter(idx => idx !== -1);
    if (nestedIndices.length > 0) {
        const firstNestedIdx = Math.min(...nestedIndices);
        const nestedArchiveEnd = firstNestedIdx + 4;
        nested = remaining.substring(0, nestedArchiveEnd);
        internalPath = remaining.substring(nestedArchiveEnd);
        if (internalPath.startsWith('/')) {
            internalPath = internalPath.substring(1);
        }
    }
    
    return {
        archive: archive,
        nested: nested,
        path: internalPath
    };
}
