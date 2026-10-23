'use strict';
// Plain DOM code. Peer-supplied strings (device names, file names, clipboard text) are only ever
// written with textContent, never innerHTML.
const api = window.devlink;
let state = null;
let selectedTarget = '';

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const osName = (o) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[o] || o || '');
const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
const fmtUptime = (s) => { const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600); return d ? `${d}d ${hr}h` : `${hr}h ${Math.floor((s % 3600) / 60)}m`; };

let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.background = bad ? 'var(--bad)' : '';
  t.style.color = bad ? '#fff' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
async function call(promise, okMsg) {
  const r = await promise;
  if (!r.ok) { toast(r.error, true); return null; }
  if (okMsg) toast(okMsg);
  return r.value ?? true;
}

// ------------------------------------------------------------ navigation
$('nav').addEventListener('click', (e) => {
  const v = e.target.dataset.view;
  if (!v) return;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b === e.target));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
});

// ------------------------------------------------------------ rendering
function render(s) {
  state = s;
  $('self-name').textContent = s.self.name;
  $('self-meta').textContent = `${osName(s.self.os)} · port ${s.self.port}` + (s.self.ips[0] ? ` · ${s.self.ips[0].address}` : '');
  $('self-fp').textContent = s.self.fingerprint;
  renderPeers(s);
  renderDiscovered(s);
  renderClipboard(s);
  renderFiles(s);
  renderPorts(s);
  renderShortcuts(s);
  renderSettings(s);
  renderScreens(s);
  renderConsent(s);
  renderSharing(s);
  renderModal(s);
  $('pairing-state').textContent = s.pairing.enabled ? 'Pairing is on – this device can be paired for the next ' + Math.max(1, Math.round((s.pairing.until - Date.now()) / 1000)) + ' s' : '';
  $('btn-allow').textContent = s.pairing.enabled ? 'Stop allowing pairing' : 'Allow pairing for 2 minutes';
}

function renderPeers(s) {
  const box = $('peers');
  box.replaceChildren(
    ...(s.peers.length
      ? s.peers.map((p) => {
          const st = p.status;
          return h('div', { class: 'item peer' },
            h('div', { class: 'peer-head' },
              h('span', { class: 'dot' + (p.online ? ' on' : '') }),
              h('b', {}, p.name), h('span', { class: 'muted' }, osName(p.os)),
              h('span', { class: 'muted small grow' }, p.online ? 'connected' : 'offline – retrying' + (p.address ? ' (' + p.address + ')' : '')),
              h('code', {}, p.fingerprint)),
            st && p.online ? h('div', { class: 'chips' },
              h('span', { class: 'chip' }, `up ${fmtUptime(st.uptime)}`),
              h('span', { class: 'chip' }, `RAM ${fmtBytes(st.memTotal - st.memFree)} / ${fmtBytes(st.memTotal)}`),
              h('span', { class: 'chip' }, `${st.cpus} cores`),
              h('span', { class: 'chip' }, st.ips.join(', ') || 'no LAN IP'),
              Object.entries(st.tools).filter(([, v]) => v).map(([k, v]) => h('span', { class: 'chip' }, `${k} ${v}`))) : null,
            h('div', { class: 'row' },
              h('button', { disabled: !p.online, onclick: () => call(api.pickAndSend(p.id, false)) }, 'Send files…'),
              h('button', { disabled: !p.online, onclick: () => call(api.pickAndSend(p.id, true)) }, 'Send folder…'),
              h('button', { disabled: !p.online, onclick: () => call(api.pushClipboard(p.id), 'Clipboard sent') }, 'Push clipboard'),
              h('button', { disabled: !p.online, onclick: () => call(api.viewScreen(p.id)) }, 'View screen'),
              h('button', { disabled: !p.online, title: 'Send one file and open it there', onclick: () => call(api.pickAndSendOpen(p.id)) }, 'Send & open…'),
              h('button', { class: 'danger', onclick: () => { if (confirm(`Forget ${p.name}? You will need to pair again.`)) call(api.unpair(p.id)); } }, 'Unpair')));
        })
      : [h('div', { class: 'muted' }, 'No paired devices yet. Pair one below.')]));
}

function renderDiscovered(s) {
  $('discovered').replaceChildren(
    ...(s.discovered.length
      ? s.discovered.map((d) => h('div', { class: 'item' },
          h('span', {}, h('b', {}, d.name), ' ', h('span', { class: 'muted' }, `${osName(d.os)} · ${d.host}:${d.port}`)),
          d.paired ? h('span', { class: 'muted' }, 'already paired')
            : h('button', { onclick: () => doPair(d.host, d.port) }, 'Pair')))
      : [h('div', { class: 'muted small' }, 'Nothing found yet. Open DevLink on the other machine, keep both on the same network, or enter an address.')]));
}

