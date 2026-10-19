const $ = id => document.getElementById(id);
let activeTab, membersTab, sync, running = false, memberRunning = false, currentMode = "activities";
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function refresh() {
  const stored = await chrome.storage.local.get(["sync", "lastError", "delivery", "syncSecret"]);
  sync = stored.sync;
  running = false;
  if (sync?.running) {
    try {running = (await chrome.tabs.sendMessage(sync.tabId, {type: "REVIVE_PING"})).running;} catch {}
  }
  const rows = ReviveCore.normalize(sync?.entries ?? [], sync?.config ?? {startDate: "2026-10-04", endDate: "2026-11-15"});
  $("pages").textContent = sync?.pages ?? 0;
  $("posts").textContent = sync?.entries?.length ?? 0;
  $("activities").textContent = rows.length;
  $("status").textContent = running ? "Đang lấy dữ liệu…" : sync?.completed ? "Đã lấy hết bài đăng" : sync ? "Đã dừng · có thể tiếp tục" : "Chưa lấy dữ liệu";
  $("details").textContent = sync ? `${rows.filter(r => r.eligible_for_review).length} activity trong kỳ · ${rows.filter(r => r.steps === null).length} thiếu bước${sync.updatedAt ? ' · ' + new Date(sync.updatedAt).toLocaleTimeString('vi-VN') : ''}` : "";
  $("error").textContent = sync?.error || stored.lastError || "";
  $("start").disabled = !activeTab || running;
  $("resume").disabled = !activeTab || running || !sync || sync.completed;
  $("stop").disabled = !running;
  $("raw").disabled = !sync?.entries?.length || running;
  const delivery = stored.delivery?.runId === sync?.startedAt ? stored.delivery : null;
  const pending = rows.length-(delivery?.sent?.length ?? 0)-(delivery?.invalid ?? 0);
  $("secretStatus").textContent = stored.syncSecret ? "Đã lưu mã kết nối trên máy." : "Chưa có mã kết nối.";
  $("deliveryStatus").textContent = delivery?.sending ? "Đang gửi về REVIVE…" : delivery?.error ? "Chưa gửi xong" : (delivery?.scanCompleted || delivery?.sent?.length || Object.keys(delivery?.reports??{}).length) ? "Đã đồng bộ về REVIVE" : "Chưa gửi dữ liệu";
  $("deliveryDetails").textContent = `${Object.keys(delivery?.reports??{}).length} bài đã gửi · ${delivery?.sent?.length ?? 0} activities đã gửi · ${Math.max(0,pending)} chưa gửi · ${delivery?.inserted ?? 0} mới · ${delivery?.skipped ?? 0} trùng${delivery?.invalid ? ` · ${delivery.invalid} thiếu ID/ngày` : ''}${delivery?.unidentifiedReports ? ` · ${delivery.unidentifiedReports} bài thiếu ID người đăng, giữ trên máy` : ''}${delivery?.scanCompleted ? ` · ${delivery.hiddenReports ?? 0} bài cũ đã ẩn` : ''}${delivery?.error ? ` · ${delivery.error}` : ''}`;
  $("retry").disabled = !stored.syncSecret || (!sync?.entries?.length && !sync?.completed) || !!delivery?.sending;

  $("startDate").disabled = $("endDate").disabled = running;
}
async function refreshMembers() {
 const stored=await chrome.storage.local.get("memberSync"),sync=stored.memberSync;
 $("memberPages").textContent=sync?.pages??0;$("memberTotal").textContent=sync?.total??0;$("memberInserted").textContent=sync?.inserted??0;
 $("memberStatus").textContent=memberRunning?"Đang đọc và gửi danh sách…":sync?.completedAt?"Đã đồng bộ thành viên":"Chưa đồng bộ";
 $("memberDetails").textContent=sync?.completedAt?`${sync.updated??0} cập nhật · ${sync.unchanged??0} không đổi · ${new Date(sync.completedAt).toLocaleTimeString("vi-VN")}`:"";
 $("syncMembers").disabled=!membersTab||memberRunning;
}
function setMode(mode){currentMode=mode;const activities=mode==="activities";$("activityPanel").hidden=!activities;$("memberPanel").hidden=activities;$("modeActivities").classList.toggle("active",activities);$("modeMembers").classList.toggle("active",!activities);$("modeActivities").setAttribute("aria-pressed",String(activities));$("modeMembers").setAttribute("aria-pressed",String(!activities));}
async function action(action, resume = false) {
  try {
    if (action === "start" && !resume && sync?.entries?.length && !confirm("Lấy mới sẽ thay dữ liệu cục bộ hiện tại. Dữ liệu chưa gửi sẽ không còn trong hàng đợi. Bạn muốn tiếp tục?")) return;
    await updateConnection();
    if (action === "start" && !activeTab) throw new Error("Mở tab thảo luận Strava trước khi lấy dữ liệu.");
    const config = {startDate: $("startDate").value, endDate: $("endDate").value};
    if (action === "start" && (!config.startDate || !config.endDate || config.startDate > config.endDate)) throw new Error("Khoảng ngày không hợp lệ.");
    await chrome.storage.local.remove("lastError");
    const response = await chrome.runtime.sendMessage({type: "REVIVE_UI", tabId: action === "stop" ? sync.tabId : activeTab.id, action, resume, config});
    if (response.error) throw new Error(response.error);
    await refresh();
  } catch (e) {$("error").textContent = String(e.message ?? e);}
}
$("start").onclick = () => action("start");
$("resume").onclick = () => action("start", true);
$("stop").onclick = () => action("stop");
$("raw").onclick = () => download("revive-strava-posts.json", {club_id: ReviveCore.CLUB, completed: sync.completed, next_cursor: sync.completed ? null : sync.cursor, config: sync.config, entries: sync.entries, observed_at: sync.updatedAt});
$("saveSecret").onclick = async () => {
 const secret = $("syncSecret").value.trim();
 const result = await chrome.runtime.sendMessage({type:"REVIVE_SAVE_SECRET",secret});
 if(result.error){$("secretStatus").textContent=result.error;return;}
 $("syncSecret").value="";
 await chrome.runtime.sendMessage({type:"REVIVE_SEND"});await refresh();
};
$("retry").onclick = async () => {$("retry").disabled=true;await chrome.runtime.sendMessage({type:"REVIVE_SEND"});await refresh();};

