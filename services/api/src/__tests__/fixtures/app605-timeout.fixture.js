// Invoked only by probe605-positive-controls.test.ts with an explicit Jest
// path. Its name intentionally does not match Jest's default test patterns.
jest.setTimeout(100);
test('app605 induced genuine Jest timeout', () => new Promise(() => {}));
