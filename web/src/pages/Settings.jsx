import { useState, useEffect, useRef } from 'react';
import { Alert, Card, Form, Input, Button, Switch, Typography, message, Divider, Space, Tag, Segmented, Modal } from 'antd';
import { SaveOutlined, KeyOutlined, FileTextOutlined, ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, SafetyCertificateOutlined, CloudUploadOutlined, BellOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const DEEPSEEK_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{8,}$/;
const CROSS_FILLED_SECRET_PATTERN = /https?:\/\/|qyapi\.weixin\.qq\.com|webhook|feishu|open-apis|app_secret/i;

function isMaskedSecret(value = '') {
  return typeof value === 'string' && value.includes('*');
}

function isAcceptableDeepSeekInput(value = '') {
  const key = String(value || '').trim();
  if (!key) return true;
  if (isMaskedSecret(key)) return true;
  return DEEPSEEK_KEY_PATTERN.test(key);
}

function looksLikeWrongSecret(value = '') {
  const key = String(value || '').trim();
  return Boolean(key && !isAcceptableDeepSeekInput(key) && CROSS_FILLED_SECRET_PATTERN.test(key));
}

export default function Settings() {
  const [form] = Form.useForm();
  const lastSafeDeepseekValueRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState('');
  const [templatesSaving, setTemplatesSaving] = useState(false);
  const [templatesSaved, setTemplatesSaved] = useState(false);
  const [neutralTemplates, setNeutralTemplates] = useState('');
  const [neutralTemplatesSaving, setNeutralTemplatesSaving] = useState(false);
  const [neutralTemplatesSaved, setNeutralTemplatesSaved] = useState(false);
  const [sentimentPrompt, setSentimentPrompt] = useState('');
  const [sentimentDefaultPrompt, setSentimentDefaultPrompt] = useState('');
  const [sentimentValidation, setSentimentValidation] = useState({ ok: true, issues: [] });
  const [sentimentPromptSaving, setSentimentPromptSaving] = useState(false);
  const [sentimentPromptSaved, setSentimentPromptSaved] = useState(false);
  const [repairingPrompt, setRepairingPrompt] = useState(false);
  const [testingSentiment, setTestingSentiment] = useState(false);
  const [sentimentTestText, setSentimentTestText] = useState('音质清晰无杂音，连接稳定');
  const [sentimentTestStars, setSentimentTestStars] = useState(5);
  const [sentimentTestResult, setSentimentTestResult] = useState(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [settings, templateData, neutralTemplateData, sentimentPromptData] = await Promise.all([
          api.getSettings(),
          api.getTemplates(),
          api.getNeutralTemplates(),
          api.getSentimentPrompt(),
        ]);
        lastSafeDeepseekValueRef.current = isAcceptableDeepSeekInput(settings.deepseekApiKey)
          ? (settings.deepseekApiKey || '')
          : '';
        form.setFieldsValue(settings);
        window.setTimeout(() => {
          const current = form.getFieldValue('deepseekApiKey');
          if (looksLikeWrongSecret(current)) {
            form.setFieldsValue({ deepseekApiKey: lastSafeDeepseekValueRef.current });
          }
        }, 250);
        setTemplates(templateData.content || '');
        setNeutralTemplates(neutralTemplateData.content || '');
        setSentimentPrompt(sentimentPromptData.content || '');
        setSentimentDefaultPrompt(sentimentPromptData.defaultContent || '');
        setSentimentValidation(sentimentPromptData.validation || { ok: true, issues: [] });
      } catch {
        message.error('加载设置失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [form]);

  const restoreDeepseekField = (warningText = '检测到其他平台密钥被填入 DeepSeek API Key，已恢复为已保存的 DeepSeek Key') => {
    form.setFieldsValue({ deepseekApiKey: lastSafeDeepseekValueRef.current });
    setKeyStatus(null);
    message.warning(warningText);
  };

  const currentDeepseekKey = () => String(form.getFieldValue('deepseekApiKey') || '').trim();

  const handleDeepseekInputChange = (event) => {
    setKeyStatus(null);
    if (looksLikeWrongSecret(event.target.value)) {
      restoreDeepseekField();
    }
  };

  const guardDeepseekInput = (value) => {
    const key = value && value.target
      ? String(value.target.value || '').trim()
      : value !== undefined
        ? String(value || '').trim()
        : currentDeepseekKey();
    if (looksLikeWrongSecret(key)) {
      restoreDeepseekField();
      return false;
    }
    if (key && !isAcceptableDeepSeekInput(key)) {
      message.warning('DeepSeek API Key 格式不正确，应以 sk- 开头，已保留原来的 Key');
      form.setFieldsValue({ deepseekApiKey: lastSafeDeepseekValueRef.current });
      return false;
    }
    return true;
  };

  const handleSave = async (values) => {
    setSaving(true);
    try {
      const safeValues = { ...values };
      if (!isAcceptableDeepSeekInput(safeValues.deepseekApiKey)) {
        delete safeValues.deepseekApiKey;
        restoreDeepseekField('DeepSeek API Key 格式不正确，已跳过保存该字段，其他设置会正常保存');
      }
      await api.updateSettings(safeValues);
      if (isAcceptableDeepSeekInput(safeValues.deepseekApiKey) && safeValues.deepseekApiKey) {
        lastSafeDeepseekValueRef.current = safeValues.deepseekApiKey;
      }
      message.success('设置已保存');
    } catch (err) {
      message.error('保存失败: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyBlur = async (event) => {
    try {
      const key = String(event?.target?.value ?? currentDeepseekKey()).trim();
      if (!guardDeepseekInput(key)) return;
      if (key) {
        form.setFieldsValue({ deepseekApiKey: key });
        await api.updateSettings({ deepseekApiKey: key });
        lastSafeDeepseekValueRef.current = key;
        message.success('API Key 已自动保存', 1.5);
      }
    } catch {
      // 手动保存按钮兜底。
    }
  };

  const handleTestKey = async () => {
    if (!guardDeepseekInput()) return;
    const key = currentDeepseekKey();
    if (!key) {
      message.warning('请先输入 API Key');
      return;
    }
    setTestingKey(true);
    setKeyStatus(null);
    try {
      const result = await api.testKey(key);
      if (result.ok) {
        setKeyStatus('ok');
        message.success(result.message);
      } else {
        setKeyStatus('fail');
        message.error(result.message);
      }
    } catch (err) {
      setKeyStatus('fail');
      message.error('连接检测失败: ' + err.message);
    } finally {
      setTestingKey(false);
    }
  };

  const handleTemplatesBlur = async () => {
    if (templatesSaved) return;
    setTemplatesSaving(true);
    try {
      await api.updateTemplates(templates);
      setTemplatesSaved(true);
      message.success('模板已自动保存', 1.5);
    } catch (err) {
      message.error('模板保存失败: ' + err.message);
    } finally {
      setTemplatesSaving(false);
    }
  };

  const handleNeutralTemplatesBlur = async () => {
    if (neutralTemplatesSaved) return;
    setNeutralTemplatesSaving(true);
    try {
      await api.updateNeutralTemplates(neutralTemplates);
      setNeutralTemplatesSaved(true);
      message.success('中性模板已自动保存', 1.5);
    } catch (err) {
      message.error('中性模板保存失败: ' + err.message);
    } finally {
      setNeutralTemplatesSaving(false);
    }
  };

  const updateSentimentPromptState = (data = {}) => {
    setSentimentPrompt(data.content || '');
    setSentimentDefaultPrompt(data.defaultContent || sentimentDefaultPrompt || '');
    setSentimentValidation(data.validation || { ok: true, issues: [] });
    setSentimentPromptSaved(true);
  };

  const handleSentimentPromptSave = async () => {
    setSentimentPromptSaving(true);
    try {
      const data = await api.updateSentimentPrompt(sentimentPrompt);
      updateSentimentPromptState(data);
      message.success(data.restoredDefault ? '已恢复默认情感分析提示词' : '情感分析提示词已保存', 1.8);
    } catch (err) {
      if (err.validation) setSentimentValidation(err.validation);
      message.warning(err.error || err.message || '提示词格式不正确，未保存');
    } finally {
      setSentimentPromptSaving(false);
    }
  };

  const handleSentimentPromptReset = async () => {
    setSentimentPromptSaving(true);
    try {
      const data = await api.resetSentimentPrompt();
      updateSentimentPromptState(data);
      message.success('已恢复默认情感分析提示词', 1.8);
    } catch (err) {
      message.error('恢复默认失败: ' + err.message);
    } finally {
      setSentimentPromptSaving(false);
    }
  };

  const handleSentimentPromptRepair = async () => {
    setRepairingPrompt(true);
    try {
      const data = await api.repairSentimentPrompt(sentimentPrompt);
      setSentimentPrompt(data.content || '');
      setSentimentValidation(data.validation || { ok: true, issues: [] });
      setSentimentPromptSaved(false);
      message.success('DeepSeek 已优化提示词，请确认后保存', 2);
    } catch (err) {
      message.error(err.error || err.message || 'AI 优化失败');
    } finally {
      setRepairingPrompt(false);
    }
  };

  const handleSentimentPromptTest = async () => {
    if (!sentimentTestText.trim()) {
      message.warning('请先输入一条测试评价');
      return;
    }
    setTestingSentiment(true);
    setSentimentTestResult(null);
    try {
      const data = await api.testSentimentPrompt({
        reviewContent: sentimentTestText,
        stars: sentimentTestStars,
        promptOverride: sentimentPrompt,
      });
      setSentimentTestResult(data.result);
    } catch (err) {
      message.error('测试失败: ' + err.message);
    } finally {
      setTestingSentiment(false);
    }
  };

  const reanalysisSummaryText = (summary = {}) => {
    const transitions = Object.entries(summary.transitions || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('，') || '无状态变化';
    return `扫描 ${summary.scanned || 0} 条，跳过 ${summary.skipped || 0} 条，将变化 ${summary.changed || 0} 条。${transitions}`;
  };

  const handleSentimentReanalysis = async (scope = 'current') => {
    setReanalyzing(true);
    try {
      const preview = await api.previewSentimentReanalysis({ scope });
      Modal.confirm({
        title: scope === 'all' ? '确认重新分析全部账号？' : '确认重新分析当前账号？',
        content: reanalysisSummaryText(preview),
        okText: '确认应用',
        cancelText: '先不应用',
        onOk: async () => {
          setReanalyzing(true);
          try {
            const applied = await api.applySentimentReanalysis({ scope });
            message.success(`重新分析完成：已更新 ${applied.changed || 0} 条`, 2);
          } catch (err) {
            message.error('应用重新分析失败: ' + err.message);
          } finally {
            setReanalyzing(false);
          }
        },
        onCancel: () => setReanalyzing(false),
      });
      if ((preview.changed || 0) === 0) setReanalyzing(false);
    } catch (err) {
      setReanalyzing(false);
      message.error('预览重新分析失败: ' + err.message);
    }
  };

  const integrationSwitchCardStyle = {
    background: '#FFFFFF',
    border: '1px solid #E9E3F3',
    borderRadius: 10,
    padding: 14,
  };

  const sentimentLabelMeta = {
    positive_auto_reply: { color: 'green', text: '明确好评' },
    neutral_auto_reply: { color: 'cyan', text: '中性可回' },
    risk_manual_review: { color: 'red', text: '疑似差评' },
    uncertain_skip: { color: 'gold', text: '无法判断' },
  };
  const sentimentIssues = sentimentValidation?.issues || [];
  const sentimentLabel = sentimentTestResult?.label;
  const sentimentMeta = sentimentLabelMeta[sentimentLabel] || { color: 'default', text: sentimentLabel || '未测试' };

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="toolbar-card fin-card">
        <div>
          <h2 className="page-title">系统设置</h2>
          <div className="page-subtitle">配置 DeepSeek、真实提交安全开关和本地模板话术</div>
        </div>
        <Space wrap>
          <Tag color="purple">API Key 脱敏保存</Tag>
          <Tag color="cyan">模板可离线使用</Tag>
        </Space>
      </div>

      <Card
        className="fin-card"
        loading={loading}
        title={
          <Space>
            <KeyOutlined style={{ color: '#7D44FE' }} />
            <span style={{ color: '#161322', fontWeight: 800 }}>API 与提交开关</span>
          </Space>
        }
        style={{ marginBottom: 18 }}
        styles={{ header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="deepseekApiKey"
            label={<Text style={{ color: '#726C83' }}>DeepSeek API Key</Text>}
            rules={[{ required: true, message: '请输入 API Key' }]}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                name="deepseek-api-key"
                autoComplete="new-password"
                data-1p-ignore="true"
                data-bwignore="true"
                data-lpignore="true"
                spellCheck={false}
                placeholder="sk-..."
                onFocus={guardDeepseekInput}
                onBlur={handleKeyBlur}
                onChange={handleDeepseekInputChange}
              />
              <Button
                icon={testingKey ? undefined : keyStatus === 'ok' ? <CheckCircleOutlined /> : keyStatus === 'fail' ? <CloseCircleOutlined /> : <ApiOutlined />}
                onClick={handleTestKey}
                loading={testingKey}
                style={{
                  background: keyStatus === 'ok' ? '#E8F7F4' : keyStatus === 'fail' ? '#FFECEF' : '#FBFAFF',
                  borderColor: keyStatus === 'ok' ? '#50B5A6' : keyStatus === 'fail' ? '#EF5C6E' : '#E9E3F3',
                  color: keyStatus === 'ok' ? '#277E72' : keyStatus === 'fail' ? '#C64055' : '#726C83',
                }}
              >
                {testingKey ? '检测中' : keyStatus === 'ok' ? '已连接' : keyStatus === 'fail' ? '连接失败' : '检测连接'}
              </Button>
            </Space.Compact>
          </Form.Item>

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -10 }}>
            输入完成后会自动保存，也可以点击底部按钮保存全部设置。
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" style={{ color: '#7D44FE', marginLeft: 6 }}>打开 DeepSeek 开放平台</a>
          </Paragraph>

          <Divider style={{ borderColor: '#F0EAF7', margin: '18px 0' }} />

          <Form.Item
            name="storeName"
            label={<Text style={{ color: '#726C83' }}>店铺名称</Text>}
          >
            <Input />
          </Form.Item>

          <Form.Item
            name="reviewDays"
            label={<Text style={{ color: '#161322', fontWeight: 800 }}>评价时间范围</Text>}
          >
            <Segmented
              options={[
                { label: '近30天', value: 30 },
                { label: '近90天', value: 90 },
                { label: '近180天', value: 180 },
              ]}
            />
          </Form.Item>

          <Divider style={{ borderColor: '#F0EAF7', margin: '18px 0' }} />

          <div style={{ background: '#FBFAFF', border: '1px solid #F0EAF7', borderRadius: 10, marginBottom: 14, padding: 14 }}>
            <Space style={{ marginBottom: 12 }}>
              <SafetyCertificateOutlined style={{ color: '#50B5A6' }} />
              <Text style={{ color: '#161322', fontWeight: 800 }}>疑似差评外部处理</Text>
              <Tag color="cyan">处理状态：未处理 / 处理完成</Tag>
            </Space>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 14 }}>
              <div style={integrationSwitchCardStyle}>
                <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <Space>
                    <CloudUploadOutlined style={{ color: '#7D44FE' }} />
                    <Text style={{ color: '#161322', fontWeight: 800 }}>上传到飞书</Text>
                  </Space>
                  <Form.Item name="feishuEnabled" valuePropName="checked" noStyle>
                    <Switch checkedChildren="上传" unCheckedChildren="关闭" />
                  </Form.Item>
                </div>
                <Text style={{ color: '#726C83', fontSize: 12 }}>
                  开启后，自动回复中识别出的疑似差评会写入指定飞书多维表格，默认处理状态为“未处理”。
                </Text>
              </div>
              <div style={integrationSwitchCardStyle}>
                <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <Space>
                    <BellOutlined style={{ color: '#50B5A6' }} />
                    <Text style={{ color: '#161322', fontWeight: 800 }}>通知企业微信</Text>
                  </Space>
                  <Form.Item name="wecomEnabled" valuePropName="checked" noStyle>
                    <Switch checkedChildren="提醒" unCheckedChildren="关闭" />
                  </Form.Item>
                </div>
                <Text style={{ color: '#726C83', fontSize: 12 }}>
                  开启后，群机器人会提醒当前飞书台账里“未处理”的疑似差评数量，并 @所有人。
                </Text>
              </div>
              <div style={integrationSwitchCardStyle}>
                <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
                  <Space>
                    <BellOutlined style={{ color: '#7D44FE' }} />
                    <Text style={{ color: '#161322', fontWeight: 800 }}>通知飞书群</Text>
                  </Space>
                  <Form.Item name="feishuBotEnabled" valuePropName="checked" noStyle>
                    <Switch checkedChildren="提醒" unCheckedChildren="关闭" />
                  </Form.Item>
                </div>
                <Text style={{ color: '#726C83', fontSize: 12 }}>
                  开启后，飞书群机器人会按店铺汇总提醒未处理疑似差评，不逐条刷屏。
                </Text>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
              <Form.Item name="feishuAppId" label="飞书 App ID" style={{ marginBottom: 0 }}>
                <Input placeholder="cli_xxx" />
              </Form.Item>
              <Form.Item name="feishuAppSecret" label="飞书 App Secret" style={{ marginBottom: 0 }}>
                <Input.Password
                  name="feishu-app-secret"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-lpignore="true"
                  spellCheck={false}
                  placeholder="飞书自建应用 App Secret"
                />
              </Form.Item>
              <Form.Item name="feishuBitableUrl" label="飞书多维表格链接" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
                <Input placeholder="https://xxx.feishu.cn/base/...?table=..." />
              </Form.Item>
              <Form.Item name="wecomWebhookUrl" label="企业微信群机器人 Webhook" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
                <Input.Password
                  name="wecom-webhook-url"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-lpignore="true"
                  spellCheck={false}
                  placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                />
              </Form.Item>
              <Form.Item name="feishuBotWebhookUrl" label="飞书群机器人 Webhook" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
                <Input.Password
                  name="feishu-bot-webhook-url"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-lpignore="true"
                  spellCheck={false}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                />
              </Form.Item>
            </div>
            <Text style={{ color: '#8A8498', display: 'block', fontSize: 12, marginTop: 10 }}>
              飞书字段只需要：店铺名称、订单编号、星级、评价内容、标记原因、处理状态、发现时间。表格链接可以带 view 参数，系统会自动解析并保存；企业微信和飞书群只负责提醒未处理数量。
            </Text>
          </div>

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <div style={{ background: '#FBFAFF', border: '1px solid #F0EAF7', borderRadius: 10, padding: 14 }}>
              <Form.Item
                name="autoReplyEnabled"
                label={<Text style={{ color: '#161322', fontWeight: 800 }}>自动回复安全开关</Text>}
                valuePropName="checked"
                style={{ marginBottom: 6 }}
              >
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
              <Text style={{ color: '#726C83', fontSize: 12 }}>
                开启后，“开始自动回复”任务才允许真实提交；抓取评价不会自动提交。
              </Text>
            </div>
            <div style={{ background: '#FBFAFF', border: '1px solid #F0EAF7', borderRadius: 10, padding: 14 }}>
              <Form.Item
                name="aiReplyEnabled"
                label={<Text style={{ color: '#161322', fontWeight: 800 }}>AI 回复生成</Text>}
                valuePropName="checked"
                style={{ marginBottom: 6 }}
              >
                <Switch checkedChildren="AI" unCheckedChildren="模板" />
              </Form.Item>
              <Text style={{ color: '#726C83', fontSize: 12 }}>
                开启后使用 DeepSeek 生成回复；关闭后仅使用本地模板。
              </Text>
            </div>
            <div style={{ background: '#FBFAFF', border: '1px solid #F0EAF7', borderRadius: 10, padding: 14 }}>
              <Form.Item
                name="aiSentimentEnabled"
                label={<Text style={{ color: '#161322', fontWeight: 800 }}>AI 情感识别</Text>}
                valuePropName="checked"
                style={{ marginBottom: 6 }}
              >
                <Switch checkedChildren="AI判断" unCheckedChildren="本地兜底" />
              </Form.Item>
              <Text style={{ color: '#726C83', fontSize: 12 }}>
                开启后用 DeepSeek 判断疑似差评；关闭或无 Key 时使用本地兜底规则。
              </Text>
            </div>
          </div>

          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={saving}
            style={{ marginTop: 18 }}
          >
            保存所有设置
          </Button>
        </Form>
      </Card>

      <Card
        className="fin-card"
        loading={loading}
        title={
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', width: '100%', gap: 12 }}>
            <Space>
              <FileTextOutlined style={{ color: '#F4B740' }} />
              <span style={{ color: '#161322', fontWeight: 800 }}>好评回复模板</span>
              {templatesSaving && <Text style={{ color: '#726C83', fontSize: 12 }}>保存中...</Text>}
              {templatesSaved && !templatesSaving && <Tag color="success">已保存</Tag>}
            </Space>
            <Text style={{ color: '#A7A0B7', fontSize: 11 }}>每行一条模板，失焦自动保存</Text>
          </div>
        }
        styles={{ header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Paragraph style={{ color: '#726C83', fontSize: 13, marginBottom: 12 }}>
          AI 会参考这些模板的风格和语气；关闭 AI 时，系统会直接使用本地模板回复。
        </Paragraph>
        <TextArea
          value={templates}
          onChange={(event) => { setTemplates(event.target.value); setTemplatesSaved(false); }}
          onBlur={handleTemplatesBlur}
          placeholder={'每行一条模板话术...\n\n例如：\n感谢亲的好评！漫步者专注音质...\n谢谢亲的支持！佩戴舒适度是我们很重视的...'}
          rows={12}
          style={{
            background: '#FBFAFF',
            borderColor: '#E9E3F3',
            color: '#161322',
            fontSize: 13,
            lineHeight: 1.8,
          }}
        />
        <div style={{ color: '#A7A0B7', display: 'flex', gap: 8, marginTop: 10 }}>
          <SafetyCertificateOutlined />
          <Text style={{ color: '#A7A0B7', fontSize: 12 }}>模板只保存在本机用户数据目录，便携包不会携带 API Key 或评价数据。</Text>
        </div>
      </Card>

      <Card
        className="fin-card"
        loading={loading}
        title={
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', width: '100%', gap: 12 }}>
            <Space>
              <FileTextOutlined style={{ color: '#5E83F6' }} />
              <span style={{ color: '#161322', fontWeight: 800 }}>中性回复模板</span>
              {neutralTemplatesSaving && <Text style={{ color: '#726C83', fontSize: 12 }}>保存中...</Text>}
              {neutralTemplatesSaved && !neutralTemplatesSaving && <Tag color="success">已保存</Tag>}
            </Space>
            <Text style={{ color: '#A7A0B7', fontSize: 11 }}>每行一条模板，失焦自动保存</Text>
          </div>
        }
        style={{ marginTop: 18 }}
        styles={{ header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Paragraph style={{ color: '#726C83', fontSize: 13, marginBottom: 12 }}>
          用于“哈哈、还行、刚拿到还没用、帮人买的、纯数字”等中性评价。AI 开启时会参考这些模板生成保守回复；AI 关闭或失败时直接随机使用模板。
        </Paragraph>
        <TextArea
          value={neutralTemplates}
          onChange={(event) => { setNeutralTemplates(event.target.value); setNeutralTemplatesSaved(false); }}
          onBlur={handleNeutralTemplatesBlur}
          placeholder={'每行一条中性回复模板...\n\n例如：\n感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。\n感谢您的反馈，产品使用过程中如有疑问或需要帮助，可以随时联系我们，祝您生活愉快。'}
          rows={8}
          style={{
            background: '#FBFAFF',
            borderColor: '#E9E3F3',
            color: '#161322',
            fontSize: 13,
            lineHeight: 1.8,
          }}
        />
        <div style={{ color: '#A7A0B7', display: 'flex', gap: 8, marginTop: 10 }}>
          <SafetyCertificateOutlined />
          <Text style={{ color: '#A7A0B7', fontSize: 12 }}>中性模板只做感谢和服务引导，不要写音质、续航、佩戴、连接等用户没有明确提到的体验。</Text>
        </div>
      </Card>

      <Card
        className="fin-card"
        loading={loading}
        title={
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', width: '100%', gap: 12 }}>
            <Space wrap>
              <SafetyCertificateOutlined style={{ color: '#7D44FE' }} />
              <span style={{ color: '#161322', fontWeight: 800 }}>情感分析提示词</span>
              <Tag color={sentimentValidation?.ok ? 'success' : 'warning'}>
                {sentimentValidation?.ok ? '格式可用' : '需要修复'}
              </Tag>
              {sentimentPromptSaving && <Text style={{ color: '#726C83', fontSize: 12 }}>保存中...</Text>}
              {sentimentPromptSaved && !sentimentPromptSaving && <Tag color="success">已保存</Tag>}
            </Space>
            <Text style={{ color: '#A7A0B7', fontSize: 11 }}>为空时自动使用系统默认模板</Text>
          </div>
        }
        style={{ marginTop: 18 }}
        styles={{ header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Paragraph style={{ color: '#726C83', fontSize: 13, marginBottom: 12 }}>
          这里控制“疑似差评 / 中性 / 明确好评”的判断逻辑。提示词改坏时不会覆盖当前可用版本，模型输出异常也会按无法判断跳过。
        </Paragraph>

        {sentimentIssues.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ borderRadius: 10, marginBottom: 12 }}
            message="当前提示词格式不完整"
            description={
              <div>
                {sentimentIssues.slice(0, 5).map((issue) => (
                  <div key={issue}>- {issue}</div>
                ))}
                {sentimentIssues.length > 5 && <div>- 还有 {sentimentIssues.length - 5} 项问题</div>}
              </div>
            }
          />
        )}

        <TextArea
          value={sentimentPrompt}
          onChange={(event) => {
            setSentimentPrompt(event.target.value);
            setSentimentPromptSaved(false);
          }}
          placeholder="留空保存时会恢复并使用系统默认情感分析提示词"
          rows={16}
          style={{
            background: '#FBFAFF',
            borderColor: sentimentValidation?.ok ? '#E9E3F3' : '#F4B740',
            color: '#161322',
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 12,
            lineHeight: 1.7,
          }}
        />

        <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', marginTop: 12 }}>
          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={sentimentPromptSaving} onClick={handleSentimentPromptSave}>
              保存提示词
            </Button>
            <Button loading={sentimentPromptSaving} onClick={handleSentimentPromptReset}>
              恢复默认
            </Button>
            <Button loading={repairingPrompt} icon={<ApiOutlined />} onClick={handleSentimentPromptRepair}>
              AI 优化提示词
            </Button>
          </Space>
          <Text style={{ color: '#A7A0B7', fontSize: 12 }}>
            当前 {sentimentPrompt.length || 0} 字，默认模板 {sentimentDefaultPrompt.length || 0} 字
          </Text>
        </div>

        <Divider style={{ borderColor: '#F0EAF7', margin: '18px 0' }} />

        <div style={{ background: '#FBFAFF', border: '1px solid #F0EAF7', borderRadius: 10, padding: 14 }}>
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <Text style={{ color: '#161322', fontWeight: 800 }}>测试提示词</Text>
            <Segmented
              options={[
                { label: '4 星', value: 4 },
                { label: '5 星', value: 5 },
              ]}
              value={sentimentTestStars}
              onChange={setSentimentTestStars}
            />
          </div>
          <TextArea
            value={sentimentTestText}
            onChange={(event) => setSentimentTestText(event.target.value)}
            rows={3}
            placeholder="输入一条评价，例如：戴久了也不疼，没有杂音，连接稳定"
            style={{ background: '#FFFFFF', borderColor: '#E9E3F3', marginBottom: 10 }}
          />
          <Space wrap>
            <Button loading={testingSentiment} onClick={handleSentimentPromptTest}>
              测试提示词
            </Button>
            <Button loading={reanalyzing} onClick={() => handleSentimentReanalysis('current')}>
              重新分析当前账号
            </Button>
            <Button loading={reanalyzing} onClick={() => handleSentimentReanalysis('all')}>
              重新分析全部账号
            </Button>
          </Space>

          {sentimentTestResult && (
            <div style={{ background: '#FFFFFF', border: '1px solid #E9E3F3', borderRadius: 10, marginTop: 12, padding: 12 }}>
              <Space wrap style={{ marginBottom: 8 }}>
                <Tag color={sentimentMeta.color}>{sentimentMeta.text}</Tag>
                <Tag color={sentimentTestResult.can_auto_reply ? 'green' : 'default'}>
                  {sentimentTestResult.can_auto_reply ? '允许自动回复' : '不自动回复'}
                </Tag>
                <Tag color={sentimentTestResult.is_real_negative ? 'red' : 'default'}>
                  {sentimentTestResult.is_real_negative ? '真实负面' : '非真实负面'}
                </Tag>
              </Space>
              <Paragraph style={{ color: '#726C83', fontSize: 13, marginBottom: 8 }}>
                {sentimentTestResult.reason || '模型未返回原因'}
              </Paragraph>
              <Space wrap>
                <Text style={{ color: '#8A8498', fontSize: 12 }}>风险词：{(sentimentTestResult.risk_words || []).join('、') || '无'}</Text>
                <Text style={{ color: '#8A8498', fontSize: 12 }}>安全词：{(sentimentTestResult.safe_positive_words || []).join('、') || '无'}</Text>
              </Space>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
