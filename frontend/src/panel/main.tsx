import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './panel.css'
import { leerConfigPanel } from './config.ts'
import { crearControladorPanel } from './controlador.ts'
import { PanelApp } from './PanelApp.tsx'

const config = leerConfigPanel({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
})
const controlador = crearControladorPanel({ config })

createRoot(document.getElementById('panel')!).render(
  <StrictMode>
    <PanelApp controlador={controlador} />
  </StrictMode>,
)
