const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function harness(count,fail=false){
 const saved={syncSecret:'test-only-secret',sync:{entries:Array.from({length:count},(_,i)=>({activity_id:String(i+1),athlete_id:'123',start_local:'2026-10-10T10:00:00'})),startedAt:'run-1',config:{}}};
 const batches=[];let shouldFail=fail;
 const ctx={TextEncoder,AbortSignal,Date,setTimeout:fn=>queueMicrotask(fn),ReviveCore:{normalize:entries=>entries,normalizePosts:()=>[],parseCode:()=>null},chrome:{storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}}},fetch:async(url,request)=>{
  assert.equal(url,'https://btn-tmg-strava-tracker.vercel.app/api/extension/activities');
  const body=JSON.parse(request.body);batches.push(body.activities);
  if(shouldFail){shouldFail=false;throw new Error('Network failure');}
  return {ok:true,json:async()=>({inserted:body.activities.length,skipped:0})};
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../delivery.js'),'utf8'),ctx);
 return {ctx,saved,batches};
}
test('delivery chunks at 50 and does not resend acknowledged IDs',async()=>{
 const h=harness(51);await h.ctx.enqueueDelivery(true);
 assert.deepEqual(h.batches.map(b=>b.length),[50,1]);assert.equal(h.saved.delivery.sent.length,51);
 await h.ctx.enqueueDelivery(true);assert.equal(h.batches.length,2);
});
test('failed upload retains queue, pauses automatic sends and manual retry succeeds',async()=>{
 const h=harness(2,true);await h.ctx.enqueueDelivery(true);
 assert.equal(h.saved.delivery.sent.length,0);assert.equal(h.saved.delivery.pending,2);assert.ok(h.saved.delivery.error);
 await h.ctx.enqueueDelivery(false);assert.equal(h.batches.length,1);
 await h.ctx.enqueueDelivery(true);assert.equal(h.saved.delivery.sent.length,2);assert.equal(h.saved.delivery.error,null);
});
test('missing credentials and incomplete activities never upload',async()=>{
 const h=harness(2);delete h.saved.syncSecret;await h.ctx.enqueueDelivery(true);assert.equal(h.batches.length,0);
 h.saved.syncSecret='test-only-secret';h.saved.sync.entries[0].athlete_id=null;
 await h.ctx.enqueueDelivery(true);assert.equal(h.saved.delivery.invalid,1);assert.equal(h.saved.delivery.sent.length,1);
});

test('photo-only reports are delivered separately and retry after failure',async()=>{
 const h=harness(1);h.ctx.ReviveCore.normalize=()=>[];
 const report={post_id:'49897451',athlete_id:'145609308',title:'LD2-1-4830',activity_ids:[]};
 h.ctx.ReviveCore.normalizePosts=()=>[report];let calls=0;
 h.ctx.fetch=async(url,request)=>{assert.ok(url.endsWith('/posts'));assert.deepEqual(JSON.parse(request.body).posts,[report]);calls++;return {ok:calls>1,json:async()=>({processed:1})};};
 await h.ctx.enqueueDelivery(true);assert.ok(h.saved.delivery.error);assert.equal(h.saved.delivery.sent.length,0);
 await h.ctx.enqueueDelivery(true);assert.equal(h.saved.delivery.error,null);assert.equal(calls,2);
 await h.ctx.enqueueDelivery(true);assert.equal(calls,2);
 report.activity_ids=['123'];await h.ctx.enqueueDelivery(true);assert.equal(calls,3);
});
test('media reports split by payload size and resume without losing post IDs',async()=>{
 const h=harness(1);h.ctx.ReviveCore.normalize=()=>[];
 const reports=Array.from({length:8},(_,i)=>({post_id:String(i+1),media:[{url:'a'.repeat(80000)}]}));
 h.ctx.ReviveCore.normalizePosts=()=>reports;let requests=0;
 h.ctx.fetch=async(url,request)=>{assert.ok(url.endsWith('/posts'));assert.ok(Buffer.byteLength(request.body)<512000);const body=JSON.parse(request.body);requests++;return {ok:true,json:async()=>({processed:body.posts.length})};};
 await h.ctx.enqueueDelivery(true);assert.equal(requests,2);assert.equal(Object.keys(h.saved.delivery.reports).length,8);assert.equal(reports.length,8);
 await h.ctx.enqueueDelivery(true);assert.equal(requests,2);
});
test('media edits resend acknowledged activities without duplicating sent IDs',async()=>{
 const h=harness(1);h.saved.sync.entries[0].media=[];h.saved.sync.entries[0].media_observed_at='2026-10-15T01:00:00Z';
 await h.ctx.enqueueDelivery(true);await h.ctx.enqueueDelivery(true);assert.equal(h.batches.length,1);
 h.saved.sync.entries[0].media=[{url:'https://dgtzuqphqg23d.cloudfront.net/activity.jpg'}];
 await h.ctx.enqueueDelivery(true);assert.equal(h.batches.length,2);assert.equal(h.saved.delivery.sent.length,1);
});

