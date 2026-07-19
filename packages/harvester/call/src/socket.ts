import { TokenVerifier } from 'livekit-server-sdk'
import type { Server as SocketServer, Socket } from 'socket.io'
import type { CallService } from './service.js'

export interface CallSocketIdentity {
  sessionId: string
  identity: string
}

/** Socket mark auth = LiveKit token verification (decision 7): the join page
 * passes its LiveKit token in the socket.io handshake `auth` payload; we
 * verify it and derive {sessionId (= room name), identity} server-side.
 * Mark events carry NO claimed identity or session — attribution comes only
 * from the verified handshake. Sockets without a token are local-recording
 * sockets and keep today's behavior. */
export function registerCallSocket(io: SocketServer, call: CallService): void {
  const verifier = new TokenVerifier(call.config.apiKey, call.config.apiSecret)
  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token
    if (!token) return next()
    try {
      const claims = await verifier.verify(token)
      const room = claims.video?.room
      const identity = claims.sub
      if (!room || !identity) return next(new Error('call token lacks a room grant'))
      socket.data.call = { sessionId: room, identity } satisfies CallSocketIdentity
      next()
    } catch {
      next(new Error('invalid call token'))
    }
  })

  io.on('connection', (socket) => {
    const id = callIdentityOf(socket)
    if (!id) return // a local-recording socket; server.ts owns its handlers

    // mark edges carry no session/identity — the handshake already did
    socket.on('marker:down', () => call.markDown(id.sessionId, id.identity))
    socket.on('marker:up', (payload?: { mode?: 'hold' | 'toggle' }) =>
      call.markUp(id.sessionId, id.identity, payload?.mode ?? null))
    socket.on('marker:flush', (edges?: { kind: 'down' | 'up'; atMs: number; mode?: 'hold' | 'toggle' | null }[]) => {
      if (Array.isArray(edges)) call.flushQueuedMarks(id.sessionId, id.identity, edges)
    })

    // client-reported connection signals: additive garnish for gap
    // derivation — webhooks alone must (and do) suffice
    for (const signal of ['reconnecting', 'reconnected'] as const) {
      socket.on(`call:${signal}`, () => call.logEvent(id.sessionId, {
        atMs: Date.now(), type: `client:${signal}`, participant: id.identity,
      }))
    }
  })
}

export function callIdentityOf(socket: Socket): CallSocketIdentity | null {
  return (socket.data as { call?: CallSocketIdentity }).call ?? null
}
