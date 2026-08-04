// 401 CAUSE PROBE. auth.ts swallows the jwt error (`} catch {`), so a 401 in a log
// is causeless. This records, test-side only, WHICH of the five 401 paths fired and
// what jsonwebtoken actually threw — which separates the candidate causes:
//   TokenExpiredError            -> expiry race / clock skew (carries expiredAt)
//   JsonWebTokenError: invalid signature -> key material differs signer vs verifier
//   JsonWebTokenError: jwt issuer/audience invalid -> wrong verifier configuration
//   'Missing or invalid Authorization header'      -> the request lost its header
const fs=require('fs');
const path=require('path');
// Off by default. AUTH_401_PROBE=1 enables it via jest.config.js.
//
// WORKSPACE-RELATIVE, NOT /tmp — caught before shipping, not after. /tmp is
// outside the GitHub Actions workspace, so actions/upload-artifact cannot see
// it: a collection step pointed at it would run, report success, and collect
// nothing, forever, with no error to notice — the exact trap #350 named.
// test-artifacts/ (relative to services/api) matches services/ui's #117
// flake-evidence convention and is already covered by the repo's root
// .gitignore.
const OUT=process.env.AUTH_OUT||'test-artifacts/auth401.jsonl';
try{fs.mkdirSync(path.dirname(OUT),{recursive:true});}catch(e){}
function rec(o){try{o.ts=Date.now();fs.appendFileSync(OUT,JSON.stringify(o)+'\n');}catch(e){}}
function tn(){try{return (expect.getState&&expect.getState().currentTestName)||'';}catch(e){return '';}}
rec({event:'authprobe-installed'});

// 1. what jwt.verify threw
const jwt=require(process.cwd()+'/node_modules/jsonwebtoken');
const origVerify=jwt.verify;
jwt.verify=function(...a){
  try{ return origVerify.apply(this,a); }
  catch(e){
    rec({kind:'verify-threw', name:e.name, message:e.message,
         expiredAt:e.expiredAt?new Date(e.expiredAt).toISOString():undefined,
         now:new Date().toISOString(), test:tn()});
    throw e;
  }
};

// 2. which 401 body was sent (the five paths are distinguishable by message)
const express=require(process.cwd()+'/node_modules/express');
const origJson=express.response.json;
express.response.json=function(body){
  try{ if(this.statusCode===401) rec({kind:'sent-401', body:JSON.stringify(body).slice(0,120), url:(this.req||{}).originalUrl, test:tn()}); }catch(e){}
  return origJson.call(this, body);
};
