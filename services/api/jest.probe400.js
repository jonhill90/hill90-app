// 400 CAPTURE PROBE. app#605: the unexplained-api-failure class has four instruments
// (jest.auth401.js, jest.identityguard.js, jest.audit.js, jest.loopdelay.js) and none
// of them inspects a response status code for 400 — verified by reading each one, not
// assumed from its name (see app#605). So when a genuine 400 occurs in this suite,
// there is nothing to read afterwards and the class stays unexplained forever, same
// trap jest.auth401.js already closed for 401.
//
// SAME MODEL AS jest.auth401.js, deliberately: hook express.response.json (this
// codebase's routes consistently send error bodies via res.status(N).json({...}),
// confirmed by reading mcp-servers.ts/workflows.ts/agents.ts directly rather than
// assumed), check this.statusCode after `.status()` has already set it, record method
// + path + the response body, append JSONL, never mutate the response.
const fs=require('fs');
const path=require('path');
// Off by default. PROBE_400=1 enables it via jest.config.js.
//
// WORKSPACE-RELATIVE, NOT /tmp — same reason as jest.auth401.js: /tmp is outside the
// GitHub Actions workspace, so actions/upload-artifact cannot see it. test-artifacts/
// (relative to services/api) is already covered by the repo's root .gitignore and
// already collected as a whole directory by ci.yml's "Collect flake evidence" step.
const OUT=process.env.PROBE_400_OUT||'test-artifacts/probe400.jsonl';
try{fs.mkdirSync(path.dirname(OUT),{recursive:true});}catch(e){}
function rec(o){try{o.ts=Date.now();fs.appendFileSync(OUT,JSON.stringify(o)+'\n');}catch(e){}}
function tn(){try{return (expect.getState&&expect.getState().currentTestName)||'';}catch(e){return '';}}
// Positive control the probe itself, not just the thing it watches for: this line
// runs on load, in every worker, whether or not a 400 ever occurs — so an empty
// capture file is distinguishable from a probe that never ran, same discipline as
// jest.auth401.js's authprobe-installed record.
rec({event:'400probe-installed'});

// RECORD ENOUGH TO DIAGNOSE: method, path, status, and the response body — capped,
// not truncated to near-nothing like auth401's 120 chars, because a 400's body is
// usually the one thing that names WHICH validation failed and that is the entire
// point of capturing it. 4000 chars comfortably covers this codebase's JSON error
// bodies (typically a single { error: "..." } object) with headroom, without risking
// an unbounded write if something pathological is ever bound into a response.
const BODY_CAP=4000;
const express=require(process.cwd()+'/node_modules/express');
const origJson=express.response.json;
express.response.json=function(body){
  try{
    if(this.statusCode===400){
      let bodyText;
      try{ bodyText=JSON.stringify(body); }catch(e){ bodyText=String(body); }
      rec({
        kind:'sent-400',
        method:(this.req||{}).method,
        path:(this.req||{}).originalUrl,
        status:this.statusCode,
        body:bodyText?bodyText.slice(0,BODY_CAP):bodyText,
        test:tn(),
      });
    }
  }catch(e){}
  return origJson.call(this, body);
};
