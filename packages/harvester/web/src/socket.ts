import { io, type Socket } from 'socket.io-client'

export interface ServerEvent {
  type: 'session' | 'session-deleted' | 'marker' | 'pipeline' | 'harvest'
  sessionId: string
  line?: string
  step?: string
  done?: number
  total?: number
  // marker events carry the stamped row; the join page uses participant +
  // endS (null while the span is open) to mirror the other side's marking
  marker?: { participant?: string | null; endS?: number | null }
}

let socket: Socket | null = null

export function getSocket(): Socket {
  socket ??= io()
  return socket
}

export function onServerEvent(handler: (e: ServerEvent) => void): () => void {
  const s = getSocket()
  s.on('server:event', handler)
  return () => { s.off('server:event', handler) }
}

/** The /join page's socket: carries the LiveKit token in the handshake so
 * the backend can verify it and derive {session, identity} server-side.
 * Not the shared singleton — a join page is its own little app. */
export function createCallSocket(token: string): Socket {
  return io({ auth: { token } })
}
