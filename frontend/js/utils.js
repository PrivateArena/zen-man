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
