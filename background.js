importScripts("core.js", "delivery.js");
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
let queue = Promise.resolve();
const allowed = ReviveCore.isDiscussionUrl;
const REVIVE_MEMBERS_ENDPOINT = "https://btn-tmg-strava-tracker.vercel.app/api/extension/members";
async function collectClubMembers(startUrl) {
  const base = new URL(startUrl);
  const queue = [base.href], visited = new Set(), members = new Map();
  let expectedCount = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    while (queue.length) {
      const href = queue.shift();
      if (visited.has(href)) continue;
      if (visited.size >= 100) return {error: "Danh sách có quá 100 trang; đã dừng để tránh đồng bộ thiếu."};
      visited.add(href);
      const response = await fetch(href, {credentials: "same-origin", headers: {Accept: "text/html"}, signal: controller.signal});
      if (!response.ok) return {error: `Không tải được trang thành viên (HTTP ${response.status}). Hãy kiểm tra phiên Strava.`};
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("text/html")) return {error: "Strava không trả trang HTML thành viên."};
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      const root = doc.querySelector("main,[role=main]") ?? doc.body;
      const pageText = (root.innerText || root.textContent || "").replace(/\s+/g, " ");
      const countMatch = pageText.match(/(?:showing\s+\d+\s*[-–]\s*\d+\s+of\s+|\b)([\d,]+)\s+members?\b/i);
      if (countMatch) expectedCount = Number(countMatch[1].replace(/,/g, ""));
      for (const link of root.querySelectorAll('a[href*="/athletes/"]')) {
        let profile;
        try { profile = new URL(link.getAttribute("href"), base.origin); } catch { continue; }
        const match = profile.pathname.match(/^\/athletes\/(\d+)\/?$/);
        if (profile.origin !== base.origin || !match) continue;
        const row = link.closest("li,tr,article,[data-athlete-id]") ?? link.parentElement ?? link;
        let roleMatch;
        for (let ancestor = row, depth = 0; ancestor && depth < 3 && !roleMatch; ancestor = ancestor.parentElement, depth++) {
          const text = (ancestor.innerText || ancestor.textContent || "").replace(/\s+/g, " ").trim();
          roleMatch = text.match(/\b(owner|admin)\b/i);
        }
        const avatarName = link.querySelector("img[alt]")?.getAttribute("alt") ?? "";
        const name = [link.innerText, link.textContent, link.getAttribute("aria-label"), link.getAttribute("title"), avatarName].map(value => (value ?? "").replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
        if (!name || /^view profile$/i.test(name)) continue;
        const role = roleMatch ? roleMatch[1][0].toUpperCase() + roleMatch[1].slice(1).toLowerCase() : "Member";
        members.set(match[1], {strava_athlete_id: match[1], strava_name: name, strava_club_role: role});
      }
      for (const link of doc.querySelectorAll('a[href]')) {
        try {
          const next = new URL(link.getAttribute("href"), href);
          const paginationLink = next.searchParams.has("page") || link.rel === "next" || !!link.closest("[class*=pagination i],[aria-label*=pagination i]");
          if (next.origin === base.origin && next.pathname === base.pathname && paginationLink && !visited.has(next.href) && !queue.includes(next.href)) queue.push(next.href);
        } catch {}
      }
    }
    if (!members.size) return {error: "Không tìm thấy hồ sơ thành viên trong trang. Strava có thể đã đổi giao diện."};
    const rows = [...members.values()];
    if (expectedCount !== null && rows.length !== expectedCount) return {error: `Đã đọc ${rows.length}/${expectedCount} thành viên qua ${visited.size} trang. Chưa gửi dữ liệu; kiểm tra phân trang Strava.`};
    if (expectedCount === null && visited.size === 1 && rows.length >= 20) return {error: `Strava trả ${rows.length} hồ sơ nhưng không cho biết tổng số trang. Chưa gửi để tránh đồng bộ thiếu.`};
    return {complete: true, expected_count: rows.length, pages: visited.size, members: rows};
  } catch (error) {
    return {error: error.name === "AbortError" ? "Đọc danh sách thành viên quá 2 phút." : String(error.message ?? error)};
  } finally { clearTimeout(timeout); }
}
// Executes in the page world, matching the successful DevTools Console request.
async function fetchPage(cursor, athleteId) {
  const url = new URL("/clubs/2368312/post_feed", location.origin);
  url.search = new URLSearchParams({feed_type: "club_posts", athlete_id: athleteId, club_id: "2368312", before: String(cursor), cursor: String(cursor)}).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {credentials: "same-origin", headers: {Accept: "application/json"}, signal: controller.signal});
    if (!response.ok) return {error: `HTTP ${response.status}. Đăng nhập lại nếu phiên đã hết hạn.`};
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return {error: "Strava không trả JSON. Kiểm tra đăng nhập."};
    const data = await response.json();
    // Read visible author metadata when the feed payload does not expose its author.
    const cards = [...document.querySelectorAll('[data-testid="web-feed-entry"]')];
    for (const entry of data.entries ?? []) {
      entry.observed_at = new Date().toISOString();
      const id = String(entry.post?.id ?? entry.post?.entity_id ?? "");
      const card = cards.find(c => [...c.querySelectorAll('a[href]')].some(a => a.getAttribute('href') === `/clubs/2368312/posts/${id}`));
      const header = card?.querySelector('[data-testid="entry-header"]');
      const link = header?.querySelector('a[href^="/athletes/"]');
      const athlete = link?.getAttribute('href')?.match(/^\/athletes\/(\d+)\/?$/)?.[1];
      if (athlete) entry.report_metadata = {athlete_id:athlete,athlete_name:header.innerText.split("\n")[0]};
    }
    return {data};
  } catch (e) { return {error: e.name === "AbortError" ? "Request quá 30 giây." : String(e)}; }
  finally { clearTimeout(timeout); }
}
async function command(message) {
  const tab = await chrome.tabs.get(message.tabId);
  if (!allowed(tab.url)) throw new Error("Mở trang thảo luận club 2368312 trên Strava trước.");
  if (message.action === "start") {
    const {sync} = await chrome.storage.local.get("sync");
    if (sync?.running && sync.tabId !== tab.id) {
      try {
        const owner = await chrome.tabs.sendMessage(sync.tabId, {type: "REVIVE_PING"});
        if (owner.running) throw new Error("Đang đồng bộ ở tab Strava khác.");
      } catch (e) { if (String(e).includes("tab Strava khác")) throw e; }
    }
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["core.js", "content.js"]});
  }
  return chrome.tabs.sendMessage(tab.id, {type: "REVIVE_COMMAND", action: message.action, resume: message.resume, config: message.config, tabId: tab.id});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === "REVIVE_MEMBERS_SYNC" && !sender.tab && sender.url === chrome.runtime.getURL("sidepanel.html")) {
    void (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      if (!ReviveCore.isMembersUrl(tab.url)) throw new Error("Mở trang Thành viên club 2368312 trên Strava trước.");
      const [{result}] = await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", func: collectClubMembers, args: [tab.url]});
      if (result?.error) throw new Error(result.error);
      const {syncSecret} = await chrome.storage.local.get("syncSecret");
      if (!syncSecret) throw new Error("Nhập mã bí mật REVIVE trước khi đồng bộ.");
      const response = await fetch(REVIVE_MEMBERS_ENDPOINT, {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${syncSecret}`}, body: JSON.stringify({club_id: ReviveCore.CLUB, complete: result.complete, expected_count: result.expected_count, members: result.members}), signal: AbortSignal.timeout(30000)});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Không đồng bộ được (HTTP ${response.status}).`);
      const sync = { ...data, pages: result.pages, completedAt: new Date().toISOString() };
      await chrome.storage.local.set({memberSync: sync});
      return sync;
    })().then(reply, error => reply({error: String(error.message ?? error)}));
    return true;
  }
  if ((message.type === "REVIVE_STATE_GET" || message.type === "REVIVE_STATE_SET") && sender.tab && allowed(sender.url)) {
    if(message.type === "REVIVE_STATE_GET")chrome.storage.local.get("sync").then(reply);
    else {
      const data={};
      if(message.data?.sync && message.data.sync.tabId===sender.tab.id)data.sync=message.data.sync;
      if(typeof message.data?.lastError === "string")data.lastError=message.data.lastError;
      chrome.storage.local.set(data).then(()=>reply({ok:true}));
    }
    return true;
  }
  if (message.type === "REVIVE_SEND" && ((sender.tab && allowed(sender.url)) || (!sender.tab && sender.url === chrome.runtime.getURL("sidepanel.html")))) {
    enqueueDelivery(!sender.tab).then(reply,()=>reply({error:"Không gửi được dữ liệu. Bấm Gửi lại."}));
    return true;
  }
  if (message.type === "REVIVE_SAVE_SECRET" && !sender.tab && sender.url === chrome.runtime.getURL("sidepanel.html")) {
    if(typeof message.secret !== "string" || message.secret.length<32 || message.secret.length>200){reply({error:"Mã cần từ 32 đến 200 ký tự."});return;}
    chrome.storage.local.set({syncSecret:message.secret}).then(()=>reply({ok:true}));return true;
  }
  if (message.type === "REVIVE_FETCH") {
    if (!sender.tab || !allowed(sender.url) || !Number.isFinite(message.cursor) || !/^\d+$/.test(message.athleteId ?? "")) {
      reply({error: "Request không hợp lệ."}); return;
    }
    chrome.scripting.executeScript({target: {tabId: sender.tab.id}, world: "MAIN", func: fetchPage, args: [message.cursor, message.athleteId]})
      .then(results => reply(results[0]?.result ?? {error: "Không đọc được phản hồi Strava."}), e => reply({error: String(e)}));
    return true;
  }
  if (message.type === "REVIVE_UI" && !sender.tab) {
    queue = queue.catch(() => {}).then(() => command(message));
    queue.then(reply, e => reply({error: String(e.message ?? e)}));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // Discard only the obsolete pre-0.2.1 account detection message, not saved entries.
  void chrome.storage.local.get("lastError").then(({lastError}) => {
    if (lastError?.includes("Không xác định được tài khoản")) return chrome.storage.local.remove("lastError");
  });
});



chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"}).catch(console.error);
