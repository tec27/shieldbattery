import { combinedAbortSignal } from './abort-signals'

describe('common/async/abort-signals', () => {
  describe('combinedAbortSignal', () => {
    test('aborts if one is aborted to begin with', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()
      const controller3 = new AbortController()

      controller2.abort(new Error('2 aborted!'))

      const signal = combinedAbortSignal([
        controller1.signal,
        controller2.signal,
        controller3.signal,
      ])
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBe(controller2.signal.reason)
    })

    test('aborts when any signal becomes aborted', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()
      const controller3 = new AbortController()

      const signal = combinedAbortSignal([
        controller1.signal,
        controller2.signal,
        controller3.signal,
      ])
      expect(signal.aborted).toBe(false)

      controller3.abort(new Error('3 aborted!'))
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBe(controller3.signal.reason)
    })

    test("doesn't change reasons with multiple aborts", () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()
      const controller3 = new AbortController()

      const signal = combinedAbortSignal([
        controller1.signal,
        controller2.signal,
        controller3.signal,
      ])
      expect(signal.aborted).toBe(false)

      controller3.abort(new Error('3 aborted!'))
      controller1.abort(new Error('1 aborted!'))
      expect(signal.aborted).toBe(true)
      expect(signal.reason).toBe(controller3.signal.reason)
    })
  })
})
