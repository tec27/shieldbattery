import React, { useEffect, useState } from 'react'
import styled from 'styled-components'
import { getJoinedChannels } from '../chat/action-creators'
import LoadingIndicator from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { getWhisperSessions } from '../whispers/action-creators'
const Container = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;

  -webkit-app-region: drag;
`

export function LoadingFilter({ children }: { children: JSX.Element }) {
  const dispatch = useAppDispatch()
  const loading = useAppSelector(s => s.loading)

  const [isLoadingJoinedChannels, setIsLoadingJoinedChannels] = useState(false)
  const [isLoadingWhisperSessions, setIsLoadingWhisperSessions] = useState(false)

  useEffect(() => {
    setIsLoadingJoinedChannels(true)

    const abortController = new AbortController()

    dispatch(
      getJoinedChannels({
        signal: abortController.signal,
        onSuccess: () => {
          setIsLoadingJoinedChannels(false)
        },
        onError: () => {
          setIsLoadingJoinedChannels(false)
          // TODO(2Pac): Do something with the error?
        },
      }),
    )

    return () => {
      abortController.abort()
    }
  }, [dispatch])

  useEffect(() => {
    setIsLoadingWhisperSessions(true)

    const abortController = new AbortController()

    dispatch(
      getWhisperSessions({
        signal: abortController.signal,
        onSuccess: () => {
          setIsLoadingWhisperSessions(false)
        },
        onError: () => {
          setIsLoadingWhisperSessions(false)
          // TODO(2Pac): Do something with the error?
        },
      }),
    )

    return () => {
      abortController.abort()
    }
  }, [dispatch])

  // TODO(tec27): make a really awesome loading screen
  if (
    isLoadingJoinedChannels ||
    isLoadingWhisperSessions ||
    Array.from(Object.values(loading)).some(v => v)
  ) {
    return (
      <Container>
        <LoadingIndicator />
      </Container>
    )
  } else {
    return React.Children.only(children)
  }
}
