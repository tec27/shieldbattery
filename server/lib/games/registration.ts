import { randomBytes } from 'node:crypto'
import { GameConfig } from '../../../common/games/configuration'
import transact from '../db/transaction'
import { createGameUserRecord } from '../models/games-users'
import { createGameRecord } from './game-models'

const RESULT_CODE_BYTES = 12

function genResultCodes(amount: number): Promise<string[]> {
  if (amount <= 0) {
    throw new Error('Invalid result code amount: ' + amount)
  }

  return new Promise((resolve, reject) => {
    randomBytes(RESULT_CODE_BYTES * amount, (err, buf) => {
      if (err) {
        reject(err)
      } else {
        const resultCodes = []
        for (let i = 0; i < amount; i++) {
          resultCodes.push(
            buf.toString('base64', i * RESULT_CODE_BYTES, (i + 1) * RESULT_CODE_BYTES),
          )
        }
        resolve(resultCodes)
      }
    })
  })
}

/**
 * Registers a game in the database so that results can be collected for it.
 *
 * @param mapId the ID of the map being played on, as stored in the `uploaded_maps` table
 * @param gameSource a string representing the source of the game, e.g. Matchmaking
 * @param gameSourceExtra extra information about the source of the game, such as the matchmaking
 *   type
 * @param gameConfig an object describing the configuration of the game
 * @param startTime the time the game is being started at. Optional, defaults to the current time.
 *
 * @returns an object containing the generated `gameId` and a map of `resultCodes` indexed by
 *   player name
 */
export async function registerGame(mapId: string, gameConfig: GameConfig, startTime = new Date()) {
  const humanPlayers = gameConfig.teams.reduce((r, team) => {
    const humans = team.filter(p => !p.isComputer)
    r.push(...humans)
    return r
  }, [])

  const resultCodesArray = await genResultCodes(humanPlayers.length)
  const resultCodes = new Map(humanPlayers.map((p, i) => [p.id, resultCodesArray[i]]))

  // NOTE(tec27): the value here makes the linter happy, but this will actually be set in the
  // transaction below
  let gameId = ''

  await transact(async client => {
    gameId = await createGameRecord(client, { startTime, mapId, config: gameConfig })
    await Promise.all(
      humanPlayers.map(p =>
        createGameUserRecord(client, {
          userId: p.id,
          gameId,
          startTime,
          selectedRace: p.race,
          resultCode: resultCodes.get(p.id)!,
        }),
      ),
    )
  })

  return { gameId, resultCodes }
}
