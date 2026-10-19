// Runs only in the extension worker; the destination cannot be supplied by a page.
const REVIVE_ENDPOINT = 'https://btn-tmg-strava-tracker.vercel.app/api/extension/activities';
let deliveryQueue = Promise.resolve();
function enqueueDelivery(manual = false) {
 deliveryQueue = deliveryQueue.catch(() => {}).then(() => sendPendingActivities(manual));
 return deliveryQueue;
}
async function sendPendingActivities(manual) {
 const stored = await chrome.storage.local.get(['sync','delivery','syncSecret']);
 const sync = stored.sync;
 if (!sync || (!sync.entries?.length && !sync.completed)) return {ok:true};
 let delivery = stored.delivery?.runId === sync.startedAt ? stored.delivery : {runId:sync.startedAt,sent:[],inserted:0,skipped:0};
 if (delivery.error && !manual) return {error:delivery.error};
 const rows = ReviveCore.normalize(sync.entries,sync.config,sync.updatedAt);
 const valid = rows.filter(row => /^\d{1,15}$/.test(row.athlete_id ?? '') && /^202\d-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(row.start_local ?? ''));
 const pending = valid.filter(row => (!delivery.sent.includes(row.activity_id) || (row.media!==undefined && delivery.activityMedia?.[row.activity_id]!==JSON.stringify([row.media,row.media_observed_at]))));
 delivery.invalid = rows.length-valid.length; delivery.pending = pending.length;
 delivery.error = null; delivery.sending = false;
 const save = () => chrome.storage.local.set({delivery:{...delivery,updatedAt:new Date().toISOString()}});
 try {
  if (!stored.syncSecret) throw new Error('Nhập mã bí mật và lưu kết nối trước khi gửi.');
  delivery.sending = true; await save();
  while (pending.length) {
   const batch = []; let bytes = 0;
   while(pending.length && batch.length<50) {
    const size = new TextEncoder().encode(JSON.stringify(pending[0])).length;
    if(size>95000)throw new Error('Một activity có dữ liệu nguồn quá lớn. Dữ liệu vẫn lưu trên máy.');
    if(batch.length && bytes+size>400000)break;
    bytes+=size;batch.push(pending.shift());
   }
   const response = await fetch(REVIVE_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${stored.syncSecret}`},body:JSON.stringify({club_id:'2368312',activities:batch}),signal:AbortSignal.timeout(30000)});
   const result = await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(result.error || `Không gửi được dữ liệu (HTTP ${response.status}).`);
   if(!Number.isInteger(result.inserted)||!Number.isInteger(result.skipped)||result.inserted+result.skipped!==batch.length)throw new Error('Phản hồi đồng bộ không hợp lệ.');
   delivery.sent=[...new Set([...delivery.sent,...batch.map(row=>row.activity_id)])];
   delivery.activityMedia ??= {};
   for(const row of batch)if(row.media!==undefined)delivery.activityMedia[row.activity_id]=JSON.stringify([row.media,row.media_observed_at]);
   delivery.inserted+=result.inserted;delivery.skipped+=result.skipped;delivery.pending=pending.length;await save();
   if(pending.length)await new Promise(resolve=>setTimeout(resolve,1100));
  }
  delivery.unidentifiedReports = sync.entries.filter(entry=> {
   const p=entry.post??{},body=String(p.post??'');
   return !(p.shared_content_v2??[]).some(a=>a.__typename==='Activity'&&a.id) && (ReviveCore.parseCode(body)||/strava\.(?:com|app\.link)/i.test(body)) && !ReviveCore.normalizePosts([entry]).length;
  }).length;
  const reports = ReviveCore.normalizePosts(sync.entries,sync.updatedAt).filter(row=>delivery.reports?.[row.post_id]!==JSON.stringify(row));
  delivery.reports ??= {};
  // Reconcile every observed post on each run, including edits to old posts.
  while (reports.length) {
   const batch=[];let bytes=0;
   while(reports.length && batch.length<50) {
    const size=new TextEncoder().encode(JSON.stringify(reports[0])).length;
    if(size>95000)throw new Error('Một bài đăng có dữ liệu ảnh quá lớn. Dữ liệu vẫn lưu trên máy.');
    if(batch.length && bytes+size>400000)break;
    bytes+=size;batch.push(reports.shift());
   }
   const response=await fetch(REVIVE_ENDPOINT.replace('/activities','/posts'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${stored.syncSecret}`},body:JSON.stringify({club_id:'2368312',posts:batch}),signal:AbortSignal.timeout(30000)});
   if(!response.ok)throw new Error('Không gửi được bài cần bổ sung. Bấm Gửi lại.');
   const result=await response.json();
   if(result.processed!==batch.length)throw new Error('Phản hồi bài cần bổ sung không hợp lệ.');
   for(const row of batch)delivery.reports[row.post_id]=JSON.stringify(row);
   await save();
   if(reports.length)await new Promise(resolve=>setTimeout(resolve,1100));
  }
  // Only a fully fetched and fully delivered run may archive absent reports.
  if (sync.completed && !sync.error && !delivery.scanCompleted) {
   const current = (await chrome.storage.local.get('sync')).sync;
   if (current?.startedAt !== sync.startedAt) return {ok:true};
   const postIds = [...new Set(sync.entries.map(entry=>String(entry.post?.id ?? entry.post?.entity_id ?? '')))];
   if(postIds.length>50000 || postIds.some(id=>!/^[1-9][0-9]{0,14}$/.test(id)))throw new Error('Danh sách ID không hợp lệ hoặc quá lớn. Chưa ẩn bài cũ.');
   const response=await fetch(REVIVE_ENDPOINT.replace('/activities','/posts/complete'),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${stored.syncSecret}`},body:JSON.stringify({club_id:'2368312',complete:true,started_at:sync.startedAt,completed_at:sync.updatedAt,pages:sync.pages,post_ids:postIds}),signal:AbortSignal.timeout(30000)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok || result.complete!==true)throw new Error(result.error || 'Chưa đối chiếu được bài cũ. Bấm Gửi lại.');
   delivery.scanCompleted=true;delivery.hiddenReports=result.hidden??0;delivery.restoredReports=result.restored??0;
   await save();
  }
 } catch(e) {
  delivery.pending=valid.filter(row=>(!delivery.sent.includes(row.activity_id) || (row.media!==undefined && delivery.activityMedia?.[row.activity_id]!==JSON.stringify([row.media,row.media_observed_at])))).length;
  delivery.error=e.name==='TimeoutError'?'Gửi quá 30 giây. Bấm Gửi lại.':String(e.message ?? 'Không gửi được dữ liệu.');
 } finally {delivery.sending=false;await save();}
 return delivery.error?{error:delivery.error}:{ok:true};
}
