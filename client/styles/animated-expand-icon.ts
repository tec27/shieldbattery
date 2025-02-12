import styled from 'styled-components'
import { MaterialIcon } from '../icons/material/material-icon'
import { standardEasing } from '../material/curve-constants'

/**
 * An expand icon which can be rotated by a 180 degrees. Usually used in accordion-like components.
 */
export const AnimatedExpandIcon = styled(MaterialIcon).attrs({ icon: 'expand_less' })<{
  $pointUp?: boolean
}>`
  color: inherit;
  transform: rotate(${props => (props.$pointUp ? '0deg' : '180deg')});
  transition: transform 125ms ${standardEasing};
  will-change: transform;
`