async function doPair(host, port) {
  toast('Contacting device…');
  const name = await call(api.pairWith(host, port));
  if (name) toast('Paired with ' + name);
}

function renderClipboard(s) {
  $('clip-log').replaceChildren(
    ...(s.clipboardLog.length
      ? s.clipboardLog.map((e) => h('div', { class: 'item' },
          h('span', {}, h('span', { class: e.dir === 'in' ? 'ok' : 'muted' }, e.dir === 'in' ? '⬇ from ' : '⬆ to '), e.peer, ' – ', e.preview),
          h('span', { class: 'muted small' }, new Date(e.ts).toLocaleTimeString())))
      : [h('div', { class: 'muted' }, 'Nothing synced yet.')]));
}

function syncSelect(sel, options, keep) {
  const sig = JSON.stringify(options);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren(...options.map(([v, label]) => h('option', { value: v }, label)));
  if (keep && options.some(([v]) => v === keep)) sel.value = keep;
}

function renderFiles(s) {
  const opts = s.peers.map((p) => [p.id, p.name + (p.online ? '' : ' (offline)')]);
  syncSelect($('file-target'), opts, selectedTarget);
  selectedTarget = $('file-target').value;
  $('transfers').replaceChildren(
    ...(s.transfers.length
      ? s.transfers.map((t) => h('div', { class: 'item' },
          h('div', { class: 'grow' },
            h('div', {}, t.dir === 'out' ? '⬆ ' : '⬇ ', h('b', {}, t.name), h('span', { class: 'muted' }, ` ${t.dir === 'out' ? 'to' : 'from'} ${t.peerName} · ${t.filesDone}/${t.files} files · ${fmtBytes(t.bytesDone)} / ${fmtBytes(t.bytes)}`)),
            t.state === 'active' ? (() => { const b = h('div', { class: 'bar' }, h('div', {})); b.firstChild.style.width = (t.bytes ? Math.min(100, (t.bytesDone / t.bytes) * 100) : 100) + '%'; return b; })() : null,
            t.state === 'error' ? h('div', { class: 'bad small' }, t.error) : null),
          t.state === 'done' ? h('span', { class: 'ok' }, 'done') : null,
          t.dir === 'in' && t.path ? h('button', { onclick: () => call(api.reveal(t.path)) }, 'Show') : null))
      : [h('div', { class: 'muted' }, 'No transfers yet.')]));
}

function renderPorts(s) {
  syncSelect($('fwd-peer'), s.peers.map((p) => [p.id, p.name]), $('fwd-peer').value);
  $('forwards').replaceChildren(
    ...(s.forwards.length
      ? s.forwards.map((f) => h('div', { class: 'item' },
          h('span', {}, h('code', {}, `localhost:${f.listenPort}`), ' → ', h('b', {}, f.peerName), ' ', h('code', {}, `localhost:${f.remotePort}`), ' ',
            f.error ? h('span', { class: 'bad small' }, f.error) : f.enabled && f.listening ? h('span', { class: 'ok small' }, `listening · ${f.connections} open`) : h('span', { class: 'muted small' }, 'off')),
          h('span', { class: 'row' },
            h('button', { onclick: () => call(api.openLocal(f.listenPort)) }, 'Open in browser'),
            h('button', { onclick: () => call(api.toggleForward(f.id, !f.enabled)) }, f.enabled ? 'Disable' : 'Enable'),
            h('button', { class: 'danger', onclick: () => call(api.removeForward(f.id)) }, 'Remove'))))
      : [h('div', { class: 'muted' }, 'No forwards yet.')]));
}

