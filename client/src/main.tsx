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
          colorBgLayout: 'hsl(216 20.11% 95.47%)',
          colorBgContainer: '#FFFFFF',
          colorBorder: 'hsl(240 5.9% 90%)',
          colorBorderSecondary: 'hsl(240 5% 96%)',
          colorFillAlter: 'hsl(240 5% 96%)',
          colorText: 'hsl(210 6% 21%)',
          colorTextSecondary: 'hsl(240 3.8% 46.1%)',
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
            headerBg: 'hsl(240 5% 96%)',
            headerColor: 'hsl(240 3.8% 46.1%)',
            headerSplitColor: 'transparent',
            borderColor: 'hsl(240 5% 96%)',
            rowHoverBg: 'hsl(200 10% 90% / 55%)',
            cellPaddingBlock: 16,
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
