import { css } from 'styled-components'
import { standardEasing } from './curve-constants'

export const fastOutSlowInShort = css`
  transition: all 250ms ${standardEasing};
`

export const fastOutSlowInNormal = css`
  transition: all 400ms ${standardEasing};
`
