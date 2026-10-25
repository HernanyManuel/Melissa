import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { TenantService } from '../src/tenancy/tenant.service';

// prettier-ignore
test('P10: summary is tenant-scoped, technical-only, and uses one fixed UTC window',async()=>{
  const tenantId='00000000-0000-4000-8000-000000000010';
  const actor={userId:'00000000-0000-4000-8000-000000000020',sessionId:'00000000-0000-4000-8000-000000000030'};
  const calls: unknown[][]=[];
  const tx={$queryRaw:async(...args:unknown[])=>{
    calls.push(args);
    return calls.length===1?[{count:'3'}]:calls.length===2?
      [{started:'5',completed:'2',failed:'1',running:'2'}]:[{count:'7'}];
  }};
  const scoped=async(a:unknown,t:string,p:string,fn:(t:typeof tx)=>Promise<unknown>)=>{
    assert.equal(a,actor);assert.equal(t,tenantId);assert.equal(p,'audit:read');
    return fn(tx);
  };
  const service=new AnalyticsService({scoped} as unknown as TenantService);
  const result=await service.summary(actor,tenantId);
  assert.equal(result.conversationsOpened,'3');
  assert.equal(result.aiTurnsStarted,'5');
  assert.equal(result.aiTurnsCompleted,'2');
  assert.equal(result.aiTurnsFailed,'1');
  assert.equal(result.aiTurnsRunning,'2');
  assert.equal(result.auditEvents,'7');
  assert.equal(result.financialStatus,'not_defined');
  assert.equal(result.billable,false);
  assert.equal(result.entitlementGranted,false);
  assert.equal(result.period.kind,'rolling_30_days_utc');
  assert.equal(result.period.to.getTime()-result.period.from.getTime(),30*86400000);
  assert.equal(calls.length,3);
});
