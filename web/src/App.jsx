import { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Reviews from './pages/Reviews';
import Settings from './pages/Settings';
import { themeConfig } from './theme';
import { api } from './api';

function createSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function useUiSessionLifecycle() {
  const sessionIdRef = useRef('');

  useEffect(() => {
    const sessionId = createSessionId();
    sessionIdRef.current = sessionId;
    api.registerUiSession(sessionId).catch(() => {});
    const heartbeat = setInterval(() => {
      api.heartbeatUiSession(sessionId).catch(() => {});
    }, 5000);

    const closeSession = () => {
      api.closeUiSession(sessionId);
    };
    window.addEventListener('pagehide', closeSession);

    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('pagehide', closeSession);
      closeSession();
    };
  }, []);
}

export default function App() {
  useUiSessionLifecycle();

  return (
    <ConfigProvider theme={themeConfig} locale={zhCN}>
      <AntApp>
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/reviews" element={<Reviews />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
