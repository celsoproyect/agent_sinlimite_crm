import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

const KNOWLEDGE = [
  { kbName: 'Policies', title: 'Returns', content: 'Returns accepted within 30 days.' },
]

describe('buildSystemPrompt — handoff rules', () => {
  it('teaches the sentinel only in auto-reply mode', () => {
    const draft = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(draft).not.toContain(HANDOFF_SENTINEL)
  })

  it('lists missing information as a handoff reason when the toggle is on', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      handoffOnMissingInfo: true,
    })
    expect(prompt).toContain('answering would require information you do not have')
  })

  it('does not hand off for missing information when the toggle is off', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      handoffOnMissingInfo: false,
    })
    expect(prompt).not.toContain('answering would require information you do not have')
    expect(prompt).toContain('that is a normal reply, not a handoff')
  })

  // Regression: the knowledge-base block used to append its own
  // unconditional "not covered -> emit the sentinel" rule, which
  // overrode the account's toggle. With a KB attached, every message the
  // retrieved excerpts didn't happen to cover — a plain greeting
  // included — handed the thread to a human and switched the bot off.
  it('does not smuggle a sentinel rule into the knowledge block when the toggle is off', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      handoffOnMissingInfo: false,
      knowledge: KNOWLEDGE,
    })
    expect(prompt).toContain('Returns accepted within 30 days.')
    expect(prompt).toContain("say you'll check and follow up")
    // The only mentions of the sentinel left are the "when to hand off"
    // rule and its "never emit it just because" counterweight — none of
    // them tied to the knowledge base falling short.
    expect(prompt).not.toContain(`do not guess — reply with exactly ${HANDOFF_SENTINEL}`)
  })

  it('still routes uncovered questions to a human when the toggle is on', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      handoffOnMissingInfo: true,
      knowledge: KNOWLEDGE,
    })
    expect(prompt).toContain(`do not guess — reply with exactly ${HANDOFF_SENTINEL}`)
  })

  it('keeps greetings and vague messages out of handoff territory', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('greetings, small talk, vague or unclear messages')
    expect(prompt).toContain(
      `Never emit ${HANDOFF_SENTINEL} just because a message is short, off-topic, or unexpected.`,
    )
  })
})

describe('buildSystemPrompt — booking rules', () => {
  it('forbids promising an appointment when the booking tools are not wired', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      bookingAvailable: false,
      noteCaptureAvailable: true,
    })
    expect(prompt).toContain('You cannot schedule, reserve, or confirm appointments')
    expect(prompt).toContain('never tell them it is booked, scheduled, reserved, requested, or confirmed')
    expect(prompt).toContain('call add_note')
    expect(prompt).not.toContain('book_appointment')
  })

  it('teaches the booking tools instead when they are wired', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      bookingAvailable: true,
      businessHoursSummary: 'Weekly hours — Monday-Saturday: 09:00-18:00; Sunday: closed.',
    })
    expect(prompt).toContain('book_appointment')
    expect(prompt).toContain('Sunday: closed')
    expect(prompt).not.toContain('You cannot schedule, reserve, or confirm appointments')
  })
})
