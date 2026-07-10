import { useState } from 'react';
import { Layout as AntLayout, Button, Space, Tag } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import Sidebar from './Sidebar';

const { Header, Content } = AntLayout;

export default function Layout({ children }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <AntLayout className="app-shell">
      <Sidebar collapsed={collapsed} />
      <AntLayout
        style={{
          marginLeft: collapsed ? 80 : 220,
          transition: 'margin-left 0.2s ease',
          background: 'transparent',
        }}
      >
        <Header
          style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(18px)',
            borderBottom: '1px solid rgba(233,227,243,0.9)',
            boxShadow: '0 12px 30px rgba(78,54,132,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 66,
            lineHeight: 'normal',
            padding: '0 28px',
          }}
        >
          <Space size={12} align="center">
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              style={{ color: '#726C83' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div style={{ color: '#161322', fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>
                HECATE官方旗舰店
              </div>
              <div style={{ color: '#8A8498', fontSize: 12, lineHeight: 1.2 }}>
                评价管理与回复工作台
              </div>
            </div>
          </Space>
          <Space size={8}>
            <Tag color="purple">时间范围可选</Tag>
            <Tag color="cyan">安全 Dry-run</Tag>
          </Space>
        </Header>
        <Content className="content-shell">
          {children}
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
