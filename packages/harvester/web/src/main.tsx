import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { JoinView } from './views/JoinView'
import './styles.css'

// /join/<id>#<token> is a standalone route: it must work on a phone without
// the rest of the harvester UI.
const join = /^\/join\/([^/]+)$/.exec(location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {join ? <JoinView sessionId={join[1]!} /> : <App />}
  </StrictMode>,
)
