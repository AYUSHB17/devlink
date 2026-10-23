'use strict';
// "Run" tab: run a command on a paired device, and decide what other devices may run here.
// Self-contained on purpose. Everything that came from the other device (names, commands, output) is only ever
// written with textContent, never innerHTML.
(() => {
  const api = window.devlink;
  const root = document.getElementById('view-jobs');
  if (!api || !api.jobs || !root) return;
  const jobs = api.jobs;

  let state = null;
  let remote = { peerId: '', enabled: null, workspaces: [], error: '', loading: false };

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
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
  const secs = (ms) => (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');

  // ------------------------------------------------------------ static parts (built once, so typing is never interrupted)
  const peerSel = el('select', { onchange: () => loadWorkspaces() });
  const wsSel = el('select', {});
  const cwdIn = el('input', { placeholder: 'folder inside it (optional)', size: 24, autocomplete: 'off' });
  const cmdIn = el('input', { class: 'grow', placeholder: 'npm test', autocomplete: 'off', spellcheck: 'false' });
  const runBtn = el('button', { class: 'primary', type: 'submit' }, 'Run there');
  const stopBtn = el('button', { type: 'button', class: 'danger', onclick: () => lastSent && call(jobs.cancel(lastSent.id)) }, 'Cancel');
  const note = el('div', { class: 'muted small' });
  const output = el('pre', { class: 'job-output' });
  const targetBox = el('div', { class: 'card' });
  const allowBox = el('label', { class: 'switch' });
  const allow = el('input', { type: 'checkbox', onchange: (e) => call(api.updateSettings({ allowJobs: e.target.checked })) });
  allowBox.append(allow, ' Let paired devices run programs on this machine (you approve each one here)');
  const wsList = el('div', { class: 'list' });
  const runningList = el('div', { class: 'list' });
  const auditList = el('div', { class: 'list' });
  const hereBox = el('div', { class: 'card col' });

  const form = el('form', { class: 'col' },
    el('div', { class: 'row' }, el('label', {}, 'Device ', peerSel), el('label', {}, 'Workspace ', wsSel), el('button', { type: 'button', onclick: () => loadWorkspaces() }, 'Refresh'), cwdIn),
    el('div', { class: 'row' }, cmdIn, runBtn, stopBtn),
    note);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const peer = peerSel.value;
    if (!peer) return toast('No device is connected', true);
    if (!wsSel.value) return toast('Pick a workspace (the other device must add one under Run → Allow jobs)', true);
    if (!cmdIn.value.trim()) return;
    if (await call(jobs.run(peer, wsSel.value, cwdIn.value.trim(), cmdIn.value))) toast('Sent – waiting for approval on the other device');
  };
  targetBox.append(el('h2', {}, 'Run on another device'), form, output);
  hereBox.append(
    el('h2', {}, 'Let other devices run jobs here'),
    allowBox,
    el('div', { class: 'muted small' }, 'A job runs as your user account on this machine. It is not sandboxed and its CPU and memory are not limited. It only gets a fixed set of environment variables (no tokens), is stopped after its time limit or 4 MB of output, and ends if the connection drops.'),
    el('h3', {}, 'Workspaces (folders a job may run in)'),
    wsList,
    el('div', { class: 'row' }, el('button', { onclick: () => call(jobs.addWorkspace()) }, 'Add folder…')),
    el('h3', {}, 'Running now'), runningList);
  root.append(
    el('h1', {}, 'Run'),
    el('p', { class: 'muted' }, 'Run a command on the other machine and see its output here. The command is split into words (quotes group them); there is no shell, so pipes, && and wildcards do nothing. Nothing runs until someone at that machine approves it.'),
    targetBox, hereBox, el('h2', {}, 'Recent jobs on this machine'), auditList);

  // ------------------------------------------------------------ approval prompt (this machine's own window)
  const dlg = el('div', { class: 'dialog' });
  const modal = el('div', { id: 'job-consent-modal', class: 'modal hidden' }, dlg);
  document.body.append(modal);
  let shownPrompt = '';

  function renderPrompt(p) {
    if (!p) { shownPrompt = ''; return modal.classList.add('hidden'); }
    if (shownPrompt !== p.id) {
      shownPrompt = p.id;
      const no = el('button', { onclick: () => call(jobs.answer(p.id, 'deny')) }, "Don't run");
      dlg.replaceChildren(
        el('h2', {}, 'Run a program?'),
        el('p', {}, `${p.peer} wants to run this on this machine, in the workspace "${p.workspace}"${p.cwd ? ' / ' + p.cwd : ''}:`),
        el('pre', { class: 'job-output' }, p.command),
        el('p', { class: 'muted small' }, 'It runs as your user account with your files and network. Only allow it if you started it. "Allow for this connection" lets that device run anything in your workspaces until it disconnects or DevLink restarts.'),
        el('div', { class: 'row end' }, no,
          el('button', { onclick: () => call(jobs.answer(p.id, 'once')) }, 'Allow once'),
          el('button', { class: 'primary', onclick: () => call(jobs.answer(p.id, 'session')) }, 'Allow for this connection')));
      // a stray Enter/Space must refuse, not allow
      setTimeout(() => no.focus(), 0);
    }
    modal.classList.remove('hidden');
  }

  // ------------------------------------------------------------ remote workspaces
  async function loadWorkspaces() {
    const peer = peerSel.value;
    remote = { peerId: peer, enabled: null, workspaces: [], error: '', loading: !!peer };
    renderTarget();
    if (!peer) return;
    const r = await jobs.workspaces(peer);
    if (peerSel.value !== peer) return;
    remote.loading = false;
    if (r.ok) { remote.enabled = r.value.enabled; remote.workspaces = r.value.workspaces; } else remote.error = r.error;
    renderTarget();
  }

  let lastSent = null;
  function renderTarget() {
    const sig = JSON.stringify(remote.workspaces);
    if (wsSel.dataset.sig !== sig) {
      const keep = wsSel.value;
      wsSel.dataset.sig = sig;
      wsSel.replaceChildren(...remote.workspaces.map((w) => el('option', { value: w.id }, w.name)));
      if (remote.workspaces.some((w) => w.id === keep)) wsSel.value = keep;
    }
    note.textContent = !peerSel.value ? 'Pair and connect a device first.'
      : remote.loading ? 'Asking the device…'
      : remote.error ? remote.error
      : remote.enabled === false ? 'That device has not turned on "Let paired devices run programs" (Run tab, on that device).'
      : !remote.workspaces.length ? 'That device has no workspace yet. Add a folder under "Let other devices run jobs here" on that device.'
      : '';
    note.className = remote.error || remote.enabled === false ? 'bad small' : 'muted small';
    runBtn.disabled = !remote.workspaces.length;
    const running = lastSent && lastSent.state !== 'done';
    stopBtn.disabled = !running;
    if (lastSent) {
      const r = lastSent.result;
      const status = r ? (r.reason ? r.reason : `exit ${r.code ?? r.signal}`) + ` · ${secs(r.ms)}` : lastSent.state === 'sent' ? 'waiting for approval…' : 'running…';
      output.textContent = `$ ${lastSent.command}   [${lastSent.peer}]\n${lastSent.tail}\n— ${status}`;
      output.scrollTop = output.scrollHeight;
    } else output.textContent = 'Output appears here.';
  }

  function render(s) {
    state = s;
    const j = s.jobs;
    if (!j) return;
    const peers = s.peers.filter((p) => p.online);
    const sig = JSON.stringify(peers.map((p) => [p.id, p.name]));
    if (peerSel.dataset.sig !== sig) {
      const keep = peerSel.value;
      peerSel.dataset.sig = sig;
      peerSel.replaceChildren(...peers.map((p) => el('option', { value: p.id }, p.name)));
      if (peers.some((p) => p.id === keep)) peerSel.value = keep;
      if (peerSel.value !== remote.peerId) loadWorkspaces();
    }
    lastSent = j.sent[0] || null;
    renderTarget();
    if (document.activeElement !== allow) allow.checked = !!j.enabled;
    wsList.replaceChildren(...(j.workspaces.length
      ? j.workspaces.map((w) => el('div', { class: 'item' }, el('span', {}, el('b', {}, w.name), ' ', el('code', {}, w.path)), el('button', { class: 'danger', onclick: () => call(jobs.removeWorkspace(w.id)) }, 'Remove')))
      : [el('div', { class: 'muted small' }, 'None yet. A job can only run inside a folder you add here.')]));
    runningList.replaceChildren(...(j.running.length
      ? j.running.map((r) => el('div', { class: 'item' }, el('span', { class: 'grow' }, el('b', {}, r.peer), ' · ', el('code', {}, r.command)), el('button', { class: 'danger', onclick: () => call(jobs.stop(r.id)) }, 'Stop')))
      : [el('div', { class: 'muted small' }, 'Nothing is running.')]));
    auditList.replaceChildren(...(j.audit.length
      ? j.audit.slice(0, 15).map((e) => el('div', { class: 'item' },
          el('span', { class: 'grow' }, el('b', {}, e.peer), ' · ', el('code', {}, e.command), el('span', { class: 'muted small' }, ` in ${e.workspace}${e.cwd ? '/' + e.cwd : ''}`)),
          el('span', { class: e.code === 0 ? 'ok small' : 'muted small' }, `${e.outcome}${e.code != null ? ' (exit ' + e.code + ')' : ''} · ${new Date(e.ts).toLocaleTimeString()}`)))
      : [el('div', { class: 'muted small' }, 'Nothing has run here yet.')]));
    renderPrompt(j.prompt);
  }

  api.onState(render);
  api.getState().then((r) => r.ok && render(r.value));
})();
