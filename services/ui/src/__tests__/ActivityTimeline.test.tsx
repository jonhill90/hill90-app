import { describe, it, expect } from 'vitest'
import { classifyEvent } from '@/app/agents/[id]/ActivityTimeline'
import type { ActivityEvent } from '@/app/agents/[id]/ActivityTimeline'

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'evt-1',
    timestamp: new Date().toISOString(),
    type: 'file_read',
    tool: 'filesystem',
    input_summary: '/workspace/data.txt',
    output_summary: '1024 bytes',
    duration_ms: null,
    success: null,
    ...overrides,
  }
}

describe('classifyEvent', () => {
  it('classifies work_failed as error', () => {
    expect(classifyEvent(makeEvent({ type: 'work_failed', success: false }))).toBe('error')
  })

  it('classifies work_received / command_start as warning', () => {
    expect(classifyEvent(makeEvent({ type: 'work_received', success: null }))).toBe('warning')
    expect(classifyEvent(makeEvent({ type: 'command_start', success: null }))).toBe('warning')
  })

  it('classifies a successful non-lifecycle event by success=true', () => {
    expect(classifyEvent(makeEvent({ type: 'file_read', success: true }))).toBe('success')
  })

  // THE ASSERTION THAT MATTERS (app#436's sibling — sibling drift sweep).
  // EventCard.tsx's getLifecycleInfo has the identical event shape and was
  // fixed to check event.success on 'work_completed'/'command_complete'
  // rather than assuming success from the type alone. classifyEvent still
  // had the pre-fix version of that exact logic: `event.success === true ||
  // event.type === 'work_completed' || ...` — the OR meant a genuinely
  // failed work_completed/command_complete event still matched the type
  // half of the OR and rendered as 'success', a green checkmark for a
  // failure, in the one place an operator is shown whether something
  // actually worked.
  it('classifies work_completed with success=false as error, not success', () => {
    expect(classifyEvent(makeEvent({ type: 'work_completed', success: false }))).toBe('error')
  })

  it('classifies command_complete with success=false as error, not success', () => {
    expect(classifyEvent(makeEvent({ type: 'command_complete', success: false }))).toBe('error')
  })

  it('still classifies work_completed with success=true as success', () => {
    // POSITIVE CONTROL — a fix that always returned 'error' for these types
    // would also pass the two tests above for the wrong reason.
    expect(classifyEvent(makeEvent({ type: 'work_completed', success: true }))).toBe('success')
  })

  it('still classifies command_complete with success=true as success', () => {
    expect(classifyEvent(makeEvent({ type: 'command_complete', success: true }))).toBe('success')
  })

  it('classifies command_complete with success=null as success (unknown treated leniently, matching prior behavior)', () => {
    // Not part of the bug being fixed — pins the existing, unchanged
    // behavior for the case neither true nor explicitly false, so this
    // fix doesn't silently tighten a case it wasn't asked to.
    expect(classifyEvent(makeEvent({ type: 'command_complete', success: null }))).toBe('success')
  })
})
