import { useState } from 'react';
import { Modal, Button, Typography, Spin, message, Tag, Space, Tooltip } from 'antd';
import { ThunderboltOutlined, FormOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Paragraph } = Typography;

function ScoreChip({ value = 5 }) {
  return (
    <span className="score-chip" style={{ background: '#FFF4D9', color: '#7A5416' }}>
      <span className="star">★</span>
      {Number(value || 0).toFixed(0)}
    </span>
  );
}

export default function ReplyModal({ review, open, onClose, onSuccess }) {
  const [reply, setReply] = useState('');
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [method, setMethod] = useState('');
  const methodLabel = {
    llm: 'AI 生成',
    template: '话术模板',
    'neutral-llm': '中性 AI',
    'neutral-template': '中性模板',
  }[method] || '已生成';
  const methodColor = method?.startsWith('neutral') ? 'cyan' : (method === 'llm' ? 'purple' : 'gold');

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await api.generateReply(review.id);
      setReply(res.reply);
      setMethod(res.method);
    } catch (err) {
      message.error('生成回复失败: ' + err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!reply.trim()) return message.warning('请先生成回复内容');
    setSubmitting(true);
    try {
      await api.submitReply(review.id, reply);
      message.success('回复成功');
      onSuccess?.();
      onClose();
    } catch (err) {
      if (err.blocked || err.skipped || err.reviewStatus) {
        message.warning(err.message);
        onSuccess?.();
        onClose();
        return;
      }
      message.error('提交失败: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!review) return null;

  return (
    <Modal
      title={
        <Space>
          <span>回复评价</span>
          {method && (
            <Tag color={methodColor}>
              {methodLabel}
            </Tag>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={620}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <Button
            icon={<ThunderboltOutlined />}
            onClick={handleGenerate}
            loading={generating}
            style={{ background: '#EEE8FF', borderColor: '#D9CDFE', color: '#7D44FE' }}
          >
            AI 生成回复
          </Button>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              确认回复
            </Button>
          </Space>
        </div>
      }
      styles={{ body: { padding: 22 } }}
    >
      <div style={{ marginBottom: 18 }}>
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
          <Space wrap>
            <Text style={{ color: '#726C83', fontSize: 12 }}>用户评价</Text>
            <ScoreChip value={review.stars || 5} />
            {review.userName && <Text style={{ color: '#726C83', fontSize: 12 }}>{review.userName}</Text>}
          </Space>
          {review.orderNo && (
            <Tooltip title={review.orderNo}>
              <span className="order-code" style={{ maxWidth: 190 }}>{review.orderNo}</span>
            </Tooltip>
          )}
        </div>
        <Paragraph
          style={{
            background: '#FBFAFF',
            border: '1px solid #F0EAF7',
            borderRadius: 8,
            color: '#5F6476',
            margin: 0,
            padding: 12,
          }}
        >
          {review.content || '(无文字评价)'}
        </Paragraph>
      </div>

      <div>
        <Text style={{ color: '#726C83', fontSize: 12 }}>回复内容</Text>
        {generating ? (
          <div style={{ background: '#FBFAFF', borderRadius: 8, marginTop: 8, padding: 32, textAlign: 'center' }}>
            <Spin />
            <div style={{ color: '#726C83', marginTop: 12 }}>AI 正在生成回复...</div>
          </div>
        ) : reply ? (
          <Paragraph
            style={{
              background: '#E8F7F4',
              border: '1px solid #CDEBE5',
              borderRadius: 8,
              color: '#244C48',
              marginBottom: 0,
              marginTop: 8,
              padding: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {reply}
          </Paragraph>
        ) : (
          <div
            style={{
              background: '#FBFAFF',
              border: '1px dashed #D9CDFE',
              borderRadius: 8,
              color: '#8A8498',
              marginTop: 8,
              padding: 32,
              textAlign: 'center',
            }}
          >
            <FormOutlined style={{ color: '#7D44FE', fontSize: 24, marginBottom: 8 }} />
            <div>点击“AI 生成回复”自动生成</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
