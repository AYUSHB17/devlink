'use strict';
// Edge drop target: files dropped here go to the device on this side of the screen.
const q = new URLSearchParams(location.search);
const peer = q.get('peer');
const side = q.get('side');
document.body.className = (side === 'left' || side === 'right' ? 'vertical ' : '') + side;
document.getElementById('label').textContent = `Drop to send to ${q.get('name') || 'device'}`;
const bar = document.getElementById('bar');
window.addEventListener('dragover', (e) => { e.preventDefault(); bar.classList.add('hot'); });
window.addEventListener('dragleave', () => bar.classList.remove('hot'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  bar.classList.remove('hot');
  const paths = [...e.dataTransfer.files].map((f) => window.devlink.pathForFile(f)).filter(Boolean);
  if (paths.length && peer) {
    document.getElementById('label').textContent = `Sending ${paths.length} item(s)…`;
    await window.devlink.sendPaths(peer, paths);
  }
});
