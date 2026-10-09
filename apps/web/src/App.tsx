import { HashRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/app-shell'
import { DashboardPage } from '@/pages/dashboard'
import { ModelsPage } from '@/pages/models'
import { RecordsPage } from '@/pages/records'

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <HashRouter>
        <AppShell>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/records" element={<RecordsPage />} />
          </Routes>
        </AppShell>
        <Toaster richColors position="top-center" />
      </HashRouter>
    </ThemeProvider>
  )
}
