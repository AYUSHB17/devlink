'use strict';
let name = new URLSearchParams(location.search).get('name') || 'Another device';
if (name.length > 24) name = name.slice(0, 23) + '…';
document.getElementById('name').textContent = name;
const mode = new URLSearchParams(location.search).get('mode');
let viewer = new URLSearchParams(location.search).get('viewer') || '';
if (viewer.length > 24) viewer = viewer.slice(0, 23) + '…';
document.getElementById('rest').textContent = mode === 'both' && viewer && viewer !== name
  ? `\u00a0is controlling · ${viewer} is viewing this machine`
  : {
  view: '\u00a0is viewing this screen',
  both: '\u00a0is controlling and viewing this machine',
}[mode] || '\u00a0is controlling this machine · move this mouse to take back';
if (mode === 'view' || mode === 'both') {
  const stop = document.getElementById('stop');
  stop.hidden = false;
  stop.onclick = () => window.banner.stop();
}
