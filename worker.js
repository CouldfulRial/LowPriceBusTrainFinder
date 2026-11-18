chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const existing = await chrome.tabs.query({url});
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, {active: true});
    await chrome.windows.update(existing[0].windowId, {focused: true});
  } else {
    await chrome.tabs.create({url});
  }
});

// Close only the temporary train tab owned by a dashboard that was closed.
chrome.tabs.onRemoved.addListener(async (id) => {
  const {trainHelper} = await chrome.storage.session.get('trainHelper');
  if (trainHelper?.owner === id) {
    try { await chrome.tabs.remove(trainHelper.tab); } catch {}
    await chrome.storage.session.remove('trainHelper');
  }
});
