import { io, type Socket } from 'socket.io-client'

export interface ServerEvent {
  type: 'session' | 'marker' | 'clock' | 'pipeline' | 'harvest'
  sessionId: string
  positionS?: number
  line?: string
  step?: string
  done?: number
  total?: number
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

export function sendMarker(kind: 'down' | 'up', sessionId: string): void {
  getSocket().emit(`marker:${kind}`, { sessionId })
}
