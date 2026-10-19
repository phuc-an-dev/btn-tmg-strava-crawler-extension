const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const core = require('../core.js');
function harness(responses, initial) {
 const saved={sync:initial}; const listeners=[]; const requests=[];
 const ctx={ReviveCore:core, Date, setTimeout:callback=>{queueMicrotask(callback);return 1;}, document:{querySelectorAll:()=>[{getAttribute:()=>'/athletes/123/training/log'},{getAttribute:()=>'/athletes/123'}]}, chrome:{
  storage:{local:{get:async()=>structuredClone(saved),set:async data=>Object.assign(saved,structuredClone(data))}},
  runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async msg=>{if(msg.type==='REVIVE_STATE_GET')return structuredClone(saved);
   if(msg.type==='REVIVE_STATE_SET'){Object.assign(saved,structuredClone(msg.data));return {ok:true};}
   if(msg.type==='REVIVE_SEND')return {ok:true};
   requests.push(msg);return responses.shift();}},
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'),'utf8'),ctx);
 const send=msg=>new Promise(resolve=>listeners[0](msg,{},resolve));
 const finished=async()=>{for(let i=0;i<100&&ctx.reviveRunner.running;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(ctx.reviveRunner.running,false);};
 return {saved,requests,send,finished};
}
const page=(id,cursor,hasMore)=>({data:{entries:[{post:{id},cursorData:{updated_at:cursor}}],pagination:{hasMore}}});
const start={type:'REVIVE_COMMAND',action:'start',tabId:7,config:{startDate:'2026-10-04',endDate:'2026-11-15'}};
test('runner fetches two pages and saves final completion outside popup lifetime',async()=>{
 const h=harness([page(1,100,true),page(2,90,false)]);
 assert.equal((await h.send(start)).ok,true);await h.finished();
 assert.equal(h.saved.sync.entries.length,2);assert.equal(h.saved.sync.completed,true);assert.equal(h.requests[1].cursor,100);assert.equal(h.saved.sync.running,false);
});
test('request failure preserves checkpoint and resume fetches the same cursor',async()=>{
 const h=harness([page(1,100,true),{error:'HTTP 429'}]);
 await h.send(start);await h.finished();assert.equal(h.saved.sync.cursor,100);assert.equal(h.saved.sync.entries.length,1);assert.equal(h.saved.sync.error,'HTTP 429');
 const resumed=harness([page(2,90,false)],h.saved.sync);await resumed.send({...start,resume:true});await resumed.finished();assert.equal(resumed.requests[0].cursor,100);assert.equal(resumed.saved.sync.entries.length,2);
});
test('resuming with another athlete refuses before any fetch',async()=>{
 const h=harness([],{athleteId:'999',completed:false,entries:[],cursor:100});
 const result=await h.send({...start,resume:true});await h.finished();assert.ok(result.error.includes('khác'));assert.equal(h.requests.length,0);
});
