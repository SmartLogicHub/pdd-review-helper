import { Row, Col, Card, Typography } from 'antd';
import { MessageOutlined, CheckCircleOutlined, StarOutlined, WarningOutlined, StopOutlined, QuestionCircleOutlined, CommentOutlined } from '@ant-design/icons';

const { Text } = Typography;

export default function StatsCards({ stats, onFlaggedClick }) {
  const cards = [
    {
      title: '待回复评价',
      hint: '明确好评，适合个性化回复',
      value: stats?.pending ?? stats?.unreplied ?? 0,
      icon: <MessageOutlined />,
      color: '#7D44FE',
      bg: '#EEE8FF',
      clickable: false,
    },
    {
      title: '中性回复',
      hint: '短文本或中性评价，使用保守回复',
      value: stats?.neutral ?? 0,
      icon: <CommentOutlined />,
      color: '#5E83F6',
      bg: '#EEF3FF',
      clickable: false,
    },
    {
      title: '已回复评价',
      hint: '本地记录已完成',
      value: stats?.replied ?? 0,
      icon: <CheckCircleOutlined />,
      color: '#50B5A6',
      bg: '#E8F7F4',
      clickable: false,
    },
    {
      title: '评价总数',
      hint: '当前本地数据池',
      value: stats?.total ?? 0,
      icon: <StarOutlined />,
      color: '#F4B740',
      bg: '#FFF4D9',
      clickable: false,
    },
    {
      title: '疑似差评',
      hint: '点击查看风险清单',
      value: stats?.flagged ?? 0,
      icon: <WarningOutlined />,
      color: '#EF5C6E',
      bg: '#FFECEF',
      clickable: true,
    },
    {
      title: '不可回复',
      hint: '平台或用户设置不允许回复',
      value: stats?.blocked ?? 0,
      icon: <StopOutlined />,
      color: '#F4B740',
      bg: '#FFF4D9',
      clickable: false,
    },
    {
      title: '无法判断',
      hint: '信息不足，已跳过自动回复',
      value: stats?.uncertain ?? 0,
      icon: <QuestionCircleOutlined />,
      color: '#5E83F6',
      bg: '#EEF3FF',
      clickable: false,
    },
  ];

  return (
    <Row gutter={[14, 14]}>
      {cards.map((card) => (
        <Col xs={24} sm={12} md={6} key={card.title}>
          <Card
            className="metric-card"
            style={{
              background: '#fff',
              border: '1px solid #E9E3F3',
              borderRadius: 10,
              cursor: card.clickable ? 'pointer' : 'default',
            }}
            styles={{ body: { padding: '18px 18px 16px' } }}
            onClick={card.clickable ? onFlaggedClick : undefined}
          >
            <div style={{ alignItems: 'flex-start', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <Text style={{ color: '#726C83', fontSize: 13 }}>{card.title}</Text>
                <div style={{ color: '#161322', fontSize: 30, fontWeight: 900, lineHeight: 1.1, marginTop: 8 }}>
                  {card.value}
                </div>
              </div>
              <div className="metric-accent" style={{ background: card.bg, color: card.color, fontSize: 21 }}>
                {card.icon}
              </div>
            </div>
            <div style={{ color: '#A7A0B7', fontSize: 12, marginTop: 12 }}>
              {card.hint}
            </div>
          </Card>
        </Col>
      ))}
    </Row>
  );
}
