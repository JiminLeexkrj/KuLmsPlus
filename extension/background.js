// 툴바 아이콘을 누르면 캘린더 탭을 연다. 이미 열려 있으면 그 탭으로 이동한다.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('calendar.html');
  const [existing] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (existing) {
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