function renderShortcuts(s) {
  const run = (cmd) => call(api.runCommand(cmd));
  // The status comes from the other device, so re-check it before it becomes a terminal command.
  const safeSsh = (p) => {
    const st = p.status;
    const ip = st && Array.isArray(st.ips) ? st.ips[0] : '';
    const ok = typeof st?.username === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(st.username) && typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
    return ok ? `ssh ${st.username}@${ip}` : null;
  };
  const sshPeers = s.peers.map((p) => ({ p, cmd: safeSsh(p) })).filter((x) => x.cmd);
  $('suggested').replaceChildren(
    ...(sshPeers.length
      ? sshPeers.map(({ p, cmd }) => {
          return h('div', { class: 'item' },
            h('span', {}, `SSH into ${p.name}  `, h('code', {}, cmd)),
            h('span', { class: 'row' }, h('button', { onclick: () => run(cmd) }, 'Open terminal'), h('button', { onclick: () => call(api.copy(cmd), 'Copied') }, 'Copy')));
        })
      : [h('div', { class: 'muted small' }, 'Connect a device to get SSH suggestions. The other machine needs Remote Login (macOS) or the OpenSSH Server (Windows) enabled.')]));
  $('shortcuts').replaceChildren(
    ...(s.shortcuts.length
      ? s.shortcuts.map((x) => h('div', { class: 'item' },
          h('span', {}, h('b', {}, x.label), '  ', h('code', {}, x.command)),
          h('span', { class: 'row' }, h('button', { onclick: () => run(x.command) }, 'Run'), h('button', { class: 'danger', onclick: () => call(api.removeShortcut(x.id)) }, 'Delete'))))
      : [h('div', { class: 'muted' }, 'No saved shortcuts.')]));
}

function setIfIdle(id, value, prop = 'value') {
  const el = $(id);
  if (document.activeElement !== el && el[prop] !== value) el[prop] = value;
}
function renderSettings(s) {
  const st = s.settings;
  setIfIdle('set-clipboardSync', st.clipboardSync, 'checked');
  setIfIdle('set-clipboardImages', st.clipboardImages, 'checked');
  setIfIdle('set-acceptFiles', st.acceptFiles, 'checked');
  setIfIdle('set-allowForwarding', st.allowForwarding, 'checked');
  setIfIdle('set-deviceName', st.deviceName);
  setIfIdle('set-listenPort', String(st.listenPort));
  $('set-downloads').textContent = st.downloadsDir;
}

const SIDE_LABEL = { left: 'left of', right: 'right of', top: 'above', bottom: 'below' };
function renderScreens(s) {
  const inp = s.input;
  const st = s.settings;
  for (const k of ['inputSharing', 'allowRemoteInput', 'clipboardOnCross', 'edgeDrop', 'swapCmdCtrl', 'invertScroll']) setIfIdle('set-' + k, !!st[k], 'checked');
  setIfIdle('set-pointerScale', String(st.pointerScale ?? 1));

  const lines = [];
  if (!st.inputSharing && !st.allowRemoteInput) lines.push(h('div', { class: 'muted' }, 'Shared mouse & keyboard is off. Turn on the options below on both machines.'));
  else if (!inp.helper.running && inp.helper.error) lines.push(h('div', { class: 'bad' }, inp.helper.error));
  else if (!inp.helper.running) lines.push(h('div', { class: 'muted' }, 'Arrange a connected device below to start.'));
  if (inp.helper.platform === 'macos' && inp.helper.running && (!inp.helper.accessibility || !inp.helper.inputMonitoring))
    lines.push(h('div', { class: 'row' },
      h('span', { class: 'bad' }, 'macOS needs permission: ' + [!inp.helper.accessibility && 'Accessibility', !inp.helper.inputMonitoring && 'Input Monitoring'].filter(Boolean).join(' and ')),
      !inp.helper.accessibility && h('button', { onclick: () => call(api.openPrivacy('accessibility')) }, 'Open Accessibility'),
      !inp.helper.inputMonitoring && h('button', { onclick: () => call(api.openPrivacy('input')) }, 'Open Input Monitoring')),
      h('div', { class: 'muted small' }, 'Add DevLink (or Terminal, if you started it with npm start), switch it on, then restart DevLink.'));
  if (inp.mode === 'leading') lines.push(h('div', { class: 'ok' }, `Your mouse and keyboard are controlling ${inp.peer}.`));
  if (inp.mode === 'following') lines.push(h('div', { class: 'ok' }, `${inp.peer} is controlling this machine.`));
  const permsOk = inp.helper.platform !== 'macos' || (inp.helper.accessibility && inp.helper.inputMonitoring);
  if (inp.helper.running && !inp.helper.error && permsOk && inp.mode === 'local') lines.push(h('div', { class: 'muted' }, 'Ready. Move the cursor off the shared edge to cross over.'));
  if (inp.notice) lines.push(h('div', { class: 'muted small' }, inp.notice));
  $('screen-status').replaceChildren(...lines);

  $('layout').replaceChildren(
    ...(s.peers.length
      ? s.peers.map((p) => {
          const side = st.inputLayout?.[p.id] || '';
          const allows = inp.peerAllows[p.id];
          const sugg = inp.layoutSuggestions && inp.layoutSuggestions[p.id];
          const sel = h('select', { onchange: (e) => call(api.setLayout(p.id, e.target.value || null)) },
            h('option', { value: '' }, 'not arranged'),
            ...Object.entries(SIDE_LABEL).map(([v, label]) => h('option', { value: v }, label)));
          sel.value = side;
          return h('div', { class: 'item' },
            h('span', { class: 'row' }, h('span', { class: 'dot' + (p.online ? ' on' : '') }), h('b', {}, p.name), ' is ', sel, ' this machine'),
            sugg ? h('span', { class: 'row' }, h('span', { class: 'small' }, `${p.name} says it is ${SIDE_LABEL[sugg]} this machine`),
              h('button', { onclick: () => call(api.setLayout(p.id, sugg)) }, 'Use this')) : null,
            h('span', { class: 'muted small' }, !p.online ? 'offline' : allows === true ? 'allows control' : 'does not allow control yet'));
        })
      : [h('div', { class: 'muted' }, 'Pair a device first.')]));
}

