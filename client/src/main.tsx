import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ant-design/v5-patch-for-react-19'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: '#6B4A2F',
          colorInfo: '#6B4A2F',
          colorLink: '#6B4A2F',
          colorBgLayout: '#F5F7FA',
          colorBorder: '#E5E7EB',
          borderRadius: 8,
          controlHeight: 36,
          fontSize: 14,
        },
        components: {
          Table: {
            headerBg: '#FAFAFA',
            headerColor: '#8C8C8C',
            headerSplitColor: 'transparent',
            borderColor: '#F0F0F0',
            rowHoverBg: '#FAFAFA',
            cellPaddingBlock: 16,
          },
          Button: {
            primaryShadow: 'none',
            defaultBorderColor: '#E5E7EB',
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
