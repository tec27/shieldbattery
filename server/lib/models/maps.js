import db from '../db'
import transact from '../db/transaction'
import { tilesetIdToName } from '../../../app/common/maps'
import { getUrl } from '../file-upload'
import { mapPath, imagePath } from '../maps/store'

class MapInfo {
  constructor(props) {
    this.hash = props.hash
    this.format = props.extension
    this.tileset = tilesetIdToName(props.tileset)
    this.name = props.title
    this.description = props.description
    this.slots = props.players_melee
    this.umsSlots = props.players_ums
    this.umsForces = props.lobby_init_data.forces
    this.width = props.width
    this.height = props.height
    this.mapUrl = null
    this.imageUrl = null
  }
}

const createMapInfo = async info => {
  const map = new MapInfo(info)
  const hashString = map.hash.toString('hex')

  return {
    ...map,
    hash: hashString,
    mapUrl: await getUrl(mapPath(hashString, map.format)),
    imageUrl: await getUrl(imagePath(hashString)),
  }
}

// transactionFn is a function() => Promise, which will be awaited inside the DB transaction. If it
// is rejected, the transaction will be rolled back.
export async function addMap(mapParams, transactionFn) {
  return await transact(async client => {
    const { mapData, extension, uploadedBy, visibility } = mapParams
    const {
      hash,
      title,
      description,
      width,
      height,
      tileset,
      meleePlayers,
      umsPlayers,
      lobbyInitData,
    } = mapData

    let map = (await getMapInfo(hash))[0]
    if (!map) {
      const query = `
        INSERT INTO maps (hash, extension, title, description, width, height, tileset,
          players_melee, players_ums, lobby_init_data)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *;
      `
      const params = [
        Buffer.from(hash, 'hex'),
        extension,
        title,
        description,
        width,
        height,
        tileset,
        meleePlayers,
        umsPlayers,
        lobbyInitData,
      ]
      const result = await client.query(query, params)
      map = await createMapInfo(result.rows[0])
    }

    const query = `
      INSERT INTO uploaded_maps (map_hash, uploaded_by, upload_date, visibility)
      VALUES ($1, $2, CURRENT_TIMESTAMP AT TIME ZONE 'UTC', $3)
      ON CONFLICT (map_hash, uploaded_by)
      DO NOTHING;
    `
    const params = [Buffer.from(hash, 'hex'), uploadedBy, visibility]

    await Promise.all([client.query(query, params), transactionFn()])
    return map
  })
}

export async function getMapInfo(...hashes) {
  const query = `
    SELECT *
    FROM maps
    WHERE hash = ANY($1)
  `
  const params = [hashes.map(h => Buffer.from(h, 'hex'))]

  const { client, done } = await db()
  try {
    const result = await client.query(query, params)

    if (result.rows.length < 1) return []

    const getInfo = hash => result.rows.find(m => m.hash.toString('hex') === hash)
    // Filter out the non-existing maps and preserve the order of the input array
    return Promise.all(hashes.filter(getInfo).map(h => createMapInfo(getInfo(h))))
  } finally {
    done()
  }
}

async function getMapsCount() {
  const query = 'SELECT COUNT(*) FROM maps'
  const params = []

  const { client, done } = await db()
  try {
    const result = await client.query(query, params)
    return result.rows[0]
  } finally {
    done()
  }
}

export async function listMaps(limit, pageNumber, searchStr) {
  const whereClause = searchStr ? 'WHERE title ILIKE $3' : ''
  const query = `
    SELECT *
    FROM maps
    ${whereClause}
    LIMIT $1
    OFFSET $2
  `
  const params = [limit, pageNumber]
  if (searchStr) {
    const escapedStr = searchStr.replace(/[_%\\]/g, '\\$&')
    params.push(`%${escapedStr}%`)
  }

  const total = await getMapsCount()

  const { client, done } = await db()
  try {
    const result = await client.query(query, params)
    const maps = await Promise.all(result.rows.map(createMapInfo))
    return { total: parseInt(total.count, 10), maps }
  } finally {
    done()
  }
}
