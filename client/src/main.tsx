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
          colorBgLayout: '#F2F3F5',
          colorBgContainer: '#FFFFFF',
          colorBorder: 'rgba(5, 5, 5, 0.06)',
          colorBorderSecondary: 'hsl(240 5% 96%)',
          colorFillAlter: '#FAFAFA',
          colorText: '#1D2129',
          colorTextSecondary: '#86909C',
          borderRadius: 6,
          borderRadiusLG: 12,
          controlHeight: 36,
          fontSize: 14,
          fontSizeSM: 12,
          lineHeight: 1.4286,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
        },
        components: {
          Table: {
            headerBg: '#FAFAFA',
            headerColor: '#86909C',
            headerSplitColor: 'transparent',
            borderColor: '#F2F3F5',
            rowHoverBg: '#F2F3F5',
            cellPaddingBlock: 12,
            headerBorderRadius: 0,
          },
          Button: {
            primaryShadow: '0 1px 2px 0 rgb(0 0 0 / 5%)',
            defaultBg: '#FFFFFF',
            defaultBorderColor: 'hsl(240 5.9% 90%)',
            defaultColor: 'hsl(210 6% 21%)',
            defaultHoverBg: 'hsl(240 5% 96%)',
            borderRadius: 6,
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
