import { useState } from 'react'
import { api, type SessionDetail } from '../api'
import { useRangePlayer } from '../audio'

/** Ten seconds of work: one sample utterance per diarized speaker, tap the
 * participant it belongs to. */
export function LabelView({ detail, onError }: {
  detail: SessionDetail
  onError: (e: string) => void
}) {
  const id = detail.session.id
  const player = useRangePlayer(id)
  const [busy, setBusy] = useState(false)

  const assign = async (label: string, participantId: number) => {
    try { await api.assignSpeaker(id, label, participantId) } catch (e) { onError(String(e)) }
  }

  const allAssigned = detail.speakers.length > 0 &&
    detail.speakers.every((s) => s.participantId != null)

  const startHarvest = async () => {
    setBusy(true)
    try { await api.harvest(id) } catch (e) { onError(String(e)); setBusy(false) }
  }

  return (
    <main className="label">
      <h1>Who is who?</h1>
      {detail.speakers.map((s) => (
        <div className="speaker" key={s.label}>
          <div className="row">
            <strong>{s.label}</strong>
            {s.sampleStartS != null && (
              <button onClick={() => player.playRange(s.sampleStartS!, s.sampleEndS)}>
                ▶ play sample
              </button>
            )}
          </div>
          <blockquote>{s.sampleText ?? '(no sample)'}</blockquote>
          <div className="row">
            {detail.participants.map((p) => (
              <button
                key={p.id}
                className={s.participantId === p.id ? 'primary' : ''}
                onClick={() => assign(s.label, p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button className="primary big" disabled={!allAssigned || busy} onClick={startHarvest}>
        {busy ? 'Harvesting…' : `Harvest ${detail.markers.filter((m) => m.flag !== 'discarded').length} markers →`}
      </button>
    </main>
  )
}
