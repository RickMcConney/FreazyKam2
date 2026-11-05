import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import './debugHooks' // dev-only window.__fkam
import { startMcpBridgeIfEnabled } from './mcp/bridgeClient'
import { startAppUpdates } from './pwa/updateStore'

startMcpBridgeIfEnabled()
startAppUpdates()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
