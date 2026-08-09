// TIMEOUT CAPTURE PROBE (in-worker half). app#605: the same instrumentation gap
// as jest.probe400.js, for the fourth uninstrumented class named in that issue —
// a request that never resolves. jest.loopdelay.js records per-test duration for
// EVERY test, pass or fail, with no correlation to outcome; it is root-cause
// context to read AFTER you already know which test timed out, not a detector.
//
// TWO HALVES, DELIBERATELY SPLIT ACROSS TWO FILES, because they run in two
// different Jest processes:
//   - THIS FILE (setupFilesAfterEnv, runs inside the same sandboxed worker
//     context as the test itself) tracks HTTP requests in flight at the Node
//     core http/https level, and records which ones are still open at test
//     teardown — the "where" half.
//   - jest.timeoutprobe.reporter.js (a Jest Reporter, runs in Jest's own main
//     process) reads the ACTUAL, final per-test result jest-circus produces,
//     including jest's own "Exceeded timeout of Nms" message — jest's real
//     timeout signal, not a duration threshold this probe invents itself. That
//     is the "detector" half, and the elapsed-ms half.
//
// WHY NOT ONE FILE HOOKING jest-circus DIRECTLY: tried first, and it silently
// did not work — verified, not assumed. jest-circus's own internal event bus
// (state.js's addEventHandler, reached via an absolute path the same way
// jest.auth401.js reaches jsonwebtoken/express) registered without error from
// inside this setupFilesAfterEnv file, but never once received a dispatched
// event, for ANY event name, confirmed with unconditional debug logging on
// every event fired. Jest loads each test file's setup into a sandboxed module
// registry; the actual jest-circus instance dispatching real events is a
// different loaded copy of the same package, so a handler pushed from inside
// the sandbox lands in an array the real dispatcher never reads from. A
// Reporter is the documented, supported way to observe final per-test
// outcomes; this file does not touch jest-circus internals at all.
const fs=require('fs');
const path=require('path');
// Off by default. PROBE_TIMEOUT=1 enables it via jest.config.js.
//
// WORKSPACE-RELATIVE, NOT /tmp — same reason as jest.auth401.js and
// jest.probe400.js. test-artifacts/ is already collected as a whole directory.
// SAME FILE the reporter half (jest.timeoutprobe.reporter.js) writes to — one
// capture file for the whole timeout story, "where" and "elapsed ms" both
// readable from one place, correlated by test name.
const OUT=process.env.PROBE_TIMEOUT_OUT||'test-artifacts/timeoutprobe.jsonl';
try{fs.mkdirSync(path.dirname(OUT),{recursive:true});}catch(e){}
function rec(o){try{o.ts=Date.now();fs.appendFileSync(OUT,JSON.stringify(o)+'\n');}catch(e){}}
function tn(){try{return (expect.getState&&expect.getState().currentTestName)||'';}catch(e){return '';}}
// Positive-control-by-construction, same discipline as jest.auth401.js and
// jest.probe400.js: this line runs on load in every worker, so an empty
// capture file is distinguishable from a probe that never ran.
rec({event:'timeoutprobe-installed'});

// Track HTTP requests in flight at the Node core http/https level (not
// supertest/superagent's own API, which has none suited to this) so this
// works regardless of which client library issues the call. A request is "in
// flight" from the moment http.request()/https.request() returns until its
// 'response', 'error' or 'close' event fires.
const http=require('http');
const https=require('https');
let seq=0;
const inFlight=new Map();
function wrapRequest(mod){
  const orig=mod.request;
  if(!orig || orig.__probeTimeoutWrapped) return;
  function wrapped(...args){
    const req=orig.apply(this,args);
    const id=++seq;
    // Node's http.request supports (options[, cb]) or (url[, options][, cb]).
    // Keep just the method: a URL or options.path can contain query credentials,
    // and these records are retained as CI artifacts.
    let method='GET';
    try{
      const firstArgIsUrl=typeof args[0]==='string' || args[0] instanceof URL;
      const opts=firstArgIsUrl ? (args[1] && typeof args[1]==='object' ? args[1] : {}) : (args[0]||{});
      method=opts.method || req.method || 'GET';
    }catch(e){}
    const entry={id, method, startedAt: Date.now(), test: tn()};
    inFlight.set(id, entry);
    const clear=()=>{ inFlight.delete(id); };
    try{
      req.once('response', clear);
      req.once('error', clear);
      req.once('close', clear);
    }catch(e){}
    return req;
  }
  wrapped.__probeTimeoutWrapped=true;
  mod.request=wrapped;
}
wrapRequest(http);
wrapRequest(https);

// THE "WHERE" HALF. A normal, passing test has awaited every request it
// issued by the time its own afterEach runs, so inFlight is empty here for
// the overwhelming majority of tests — recording only when non-empty keeps
// this from becoming per-test noise. For a test whose own timeout jest-circus
// is about to declare (or just declared), this is exactly the request(s) that
// never got a response — correlated with the reporter's own 'test-timeout'
// record (same file) by test name.
//
// Global afterEach, not a jest-circus hook: this is the PUBLIC API, already
// available as a global by the time setupFilesAfterEnv runs — same mechanism
// jest.identityguard.js already relies on for its own per-test check.
afterEach(() => {
  if(inFlight.size===0) return;
  const now=Date.now();
  const pendingRequests=Array.from(inFlight.values()).map((e)=>({
    method:e.method, elapsedMs: now-e.startedAt,
  }));
  rec({
    kind:'requests-open-at-teardown',
    test: tn(),
    pendingRequests,
  });
});
