import {openSync,closeSync,fstatSync,readFileSync,lstatSync,realpathSync,constants} from 'node:fs';
import {isAbsolute,resolve,dirname} from 'node:path';
import {isIP} from 'node:net';

const fail=()=>{throw new Error('invalid_production_configuration');};
function fields(value,required,optional=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))fail();
}
function absolute(path) {if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)fail();}
function privateStat(stat) {
  if(stat.uid!==process.getuid()||(stat.mode&0o077)!==0)fail();
}
export function readPrivateFile(path) {
  absolute(path);let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);privateStat(stat);
    if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)fail();
    return readFileSync(fd,'utf8');
  }finally{if(fd!==undefined)closeSync(fd);}
}
function database(path) {
  absolute(path);const parent=dirname(path),stat=lstatSync(parent);privateStat(stat);
  if(!stat.isDirectory()||realpathSync(parent)!==parent)fail();
  try {
    const file=lstatSync(path);privateStat(file);
    if(!file.isFile()||file.nlink!==1)fail();
  }catch(error){if(error.code!=='ENOENT')throw error;}
}

// Only JSON data is accepted. SDK/fetch injections remain in-process test seams.
export function validateProductionConfig(config,now=Date.now()) {
  fields(config,['listener','expiresAt','localOAuth','photon','photonProjectSecret','messageHandling']);
  const deadline=Date.parse(config.expiresAt);
  if(typeof config.expiresAt!=='string'||!Number.isFinite(deadline)||deadline<=now||deadline>now+3600000)fail();
  const listener=config.listener;
  fields(listener,['mode','host','port'],['certFile','keyFile']);
  if(!Number.isSafeInteger(listener.port)||listener.port<0||listener.port>65535||!isIP(listener.host))fail();
  if(listener.mode==='proxy'){
    if(!['127.0.0.1','::1'].includes(listener.host)||listener.certFile!==undefined||listener.keyFile!==undefined)fail();
  }else if(listener.mode==='tls'){
    absolute(listener.certFile);absolute(listener.keyFile);
  }else fail();
  const auth=config.localOAuth;
  fields(auth,['issuer','resource','clientId','redirectUris','ownerSubject','databasePath','jwks','cookieKeys','google']);
  fields(auth.google,['clientId','clientSecret']);
  fields(config.photon,['projectId','ownerAddress','line','dm']);
  fields(config.messageHandling,['databasePath'],['workerIntervalMs','sendTimeoutMs']);
  database(auth.databasePath);database(config.messageHandling.databasePath);
  if(auth.databasePath===config.messageHandling.databasePath)fail();
  // Detailed identity/key/route checks are performed by the existing host before listening.
  return {...config,localOAuth:{...auth,trustProxy:listener.mode==='proxy'}};
}

export function loadProductionConfig(path) {
  try{return validateProductionConfig(JSON.parse(readPrivateFile(path)));}
  catch{throw new Error('invalid_production_configuration');}
}
