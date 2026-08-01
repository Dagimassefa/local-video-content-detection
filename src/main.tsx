import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { installDebugBridge } from './app/debugBridge'
import './app/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

installDebugBridge()

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
