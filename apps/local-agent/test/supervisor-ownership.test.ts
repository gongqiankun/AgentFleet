import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {acquireSupervisorLease} from '../src/supervisor-ownership.js';
import {superviseAgent} from '../src/supervisor.js';
import {StateStore} from '../src/store.js';
test('a second supervisor cannot own update/rollback state while the first is live',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'supervisor-owner-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const release=await acquireSupervisorLease(dir);assert.ok(release);
 try{assert.equal(await acquireSupervisorLease(dir),undefined);}finally{release();}
 const next=await acquireSupervisorLease(dir);assert.ok(next);next();
});
test('a pre-existing foreground worker prevents a new supervisor from touching update state',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'supervisor-foreground-'));const store=new StateStore(dir);await store.initialize();
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const lease=await store.acquireRuntimeOwnership();const path=join(dir,'update-state.json');await writeFile(path,'must remain unchanged');
 await superviseAgent(dir,new AbortController().signal);
 assert.equal(await readFile(path,'utf8'),'must remain unchanged');
 await store.releaseRuntimeOwnership(lease);
});

test('a supervisor lease held by a dead process is reclaimed',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const dir=await mkdtemp(join(tmpdir(),'supervisor-stale-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const initial=await acquireSupervisorLease(dir);assert.ok(initial);initial();
 const db=new DatabaseSync(join(dir,'supervisor.sqlite'));
 db.prepare('INSERT INTO owner(id,pid,start,token) VALUES(1,?,?,?)').run(2147483647,'stale','old');db.close();
 const release=await acquireSupervisorLease(dir);assert.ok(release);release();
});
