/**
 * Moves the GeoAgent toggle button and conversation panel out of the map
 * container and into a sidebar element so the examples can use a left/right
 * split layout (sidebar 25% wide, map on the right).
 *
 * The control itself stays fully functional: collapsing hides the panel and
 * leaves the toggle button at the top of the sidebar.
 */
export function dockAgentPanel(host: HTMLElement, sidebar: HTMLElement): void {
  const adopt = (): boolean => {
    const panel = host.querySelector<HTMLElement>('.geoagent-panel');
    if (!panel) return false;
    const button = host.querySelector<HTMLElement>('.geoagent-control');
    if (button && button.parentElement !== sidebar) {
      sidebar.appendChild(button);
      // The OpenLayers/Leaflet mount helpers position the button absolutely
      // inside the map viewport; inside the sidebar it flows normally.
      button.style.cssText = '';
      button.classList.remove('geoagent-openlayers-control');
    }
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
