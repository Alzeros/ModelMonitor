import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installDevErrorOverlay } from './lib/dev-error-overlay'
import './index.css'
import App from './App.tsx'

installDevErrorOverlay()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
