import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { IdentityMail } from '../src/identity/mail';
import { configureHttp } from '../src/http';
import { waitReady } from './wait-ready';

// Real PostgreSQL trigger/RLS and Nest RBAC. Provider and payment services
// are not involved: the ledger is informational and always non-billable.
// prettier-ignore
test('technical AI usage observations stay exact-once, immutable and tenant-isolated', { timeout: 60000 }, async () => {
  const url = process.env.MIGRATION_DATABASE_URL;
  assert(url);
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  const deps = app.get(Dependencies);
  const admin = new PrismaClient({ datasources: { db: { url } } });
  const emails = new Map<string,string>();
  app.get(IdentityMail).send = async (email,purpose,token) => {
    if (purpose === 'verify') emails.set(email,token);
  };
  configureHttp(app,config,false);
  await app.listen(0,'127.0.0.1');
  const base = await app.getUrl();
  const request=(method:string,path:string,body?:object,token?:string)=>
    fetch(base+'/api/v1'+path,{
      method,headers:{
        Origin:config.CORS_ORIGIN,'Content-Type':'application/json',
        ...(token?{Authorization:'Bearer '+token}:{})
      },body:body?JSON.stringify(body):undefined,
    });
  const json=async<T>(r:Response,status:number):Promise<T>=>{
    assert.equal(r.status,status,await r.clone().text());
    return r.json() as Promise<T>;
  };
  const register=async()=>{
    const email='meter-'+randomUUID()+'@example.test';
    const password='Usage-Test-123!';
    assert.equal((await request('POST','/auth/register',{
      email,password,name:'Meter viewer',termsAccepted:true
    })).status,202);
    assert.equal((await request('POST','/auth/verify',{token:emails.get(email)})).status,204);
    const logged=await json<{access_token:string}>(
      await request('POST','/auth/login',{email,password}),200);
    const person=await admin.user.findUniqueOrThrow({where:{email}});
    return {token:logged.access_token,id:person.id};
  };
  const createTurn=async(tenantId:string,baseId:string,ageDays=0)=>{
    const at=new Date(Date.now()-ageDays*86400000);
    const turnId=randomUUID();
    await admin.aiTurn.create({data:{
      id:turnId,tenantId,conversationId:baseId,customerId:
        (await admin.conversation.findUniqueOrThrow({
          where:{tenantId_id:{tenantId,id:baseId}},select:{customerId:true}
        })).customerId,
      modeEpoch:0n,stateVersion:0n,status:'completed',rounds:1,
      completedAt:at,startedAt:at,
    }});
    return turnId;
  };
  const fixtures=async(tenantId:string)=>{
    const uid=randomUUID().replace(/-/g,'');
    const channel=await admin.channelConnection.create({data:{
      tenantId,id:randomUUID(),channelType:'webchat',mode:'mock',
      externalAccountId:'mock:'+uid,externalPhoneId:'mock:'+uid,
      displayName:'Usage test',status:'active',
    }});
    const customer=await admin.customer.create({data:{
      tenantId,id:randomUUID(),displayName:'Usage customer',
      phoneE164:'+3519'+String(Math.floor(Math.random()*100000000)).padStart(8,'0'),
    }});
    const conversation=await admin.conversation.create({data:{
      tenantId,id:randomUUID(),customerId:customer.id,
      channelConnectionId:channel.id,lastMessageAt:new Date(),
    }});
    return conversation.id;
  };
  const write=async(tenantId:string,turnId:string,outcome:'completed'|'failed',
    inputTokens:number,outputTokens:number,createdAt?:Date)=>
    admin.aiUsageEvent.create({data:{
      tenantId,id:randomUUID(),turnId,
      providerKey:'mock',modelKey:'configured-model',
      outcome,inputTokens,outputTokens,
      ...(createdAt?{createdAt}:{})
    }});
  try {
    await waitReady(base);
    const [owner,outsider]=await Promise.all([register(),register()]);
    const a=await json<{id:string}>(await request('POST','/tenants',{
      name:'Observation A',countryCode:'PT',timezone:'Europe/Lisbon',
    },owner.token),201);
    const b=await json<{id:string}>(await request('POST','/tenants',{
      name:'Observation B',countryCode:'PT',timezone:'Europe/Lisbon',
    },outsider.token),201);
    const path='/tenants/'+a.id+'/billing/usage';
    assert.equal((await request('GET',path)).status,401);
    assert.equal((await request('GET',path,undefined,outsider.token)).status,404);
    await admin.membership.create({data:{
      tenantId:a.id,userId:outsider.id,role:'viewer',
    }});
    assert.equal((await request('GET',path,undefined,outsider.token)).status,403);
    assert.equal((await request('POST',path,{billable:true},owner.token)).status,404);
    const empty=await json<{
      events:string;inputTokens:string;outputTokens:string;billable:boolean;
      financialStatus:string;entitlementGranted:boolean;outcomes:object[];
    }>(await request('GET',path,undefined,owner.token),200);
    assert.deepEqual([empty.events,empty.inputTokens,empty.outputTokens],['0','0','0']);
    assert.equal(empty.billable,false);
    assert.equal(empty.entitlementGranted,false);
    assert.equal(empty.financialStatus,'not_defined');
    assert.deepEqual(empty.outcomes,[]);

    const ca=await fixtures(a.id);
    const cb=await fixtures(b.id);
    const firstTurn=await createTurn(a.id,ca);
    const first=await write(a.id,firstTurn,'completed',120,30);
    const otherTurn=await createTurn(b.id,cb);
    await write(b.id,otherTurn,'completed',999,50);
    const oldDate=new Date(Date.now()-45*86400000);
    const oldTurn=await createTurn(a.id,ca,45);
    await write(a.id,oldTurn,'completed',500,100,oldDate);
    const twiceTurn=await createTurn(a.id,ca);
    const attempted=await Promise.allSettled([
      write(a.id,twiceTurn,'completed',11,7),
      write(a.id,twiceTurn,'completed',11,7),
    ]);
    assert.equal(attempted.filter(v=>v.status==='fulfilled').length,1);
    assert.equal(attempted.filter(v=>v.status==='rejected').length,1);
    assert.equal(await admin.billingUsageObservation.count({where:{tenantId:a.id}}),3);
    assert.equal(await admin.aiUsageEvent.count({where:{tenantId:a.id}}),3);
    const observation=await admin.billingUsageObservation.findUniqueOrThrow({
      where:{tenantId_sourceEventId:{tenantId:a.id,sourceEventId:first.id}},
    });
    assert.equal(observation.turnId,firstTurn);
    assert.equal(observation.inputTokens,120);
    assert.equal(observation.outputTokens,30);
    assert.equal(observation.billable,false);

    const usage=await json<{
      meter:string;events:string;inputTokens:string;outputTokens:string;
      billable:boolean;financialStatus:string;entitlementGranted:boolean;
      window:{days:number;from:string;to:string};
      outcomes:Array<{outcome:string;events:string;inputTokens:string;outputTokens:string}>;
    }>(await request('GET',path,undefined,owner.token),200);
    assert.equal(usage.meter,'ai_turn_tokens_observed');
    assert.equal(usage.events,'2');
    assert.equal(usage.inputTokens,'131');
    assert.equal(usage.outputTokens,'37');
    assert.equal(usage.billable,false);
    assert.equal(usage.entitlementGranted,false);
    assert.equal(usage.financialStatus,'not_defined');
    assert.equal(usage.window.days,30);
    assert.equal(usage.outcomes.length,1);
    assert.deepEqual(usage.outcomes[0],{
      outcome:'completed',events:'2',inputTokens:'131',outputTokens:'37',
    });
    assert(!JSON.stringify(usage).includes('mock:'));
    assert(!JSON.stringify(usage).includes('providerKey'));
    assert(!JSON.stringify(usage).includes('turnId'));
    // P10: use the same real HTTP/RBAC/RLS test fixture to prove analytics
    // never imports another tenant's conversations or AI turns.
    const analyticsPath='/tenants/'+a.id+'/analytics/summary';
    assert.equal((await request('GET',analyticsPath)).status,401);
    assert.equal((await request('GET',analyticsPath,undefined,outsider.token)).status,403);
    assert.equal((await request('GET','/tenants/'+b.id+'/analytics/summary',undefined,owner.token)).status,404);
    const analytics=await json<{
      period:{kind:string;from:string;to:string};financialStatus:string;
      billable:boolean;entitlementGranted:boolean;conversationsOpened:string;
      aiTurnsStarted:string;aiTurnsCompleted:string;aiTurnsFailed:string;
      auditEvents:string;
    }>(await request('GET',analyticsPath,undefined,owner.token),200);
    assert.equal(analytics.conversationsOpened,'1');
    assert.equal(analytics.aiTurnsStarted,'2');
    assert.equal(analytics.aiTurnsCompleted,'2');
    assert.equal(analytics.aiTurnsFailed,'0');
    assert.match(analytics.auditEvents,/^\d+$/);
    assert(BigInt(analytics.auditEvents) >= 1n,'tenant creation must create an audit event');
    assert.equal(analytics.billable,false);
    assert.equal(analytics.entitlementGranted,false);
    assert.equal(analytics.financialStatus,'not_defined');
    assert.equal(analytics.period.kind,'rolling_30_days_utc');
    assert(!JSON.stringify(analytics).includes('providerKey'));
    const otherAnalytics=await json<{conversationsOpened:string;aiTurnsStarted:string}>(
      await request('GET','/tenants/'+b.id+'/analytics/summary',undefined,outsider.token),200);
    assert.equal(otherAnalytics.conversationsOpened,'1');
    assert.equal(otherAnalytics.aiTurnsStarted,'1');
    const foreign=await json<{events:string;inputTokens:string}>(
      await request('GET','/tenants/'+b.id+'/billing/usage',undefined,outsider.token),200);
    assert.equal(foreign.events,'1');
    assert.equal(foreign.inputTokens,'999');

    // No endpoint may turn a technical observation into a charge, and
    // not even a privileged direct UPDATE/DELETE can rewrite the journal.
    await assert.rejects(admin.billingUsageObservation.update({
      where:{tenantId_sourceEventId:{tenantId:a.id,sourceEventId:first.id}},
      data:{inputTokens:12345},
    }));
    await assert.rejects(admin.billingUsageObservation.delete({
      where:{tenantId_sourceEventId:{tenantId:a.id,sourceEventId:first.id}},
    }));
    await assert.rejects(admin.aiUsageEvent.delete({
      where:{tenantId_id:{tenantId:a.id,id:first.id}},
    }));
    const [grants]=await admin.$queryRaw<Array<{
      selectCol:boolean;insertRow:boolean;updateRow:boolean;deleteRow:boolean;
    }>>`SELECT
       has_column_privilege('melissa_runtime','billing_usage_observations',
         'input_tokens','SELECT') AS "selectCol",
       has_table_privilege('melissa_runtime','billing_usage_observations',
         'INSERT') AS "insertRow",
       has_table_privilege('melissa_runtime','billing_usage_observations',
         'UPDATE') AS "updateRow",
       has_table_privilege('melissa_runtime','billing_usage_observations',
         'DELETE') AS "deleteRow"`;
    assert.deepEqual(grants,{
      selectCol:true,insertRow:false,updateRow:false,deleteRow:false,
    });
    const [rls]=await admin.$queryRaw<Array<{
      relrowsecurity:boolean;relforcerowsecurity:boolean;
    }>>`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relname='billing_usage_observations'`;
    assert.deepEqual(rls,{relrowsecurity:true,relforcerowsecurity:true});
    const [outside]=await deps.db.$queryRaw<Array<{n:bigint}>>`
      SELECT COUNT(source_event_id)::bigint AS n FROM billing_usage_observations`;
    assert.equal(outside?.n,0n,'RLS denies unscoped event enumeration');
    assert.equal(await admin.billingUsageObservation.count({where:{tenantId:b.id}}),1);
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
