import { injectable } from 'tsyringe'
import { monotonicNow } from './monotonic-now'

export type TimeoutId = ReturnType<typeof setTimeout>

/** An injected utility class for retrieving the current time. */
@injectable()
export class Clock {
  /**
   * Retrieves the current time as a number of milliseconds since the epoch.
   *
   * @see Date.now
   */
  now(): number {
    return Date.now()
  }

  /**
   * Retrieves the current monotonic clock offset in milliseconds. This value will always tick
   * upwards regardless of any system clock changes (or offsets due to DST, etc.). It is only safe
   * to use for the lifetime of a single application run, and should not be stored outside of the
   * application.
   *
   * @see window.performance.now
   */
  monotonicNow(): number {
    return monotonicNow()
  }

  /**
   * Calls a method after `timeoutMillis` milliseconds.
   *
   * @see window.setTimeout
   */
  setTimeout(fn: (args: void) => void, timeoutMillis: number): TimeoutId {
    return setTimeout(fn, timeoutMillis)
  }
}