async function updateConnection() {
  activeTab = undefined;
  membersTab = undefined;
  const stored = (await chrome.storage.local.get("sync")).sync;
  activeTab = await ReviveCore.findDiscussionTab(chrome.tabs, stored?.tabId);
  membersTab = await ReviveCore.findMembersTab(chrome.tabs);
  $("connection").textContent = activeTab ? "Đã kết nối tab thảo luận Strava · sẵn sàng lấy dữ liệu" : "Mở tab Thảo luận Strava để đồng bộ hoạt động.";
  $("memberConnection").textContent = membersTab ? "Đã kết nối trang Thành viên Strava · sẵn sàng đồng bộ" : "Mở trang Thành viên của club 2368312 trên Strava rồi mở sidebar.";
  await refresh();
  await refreshMembers();
}
(async () => {
  const stored = (await chrome.storage.local.get("sync")).sync;
  if (stored?.config) {$("startDate").value = stored.config.startDate; $("endDate").value = stored.config.endDate;}
  await updateConnection();
})().catch(e => {$("error").textContent = String(e);});
chrome.tabs.onActivated.addListener(() => {void updateConnection();});
chrome.tabs.onUpdated.addListener((_id, info) => {if (info.url || info.status === "complete") void updateConnection();});
chrome.storage.onChanged.addListener((_changes, area) => {if (area === "local") {void refresh();void refreshMembers();}});
$("modeActivities").onclick=()=>setMode("activities");$("modeMembers").onclick=()=>setMode("members");
$("syncMembers").onclick=async()=>{
 if(!membersTab)return;
 memberRunning=true;$("memberError").textContent="";await refreshMembers();
 try{const result=await chrome.runtime.sendMessage({type:"REVIVE_MEMBERS_SYNC",tabId:membersTab.id});if(result?.error)throw new Error(result.error);await refreshMembers();}
 catch(error){$("memberError").textContent=String(error.message??error);}
 finally{memberRunning=false;await refreshMembers();}
};
