import { assertUnreachable } from '../../../../common/assert-unreachable'
import { Clock, TimeoutId } from '../clock'

type ScheduledTimeout = [fn: () => void, timeoutMillis: number]

export enum StopCriteria {
  EmptyQueue,
  NumTasks,
  TimeReached,
}

export interface EmptyQueueStopCondition {
  criteria: StopCriteria.EmptyQueue
}

export interface NumTasksStopCondition {
  criteria: StopCriteria.NumTasks
  numTasks: number
}

export interface TimeReachedStopCondition {
  criteria: StopCriteria.TimeReached
  timeMillis: number
}

export type StopCondition =
  | EmptyQueueStopCondition
  | NumTasksStopCondition
  | TimeReachedStopCondition

export class FakeClock extends Clock {
  private currentTime = 0

  private currentTimeoutId: TimeoutId = 0 as unknown as TimeoutId
  private timeoutsToRun: ScheduledTimeout[] = []
  private timeoutsCompletedPromise = Promise.resolve()
  private timeoutsCompletedResolve = () => {}
  private timeoutRunnerScheduled = false

  /**
   * If true (default), automatically runs any setTimeout's as a microtask immediately after they
   * are scheduled. (That is, they will run the next time execution returns to the event loop).
   */
  autoRunTimeouts = true

  setCurrentTime(time: number) {
    this.currentTime = time
  }

  override now() {
    return this.currentTime
  }

  override monotonicNow() {
    return this.currentTime
  }

  // TODO(tec27): Build a system for only running X timeouts. This auto setup only works if the
  // timeout setting terminates (e.g. a called timeout doesn't schedule an additional timeout).
  override setTimeout(fn: () => void, timeoutMillis: number): TimeoutId {
    this.timeoutsToRun.push([fn, this.currentTime + timeoutMillis])
    if (this.autoRunTimeouts && !this.timeoutRunnerScheduled) {
      this.timeoutRunnerScheduled = true
      this.timeoutsCompletedPromise = new Promise(resolve => {
        this.timeoutsCompletedResolve = resolve
      })
      queueMicrotask(() => this.runTimeouts({ criteria: StopCriteria.EmptyQueue }, true))
    }

    this.currentTimeoutId = (Number(this.currentTimeoutId) + 1) as unknown as TimeoutId
    return this.currentTimeoutId
  }

  /**
   * Returns a promise that resolves when all the currently scheduled timeouts have been run. Only
   * works if timeouts are set to automatically run.
   */
  async allTimeoutsCompleted() {
    if (!this.autoRunTimeouts) {
      throw new Error('This method only works when FakeClock#autoRunTimeouts is true.')
    }
    return this.timeoutsCompletedPromise
  }

  /**
   * Runs scheduled timeouts (previous and newly-scheduled) until the specified stop condition is
   * met.
   */
  async runTimeoutsUntil(stopCondition: StopCondition) {
    if (this.autoRunTimeouts) {
      throw new Error(
        'Timeouts are being run automatically. If you would like to run timeouts ' +
          'manually, set FakeClock#autoRunTimeouts to false first.',
      )
    }

    await this.runTimeouts(stopCondition, false)
  }

  private async runTimeouts(stopCondition: StopCondition, isAutoRun: boolean) {
    try {
      let tasksRun = 0
      const stopConditionMet = (): boolean => {
        switch (stopCondition.criteria) {
          case StopCriteria.EmptyQueue:
            return this.timeoutsToRun.length === 0
          case StopCriteria.NumTasks:
            return tasksRun >= stopCondition.numTasks
          case StopCriteria.TimeReached:
            return (
              this.currentTime >= stopCondition.timeMillis &&
              // We want to continue running if the next task's timeout is exactly the current time,
              // as that task should execute too
              this.timeoutsToRun[0]?.[1] > this.currentTime
            )
          default:
            return assertUnreachable(stopCondition)
        }
      }

      if (stopCondition.criteria === StopCriteria.TimeReached) {
        // If we're trying to run to a particular time, insert a task at exactly that time. This
        // lets us avoid doing special checks in the loop below for this criteria to ensure we stop
        // at exactly this time and don't run an extra task later than it.
        this.timeoutsToRun.unshift([() => {}, stopCondition.timeMillis])
      }

      while (!stopConditionMet() && this.timeoutsToRun.length) {
        this.timeoutsToRun.sort((a, b) => a[1] - b[1])

        const [fn, timeoutMillis] = this.timeoutsToRun.shift()!
        this.currentTime = Math.max(this.currentTime, timeoutMillis)
        fn()
        tasksRun++

        // In case the timer functions themselves use promises, we wait for the event queue to come
        // back around
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    } finally {
      if (isAutoRun) {
        this.timeoutRunnerScheduled = false
        this.timeoutsCompletedResolve()
      }
    }
  }
}
