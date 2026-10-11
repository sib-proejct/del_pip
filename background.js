const defaultTitle = "이 페이지의 PiP 제한 속성 제거";
const tabStates = new Map();

function stateFor(tabId) {
  if (!tabStates.has(tabId)) tabStates.set(tabId, { revision: 0, updates: Promise.resolve() });
  return tabStates.get(tabId);
}

function showState(tabId, state, revision, text, title, color) {
  // Serialize UI writes so navigation's reset follows any already-started write.
  state.updates = state.updates.then(async () => {
    if (tabStates.get(tabId) !== state || state.revision !== revision) return;
    await Promise.allSettled([
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setTitle({ tabId, title })
    ]);
  });
  return state.updates;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const state = stateFor(tabId);
  return showState(tabId, state, ++state.revision, "", defaultTitle, "#167D55");
});

chrome.tabs.onRemoved.addListener((tabId) => tabStates.delete(tabId));

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  const tabId = tab.id;
  const state = stateFor(tabId);
  const revision = ++state.revision;
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    if (!frames.length) throw new Error("No accessible frames");
    const removed = frames.reduce((sum, frame) => sum + (frame.result?.removed || 0), 0);
    await showState(tabId, state, revision, "ON",
      `PiP 속성 감시 중 · 이번 클릭에서 ${removed}개 제거 · 반복 충돌 시 잠시 재시도를 쉽니다`, "#167D55");
  } catch {
    await showState(tabId, state, revision, "!",
      "실행할 수 없는 페이지입니다. 일반 웹페이지에서 다시 클릭하세요.", "#B42318");
  }
});
