import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const module=await import('./photon-recovery-store.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const identity={projectId:'fixture',ownerAddress:'+15550000001',dm:'any;-;+15550000001',line:'shared',issuer:'https://issuer.example/',clientId:'client',subject:'owner'};
function fixture(t){
  assert.equal(typeof module.openPhotonRecoveryStore,'function','durable recovery store must exist');
  const dir=mkdtempSync(join(tmpdir(),'photon-checkpoint-')),path=join(dir,'recovery.sqlite'),handles=[];
  const open=(changes={})=>{const s=module.openPhotonRecoveryStore({path,identity,messageStoreId:'generation-1',...changes});handles.push(s);return s;};
  t.after(()=>{handles.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});return {open,path};
}
test('checkpoint commits only contiguous receipts and survives reopen with duplicate fingerprint',t=>{
  const {open,path}=fixture(t);let s=open();assert.equal(s.checkpoint(),0);
  assert.throws(()=>s.commit(2,'b'.repeat(64)),/sequence_gap/);
  s.commit(1,'a'.repeat(64));s.close();s=open();assert.equal(s.checkpoint(),1);assert.equal(s.receipt(1),'a'.repeat(64));
  assert.throws(()=>s.commit(1,'b'.repeat(64)),/sequence_gap/);assert.equal(statSync(path).mode&0o777,0o600);
});
test('checkpoint refuses another owner, restored message generation and competing process handle',t=>{
  const {open}=fixture(t);let s=open();assert.throws(()=>open(),/database_in_use/);s.close();
  assert.throws(()=>open({identity:{...identity,subject:'other'}}),/identity_mismatch/);
  assert.throws(()=>open({messageStoreId:'restored-generation'}),/identity_mismatch/);
});
