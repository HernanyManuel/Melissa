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
import { StripePortalGateway } from '../src/billing/stripe-test-portal-provider';
import { waitReady } from './wait-ready';

// Real Nest authentication and PostgreSQL tenant RLS; Stripe is mocked.
// prettier-ignore
test('test Portal checks RBAC, linked Checkout, rate limit and disabled entitlements', { timeout: 45000 }, async () => {
  assert(process.env.MIGRATION_DATABASE_URL);
  const app=await NestFactory.create(AppModule,{logger:false});
  const cfg=app.get<Configuration>(CONFIG);
  const deps=app.get(Dependencies);
  const portal=app.get(StripePortalGateway);
  const admin=new PrismaClient({datasources:{db:{url:process.env.MIGRATION_DATABASE_URL}}});
  const verification=new Map<string,string>();
  app.get(IdentityMail).send=async(email,purpose,token)=>{
    if(purpose==='verify') verification.set(email,token);
  };
  configureHttp(app,cfg,false);
  await app.listen(0,'127.0.0.1');
  const base=await app.getUrl();
  const call=(method:string,path:string,body?:object,token?:string)=>
    fetch(base+'/api/v1'+path,{method,headers:{
      Origin:cfg.CORS_ORIGIN,'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{})},
      body:body?JSON.stringify(body):undefined});
  const json=async<T>(r:Response,status:number):Promise<T>=>{
    assert.equal(r.status,status,await r.clone().text());
    return r.json() as Promise<T>;
  };
  const register=async()=>{
    const email='portal-'+randomUUID()+'@example.test';
    const password='Portal-Pass-123!';
    assert.equal((await call('POST','/auth/register',{
      email,password,name:'Portal user',termsAccepted:true})).status,202);
    assert.equal((await call('POST','/auth/verify',{token:verification.get(email)})).status,204);
    const login=await json<{access_token:string}>(
      await call('POST','/auth/login',{email,password}),200);
    const user=await admin.user.findUniqueOrThrow({where:{email}});
    return {token:login.access_token,id:user.id};
  };
  let calls=0;
  portal.open=async(input)=>{
    calls++;
    assert.equal(input.configurationId,'bpc_ReadOnly');
    return {url:'https://billing.stripe.com/p/session/test_'+randomUUID().replace(/-/g,'')};
  };
  try {
    await waitReady(base);
    const [owner,other]=await Promise.all([register(),register()]);
    const tenant=await json<{id:string}>(await call('POST','/tenants',{
      name:'Test portal',countryCode:'PT',timezone:'Europe/Lisbon'},owner.token),201);
    const foreign=await json<{id:string}>(await call('POST','/tenants',{
      name:'Other portal',countryCode:'PT',timezone:'Europe/Lisbon'},other.token),201);
    const endpoint='/tenants/'+tenant.id+'/billing/portal';
    assert.equal((await call('POST',endpoint,undefined,owner.token)).status,404);
    cfg.STRIPE_TEST_PORTAL_ENABLED='true';
    cfg.STRIPE_TEST_SECRET_KEY='sk_test_'+'a'.repeat(32);
    cfg.STRIPE_TEST_PORTAL_CONFIGURATION_ID='bpc_ReadOnly';
    cfg.STRIPE_TEST_CHECKOUT_RETURN_ORIGIN='http://localhost:8080';
    assert.equal((await call('POST',endpoint)).status,401);
    assert.equal((await call('POST',endpoint,undefined,other.token)).status,404);
    await admin.membership.create({
      data:{tenantId:tenant.id,userId:other.id,role:'viewer'}});
    assert.equal((await call('POST',endpoint,undefined,other.token)).status,403);
    assert.equal((await call('POST',endpoint,undefined,owner.token)).status,409);
    const planId=randomUUID();
    const priceId='price_'+randomUUID().replace(/-/g,'');
    await admin.billingPlan.create({data:{
      id:planId,key:'portal-'+randomUUID(),name:'Portal test plan',
      currency:'EUR',basePrice:'19.990000',billingInterval:'month',
      includedConversations:10,includedMessages:null,includedStaff:1,
      includedChannels:1,includedLocations:1,
      overagePricePerConversation:'0',features:{},
      active:true, stripePriceId:priceId,
      stripeProductId:'prod_'+randomUUID().replace(/-/g,'')}});
    const sub=await admin.tenantSubscription.create({data:{
      id:randomUUID(),tenantId:tenant.id,planId,provider:'stripe',
      providerCustomerId:'cus_'+randomUUID().replace(/-/g,''),
      providerSubscriptionId:'sub_'+randomUUID().replace(/-/g,''),
      status:'active',currentPeriodStart:new Date(Date.now()-86400000),
      currentPeriodEnd:new Date(Date.now()+86400000)}});
    assert.equal((await call('POST',endpoint,undefined,owner.token)).status,409,
      'unlinked legacy subscription denied');
    const sessionId='cs_test_'+randomUUID().replace(/-/g,'');
    const intent=await admin.stripeCheckoutIntent.create({data:{
      id:randomUUID(),tenantId:tenant.id,planId,requestId:randomUUID(),
      stripePriceId:priceId,status:'ready',checkoutSessionId:sessionId,
      checkoutUrl:'https://checkout.stripe.com/c/pay/'+sessionId,
      expiresAt:new Date(Date.now()+3600000)}});
    await admin.tenantSubscription.update({
      where:{tenantId:tenant.id},data:{checkoutSessionId:sessionId}});
    const launched=await json<{portalUrl:string}>(
      await call('POST',endpoint,undefined,owner.token),201);
    assert(launched.portalUrl.startsWith('https://billing.stripe.com/'));
    assert.equal(calls,1);
    assert.equal((await call('POST',endpoint,undefined,owner.token)).status,429);
    assert.equal(calls,1);
    assert.equal((await call('POST','/tenants/'+foreign.id+'/billing/portal',
      undefined,owner.token)).status,404);
    assert.equal(await admin.auditEvent.count({
      where:{tenantId:tenant.id,action:'billing.portal.created',targetId:sub.id}}),1);
    const audit=await admin.auditEvent.findMany({
      where:{tenantId:tenant.id,action:'billing.portal.created'}});
    assert(!JSON.stringify(audit).includes('billing.stripe.com'),
      'bearer Portal URLs are not persisted in audit logs');
    const snapshot=await json<{entitlements:{
      automationEnabled:boolean;billingVerified:boolean;
    }}>(await call('GET','/tenants/'+tenant.id+'/billing/subscription',
      undefined,owner.token),200);
    assert.equal(snapshot.entitlements.automationEnabled,false);
    assert.equal(snapshot.entitlements.billingVerified,false);
    const [access]=await deps.db.$queryRaw<Array<{canRead:boolean;canUpdate:boolean}>>`
      SELECT has_column_privilege(current_user,'subscriptions',
        'provider_customer_id','SELECT') AS "canRead",
        has_table_privilege(current_user,'subscriptions','UPDATE') AS "canUpdate"`;
    assert.deepEqual(access,{canRead:true,canUpdate:false});
    assert.equal(await deps.db.tenantSubscription.count(),0);
    assert.equal(intent.tenantId,tenant.id);
  } finally {
    await app.close();
    await admin.$disconnect();
  }
});
