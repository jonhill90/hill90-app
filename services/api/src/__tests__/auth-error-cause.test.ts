// A 401 must say WHY. This is a permanent property, not a debugging aid: the bare
// `catch {}` this replaces is why six 401s across 623 logs were indistinguishable.
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createRequireAuth } from '../middleware/auth';

const kA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const kB = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISS = 'https://auth.hill90.com/realms/hill90';

function run(token: string) {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const mw = createRequireAuth({ issuer: ISS, getSigningKey: async () => kA.publicKey });
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const res: any = { status: () => res, json: () => res };
  return mw(req, res, () => {}).then(() => {
    const out = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    return out;
  });
}

describe('401 cause is reported', () => {
  it('distinguishes an EXPIRED token from a WRONG-KEY token in the log', async () => {
    const expired = jwt.sign({ sub: 'u' }, kA.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: -10 });
    const wrongKey = jwt.sign({ sub: 'u' }, kB.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: '1h' });

    const expiredOut = await run(expired);
    const wrongKeyOut = await run(wrongKey);

    expect(expiredOut).toContain('TokenExpiredError');
    expect(expiredOut).toContain('expiredAt');
    expect(wrongKeyOut).toContain('JsonWebTokenError');
    expect(wrongKeyOut).toContain('invalid signature');
    expect(expiredOut).not.toEqual(wrongKeyOut);          // the whole point
  });

  it('never logs the token itself', async () => {
    const expired = jwt.sign({ sub: 'u' }, kA.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: -10 });
    const out = await run(expired);
    expect(out).not.toContain(expired);
    expect(out).not.toContain(expired.split('.')[2]);      // the signature segment
  });
});
