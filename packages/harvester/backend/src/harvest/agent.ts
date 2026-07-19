import { query } from '@anthropic-ai/claude-agent-sdk'
import { SYSTEM_PROMPT } from './prompts.js'

export interface AgentTurnResult {
  text: string
  sessionId: string
}

export interface AgentClient {
  /** One focused turn. Pass resume to continue an existing agent session —
   * the transcript sent in an earlier turn stays in context (and in the
   * prompt cache). */
  turn(prompt: string, resume?: string): Promise<AgentTurnResult>
}

/** Rides the machine's Claude Code subscription auth — no API keys. */
export function createAgentClient(model: string): AgentClient {
  return {
    async turn(prompt, resume) {
      const q = query({
        prompt,
        options: {
          model,
          systemPrompt: SYSTEM_PROMPT,
          // text-only worker: no built-in tools at all (allowedTools: [] would
          // merely leave them unapproved — a denied attempt still costs a turn)
          tools: [],
          maxTurns: 4,
          ...(resume ? { resume } : {}),
        },
      })
      let sessionId = resume ?? ''
      for await (const message of q) {
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id
        }
        if (message.type === 'result') {
          sessionId = message.session_id ?? sessionId
          if (message.subtype === 'success') {
            return { text: message.result, sessionId }
          }
          throw new Error(`agent turn failed: ${message.subtype}`)
        }
      }
      throw new Error('agent stream ended without a result message')
    },
  }
}
