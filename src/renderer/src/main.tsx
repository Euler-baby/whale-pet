/**
 * renderer 入口（M0）
 *
 * React 19 createRoot；StrictMode 只在开发期双调用 effect，bootstrap 已做单例去重（见 App.tsx）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载点（index.html 损坏？）')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