function renderSharing(s) {
  const sc = s.screen || { sharingTo: [], viewing: [], prompt: null };
  // who is viewing this screen
  $('sharing-status').replaceChildren(
    ...(sc.sharingTo.length
      ? [h('div', { class: 'card row' },
          h('span', { class: 'bad grow' }, `${sc.sharingTo.map((x) => x.peer).join(', ')} ${sc.sharingTo.length > 1 ? 'are' : 'is'} viewing this screen`),
          h('button', { class: 'primary', onclick: () => call(api.stopScreenSharing()) }, 'Stop sharing'))]
      : []));
  // screen consent prompt
  const m = $('screen-consent-modal');
  if (sc.prompt) {
    $('screen-consent-text').textContent = `${sc.prompt.name} wants to see this screen.`;
    // a stray Enter/Space must refuse, not allow
    if (m.classList.contains('hidden')) setTimeout(() => $('screen-consent-no').focus(), 0);
    m.classList.remove('hidden');
  } else m.classList.add('hidden');
  // links
  const opts = s.peers.filter((p) => p.online).map((p) => [p.id, p.name]);
  syncSelect($('link-peer'), opts, $('link-peer').value);
  $('link-log').replaceChildren(
    ...(s.links || []).slice(0, 15).map((e) => h('div', { class: 'item' },
      h('span', { class: 'grow' }, h('span', { class: e.dir === 'in' ? 'ok' : 'muted' }, e.dir === 'in' ? '⬇ from ' : '⬆ to '), e.peer, ' – ', e.url),
      h('span', { class: e.state === 'refused' ? 'bad small' : 'muted small' }, e.state === 'refused' ? e.note || 'refused' : e.state))));
  // settings extras
  for (const k of ['acceptLinks', 'openSentFiles', 'allowScreenView', 'browserBridge']) setIfIdle('set-' + k, !!s.settings[k], 'checked');
  $('tab-hotkey').textContent = s.self.os === 'macOS' ? 'Cmd+Option+Shift+L' : 'Ctrl+Alt+Shift+L';
  $('screen-perm').replaceChildren(
    ...(s.self.os === 'macOS' && s.settings.allowScreenView
      ? [h('span', { class: 'muted' }, 'macOS also needs Screen Recording permission for Electron.'), h('button', { onclick: () => call(api.openScreenPrivacy()) }, 'Open Screen Recording')]
      : []));
  const b = s.bridge || {};
  $('bridge-info').replaceChildren(
    ...(s.settings.browserBridge
      ? [h('div', { class: b.running ? 'ok' : 'bad' }, b.running ? `Listening on 127.0.0.1:${b.port}` : b.error || 'not running'),
         h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Extension token:'), h('code', {}, s.settings.browserBridgeToken),
           h('button', { onclick: () => call(api.copy(s.settings.browserBridgeToken), 'Token copied') }, 'Copy'),
           h('button', { onclick: () => call(api.newBridgeToken(), 'New token – paste it into the extension again') }, 'New token')),
         h('div', { class: 'muted' }, 'Install the extension from the project folder: chrome://extensions (or edge://extensions) → Developer mode → Load unpacked → choose devlink/extension, then paste this token in its options.')]
      : []));
}
$('screen-consent-yes').onclick = () => call(api.answerScreenConsent(true));
$('screen-consent-no').onclick = () => call(api.answerScreenConsent(false));
$('link-form').onsubmit = async (e) => {
  e.preventDefault();
  const peer = $('link-peer').value;
  if (!peer) return toast('No device is connected', true);
  if (await call(api.sendLink(peer, $('link-url').value.trim()), 'Link sent')) $('link-url').value = '';
};

