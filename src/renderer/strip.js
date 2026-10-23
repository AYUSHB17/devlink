'use strict';
// Edge drop target: files dropped here go to the device on this side of the screen.
// A short hover is required, so a drag that merely passes over the edge doesn't send anything.
const DWELL_MS = 400;
const q = new URLSearchParams(location.search);
const side = q.get('side');
const label = document.getElementById('label');
const bar = document.getElementById('bar');
const idle = `Drop to send to ${q.get('name') || 'device'}`;
document.body.className = (side === 'left' || side === 'right' ? 'vertical ' : '') + side;
label.textContent = idle;
let enteredAt = 0;
let armTimer;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!enteredAt) {
    enteredAt = Date.now();
    armTimer = setTimeout(() => bar.classList.add('hot'), DWELL_MS);
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  enteredAt = 0;
  clearTimeout(armTimer);
  bar.classList.remove('hot');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const armed = enteredAt && Date.now() - enteredAt >= DWELL_MS;
  enteredAt = 0;
  clearTimeout(armTimer);
  bar.classList.remove('hot');
  if (!armed) {
    label.textContent = 'Hold over the edge a moment to send';
    setTimeout(() => (label.textContent = idle), 1500);
    return;
  }
  const paths = [...e.dataTransfer.files].map((f) => window.strip.pathForFile(f)).filter(Boolean);
  if (!paths.length) {
    // a link, or a URL dragged from a browser's address bar
    const list = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//i.test(l));
    if (!list.length) return;
    label.textContent = `Opening ${list.length} link(s) there…`;
    const r = await window.strip.dropLinks(list);
    if (!r.ok) label.textContent = r.error;
    return;
  }
  label.textContent = `Sending ${paths.length} item(s)…`;
  const r = await window.strip.drop(paths);
  if (!r.ok) label.textContent = r.error;
});
