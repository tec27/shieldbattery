import { USE_STATIC_TURNRATE } from '../../../common/flags'
import { BwTurnRate, BwUserLatency, turnRateToMaxLatency } from '../../../common/network'
import { RallyPointRouteInfo } from '../rally-point/rally-point-service'

// NOTE(tec27): It's important that these are sorted low -> high
const POTENTIAL_TURN_RATES: ReadonlyArray<BwTurnRate> = [12, 14, 16, 20, 24]
/**
 * Entries of turn rate -> the max latency that is allowed to auto-pick that turn rate. These values
 * are chosen to work initially on low latency, although with significant packet loss may need to be
 * bumped higher. (This is a stop-gap measure, longer-term our netcode should be able to adjust on
 * the fly.)
 */
const MAX_LATENCIES_LOW: ReadonlyArray<[turnRate: BwTurnRate, maxLatency: number]> =
  POTENTIAL_TURN_RATES.map(turnRate => [
    turnRate,
    turnRateToMaxLatency(turnRate, BwUserLatency.Low),
  ])
/**
 * Latencies to check if none of the MAX_LATENCIES_LOW work. At that point we pick a latency based
 * on what would be optimal for the "High" ingame latency setting.
 */
const MAX_LATENCIES_HIGH: ReadonlyArray<[turnRate: BwTurnRate, maxLatency: number]> =
  POTENTIAL_TURN_RATES.map(turnRate => [
    turnRate,
    turnRateToMaxLatency(turnRate, BwUserLatency.High),
  ])

export function getTurnRateForRoutes(routes: ReadonlyArray<RallyPointRouteInfo>): {
  maxEstimatedLatency: number
  turnRate?: BwTurnRate
  userLatency?: BwUserLatency
} {
  let turnRate: BwTurnRate | undefined
  let userLatency: BwUserLatency | undefined
  let maxEstimatedLatency = 0
  for (const route of routes) {
    if (route.estimatedLatency > maxEstimatedLatency) {
      maxEstimatedLatency = route.estimatedLatency
    }
  }

  if (USE_STATIC_TURNRATE) {
    let availableTurnRates = MAX_LATENCIES_LOW.filter(
      ([_, latency]) => latency > maxEstimatedLatency,
    )
    if (availableTurnRates.length) {
      // Of the turn rates that work for this latency, pick the best one
      turnRate = availableTurnRates.at(-1)![0]
      userLatency = BwUserLatency.Low
    } else {
      // Fall back to a latency that will work for High latency
      availableTurnRates = MAX_LATENCIES_HIGH.filter(
        ([_, latency]) => latency > maxEstimatedLatency,
      )
      // Of the turn rates that work for this latency, pick the best one
      turnRate = availableTurnRates.length ? availableTurnRates.at(-1)![0] : 12
      userLatency = BwUserLatency.High
    }
  }

  return { maxEstimatedLatency, turnRate, userLatency }
}
