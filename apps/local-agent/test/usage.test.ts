import test from "node:test";
import assert from "node:assert/strict";
import { tokenUsage, quotaSnapshot } from "../src/usage.js";
import { CodexAppServer, type AppServerCallbacks, type AppEvent } from "../src/app-server.js";
const counts={inputTokens:80,outputTokens:20,cachedInputTokens:30,reasoningOutputTokens:10,totalTokens:100};
test("usage allowlist rejects unsafe counters and never relays account credentials",()=>{
 assert.equal(tokenUsage({total:{...counts,inputTokens:-1},last:counts}),undefined);
 assert.equal(tokenUsage({total:{...counts,totalTokens:Infinity},last:counts}),undefined);
 const parsed=tokenUsage({total:counts,last:counts,secret:"drop",modelContextWindow:10000});assert.ok(parsed);assert.ok(!JSON.stringify(parsed).includes("secret"));
 const quota=quotaSnapshot({accountId:"synthetic-account",accessToken:"never-relay",rateLimitsByLimitId:{codex:{secondary:{usedPercent:64,windowDurationMins:10080,resetsAt:1900000000}}}}, {account:{email:"demo@example.test"}})!;
 assert.equal((quota.windows as Record<string,unknown>[])[0]?.windowMinutes,10080);
 assert.match(String(quota.accountKey),/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(quota).includes("synthetic-account"));assert.ok(!JSON.stringify(quota).includes("never-relay"));
});
test("native usage notifications use durable events and never request a turn or resume",async()=>{
 const events:AppEvent[]=[];
 const callbacks: AppServerCallbacks = { onEvent:async event=>{events.push(event);}, findManagedThread:()=>({nativeThreadId:"native",projectId:"project",appServerEpoch:"epoch",policyVersion:"remote-restricted-v1",policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString()}), findProject:()=>undefined, onVolatile:()=>assert.fail("unexpected delta"), onApproval:async()=>assert.fail("unexpected approval"), onApprovalResolved:async()=>assert.fail("unexpected resolution"), onExit:async()=>{} };
 const client=new CodexAppServer(callbacks);
 const notify=(client as unknown as {handleNotification(method:string,params:Record<string,unknown>):Promise<void>}).handleNotification.bind(client);
 await notify("thread/tokenUsage/updated",{threadId:"native",turnId:"turn",tokenUsage:{total:counts,last:counts}});
 assert.equal(events.length,1);assert.equal(events[0]?.type,"thread.usage");assert.equal(events[0]?.nativeThreadId,"native");
 await notify("thread/tokenUsage/updated",{threadId:"native",turnId:"turn",tokenUsage:{total:{},last:{}}});assert.equal(events.length,1);
 await client.refreshQuota();assert.equal(client.getQuotaSnapshot(),undefined);
});
test("concurrent quota reads are coalesced, failures retain timestamps, and account changes invalidate cached quota",async()=>{
 const callbacks: AppServerCallbacks = {onEvent:async()=>{},findManagedThread:()=>undefined,findProject:()=>undefined,onVolatile:()=>{},onApproval:async()=>{throw new Error("unexpected approval");},onApprovalResolved:async()=>{},onExit:async()=>{}};
 const client=new CodexAppServer(callbacks);
 const internal=client as unknown as {initialized:boolean;request(method:string,params:unknown):Promise<unknown>;handleNotification(method:string,params:Record<string,unknown>):Promise<void>};
 internal.initialized=true;const methods:string[]=[];
 internal.request=async method=>{methods.push(method);return method==="account/read"?{account:{email:"test@example.test"}}:{accountId:"test-account",rateLimits:{secondary:{usedPercent:25,windowDurationMins:10080}}};};
 await Promise.all([client.refreshQuota(),client.refreshQuota()]);const snapshot=client.getQuotaSnapshot();assert.ok(snapshot);
 assert.deepEqual(methods,["account/read","account/rateLimits/read"]);
 internal.request=async()=>{throw new Error("offline");};await client.refreshQuota();assert.equal(client.getQuotaSnapshot(),snapshot);
 await internal.handleNotification("account/updated",{});assert.equal(client.getQuotaSnapshot(),undefined);
 const limits={accountId:"shared-workspace",rateLimits:{}};
 assert.notEqual(quotaSnapshot(limits,{account:{email:"one@example.test"}})?.accountKey,quotaSnapshot(limits,{account:{email:"two@example.test"}})?.accountKey);
 assert.equal(quotaSnapshot(limits)?.accountKey,undefined);
});
