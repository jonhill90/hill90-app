/** Permanent positive controls for app#605's CI-enabled Jest probes.
 *
 * The timeout control runs a child Jest process that really exceeds Jest's
 * own timeout. The outer test expects that child to fail, then asserts the
 * reporter's record; a slow test that passes cannot satisfy this control.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';
import request from 'supertest';

const artifacts = path.join(process.cwd(), 'test-artifacts');
const ORDINARY_DISCOVERY_TIMEOUT_MS = 10_000;

const enabled = process.env.PROBE_400 === '1' && process.env.PROBE_TIMEOUT === '1';
const describeWhenEnabled = enabled ? describe : describe.skip;

function listOrdinaryTests(spawn = spawnSync) {
  const listed = spawn(
    process.execPath,
    [path.join(process.cwd(), 'node_modules/jest/bin/jest.js'), '--listTests'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: ORDINARY_DISCOVERY_TIMEOUT_MS },
  );

  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`ordinary discovery exited ${listed.status}`);
  return String(listed.stdout || '');
}

describeWhenEnabled('app#605 probe positive controls', () => {
  it('keeps the timeout fixture out of the ordinary Jest test list', () => {
    const fixture = path.join(process.cwd(), 'test-fixtures/app605-timeout.fixture.js');
    const timedOut = jest.fn((_command: string, _args: string[], _options: { timeout?: number }) => ({
      status: 0,
      stdout: '',
      error: Object.assign(new Error('ordinary discovery timed out'), { code: 'ETIMEDOUT' }),
    }));

    expect(() => listOrdinaryTests(timedOut as unknown as typeof spawnSync)).toThrow('ordinary discovery timed out');
    expect(timedOut.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 10_000 }));

    expect(listOrdinaryTests()).not.toContain(fixture);
  });

  it('captures a genuine Express 400 response', async () => {
    const app = express();
    app.get('/app605-control-400', (_req, res) => res.status(400).json({
      error: 'app605-control',
      secret: 'app605-deliberate-secret',
    }));

    await request(app).get('/app605-control-400?token=app605-deliberate-token').expect(400);

    const out = process.env.PROBE_400_OUT || path.join(artifacts, 'probe400.jsonl');
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('sent-400');
    expect(text).toContain('"route":"/app605-control-400"');
    expect(text).not.toContain('app605-deliberate-secret');
    expect(text).not.toContain('app605-deliberate-token');
  });

  it('captures Jest\'s actual timeout signal, not a slow passing duration', () => {
    const fixture = path.join(process.cwd(), 'test-fixtures/app605-timeout.fixture.js');
    const out = path.join(artifacts, `timeoutprobe-control-${process.pid}.jsonl`);

    const run = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules/jest/bin/jest.js'),
        fixture,
        '--testMatch',
        '**/test-fixtures/app605-timeout.fixture.js',
        '--runInBand',
        '--forceExit',
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env: { ...process.env, PROBE_TIMEOUT: '1', PROBE_TIMEOUT_OUT: out } },
    );

    expect(run.status).not.toBe(0);
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('test-timeout');
    expect(text).toContain('requests-open-at-teardown');
    expect(text).not.toContain('app605-timeout-deliberate-token');
  });
});
