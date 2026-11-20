/**
 * Moves the GeoAgent conversation panel out of the map container and into a
 * sidebar element so the examples can use a left/right split layout. The
 * sidebar width adapts to the panel instead of being a fixed fraction of the
 * viewport, and the floating toggle button is removed because the panel is
 * always visible in the sidebar.
 */
export function dockAgentPanel(host: HTMLElement, sidebar: HTMLElement): void {
  const adopt = (): boolean => {
    const panel = host.querySelector<HTMLElement>('.geoagent-panel');
    if (!panel) return false;
    // The floating toggle button is not needed in the split layout; the panel
    // stays docked and always visible in the sidebar.
    const button = host.querySelector<HTMLElement>('.geoagent-control');
    if (button) button.remove();
    if (panel.parentElement !== sidebar) sidebar.appendChild(panel);
    panel.classList.add('geoagent-panel-docked');
    return true;
  };

  if (adopt()) return;

  // The React wrapper adds the control inside a child effect, so right after
  // render the panel may not exist yet; poll for a short while.
  let frames = 0;
  const tick = (): void => {
    if (adopt() || ++frames > 120) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
