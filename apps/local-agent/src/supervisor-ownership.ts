import {DatabaseSync} from 'node:sqlite';
import {mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {platformProcessStartToken} from './store.js';
import {AgentError} from './errors.js';

type Owner={pid:number;start:string;token:string};
async function live(owner:Owner):Promise<boolean>{
  const start=await platformProcessStartToken(owner.pid);
  if(start)return start===owner.start;
  try {process.kill(owner.pid,0);} catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;}
  throw new AgentError('PROCESS_IDENTITY_UNAVAILABLE','cannot safely establish supervisor process identity');
}
/** Separate from the worker lease: competing parents must never rewrite rollback state. */
export async function acquireSupervisorLease(dataDir:string):Promise<(() => void)|undefined>{
  await mkdir(dataDir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(dataDir,'supervisor.sqlite'),{allowExtension:false});
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,start TEXT NOT NULL,token TEXT NOT NULL) STRICT');
  const read=()=>db.prepare('SELECT pid,start,token FROM owner WHERE id=1').get() as Owner|undefined;
  try {
    const start=await platformProcessStartToken(process.pid);
    if(!start)throw new AgentError('PROCESS_IDENTITY_UNAVAILABLE','cannot read supervisor process identity');
    for(;;){
      const observed=read();const active=observed?await live(observed):false;
      db.exec('BEGIN IMMEDIATE');
      const current=read();
      if(current?.token!==observed?.token){db.exec('ROLLBACK');continue;}
      if(active){db.exec('ROLLBACK');db.close();return undefined;}
      const token=randomUUID();
      db.prepare('INSERT OR REPLACE INTO owner(id,pid,start,token) VALUES(1,?,?,?)').run(process.pid,start,token);db.exec('COMMIT');
      return ()=>{try{db.prepare('DELETE FROM owner WHERE id=1 AND token=?').run(token);}finally{db.close();}};
    }
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');db.close();throw error;}
}
/** Protect workers launched by older parents or a foreground command. */
export async function hasLiveRuntimeOwner(dataDir:string):Promise<boolean>{
  const file=join(dataDir,'state.sqlite');
  try{await stat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  const db=new DatabaseSync(file,{readOnly:true,allowExtension:false});
  let owner:Owner|undefined;
  try{owner=db.prepare('SELECT pid,process_start_token AS start,owner_token AS token FROM runtime_owner WHERE singleton=1').get() as Owner|undefined;}
  finally{db.close();}
  return owner?live(owner):false;
}
