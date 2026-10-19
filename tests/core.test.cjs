const {test} = require('node:test');
const assert = require('node:assert/strict');
const c = require('../core.js');
const config = {startDate: '2026-10-04', endDate: '2026-11-15'};
const stats = (label, value) => [{key: 'stat_two_subtitle', value: label}, {key: 'stat_two', value}];
const entry = (id, overrides = {}) => ({post: {id, date: '2026-10-10T14:00:00Z', post: 'LD2_10', shared_content_activity_stats: stats('Steps','6,000'), shared_content_v2: [{__typename: 'Activity', id: '123', name: 'LD2_10', athlete: {id: '456'}, startLocal: '2026-10-04T00:00:00', activityKind: {sportType:'Walk'}, scalars: {distance: 4000, elapsedTime: 3600}}], ...overrides}});
test('cursor completes, advances and rejects stalled/empty continuation', () => {
 assert.equal(c.nextCursor({entries:[],pagination:{hasMore:false}},100),null);
 assert.equal(c.nextCursor({entries:[{cursorData:{updated_at:90}}],pagination:{hasMore:true}},100),90);
 assert.throws(()=>c.nextCursor({entries:[{cursorData:{updated_at:100}}],pagination:{hasMore:true}},100));
 assert.throws(()=>c.nextCursor({entries:[],pagination:{hasMore:true}},100));
});
test('steps depend on subtitle and strict integer parsing', () => {
 assert.equal(c.stepsFromStats(stats('Steps','15,408')),15408);
 assert.equal(c.stepsFromStats(stats('Số bước','11.012')),11012);
 assert.equal(c.stepsFromStats(stats('Elev Gain','21 m')),null);
 assert.equal(c.stepsFromStats(stats('Steps','1.2k')),null);
});
test('accepts Vietnamese and mixed separators without matching larger words', () => {
 for (const s of ['LD2_10_6000','LĐ 2 - 10 - 6.000','ld2-10-6000']) assert.equal(c.parseCode(s).people,10);
 assert.equal(c.parseCode('FIELD2_10'),null);
});
test('dedupes posts and activities while retaining post provenance', () => {
 const merged=c.mergeEntries([entry(1)],[entry(1),entry(2)]); assert.equal(merged.length,2);
 const rows=c.normalize(merged,config); assert.equal(rows.length,1); assert.equal(rows[0].source_posts.length,2);
});
test('points stay pending, missing Steps never falls back to title', () => {
 let row=c.normalize([entry(1)],config)[0]; assert.equal(row.proposed_points,12000); assert.equal(row.status,'pending');
 row=c.normalize([entry(1,{shared_content_activity_stats: stats('Elev Gain','21 m')})],config)[0]; assert.equal(row.steps,null); assert.equal(row.proposed_points,null);
 row=c.normalize([entry(1,{post:'LD2_1',shared_content_v2:[{...entry(1).post.shared_content_v2[0],name:'LD2_1'}]})],config)[0];assert.equal(row.proposed_points,6000);
});
test('inclusive event dates and exclusions use activity date, not post date', () => {
 const base=entry(1).post.shared_content_v2[0];
 for(const day of ['2026-10-04','2026-11-15']) assert.equal(c.normalize([entry(1,{shared_content_v2:[{...base,startLocal:day+'T23:59:59'}]})],config)[0].eligible_for_review,true);
 assert.equal(c.normalize([entry(1,{shared_content_v2:[{...base,startLocal:'2026-10-03T23:59:59'}]})],config)[0].eligible_for_review,false);
});
test('multiple attachments are not assigned the same post Steps', () => {
 const a=entry(1).post.shared_content_v2[0];const rows=c.normalize([entry(1,{shared_content_v2:[a,{...a,id:'789'}]})],config);
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.steps===null && r.warnings.includes('ambiguous_post_stats')));
});

