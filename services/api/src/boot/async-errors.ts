/**
 * Route async handler rejections into Express's error pipeline.
 *
 * WHY THIS EXISTS. Express 4 ignores the value a route handler returns. An
 * `async` handler therefore returns a promise nobody holds, so when it rejects:
 *
 *   1. Express never calls `next(err)`, so the request is never answered — the
 *      client hangs until it times out; and
 *   2. the rejection is unhandled, and Node exits on an unhandled rejection by
 *      default. This service registers no `process.on('unhandledRejection')`.
 *
 * Measured against the production runtime rather than assumed:
 *
 *   $ docker run --rm node:20-alpine node repro.js
 *   PROCESS EXIT CODE 1
 *
 * So one database error, on any handler whose awaits are not inside a
 * try/catch, took the API down. Eighteen handlers were in that state.
 *
 * WHY AT THE BOUNDARY rather than at each site. Adding a try/catch to eighteen
 * handlers fixes eighteen handlers; the nineteenth, written next month, arrives
 * unprotected and the failure mode is a dead container rather than a failing
 * test. Patching the one place Express invokes a handler makes the boundary
 * incapable of losing a rejection, which is the difference between fixing a
 * design and cataloguing its instances. Per-site try/catch is still correct
 * where a handler wants a *specific* status; this is the floor beneath them.
 *
 * This is the mechanism `express-async-errors` uses, vendored — about twenty
 * lines against a new dependency in the path of every request.
 *
 * IT FAILS LOUDLY. Reaching into `express/lib/router/layer` is version-coupled,
 * so if the shape is not what this expects the import throws at startup rather
 * than silently not patching. A guard that quietly does nothing is the failure
 * mode this repository keeps paying for.
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

const Layer = require('express/lib/router/layer');

if (typeof Layer !== 'function' || typeof Layer.prototype?.handle_request !== 'function') {
  throw new Error(
    '[async-errors] express/lib/router/layer does not expose handle_request. ' +
      'Express internals changed; this patch must be revisited rather than dropped — ' +
      'without it an async handler rejection kills the process.'
  );
}

const PATCH_FLAG = '__hill90AsyncErrorsPatched';
const original = Layer.prototype.handle_request;

function handleRequestCatchingRejections(this: any, req: any, res: any, next: any): void {
  const fn = this.handle;

  // Error-handling middleware takes four arguments; leave those to Express.
  if (typeof fn !== 'function' || fn.length > 3) {
    return original.call(this, req, res, next);
  }

  let result: any;
  try {
    result = fn.call(this, req, res, next);
  } catch (err) {
    next(err);
    return;
  }

  if (result && typeof result.then === 'function') {
    // Only rejections are forwarded. A handler that resolves has already done
    // whatever it intended with `res`, and calling next() there would run the
    // rest of the stack a second time.
    Promise.resolve(result).catch(next);
  }
}

(handleRequestCatchingRejections as any)[PATCH_FLAG] = true;

if (!original[PATCH_FLAG]) {
  Layer.prototype.handle_request = handleRequestCatchingRejections;
}

export {};
