import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import Count from './pages/Count'
import Home from './pages/Home'
import Inbound from './pages/Inbound'
import Login from './pages/Login'
import Outbound from './pages/Outbound'
import Stock from './pages/Stock'
import Records from './pages/Records'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route path="inbound" element={<Inbound />} />
          <Route path="outbound" element={<Outbound />} />
          <Route path="stock" element={<Stock />} />
          <Route path="count" element={<Count />} />
          <Route path="records" element={<Records />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