test('account detection skips Training and search links and uses exact profile path', () => {
 const doc={querySelectorAll:()=>['/athletes/123/training/log','/athletes/search','/athletes/456'].map(href=>({getAttribute:()=>href}))};
 assert.equal(c.detectAthleteId(doc),'456');
 assert.equal(c.detectAthleteId({querySelectorAll:()=>[{getAttribute:()=>'/athletes/123/training/log'}]}),null);
 assert.equal(c.detectAthleteId({querySelectorAll:()=>[{getAttribute:()=>'https://evil.example/athletes/123'}]}),null);
});
test('discussion tab resolver recovers when active query hides URL', async () => {
 const tab={id:42,url:'https://www.strava.com/clubs/2368312/discussion'};
 const tabs={query:async q=>q.active?[{id:42}]:[tab]};
 assert.equal((await c.findDiscussionTab(tabs)).id,42);
});
test('discussion tab resolver avoids unrelated and ambiguous tabs', async () => {
 const tabs={query:async q=>q.active?[{id:1,url:'https://example.com'}]:[{id:2,url:'https://www.strava.com/clubs/2368312/discussion'},{id:3,url:'https://www.strava.com/clubs/2368312/discussion/'}]};
 assert.equal(await c.findDiscussionTab(tabs),null);
 assert.equal((await c.findDiscussionTab(tabs,3)).id,3);
 assert.equal(c.isDiscussionUrl('https://www.strava.com/clubs/2368312/discussion?x=1'),true);
 assert.equal(c.isDiscussionUrl('https://www.strava.com/clubs/2368312/discussion-evil'),false);
});
test('photo reports do not become activities or inherit title steps',()=>{
 const post={post:{id:49897451,post:'LD2-1-4830',date:'2026-10-13T12:02:00Z',shared_content_v2:[]},report_metadata:{athlete_id:'145609308',athlete_name:'Thi Ca Trần Lê'}};
 assert.deepEqual(c.normalize([post],config),[]);
 const report=c.normalizePosts([post])[0];assert.equal(report.post_id,'49897451');assert.equal(report.athlete_id,'145609308');assert.equal(report.title,'LD2-1-4830');assert.deepEqual(report.activity_ids,[]);
 assert.equal('steps' in report,false);assert.equal('points' in report,false);
 const fixed={...post,post:{...post.post,shared_content_v2:[{__typename:'Activity',id:'123'}]}};
 assert.deepEqual(c.normalizePosts([fixed])[0].activity_ids,['123']);
 assert.deepEqual(c.normalizePosts([{post:{id:1,post:'Club announcement',athlete_id:2}}]),[]);
 assert.deepEqual(c.normalizePosts([{post:{id:1,post:'LD2-1-4830'}}]),[]);
});
test('discussion kudos come from the post, retain zero, and never use activity kudos',()=>{
 const report=entry(1,{athlete_id:999,originator_name:'Post author',kudos_count:0});
 report.post.shared_content_v2[0].kudos_count=42;
 const row=c.normalizePosts([report],'2026-10-14T15:43:33Z')[0];
 assert.equal(row.kudos_count,0);assert.equal(row.athlete_id,'999');assert.equal(row.athlete_name,'Post author');assert.equal(row.kudos_observed_at,'2026-10-14T15:43:33Z');
 report.post.kudos_count=8;assert.equal(c.normalizePosts([report])[0].kudos_count,8);
 delete report.post.kudos_count;assert.equal(c.normalizePosts([report])[0].kudos_count,null);
 report.post.kudos_count=-1;assert.equal(c.normalizePosts([report])[0].kudos_count,null);
});
test('post photos keep direct image sizes, reject other origins/videos, and preserve unknown media',()=>{
 const url='https://dgtzuqphqg23d.cloudfront.net/image.jpg';
 const photo={id:1,media_type:1,urls:{100:url+'?size=100',1800:url},caption:'A photo'};
 assert.deepEqual(c.normalizePhotos([photo]),[{id:'1',url,thumbnail_url:url+'?size=100',caption:'A photo'}]);
 assert.equal(c.normalizePhotos(undefined),undefined);
 assert.deepEqual(c.normalizePhotos([null,{...photo,media_type:2},{...photo,urls:{1800:'https://example.com/photo'}},{...photo,urls:{1800:'http://dgtzuqphqg23d.cloudfront.net/photo'}}]),[]);
 assert.equal(c.normalizePhotos(Array(20).fill(photo)).length,10);
});
test('activity media comes from the attachment, excludes video, and preserves the newest snapshot',()=>{
 const photo={id:'a1',type:'Photo',imageUrlWithMetadata:{imageUrl:'https://dgtzuqphqg23d.cloudfront.net/activity.jpg'},metadata:{caption:'Activity photo'}};
 const first=entry('10');first.observed_at='2026-10-15T01:00:00Z';first.post.photos=[{media_type:1,urls:{1800:'https://dgtzuqphqg23d.cloudfront.net/post.jpg'}}];first.post.shared_content_v2[0].media=[photo,{...photo,type:'Video'}];
 const old=structuredClone(first);old.observed_at='2026-10-14T01:00:00Z';old.post.shared_content_v2[0].media=[];
 const rows=c.normalize([first,old],config);assert.equal(rows[0].media.length,1);assert.equal(rows[0].media[0].url,photo.imageUrlWithMetadata.imageUrl);assert.equal(rows[0].media_observed_at,first.observed_at);
 assert.equal(c.normalizeActivityMedia(undefined),undefined);assert.deepEqual(c.normalizeActivityMedia([]),[]);
});
