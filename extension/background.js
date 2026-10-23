import { call, webUrl } from './devlink.js';

// Right-click menu: send this page / this link to the other computer (the only connected one,
// or the one chosen last in the popup).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'page', title: 'Send this tab to my other computer', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'link', title: 'Open this link on my other computer', contexts: ['link'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'link' ? info.linkUrl : tab && tab.url;
  if (!webUrl(url)) return;
  const { device = '' } = await chrome.storage.local.get('device');
  try {
    await call('/v1/send', { device: device || undefined, urls: [url] });
    chrome.action.setBadgeText({ text: '✓' });
  } catch (e) {
    console.warn('DevLink:', e.message);
    chrome.action.setBadgeText({ text: '!' });
  }
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
});
