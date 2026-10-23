// Shared helpers: talk to the DevLink app's local bridge (127.0.0.1 only, token from DevLink Settings).
export async function config() {
  const { token = '', port = 47823 } = await chrome.storage.local.get(['token', 'port']);
  return { token, port };
}

export async function call(path, body) {
  const { token, port } = await config();
  if (!token) throw new Error('Open the extension options and paste the token from DevLink → Settings.');
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-devlink-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('DevLink is not running, or "Browser extension" is off in its Settings.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `DevLink answered ${res.status}`);
  return data;
}

export const webUrl = (u) => /^https?:\/\//i.test(u || '');
