/**
 * The single mapping point, and the guard that keeps it single.
 *
 * Rendering a permission error as an infrastructure outage has happened three
 * times — storage in #138, vault in #149, both written by copying the panel
 * next door. #149 added `statusFromFailedProbe`, which was correct and
 * insufficient: calling it was something a new panel had to REMEMBER. Three
 * near-identical try/ok/catch blocks is a template, and templates get copied.
 *
 * So the behavioural cases below pin the mapping, and the LAST case pins the
 * structure: no panel may map a response to a status on its own. Without that
 * one, this file would prove the helper is correct while the next panel quietly
 * ignores it — which is exactly what happened between #138 and #149.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeService, statusFromFailedProbe } from '@/utils/service-probe'

afterEach(() => vi.unstubAllGlobals())

const reply = (status: number, body: unknown = {}) =>
  vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  )

describe('statusFromFailedProbe', () => {
  it('401 and 403 are "cannot see", not "broken"', () => {
    for (const code of [401, 403]) {
      const s = statusFromFailedProbe('vault', code)
      expect(s.status).toBe('unknown')
      expect(s.error).toBe('Not visible to your account')
    }
  })

  it('every other failure stays unhealthy — the half that stops it being a mute button', () => {
    // A version that called all failures "unknown" would satisfy the case above
    // and hide every real outage.
    for (const code of [400, 404, 418, 500, 502, 503]) {
      const s = statusFromFailedProbe('vault', code)
      expect(s.status).toBe('unhealthy')
      expect(s.error).toBe(`HTTP ${code}`)
    }
  })
})

describe('probeService', () => {
  it('a 2xx is healthy', async () => {
    vi.stubGlobal('fetch', reply(200))
    expect((await probeService('vault', '/x')).status).toBe('healthy')
  })

  it('a 403 is unknown', async () => {
    vi.stubGlobal('fetch', reply(403))
    const s = await probeService('vault', '/x')
    expect(s.status).toBe('unknown')
    expect(s.error).toBe('Not visible to your account')
  })

  it('a 500 is unhealthy', async () => {
    vi.stubGlobal('fetch', reply(500))
    expect((await probeService('vault', '/x')).status).toBe('unhealthy')
  })

  it('a thrown fetch is unhealthy — no response means no permission question', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    const s = await probeService('vault', '/x')
    expect(s.status).toBe('unhealthy')
    expect(s.error).toBe('Connection failed')
  })

  it('onOk runs only on success, so it cannot smuggle back a failure mapping', async () => {
    const onOk = vi.fn(() => ({ service: 'api', status: 'healthy' as const }))

    vi.stubGlobal('fetch', reply(200))
    await probeService('api', '/x', onOk)
    expect(onOk).toHaveBeenCalledTimes(1)

    onOk.mockClear()
    vi.stubGlobal('fetch', reply(403))
    const s = await probeService('api', '/x', onOk)
    expect(onOk).not.toHaveBeenCalled()
    expect(s.status).toBe('unknown')
  })

  it('a throw inside onOk is still unhealthy, not an unhandled rejection', async () => {
    vi.stubGlobal('fetch', reply(200))
    const s = await probeService('api', '/x', () => {
      throw new Error('bad json')
    })
    expect(s.status).toBe('unhealthy')
  })
})

// ---------------------------------------------------------------------------

describe('STRUCTURAL: the monitoring page cannot map a response itself', () => {
  const source = readFileSync(
    join(__dirname, '../app/harness/monitoring/MonitoringClient.tsx'),
    'utf8',
  )

  // The rule is deliberately narrow. A first version banned every `res.ok` and
  // every `status: '...'` literal in the file, and it was WRONG in two places:
  // `fetchAgents` reads `res.ok` for a data fetch that produces no HealthStatus
  // at all, and the API panel's `onOk` legitimately returns `status: 'healthy'`
  // — a callback that provably cannot run on a failure. A guard that forces
  // those two edits would be making the code worse to satisfy itself.
  //
  // What actually caused #138 and #149 is narrower and checkable: a panel
  // deciding, from a failed response, that a service is down.

  it('never constructs a FAILURE status of its own', () => {
    // `unhealthy` and `unknown` may only be produced by the shared module.
    // `healthy` is not banned: it is reachable only inside onOk, which runs on
    // 2xx alone, and a test above pins that.
    const offenders = source.match(/status:\s*'(unhealthy|unknown)'/g) ?? []
    expect(offenders).toEqual([])
  })

  it('sets a health state only from the shared probe', () => {
    // The precise shape of both regressions:
    //     setVaultHealth({ service: 'vault', status: 'unhealthy', ... })
    // Every setter call must carry probeService on the same line.
    // A WINDOW, not a line: the API panel's call spans several lines because it
    // passes an onOk callback, and a line-exact check failed on `setHealth(`
    // alone. The property is "the setter's argument is a probeService call",
    // which the next few lines carry.
    const lines = source.split('\n')
    const calls: string[] = []
    lines.forEach((l, i) => {
      if (!/set(Health|VaultHealth|StorageHealth)\(/.test(l)) return
      if (/useState/.test(l)) return
      calls.push(lines.slice(i, i + 3).join('\n'))
    })
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const call of calls) {
      expect(call).toMatch(/probeService\(/)
    }
  })

  it('CONTROL: this guard can actually fail', () => {
    // A regex matching nothing would pass regardless of what the file said.
    const planted = "      setVaultHealth({ service: 'vault', status: 'unhealthy' })"
    expect(planted.match(/status:\s*'(unhealthy|unknown)'/g)).toHaveLength(1)
    expect(/set(Health|VaultHealth|StorageHealth)\(/.test(planted)).toBe(true)
    expect(planted).not.toMatch(/probeService\(/)
  })

  it('and it does use the shared probe', () => {
    // The complement: banning the wrong thing is not the same as having the
    // right thing. Without this, deleting every probe would pass.
    expect(source).toMatch(/probeService\(/)
    expect(source.match(/probeService\(/g)!.length).toBeGreaterThanOrEqual(3)
  })
})
