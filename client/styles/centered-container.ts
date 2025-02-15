import styled from 'styled-components'

// TODO(tec27): It would be nice to have the scrollbar appear on the right edge of the container
// rather than inside the margin (I think this may require nesting one more container though, since
// the outer one would need 100% width for this?)
/**
 * A container with normal horizontal padding intended for use as the "root" of application content
 * (below app bar). Content inside of it will be horizontally centered and the left edge will fall
 * on a whole pixel.
 */
export const CenteredContentContainer = styled.div`
  width: 100%;
  max-width: calc(1200px + 2 * 24px);
  height: 100%;
  padding: 0 24px 0 calc(24px + var(--pixel-shove-x, 0));

  overflow-x: hidden;
  overflow-y: auto;
`
