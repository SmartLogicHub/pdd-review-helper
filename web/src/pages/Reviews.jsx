import { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Typography, Select, message, Tooltip } from 'antd';
import { ReloadOutlined, WarningOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import ReplyModal from '../components/ReplyModal';
import { api } from '../api';

const { Text } = Typography;

function ScoreChip({ value = 5 }) {
  return (
    <span className="score-chip" style={{ background: '#FFF4D9', color: '#7A5416' }}>
      <span className="star">★</span>
      {Number(value || 0).toFixed(0)}
    </span>
  );
}

function OrderText({ value }) {
  if (!value) return <Text style={{ color: '#A7A0B7' }}>-</Text>;
  return (
    <Tooltip title={value}>
      <span className="order-code">{value}</span>
    </Tooltip>
  );
}

function reviewStatus(record = {}) {
  if (record.reviewStatus) return record.reviewStatus;
  if (record.replied) return 'replied';
  if (record.flagged) return 'flagged';
  if (record.replyBlocked || record.canReview === false || record.canInteract === false) return 'blocked';
  if (record.uncertainSkip) return 'uncertain';
  if (record.neutralReply || record.sentimentLabel === 'neutral_auto_reply') return 'neutral';
  return 'pending';
}

const PLATFORM_SKIP_REASON_PATTERN = /平台.*(不允许|不可|不能|不支持).*(回复|互动|评论)|用户.*(不可|不允许|不能|不支持).*(回复|互动|评论)|不可回复|不可评论|不支持回复|不能回复|无法回复|不允许回复\/互动/;

function riskReason(record = {}) {
  const riskWords = Array.isArray(record.riskWords)
    ? record.riskWords.map(word => String(word || '').trim()).filter(Boolean)
    : [];
  if (riskWords.length) return riskWords.join('、');
  const reason = String(record.flagReason || '').trim();
  if (reason && !PLATFORM_SKIP_REASON_PATTERN.test(reason)) return reason;
  return '好评星级但评价内容疑似差评';
}

function StatusTag({ record }) {
  const status = reviewStatus(record);
  if (status === 'flagged') {
    return (
      <Tooltip title={riskReason(record)}>
        <Tag color="error" icon={<WarningOutlined />}>疑似差评</Tag>
      </Tooltip>
    );
  }
  if (status === 'blocked') {
    return (
      <Tooltip title={record.skipReason || '平台或用户设置不允许回复'}>
        <Tag color="warning">不可回复</Tag>
      </Tooltip>
    );
  }
  if (status === 'uncertain') {
    return (
      <Tooltip title={record.uncertainReason || '评价信息不足，已跳过自动回复'}>
        <Tag color="geekblue" icon={<QuestionCircleOutlined />}>无法判断</Tag>
      </Tooltip>
    );
  }
  if (status === 'neutral') {
    return (
      <Tooltip title={record.neutralReason || '中性评价，使用保守回复'}>
        <Tag color="cyan">中性回复</Tag>
      </Tooltip>
    );
  }
  if (status === 'replied') return <Tag color="success">已回复</Tag>;
  return <Tag color="processing">待回复</Tag>;
}

export default function Reviews() {
  const [reviews, setReviews] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const [replyTarget, setReplyTarget] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
      try {
        const params = { page, size: 15 };
      params.status = filter;
      const res = await api.getReviews(params);
      setReviews(res.list);
      setTotal(res.total);
    } catch (err) {
      message.error('加载失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleReply = (review) => {
    setReplyTarget(review);
    setModalOpen(true);
  };

  const columns = [
    {
      title: '评价内容',
      dataIndex: 'content',
      key: 'content',
      width: 360,
      ellipsis: true,
      render: (text) => (
        <Text style={{ color: '#5F6476' }}>
          {text || <Text type="secondary">(无文字)</Text>}
        </Text>
      ),
    },
    {
      title: '用户',
      dataIndex: 'userName',
      key: 'userName',
      width: 100,
      render: (text) => <Text style={{ color: '#726C83' }}>{text || '-'}</Text>,
    },
    {
      title: '星级',
      dataIndex: 'stars',
      key: 'stars',
      width: 92,
      render: (stars) => <ScoreChip value={stars} />,
    },
    {
      title: '订单编号',
      dataIndex: 'orderNo',
      key: 'orderNo',
      width: 190,
      render: (orderNo) => <OrderText value={orderNo} />,
    },
    {
      title: '时间',
      dataIndex: 'time',
      key: 'time',
      width: 158,
      render: (time) => <Text style={{ color: '#726C83', fontSize: 12 }}>{time || '-'}</Text>,
    },
    {
      title: '状态',
      key: 'status',
      width: 126,
      render: (_, record) => <StatusTag record={record} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 92,
      render: (_, record) => (
        ['pending', 'neutral'].includes(reviewStatus(record)) && (
          <Button type="link" size="small" onClick={() => handleReply(record)} style={{ color: '#7D44FE' }}>
            回复
          </Button>
        )
      ),
    },
  ];

  return (
    <div>
      <div className="toolbar-card fin-card">
        <div>
          <h2 className="page-title">评价管理</h2>
          <div className="page-subtitle">按回复状态查看本地评价池，订单号和星级列已固定防止重叠</div>
        </div>
        <div className="toolbar-actions">
          <Select
            value={filter}
            onChange={(value) => { setFilter(value); setPage(1); }}
            options={[
              { value: 'all', label: '全部评价' },
              { value: 'pending', label: '待回复' },
              { value: 'neutral', label: '中性回复' },
              { value: 'replied', label: '已回复' },
              { value: 'flagged', label: '疑似差评' },
              { value: 'blocked', label: '不可回复' },
              { value: 'uncertain', label: '无法判断' },
            ]}
            style={{ width: 140 }}
          />
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
        </div>
      </div>

      <Card
        className="fin-card"
        styles={{ body: { padding: 0 } }}
      >
        <Table
          columns={columns}
          dataSource={reviews}
          rowKey="id"
          loading={loading}
          size="middle"
          scroll={{ x: 1102 }}
          pagination={{
            current: page,
            total,
            pageSize: 15,
            onChange: (nextPage) => setPage(nextPage),
            showTotal: (count) => <Text style={{ color: '#726C83' }}>共 {count} 条</Text>,
          }}
          locale={{ emptyText: <Text style={{ color: '#A7A0B7' }}>暂无评价记录</Text> }}
        />
      </Card>

      <ReplyModal
        review={replyTarget}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSuccess={loadData}
      />
    </div>
  );
}
