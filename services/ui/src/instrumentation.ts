/**
 * Next.js's own hook, run once per server instance before it starts handling
 * requests. Guarded to the Node.js runtime deliberately: `register()` also fires
 * for the Edge runtime (this app's `middleware.ts`), which has no `process` object
 * at all — `process.on` would throw there, not silently do nothing.
 *
 * See src/instrumentation/unhandled-rejection-backstop.ts for what this installs
 * and why.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installUnhandledRejectionBackstop } = await import(
      './instrumentation/unhandled-rejection-backstop'
    );
    installUnhandledRejectionBackstop();
  }
}
