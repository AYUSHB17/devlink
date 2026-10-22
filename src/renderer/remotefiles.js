'use strict';
// "Remote files" tab: share folders from this device, browse and edit folders shared by a paired device.
// Self-contained on purpose. Everything that came from the other device (names, paths, errors) is only ever
// written with textContent, never innerHTML.
(() => {
  const api = window.devlink;
  const root = document.getElementById('view-remotefiles');
  if (!api || !api.rfs || !root) return;
  const rfs = api.rfs;

  let state = null;
  let peerId = '';
  let remote = { peerId: '', shares: null, share: '', path: '', entries: null, error: '', loading: false };
  let typing = false; // do not rebuild the UI while a field has focus
  let activityOpen = false;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') e[k] = !!v;
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const toast = (msg, bad) => {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    t.style.background = bad ? 'var(--bad)' : '';
    t.style.color = bad ? '#fff' : '';
    setTimeout(() => t.classList.add('hidden'), 3500);
  };
  async function call(promise, okMsg) {
    const r = await promise;
    if (!r.ok) { toast(r.error, true); return null; }
    if (okMsg) toast(okMsg);
    return r.value ?? true;
  }
  const fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
  const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const join = (a, b) => (a ? a + '/' + b : b);
  const parent = (p) => p.split('/').slice(0, -1).join('/');

  // ------------------------------------------------------------ this device: what I share

  function mine(rf) {
    return el('div', { class: 'card' },
      el('h2', {}, 'Share my folders'),
      el('p', { class: 'muted small' }, 'Paired devices can browse the folders you share here, and edit them only if you allow it. Nothing is shared until you switch this on and add a folder. Your home folder, whole drives and credential folders (.ssh, .aws, …) can never be shared.'),
      el('label', { class: 'switch' },
        el('input', { type: 'checkbox', checked: rf.enabled, onchange: (e) => call(rfs.enable(e.target.checked)) }),
        ' Let paired devices browse the folders I share'),
      el('div', { class: 'list' },
        rf.shares.length
          ? rf.shares.map((s) => el('div', { class: 'item' },
              el('span', {}, el('b', {}, s.name), '  ', el('span', { class: 'muted small' }, s.path)),
              el('span', { class: 'row' },
                el('label', { class: 'small' }, el('input', { type: 'checkbox', checked: s.writable, onchange: (e) => call(rfs.setWritable(s.id, e.target.checked)) }), ' Allow editing'),
                el('button', { class: 'danger', onclick: () => call(rfs.unshare(s.id)) }, 'Stop sharing'))))
          : el('div', { class: 'muted' }, 'No folders shared yet.')),
      el('div', { class: 'row' },
        el('button', { onclick: () => call(rfs.share(false), 'Folder shared (read-only)') }, 'Share a folder…'),
        el('button', { onclick: () => { if (confirm('Devices you paired will be able to change files in this folder. Continue?')) call(rfs.share(true), 'Folder shared (editable)'); } }, 'Share an editable folder…')),
      rf.activity.length
        ? el('details', { open: activityOpen, ontoggle: (e) => { activityOpen = e.target.open; } }, el('summary', { class: 'small' }, `Recent access by other devices (${rf.activity.length})`),
            el('div', { class: 'list' }, rf.activity.map((a) => el('div', { class: 'item small' },
              el('span', {}, `${a.peer}: ${a.op} `, el('code', {}, `${a.share}/${a.path}`), a.ok ? '' : '  (refused)'),
              el('span', { class: 'muted' }, ago(a.ts))))))
        : null);
  }

  // ------------------------------------------------------------ other devices: browse

  async function loadShares() {
    remote = { peerId, shares: null, share: '', path: '', entries: null, error: '', loading: true };
    draw();
    const r = await rfs.shares(peerId);
    if (remote.peerId !== peerId) return;
    remote.loading = false;
    if (!r.ok) remote.error = r.error;
    else { remote.shares = r.value; if (r.value.length) remote.share = r.value[0].id; }
    draw();
    if (remote.share) openDir('');
  }
  async function openDir(p) {
    remote.loading = true; remote.error = '';
    draw();
    const asked = { peerId, share: remote.share };
    const r = await rfs.list(peerId, remote.share, p);
    if (asked.peerId !== peerId || asked.share !== remote.share) return;
    remote.loading = false;
    if (!r.ok) remote.error = r.error;
    else { remote.entries = r.value; remote.path = p; }
    draw();
  }

  function browse(s) {
    const peers = s.peers;
    if (!peers.some((p) => p.id === peerId)) peerId = (peers.find((p) => p.online) || peers[0] || {}).id || '';
    const cur = peers.find((p) => p.id === peerId);
    const sh = (remote.shares || []).find((x) => x.id === remote.share);
    return el('div', { class: 'card' },
      el('h2', {}, 'Browse another device'),
      peers.length
        ? el('div', { class: 'row' },
            el('label', {}, 'Device ', el('select', { onchange: (e) => { peerId = e.target.value; remote.shares = null; remote.entries = null; remote.error = ''; draw(); } },
              peers.map((p) => el('option', { value: p.id, selected: p.id === peerId }, p.name + (p.online ? '' : ' (offline)'))))),
            el('button', { disabled: !cur || !cur.online, onclick: loadShares }, remote.shares ? 'Refresh shares' : 'Connect'),
            remote.shares && remote.shares.length
              ? el('label', {}, 'Folder ', el('select', { onchange: (e) => { remote.share = e.target.value; openDir(''); } },
                  remote.shares.map((x) => el('option', { value: x.id, selected: x.id === remote.share }, x.name + (x.writable ? ' (editable)' : ' (read-only)')))))
              : null)
        : el('div', { class: 'muted' }, 'Pair a device first.'),
      remote.loading ? el('div', { class: 'muted small' }, 'Loading…') : null,
      remote.error ? el('div', { class: 'error' }, remote.error) : null,
      remote.shares && !remote.shares.length ? el('div', { class: 'muted' }, 'That device is not sharing any folders.') : null,
      remote.entries
        ? el('div', {},
            el('div', { class: 'row small' },
              el('button', { disabled: !remote.path, onclick: () => openDir(parent(remote.path)) }, '↑ Up'),
              el('code', {}, '/' + remote.path)),
            el('div', { class: 'list' },
              remote.entries.length
                ? remote.entries.map((e) => e.type === 'dir'
                    ? el('div', { class: 'item' }, el('a', { href: '#', class: 'dirlink', onclick: (ev) => { ev.preventDefault(); openDir(join(remote.path, e.name)); } }, '📁 ' + e.name), el('span'))
                    : el('div', { class: 'item' },
                        el('span', {}, e.name, '  ', el('span', { class: 'muted small' }, fmtBytes(e.size))),
                        el('span', { class: 'row' },
                          el('button', { onclick: () => call(rfs.copy(peerId, remote.share, join(remote.path, e.name)), 'Copied to your Downloads folder') }, 'Copy here'),
                          sh && sh.writable ? el('button', { class: 'primary', onclick: () => call(rfs.edit(peerId, remote.share, join(remote.path, e.name)), 'Opened. Saving in your editor sends changes back.') }, 'Edit') : null)))
                : el('div', { class: 'muted' }, 'Empty folder.')))
        : null);
  }

  function edits(rf) {
    if (!rf.edits || !rf.edits.length) return null;
    return el('div', { class: 'card' },
      el('h2', {}, 'Files you are editing'),
      el('p', { class: 'muted small' }, 'Each save in your editor is sent back to the other device. A save is refused, and your copy kept, if the file changed there in the meantime.'),
      el('div', { class: 'list' }, rf.edits.map((x) => el('div', { class: 'item' },
        el('span', {}, el('b', {}, x.name), '  ', el('span', { class: 'muted small' }, `on ${x.peerName}`), '  ',
          el('span', { class: x.state === 'error' ? 'error small' : 'muted small' },
            x.state === 'saving' ? 'saving…' : x.state === 'saved' ? 'saved ' + ago(x.ts) : x.state === 'error' ? 'not saved: ' + x.error : 'open')),
        el('button', { onclick: () => call(rfs.stopEdit(x.id), 'Stopped') }, 'Stop editing')))));
  }

  function draw() {
    if (!state || !state.remotefs || typing) return;
    root.replaceChildren(
      el('h1', {}, 'Remote files'),
      browse(state),
      edits(state.remotefs),
      mine(state.remotefs));
  }

  root.addEventListener('focusin', (e) => { typing = e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type === 'text'; });
  root.addEventListener('focusout', () => { typing = false; });
  api.onState((s) => { state = s; draw(); });
  api.getState().then((r) => { if (r.ok) { state = r.value; draw(); } });
})();
