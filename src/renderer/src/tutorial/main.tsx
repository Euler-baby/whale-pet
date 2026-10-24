import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import TutorialApp from './TutorialApp'
import './tutorial.css'

const container = document.getElementById('root')
if (container === null) throw new Error('缺少 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <TutorialApp />
  </StrictMode>,
)
