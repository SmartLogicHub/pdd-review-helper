import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  MessageOutlined,
  SettingOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';

const { Sider } = Layout;

export default function Sidebar({ collapsed }) {
  const navigate = useNavigate();
  const location = useLocation();

  const items = [
    { key: '/', icon: <DashboardOutlined />, label: '工作台' },
    { key: '/reviews', icon: <MessageOutlined />, label: '评价管理' },
    { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
  ];

  return (
    <Sider
      trigger={null}
      collapsible
      collapsed={collapsed}
      width={220}
      style={{
        borderRight: '1px solid rgba(233,227,243,0.9)',
        boxShadow: '12px 0 34px rgba(78,54,132,0.05)',
        height: '100vh',
        position: 'fixed',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          alignItems: 'center',
          borderBottom: '1px solid rgba(233,227,243,0.9)',
          display: 'flex',
          height: 66,
          justifyContent: 'center',
          padding: '0 14px',
        }}
      >
        {!collapsed ? (
          <div style={{ alignItems: 'center', display: 'flex', gap: 10, minWidth: 0 }}>
            <div
              style={{
                background: 'linear-gradient(135deg, #7D44FE, #50B5A6)',
                borderRadius: 8,
                color: '#fff',
                display: 'grid',
                height: 34,
                placeItems: 'center',
                width: 34,
              }}
            >
              <SoundOutlined />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#161322', fontSize: 15, fontWeight: 900, whiteSpace: 'nowrap' }}>
                AI 评价助手
              </div>
              <div style={{ color: '#8A8498', fontSize: 11 }}>
                Review Ops
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              background: 'linear-gradient(135deg, #7D44FE, #50B5A6)',
              borderRadius: 8,
              color: '#fff',
              display: 'grid',
              height: 34,
              placeItems: 'center',
              width: 34,
            }}
          >
            <SoundOutlined />
          </div>
        )}
      </div>

      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
        items={items}
        onClick={({ key }) => navigate(key)}
        style={{ borderInlineEnd: 'none', marginTop: 12 }}
      />
    </Sider>
  );
}
