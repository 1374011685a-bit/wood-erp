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
          colorPrimaryHover: '#5A3D27',
          colorPrimaryActive: '#4D3421',
          colorInfo: '#6B4A2F',
          colorLink: '#6B4A2F',
          colorBgLayout: '#EEF2F7',
          colorBgContainer: '#FFFFFF',
          colorBorder: 'rgba(15, 23, 42, 0.08)',
          colorBorderSecondary: '#F0F0F0',
          colorFillAlter: '#FAFAFA',
          colorText: '#161B26',
          colorTextSecondary: '#667085',
          borderRadius: 8,
          borderRadiusLG: 16,
          controlHeight: 36,
          fontSize: 14,
          fontSizeSM: 12,
          lineHeight: 1.5715,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
        },
        components: {
          Table: {
            headerBg: 'transparent',
            headerColor: '#8C8C8C',
            headerSplitColor: 'transparent',
            borderColor: '#F0F0F0',
            rowHoverBg: 'rgba(15, 23, 42, 0.012)',
            cellPaddingBlock: 16,
            headerBorderRadius: 0,
          },
          Button: {
            primaryShadow: '0 3px 10px rgba(107, 74, 47, 0.18)',
            defaultBg: 'rgba(255, 255, 255, 0.58)',
            defaultBorderColor: 'rgba(15, 23, 42, 0.08)',
            defaultColor: '#161B26',
            defaultHoverBg: 'rgba(255, 255, 255, 0.9)',
            borderRadius: 8,
          },
          Input: {
            activeBorderColor: '#6B4A2F',
            hoverBorderColor: 'transparent',
            activeShadow: '0 0 0 3px rgba(107, 74, 47, 0.07)',
          },
          Modal: {
            borderRadiusLG: 16,
          },
          Drawer: {
            colorBgElevated: '#FFFFFF',
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
)
