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
          colorBgLayout: '#F5F7FA',
          colorBgContainer: '#FFFFFF',
          colorBorder: '#E5E7EB',
          colorBorderSecondary: '#F0F0F0',
          colorFillAlter: '#FAFAFA',
          colorText: '#1F2937',
          colorTextSecondary: '#667085',
          borderRadius: 8,
          borderRadiusLG: 16,
          controlHeight: 36,
          fontSize: 14,
          lineHeight: 1.5715,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
        },
        components: {
          Table: {
            headerBg: '#FAFAFA',
            headerColor: '#8C8C8C',
            headerSplitColor: 'transparent',
            borderColor: '#F0F0F0',
            rowHoverBg: '#F5F7FA',
            cellPaddingBlock: 16,
            headerBorderRadius: 0,
          },
          Button: {
            primaryShadow: '0 3px 10px rgba(107, 74, 47, 0.18)',
            defaultBg: '#FFFFFF',
            defaultBorderColor: '#E5E7EB',
            defaultColor: '#344054',
            defaultHoverBg: '#FAFAFA',
            borderRadius: 8,
          },
          Input: {
            activeBorderColor: '#6B4A2F',
            hoverBorderColor: '#D0D5DD',
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