function completedHarness(count=1){
 const h=harness(count);h.ctx.ReviveCore.normalize=()=>[];
 h.saved.sync={...h.saved.sync,completed:true,pages:2,startedAt:'2026-10-18T01:00:00.000Z',updatedAt:'2026-10-18T01:01:00.000Z',entries:Array.from({length:count},(_,i)=>({post:{id:String(i+1)}}))};
 const requests=[];
 h.ctx.fetch=async(url,request)=>{const body=JSON.parse(request.body);requests.push({url,body});return {ok:true,json:async()=>url.endsWith('/complete')?{complete:true,hidden:3,restored:1}:{processed:body.posts.length}};};
 return {...h,requests};
}
test('complete scan sends all raw post IDs after reports, once, including unnormalizable posts',async()=>{
 const h=completedHarness(2);h.ctx.ReviveCore.normalizePosts=()=>[{post_id:'1',athlete_id:'123',activity_ids:[]}];
 await h.ctx.enqueueDelivery(true);
 assert.deepEqual(h.requests.map(r=>r.url.split('/').at(-1)),['posts','complete']);
 assert.deepEqual(h.requests[1].body.post_ids,['1','2']);assert.equal(h.saved.delivery.hiddenReports,3);
 await h.ctx.enqueueDelivery(true);assert.equal(h.requests.length,2);
});
test('partial, failed crawl and failed upload do not finalize',async()=>{
 for(const patch of [{completed:false},{error:'Fetch failed'}]){
  const h=completedHarness();Object.assign(h.saved.sync,patch);await h.ctx.enqueueDelivery(true);assert.equal(h.requests.length,0);
 }
 const h=completedHarness();h.ctx.ReviveCore.normalizePosts=()=>[{post_id:'1'}];
 h.ctx.fetch=async url=>{assert.ok(url.endsWith('/posts'));return {ok:false};};
 await h.ctx.enqueueDelivery(true);assert.ok(h.saved.delivery.error);assert.ok(!h.saved.delivery.scanCompleted);
});
test('finalization failure is retried without repeating acknowledged reports',async()=>{
 const h=completedHarness();h.ctx.ReviveCore.normalizePosts=()=>[{post_id:'1'}];
 const fetch=h.ctx.fetch;let failed=false;
 h.ctx.fetch=async(...args)=>{if(args[0].endsWith('/complete')&&!failed){failed=true;throw new Error('Network');}return fetch(...args);};
 await h.ctx.enqueueDelivery(true);assert.ok(h.saved.delivery.error);assert.equal(Object.keys(h.saved.delivery.reports).length,1);
 await h.ctx.enqueueDelivery(false);assert.equal(h.requests.length,1);
 await h.ctx.enqueueDelivery(true);assert.equal(h.requests.length,2);assert.equal(h.saved.delivery.scanCompleted,true);
});
test('empty completed feed finalizes; malformed post IDs never finalize',async()=>{
 const h=completedHarness(0);await h.ctx.enqueueDelivery(true);assert.deepEqual(h.requests[0].body.post_ids,[]);
 const invalid=completedHarness();invalid.saved.sync.entries=[{post:{}}];await invalid.ctx.enqueueDelivery(true);
 assert.equal(invalid.requests.length,0);assert.ok(invalid.saved.delivery.error);
});
test('superseded crawl does not finalize using a new run checkpoint',async()=>{
 const h=completedHarness();h.ctx.ReviveCore.normalizePosts=()=>[{post_id:'1'}];const fetch=h.ctx.fetch;
 h.ctx.fetch=async(...args)=>{h.saved.sync.startedAt='new-run';return fetch(...args);};
 await h.ctx.enqueueDelivery(true);assert.equal(h.requests.length,1);assert.ok(!h.saved.delivery.scanCompleted);
});
