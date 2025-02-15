import { freeze, produce, Producer } from 'immer'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getErrorStack } from '../common/errors'
import { useSelfUser } from './auth/auth-utils'
import logger from './logging/logger'

/**
 * A hook to access the previous value of some variable inside a functional component.
 *
 * @example
 *
 * export const CounterComponent = () => {
 *   const [count, setCount] = useState(0)
 *   const prevCount = usePrevious(count)
 *   return <div>Now: {count}, before: {prevCount}</div>
 * }
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>()
  useEffect(() => {
    ref.current = value
  })
  return ref.current
}

/**
 * A hook that returns the last value for a variable that was not `undefined`. If no such value has
 * been seen yet, `undefined` will be returned.
 */
export function usePreviousDefined<T>(value: T | undefined): T | undefined {
  const ref = useRef<T>()
  useEffect(() => {
    if (value !== undefined) {
      ref.current = value
    }
  })

  return ref.current
}

/**
 * A hook which allows the callbacks and effects to access the current value of a prop or state
 * field without needing to be re-run/re-created.
 *
 * @example
 *
 * export const CounterComponent = (props) => {
 *   const countRef = useValueAsRef(props.count)
 *   const onClick = useCallback(() => console.log('Count: ' + countRef.current), [])
 *   return <button title='Count' onClick={onClick} />
 * }
 */
export function useValueAsRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value)
  ref.current = value

  return ref
}

/**
 * Hook that returns a function which, when called, triggers a re-render of the current component.
 *
 * @example
 * export const UpdatingComponent = () => {
 *   const forceUpdate = useForceUpdate()
 *   return <span onClick={() => forceUpdate()}>Date: {new Date().toString()}</span>
 * }
 */
export function useForceUpdate(): () => void {
  const [, forceUpdater] = useState<Record<string, never>>()
  return useCallback(() => {
    forceUpdater({})
  }, [])
}

/**
 * A hook which multiplexes the given ref with a local one. Mostly useful when needing to create a
 * local ref in a component that already forwards a ref to another component below it.
 */
export function useMultiRef<T>(
  ref: React.ForwardedRef<T>,
): [elemRef: React.MutableRefObject<T | undefined>, setElemRef: (elem: T | null) => void] {
  const elemRef = useRef<T>()
  const setElemRef = useCallback(
    (elem: T | null) => {
      elemRef.current = elem ?? undefined
      if (ref) {
        if (typeof ref === 'function') {
          ref(elem)
        } else {
          ref.current = elem
        }
      }
    },
    [ref],
  )

  return [elemRef, setElemRef]
}

/**
 * Wraps a function/callback so that it is identity-stable, even if it is recreated across
 * different renders. This is useful for functions that depend on current props/state, but are used
 * as event handlers on their children.
 *
 * This is a not-completely-correct implementation of React's future `useEvent` hook, as described
 * here: https://github.com/reactjs/rfcs/blob/useevent/text/0000-useevent.md
 *
 * It differs in the following ways (and you should avoid causing any behavior that differs as a
 * result of these, so we can easily migrate in the future):
 *
 * - It doesn't throw if the stable callback is called during rendering
 * - The current function value gets swapped slightly later than React's future version
 *
 * TODO(tec27): Replace with React's `useEvent` once it is available
 */
export function useStableCallback<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef<(...args: A) => R>(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current(...args), [])
}

/**
 * Similar to the `useState` hook, but using immer under the hood which allows you to provide a
 * producer function in the setter to change the state in an immutable way. Mostly useful if you
 * want to use Map or Set as state.
 *
 * If you pass a non-function value to the setter, this hook behaves the same as `useState` and just
 * updates the state with that value.
 */
export function useImmerState<T>(initialState: T): [T, (updater: Producer<T> | T) => void] {
  const [value, setValue] = useState(() =>
    freeze(initialState instanceof Function ? initialState() : initialState, true),
  )
  return [
    value,
    useCallback((updater: Producer<T> | T) => {
      if (updater instanceof Function) {
        setValue(produce(updater))
      } else {
        setValue(freeze(updater))
      }
    }, []),
  ]
}

function loadAndParseLocalStorage<T>(key: string): T | undefined {
  const valueJson = localStorage.getItem(key)
  if (valueJson === null) {
    return undefined
  }

  try {
    return JSON.parse(valueJson)
  } catch (err) {
    logger.error(`error parsing value for ${key}: ${getErrorStack(err)}`)
    return undefined
  }
}

/**
 * Hook that is similar to `useState` but the value is stored in `LocalStorage`, keyed by user ID.
 * T must be serializable to JSON. Parsing failures will be logged and act as if the value is unset.
 */
export function useUserLocalStorageValue<T>(
  key: string,
): [value: T | undefined, storeValue: (value: T | undefined) => void] {
  const currentUser = useSelfUser()?.id ?? 0
  const userKey = `${String(currentUser)}|${key}`
  const [value, setValue] = useState(() => loadAndParseLocalStorage<T>(userKey))

  const storeValue = useCallback(
    (newValue: T | undefined) => {
      if (newValue === undefined) {
        localStorage.removeItem(userKey)
      } else {
        localStorage.setItem(userKey, JSON.stringify(newValue))
      }
      setValue(newValue)
    },
    [userKey],
  )

  useEffect(() => {
    function handleChange(event: StorageEvent) {
      if (event.storageArea === localStorage && event.key === userKey) {
        setValue(loadAndParseLocalStorage<T>(userKey))
      }
    }
    window.addEventListener('storage', handleChange)

    return () => {
      window.removeEventListener('storage', handleChange)
    }
  }, [userKey])

  return [value, storeValue]
}
