declare module 'rally-point-creator' {
  interface CreatedRoute {
    p1Id: number
    p2Id: number
    routeId: string
  }

  export default class RallyPointCreator {
    constructor(host: string, port: number, secret: string)
    bind(): Promise<void>
    close(): void
    addErrorHandler(fn: (err: Error) => void): void
    removeErrorHandler(fn: (err: Error) => void): void
    createRoute(host: string, port: number, timeoutMs?: number): Promise<CreatedRoute>
  }
}
