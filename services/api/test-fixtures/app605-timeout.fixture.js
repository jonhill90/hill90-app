// Invoked only by probe605-positive-controls.test.ts with an explicit Jest path.
// It deliberately lives outside __tests__ so normal discovery cannot run it.
const http = require('http');

jest.setTimeout(100);
test('app605 induced genuine Jest timeout', () => new Promise((resolve) => {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    // Do not await this request or resolve the test: Jest must emit its own timeout,
    // while the probe's real http.request wrapper sees it open at teardown.
    http.request(`http://127.0.0.1:${port}/app605-timeout?token=app605-timeout-deliberate-token`).end();
  });
}));
