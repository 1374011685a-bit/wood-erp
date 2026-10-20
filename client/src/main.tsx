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
          colorPrimary: 'hsl(27 39% 30.2%)',
          colorPrimaryHover: 'hsl(27 39% 26%)',
          colorPrimaryActive: 'hsl(27 39% 22%)',
          colorInfo: 'hsl(27 39% 30.2%)',
          colorLink: 'hsl(27 39% 30.2%)',
          colorBgLayout: '#F0F2F5',
          colorBgContainer: '#FFFFFF',
          colorBorder: '#E5E6EB',
          colorBorderSecondary: '#EBEBEB',
          colorFillAlter: '#FAFAFA',
          colorText: '#1D2129',
          colorTextSecondary: '#666666',
          borderRadius: 4,
          borderRadiusLG: 12,
          controlHeight: 32,
          fontSize: 14,
          fontSizeSM: 12,
          lineHeight: 1.4286,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
        },
        components: {
          Table: {
            headerBg: '#FAFAFA',
            headerColor: '#333333',
            headerSplitColor: 'transparent',
            borderColor: '#EBEBEB',
            rowHoverBg: '#F5F8FF',
            cellPaddingBlock: 8,
            headerBorderRadius: 0,
          },
          Button: {
            primaryShadow: '0 1px 2px 0 rgb(0 0 0 / 5%)',
            defaultBg: '#FFFFFF',
            defaultBorderColor: '#D9D9D9',
            defaultColor: '#333333',
            defaultHoverBg: '#FAFAFA',
            borderRadius: 4,
          },
          Input: {
            activeBorderColor: 'hsl(27 39% 30.2%)',
            hoverBorderColor: 'hsl(240 5.9% 90%)',
            activeShadow: 'inset 0 0 0 1px hsl(27 39% 30.2%)',
          },
          Modal: {
            borderRadiusLG: 12,
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
