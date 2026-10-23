'use strict';
let name = new URLSearchParams(location.search).get('name') || 'Another device';
if (name.length > 24) name = name.slice(0, 23) + '…';
document.getElementById('name').textContent = name;
document.getElementById('rest').textContent =
  new URLSearchParams(location.search).get('mode') === 'view'
    ? '\u00a0is viewing this screen'
    : '\u00a0is controlling this machine · move this mouse to take back';
if (new URLSearchParams(location.search).get('mode') === 'view') {
  const stop = document.getElementById('stop');
  stop.hidden = false;
  stop.onclick = () => window.banner.stop();
}