function renderConsent(s) {
  const p = s.input && s.input.consentPrompt;
  const m = $('consent-modal');
  if (!p) return m.classList.add('hidden');
  $('consent-text').textContent = `${p.name} is trying to move its mouse and keyboard onto this machine.`;
  if (m.classList.contains('hidden')) setTimeout(() => $('consent-no').focus(), 0);
  m.classList.remove('hidden');
}
$('consent-yes').onclick = () => call(api.answerConsent(true));
$('consent-no').onclick = () => call(api.answerConsent(false));

function renderModal(s) {
  const m = $('modal');
  if (!s.pairPrompt) return m.classList.add('hidden');
  $('modal-text').textContent = `${s.pairPrompt.peer.name} (${osName(s.pairPrompt.peer.os)}) wants to pair. Device fingerprint ${s.pairPrompt.peer.fingerprint}.`;
  $('modal-code').textContent = s.pairPrompt.sas.slice(0, 3) + ' ' + s.pairPrompt.sas.slice(3);
  m.classList.remove('hidden');
}

// ------------------------------------------------------------ events
$('btn-allow').onclick = () => call(state && state.pairing.enabled ? api.stopPairing() : api.startPairing());
$('manual-pair').onsubmit = (e) => { e.preventDefault(); doPair($('pair-host').value.trim(), parseInt($('pair-port').value, 10)); };
$('modal-yes').onclick = () => call(api.answerPair(true));
$('modal-no').onclick = () => call(api.answerPair(false));
$('file-target').onchange = (e) => (selectedTarget = e.target.value);
$('btn-send-files').onclick = () => selectedTarget ? call(api.pickAndSend(selectedTarget, false)) : toast('Pair a device first', true);
$('btn-send-folder').onclick = () => selectedTarget ? call(api.pickAndSend(selectedTarget, true)) : toast('Pair a device first', true);
$('btn-open-downloads').onclick = () => call(api.reveal(state.settings.downloadsDir));
$('fwd-form').onsubmit = async (e) => {
  e.preventDefault();
  const ok = await call(api.addForward($('fwd-peer').value, parseInt($('fwd-local').value, 10), parseInt($('fwd-remote').value, 10)));
  if (ok) { $('fwd-local').value = ''; $('fwd-remote').value = ''; }
};
$('shortcut-form').onsubmit = async (e) => {
  e.preventDefault();
  if (await call(api.saveShortcut($('sc-label').value, $('sc-command').value))) { $('sc-label').value = ''; $('sc-command').value = ''; }
};
for (const key of ['clipboardSync', 'clipboardImages', 'acceptFiles', 'allowForwarding', 'inputSharing', 'allowRemoteInput', 'clipboardOnCross', 'edgeDrop', 'swapCmdCtrl', 'invertScroll', 'acceptLinks', 'openSentFiles', 'allowScreenView', 'browserBridge'])
  $('set-' + key).onchange = (e) => call(api.updateSettings({ [key]: e.target.checked }));
$('set-deviceName').onchange = (e) => e.target.value.trim() && call(api.updateSettings({ deviceName: e.target.value.trim() }), 'Saved – restart to re-announce the new name');
$('set-pointerScale').onchange = (e) => { const n = parseFloat(e.target.value); if (n >= 0.25 && n <= 4) call(api.updateSettings({ pointerScale: n })); };
$('set-listenPort').onchange = (e) => { const n = parseInt(e.target.value, 10); if (n >= 0 && n < 65536) call(api.updateSettings({ listenPort: n }), 'Saved – restart DevLink to apply'); };
$('btn-downloads').onclick = () => call(api.chooseDownloads());

// drag & drop anywhere in the window
const drop = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('over'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const online = state.peers.filter((p) => p.online);
  const target = online.find((p) => p.id === selectedTarget) || (online.length === 1 ? online[0] : null);
  if (!target) return toast('Pick an online device in the Files tab first', true);
  if (await call(api.sendPaths(target.id, paths))) toast(`Sending ${paths.length} item(s) to ${target.name}`);
});

api.onState(render);
api.getState().then((r) => r.ok && render(r.value));
// keep the pairing countdown fresh
setInterval(() => state && state.pairing.enabled && render({ ...state }), 1000);
