import { call, config } from './devlink.js';

const $ = (id) => document.getElementById(id);
config().then(({ token, port }) => { $('token').value = token; $('port').value = port; });
$('save').onclick = async () => {
  const port = parseInt($('port').value, 10) || 47823;
  await chrome.storage.local.set({ token: $('token').value.trim(), port });
  try {
    const { self, devices } = await call('/v1/devices');
    $('status').textContent = `Connected to DevLink on ${self}. Devices online: ${devices.map((d) => d.name).join(', ') || 'none'}`;
    $('status').className = 'ok';
  } catch (e) {
    $('status').textContent = e.message;
    $('status').className = 'bad';
  }
};
