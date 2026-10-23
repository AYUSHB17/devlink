import { call, webUrl } from './devlink.js';

const $ = (id) => document.getElementById(id);
const status = (text, cls = 'muted') => { $('status').textContent = text; $('status').className = cls; };
$('options').onclick = () => chrome.runtime.openOptionsPage();

async function send(urls) {
  urls = urls.filter(webUrl);
  if (!urls.length) return status('Nothing to send (only http/https pages).', 'bad');
  try {
    const r = await call('/v1/send', { device: $('device').value, urls });
    status(`Sent ${r.sent} to ${$('device').selectedOptions[0].textContent}.`, 'ok');
  } catch (e) {
    status(e.message, 'bad');
  }
}

(async () => {
  try {
    const { devices } = await call('/v1/devices');
    if (!devices.length) return status('No other computer is connected in DevLink.', 'bad');
    const { device = '' } = await chrome.storage.local.get('device');
    for (const d of devices) $('device').append(new Option(`${d.name} (${d.os})`, d.id));
    if (devices.some((d) => d.id === device)) $('device').value = device;
    $('device').onchange = () => chrome.storage.local.set({ device: $('device').value });
    $('pick').hidden = devices.length < 2;
    $('actions').hidden = false;
    status(devices.length === 1 ? `Connected to ${devices[0].name}` : 'Choose a computer');
  } catch (e) {
    status(e.message, 'bad');
  }
})();

$('tab').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  send([tab && tab.url]);
};
$('all').onclick = async () => send((await chrome.tabs.query({ currentWindow: true })).map((t) => t.url));
