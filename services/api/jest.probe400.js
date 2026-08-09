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
// assumed), check this.statusCode after `.status()` has already set it, record only
// fixed diagnostic metadata, append JSONL, never mutate the response. Artifact
// retention is broader than an individual job log, so response bodies and request
// URLs are deliberately not captured: both can contain caller-controlled secrets.
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

// Retain only the matched route template, method and status. `originalUrl` includes
// query values, and a JSON error body can echo invalid credentials or request input.
// A route template is application-defined rather than caller-controlled; omit it
// when Express has no matched string route rather than falling back to a raw URL.
function routeTemplate(req){
  try{return typeof req.route.path==='string' ? req.route.path : undefined;}catch(e){}
}
const express=require(process.cwd()+'/node_modules/express');
const origJson=express.response.json;
express.response.json=function(body){
  try{
    if(this.statusCode===400){
      rec({
        kind:'sent-400',
        method:(this.req||{}).method,
        route:routeTemplate(this.req||{}),
        status:this.statusCode,
        test:tn(),
      });
    }
  }catch(e){}
  return origJson.call(this, body);
};
