import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Button, Table, Tag, Typography, message, Space, Spin, Progress, Modal, Tooltip, Segmented, Input, List } from 'antd';
import {
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  DeleteOutlined,
  WarningOutlined,
  StopOutlined,
  CloseCircleOutlined,
  UserSwitchOutlined,
  LoginOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import StatsCards from '../components/StatsCards';
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

function modeFromJob(job) {
  if (job?.type === 'e2e-dry-run') return 'e2e-dry-run';
  if (job?.type === 'reply-all-accounts') return 'all-accounts';
  if (job?.type === 'reply-good-reviews') return 'submit';
  return '';
}

function accountDisplayName(account = {}) {
  return account.shopName || account.name || '默认账号';
}

function shopStatusText(account = {}) {
  if (account.shopName) return `真实店铺：${account.shopName}`;
  if (account.shopNameStatus === 'failed') return `店铺名识别失败：${account.shopNameError || '请重新识别'}`;
  return '真实店铺名未识别';
}

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, replied: 0, unreplied: 0, pending: 0, neutral: 0, actionable: 0, flagged: 0, blocked: 0, uncertain: 0 });
  const [settings, setSettings] = useState({ autoReplyEnabled: false, aiReplyEnabled: false, reviewDays: 90 });
  const [accountsState, setAccountsState] = useState({ currentAccountId: 'default', accounts: [] });
  const [accountsSummary, setAccountsSummary] = useState({ currentAccountId: 'default', accounts: [], totals: {} });
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [accountBusy, setAccountBusy] = useState('');
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [replyingAll, setReplyingAll] = useState(false);
  const [replyProgress, setReplyProgress] = useState(null);
  const [replyReport, setReplyReport] = useState(null);
  const [automationMode, setAutomationMode] = useState('');
  const [autoReplyJobId, setAutoReplyJobId] = useState('');
  const eventSourceRef = useRef(null);
  const [flaggedModalOpen, setFlaggedModalOpen] = useState(false);
  const [flaggedReviews, setFlaggedReviews] = useState([]);
  const [flaggedLoading, setFlaggedLoading] = useState(false);
  const [syncingRiskId, setSyncingRiskId] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStats, nextReviews, nextSettings, nextAccounts, nextSummary] = await Promise.all([
        api.getStats(),
        api.getReviews({ size: 10 }),
        api.getSettings(),
        api.getAccounts(),
        api.getAccountsSummary(),
      ]);
      setStats(nextStats);
      setReviews(nextReviews.list);
      setSettings(nextSettings);
      setAccountsState(nextAccounts);
      setAccountsSummary(nextSummary);
    } catch (err) {
      message.error('加载数据失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => () => {
    eventSourceRef.current?.close();
  }, []);

  const currentAccount = accountsState.accounts.find(account => account.id === accountsState.currentAccountId)
    || accountsState.accounts[0]
    || { id: 'default', name: '默认账号' };
  const reviewDays = Number(settings.reviewDays || 90);
  const autoTargetCount = Number(stats.actionable ?? stats.unreplied ?? 0);
  const accountTotals = accountsSummary.totals || {};

  const handleReviewDaysChange = async (value) => {
    const nextDays = Number(value);
    try {
      const res = await api.updateSettings({ reviewDays: nextDays });
      setSettings(res.settings || { ...settings, reviewDays: nextDays });
      message.success(`已切换为近${nextDays}天`);
    } catch (err) {
      message.error('切换时间范围失败: ' + err.message);
    }
  };

  const handleCreateAccount = async () => {
    const name = newAccountName.trim() || `账号 ${(accountsState.accounts?.length || 0) + 1}`;
    setAccountBusy('create');
    try {
      const res = await api.createAccount(name);
      setAccountsState(res.state);
      setNewAccountName('');
      message.success('账号已添加，请点击“打开登录”扫码登录');
    } catch (err) {
      message.error('添加账号失败: ' + err.message);
    } finally {
      setAccountBusy('');
    }
  };

  const handleSwitchAccount = async (accountId) => {
    setAccountBusy(accountId);
    try {
      const res = await api.switchAccount(accountId);
      setAccountsState(res.state);
      await loadData();
      message.success(`已切换到 ${accountDisplayName(res.account)}`);
    } catch (err) {
      message.error('切换账号失败: ' + err.message);
    } finally {
      setAccountBusy('');
    }
  };

  const handleOpenAccount = async (accountId) => {
    setAccountBusy(`open-${accountId}`);
    try {
      const res = await api.openAccount(accountId);
      setAccountsState(res.state);
      await loadData();
      message.success('已打开该账号的专属浏览器，请在拼多多页面扫码登录');
    } catch (err) {
      message.error('打开登录窗口失败: ' + err.message);
    } finally {
      setAccountBusy('');
    }
  };

  const handleDetectShopName = async (accountId) => {
    setAccountBusy(`detect-${accountId}`);
    try {
      const res = await api.detectAccountShop(accountId);
      setAccountsState(res.state);
      await loadData();
      message.success(`已识别店铺：${res.account.shopName}`);
    } catch (err) {
      message.error('识别店铺名失败: ' + err.message);
      if (err.state) setAccountsState(err.state);
    } finally {
      setAccountBusy('');
    }
  };

  const handleDetectAllShopNames = async () => {
    setAccountBusy('detect-all');
    try {
      const res = await api.detectAllAccountShops();
      setAccountsState(res.state);
      await loadData();
      const failed = (res.results || []).filter(item => !item.success).length;
      if (failed) {
        message.warning(`店铺名识别完成，但有 ${failed} 个账号需要登录或手动检查`);
      } else {
        message.success('全部账号真实店铺名已识别');
      }
    } catch (err) {
      message.error('识别全部店铺名失败: ' + err.message);
    } finally {
      setAccountBusy('');
    }
  };

  const handleCloseAccountBrowser = async () => {
    setAccountBusy('close-browser');
    try {
      await api.closeAccountBrowser();
      message.success('已关闭当前账号浏览器，登录态会保留');
    } catch (err) {
      message.error('关闭浏览器失败: ' + err.message);
    } finally {
      setAccountBusy('');
    }
  };

  const handleDeleteAccount = (account) => {
    Modal.confirm({
      title: `删除账号「${accountDisplayName(account)}」？`,
      content: '会删除该账号的本地评价池，不会影响拼多多账号本身。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.deleteAccount(account.id);
          setAccountsState(res.state);
          await loadData();
          message.success('账号已删除');
        } catch (err) {
          message.error('删除账号失败: ' + err.message);
        }
      },
    });
  };

  const handleFetch = async () => {
    if (replyingAll) {
      message.warning('自动化任务仍在运行或停止中，请先停止或等待结束后再抓取');
      return;
    }
    setFetching(true);
    try {
      const res = await api.fetchReviews();
      message.success(`抓取完成：本次读取 ${res.fetchedCount ?? res.newCount ?? 0} 条，新入库 ${res.newCount ?? 0} 条；当前本地 ${res.total ?? 0} 条，待回复 ${res.unreplied ?? 0} 条`);
      await loadData();
    } catch (err) {
      message.error('抓取失败: ' + err.message);
    } finally {
      setFetching(false);
    }
  };

  const handleReply = (review) => {
    setReplyTarget(review);
    setModalOpen(true);
  };

  const finishAutoReply = useCallback(async () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setReplyingAll(false);
    setAutoReplyJobId('');
    setAutomationMode('');
    await loadData();
  }, [loadData]);

  const subscribeAutomationJob = useCallback((job) => {
    eventSourceRef.current?.close();
    const source = api.subscribeAutoReply(job.id, async (event) => {
      if (event.type === 'started') {
        setReplyProgress((prev) => ({ ...prev, status: 'starting', dryRun: event.dryRun }));
        return;
      }
      if (event.type === 'progress') {
        setReplyProgress((prev) => ({ ...(prev || {}), ...event }));
        if (event.status === 'ok' || event.status === 'skip') {
          await loadData();
        }
        return;
      }
      if (event.type === 'stopping') {
        setReplyProgress((prev) => ({ ...(prev || {}), status: 'stopping' }));
        return;
      }
      if (event.type === 'done') {
        setReplyReport(event);
        message.success(`${event.mode === 'e2e-dry-run' ? '全页 E2E Dry-run' : event.dryRun ? 'Dry-run 验收' : '自动回复'}完成：扫描 ${event.scanned || 0} 条，弹窗 ${event.dialogOpened || event.success || 0} 次，失败 ${event.failed || 0} 条`);
        await finishAutoReply();
        return;
      }
      if (event.type === 'stopped') {
        setReplyReport(event);
        message.info('任务已停止');
        await finishAutoReply();
        return;
      }
      if (event.type === 'error') {
        message.error('任务失败: ' + (event.error || '未知错误'));
        await finishAutoReply();
      }
    });
    eventSourceRef.current = source;
  }, [finishAutoReply, loadData]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { job } = await api.getActiveAutomation();
        if (cancelled || !job || autoReplyJobId === job.id) return;
        const mode = modeFromJob(job);
        setReplyingAll(true);
        setAutoReplyJobId(job.id);
        setAutomationMode(mode);
        setReplyProgress((prev) => prev || {
          status: job.status === 'stopping' ? 'stopping' : 'running',
          mode,
          dryRun: job.type === 'e2e-dry-run',
        });
        subscribeAutomationJob(job);
        message.info('已恢复后台自动化任务进度');
      } catch (err) {
        console.warn('恢复自动化任务失败', err);
      }
    })();
    return () => { cancelled = true; };
  }, [autoReplyJobId, subscribeAutomationJob]);

  const startAutomationJob = async ({ dryRun = false, maxCount, allAccounts = false } = {}) => {
    eventSourceRef.current?.close();
    setReplyingAll(true);
    setAutomationMode(allAccounts ? 'all-accounts' : (dryRun ? 'dry-run' : 'submit'));
    setReplyReport(null);
    setReplyProgress({ current: 0, total: maxCount || 0, status: 'starting', dryRun });
    try {
      const { job } = allAccounts
        ? await api.startReplyAllAccounts({ maxCount, dryRun })
        : await api.startAutoReply({ maxCount, dryRun });
      setAutoReplyJobId(job.id);
      subscribeAutomationJob(job);
    } catch (err) {
      message.error('启动任务失败: ' + err.message);
      setReplyingAll(false);
      setReplyProgress(null);
      setAutoReplyJobId('');
      setAutomationMode('');
    }
  };

  const handleToggleAiReply = async () => {
    const nextEnabled = !settings.aiReplyEnabled;
    try {
      const res = await api.updateSettings({ aiReplyEnabled: nextEnabled });
      setSettings(res.settings || { ...settings, aiReplyEnabled: nextEnabled });
      message.success(nextEnabled ? 'AI 回复已开启' : 'AI 回复已关闭，将使用模板回复');
    } catch (err) {
      message.error('切换 AI 回复失败: ' + err.message);
    }
  };

  const handleReplyAll = async () => {
    if (!settings.autoReplyEnabled) {
      message.warning('请先在「系统设置」开启自动回复安全开关');
      return;
    }
    message.info(autoTargetCount > 0
      ? '正在启动自动回复任务'
      : '本地评价池为空，仍会打开拼多多页面实时筛选并启动自动回复');
    await startAutomationJob({ dryRun: false });
  };

  const handleReplyAllAccounts = async () => {
    if (!settings.autoReplyEnabled) {
      message.warning('请先在「系统设置」开启自动回复安全开关');
      return;
    }
    Modal.confirm({
      title: '处理全部账号？',
      content: `将按顺序处理 ${accountsState.accounts.length || 0} 个账号。遇到登录或验证会暂停等待你手动处理。`,
      okText: '开始处理全部账号',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => startAutomationJob({ dryRun: false, allAccounts: true }),
    });
  };

  const handleStopAutoReply = async () => {
    try {
      if (autoReplyJobId) {
        await api.stopAutoReply(autoReplyJobId);
      } else {
        await api.stopActiveAutomation();
      }
      setReplyProgress((prev) => ({ ...(prev || {}), status: 'stopping' }));
      message.info('已发送停止指令，当前评价处理完后会停止');
    } catch (err) {
      message.error('停止失败: ' + err.message);
    }
  };

  const handleClearAutomationPanel = async () => {
    if (replyingAll) {
      try {
        if (autoReplyJobId) {
          await api.stopAutoReply(autoReplyJobId);
        } else {
          await api.stopActiveAutomation();
        }
        message.info('已发送停止指令，并清理当前面板');
      } catch (err) {
        message.warning('面板已清理，但停止指令返回: ' + err.message);
      }
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setReplyingAll(false);
    setAutoReplyJobId('');
    setAutomationMode('');
    setReplyProgress(null);
    setReplyReport(null);
  };

  const handleClearReplied = () => {
    Modal.confirm({
      title: '确认清除',
      content: '将清除所有已回复的评价记录，未回复评价会保留。',
      okText: '确认清除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.clearReplied();
          message.success(`已清除，剩余 ${res.remaining} 条未回复记录`);
          await loadData();
        } catch (err) {
          message.error('清除失败: ' + err.message);
        }
      },
    });
  };

  const handleClearAll = () => {
    Modal.confirm({
      title: '确认清空全部',
      content: '将删除所有本地评价记录。此操作不可撤销。',
      okText: '全部清空',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.clearAll();
          message.success('所有评价记录已清空');
          await loadData();
        } catch (err) {
          message.error('清空失败: ' + err.message);
        }
      },
    });
  };

  const showFlaggedReviews = async () => {
    if (stats.flagged === 0) {
      message.info('当前没有疑似差评');
      return;
    }
    setFlaggedModalOpen(true);
    setFlaggedLoading(true);
    try {
      const res = await api.getReviews({ flagged: true, size: 200 });
      setFlaggedReviews(res.list);
    } catch (err) {
      message.error('加载疑似差评失败: ' + err.message);
    } finally {
      setFlaggedLoading(false);
    }
  };

  const handleSyncRiskReview = async (review) => {
    const id = review.reviewId || review.id || review.orderNo;
    setSyncingRiskId(id);
    try {
      await api.syncRiskReview(id);
      message.success('已同步到飞书，并提醒企业微信群');
      await showFlaggedReviews();
      await loadData();
    } catch (err) {
      message.error('同步疑似差评失败: ' + err.message);
    } finally {
      setSyncingRiskId('');
    }
  };

  const riskSyncTag = (review) => {
    if (review.riskSyncStatus === 'synced') return <Tag color="success">飞书已同步</Tag>;
    if (review.riskSyncStatus === 'partial') return <Tag color="warning">飞书已同步，企微失败</Tag>;
    if (review.riskSyncStatus === 'failed') return <Tag color="error">同步失败</Tag>;
    if (review.riskSyncStatus === 'skipped') return <Tag color="default">未开启同步</Tag>;
    return <Tag color="processing">待同步</Tag>;
  };

  const progressStatusText = (status) => ({
    ok: '成功',
    'dry-run': 'Dry-run 通过',
    'e2e-start': 'E2E 启动',
    'e2e-skip': 'E2E 跳过',
    'e2e-dialog-ok': '弹窗通过',
    'e2e-ai-fail': 'AI 失败',
    'e2e-page-fail': '页面失败',
    'e2e-page-done': '本页完成',
    skip: '跳过',
    fail: '失败',
    waiting: '等待人工处理',
    resumed: '已继续',
    'popup-closed': '已处理弹窗',
    retry: '重试中',
    report: '已读取筛选结果',
    starting: '启动中',
    stopping: '停止中',
  }[status] || '处理中');

  const progressStatusColor = (status) => ({
    ok: '#50B5A6',
    'dry-run': '#50B5A6',
    'e2e-start': '#5E83F6',
    'e2e-skip': '#F4B740',
    'e2e-dialog-ok': '#50B5A6',
    'e2e-ai-fail': '#EF5C6E',
    'e2e-page-fail': '#EF5C6E',
    'e2e-page-done': '#50B5A6',
    skip: '#F4B740',
    fail: '#EF5C6E',
    waiting: '#F4B740',
    resumed: '#5E83F6',
    'popup-closed': '#5E83F6',
    retry: '#5E83F6',
    report: '#5E83F6',
    starting: '#5E83F6',
    stopping: '#5E83F6',
  }[status] || '#726C83');

  const progressDone = () => {
    if (!replyProgress) return 0;
    return Number(replyProgress.processed ?? (
      (replyProgress.success || 0) + (replyProgress.skipped || 0) + (replyProgress.failed || 0)
    ));
  };

  const progressTotal = () => {
    if (!replyProgress) return 0;
    if (replyProgress.mode === 'e2e-dry-run' || automationMode === 'e2e-dry-run') {
      return Number(replyProgress.pageCount || 0);
    }
    return Number(replyProgress.total || progressDone() || 0);
  };

  const progressTitle = () => {
    if (!replyProgress) return '';
    if (replyProgress.mode === 'e2e-dry-run' || automationMode === 'e2e-dry-run') {
      return `全页 E2E Dry-run：第 ${replyProgress.page || 0}/${replyProgress.pageCount || 0} 页，已扫描 ${replyProgress.scanned || 0} 条`;
    }
    const done = progressDone();
    const total = progressTotal();
    if (replyProgress.dryRun || automationMode === 'dry-run') {
      return `批量 Dry-run 验收：已处理 ${done}/${total}`;
    }
    return `AI 自动回复：已回复 ${replyProgress.success || replyProgress.current || 0}，已处理 ${done}/${total}，实时剩余 ${replyProgress.remainingTargets ?? replyProgress.liveTotalRows ?? 0}`;
  };

  const progressPercent = () => {
    if (!replyProgress) return 0;
    if (replyProgress.mode === 'e2e-dry-run' || automationMode === 'e2e-dry-run') {
      return replyProgress.pageCount ? Math.round(((replyProgress.page || 0) / replyProgress.pageCount) * 100) : 0;
    }
    const total = progressTotal();
    return total ? Math.min(100, Math.round((progressDone() / total) * 100)) : 0;
  };

  const columns = [
    {
      title: '评价内容',
      dataIndex: 'content',
      key: 'content',
      width: 390,
      ellipsis: true,
      render: (text) => (
        <Text style={{ color: '#5F6476' }}>
          {text || <Text type="secondary">(无文字)</Text>}
        </Text>
      ),
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
      width: 116,
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
          <h2 className="page-title">评价运营工作台</h2>
          <div className="page-subtitle">
            当前店铺：{accountDisplayName(currentAccount)}；当前账号本地评价池，抓取、验收并安全回复近{reviewDays}天 4/5 星未回复评价
          </div>
          <Space size={8} wrap style={{ marginTop: 10 }}>
            <span className="stat-pill">本地 {stats.total || 0}</span>
            <span className="stat-pill">待回复 {stats.pending ?? stats.unreplied ?? 0}</span>
            <span className="stat-pill">中性回复 {stats.neutral || 0}</span>
            <span className="stat-pill">自动可处理 {autoTargetCount}</span>
            <span className="stat-pill">疑似差评 {stats.flagged || 0}</span>
            {(stats.blocked || 0) > 0 && <span className="stat-pill">不可回复 {stats.blocked || 0}</span>}
            {(stats.uncertain || 0) > 0 && <span className="stat-pill">无法判断 {stats.uncertain || 0}</span>}
          </Space>
        </div>
        <div className="toolbar-actions">
          <Segmented
            value={reviewDays}
            onChange={handleReviewDaysChange}
            disabled={replyingAll}
            options={[
              { label: '近30天', value: 30 },
              { label: '近90天', value: 90 },
              { label: '近180天', value: 180 },
            ]}
          />
          <Button icon={<UserSwitchOutlined />} onClick={() => setAccountModalOpen(true)}>
            {accountDisplayName(currentAccount)}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
          <Button type="primary" icon={<SyncOutlined />} onClick={handleFetch} loading={fetching} disabled={replyingAll}>抓取最新评价</Button>
          <Button
            icon={<ThunderboltOutlined />}
            onClick={handleToggleAiReply}
            disabled={replyingAll}
            type={settings.aiReplyEnabled ? 'primary' : 'default'}
          >
            AI回复：{settings.aiReplyEnabled ? '开' : '关'}
          </Button>
          <Tooltip title={
            !settings.autoReplyEnabled
              ? '请先到系统设置开启自动回复安全开关'
              : autoTargetCount > 0
                ? '点击后立即启动自动回复任务'
                : '本地评价池为空，也会重新打开拼多多页面实时筛选'
          }>
            <span>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={handleReplyAll}
                loading={replyingAll && automationMode === 'submit'}
                disabled={!settings.autoReplyEnabled || (replyingAll && automationMode !== 'submit')}
                danger
              >
                {autoTargetCount > 0 ? `开始自动回复 (${autoTargetCount})` : '开始自动回复'}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="按账号列表顺序处理，遇到登录/验证会等待你手动完成">
            <span>
              <Button
                type="primary"
                icon={<UserSwitchOutlined />}
                onClick={handleReplyAllAccounts}
                loading={replyingAll && automationMode === 'all-accounts'}
                disabled={!settings.autoReplyEnabled || (replyingAll && automationMode !== 'all-accounts')}
                danger
              >
                处理全部账号
              </Button>
            </span>
          </Tooltip>
          {replyingAll && (
            <Button icon={<StopOutlined />} onClick={handleStopAutoReply} danger>停止</Button>
          )}
          <Button icon={<DeleteOutlined />} onClick={handleClearReplied} disabled={stats.replied === 0}>
            清除已回复 ({stats.replied || 0})
          </Button>
          <Button danger onClick={handleClearAll} disabled={stats.total === 0}>清空全部</Button>
        </div>
      </div>

      {replyProgress && (
        <div className="fin-card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 14 }}>
            <Text style={{ color: '#161322', fontWeight: 700 }}>{progressTitle()}</Text>
            <Space size={8}>
              <Text style={{ color: progressStatusColor(replyProgress.status), fontWeight: 700 }}>
                {progressStatusText(replyProgress.status)}
              </Text>
              <Button
                size="small"
                icon={<CloseCircleOutlined />}
                onClick={handleClearAutomationPanel}
                danger={replyingAll}
              >
                {replyingAll ? '停止并清理' : '关闭面板'}
              </Button>
            </Space>
          </div>
          <Progress percent={progressPercent()} strokeColor="#7D44FE" trailColor="#EEE8FF" showInfo={false} />
          <Space wrap size={14} style={{ marginTop: 8 }}>
            <Text style={{ color: '#726C83', fontSize: 12 }}>扫描 {replyProgress.scanned || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>跳过 {replyProgress.skipped || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>可回复 {replyProgress.replyable || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>正常回复 {replyProgress.positiveReplies || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>中性回复 {replyProgress.neutralReplies || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>弹窗 {replyProgress.dialogOpened || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>失败 {replyProgress.failed || 0}</Text>
            <Text style={{ color: '#726C83', fontSize: 12 }}>实时剩余 {replyProgress.remainingTargets ?? replyProgress.liveTotalRows ?? 0}</Text>
            {(replyProgress.visibleRows || replyProgress.liveTotalRows) && (
              <Text style={{ color: '#726C83', fontSize: 12 }}>
                本轮可展示 {replyProgress.visibleRows ?? replyProgress.liveTotalRows}
                {replyProgress.liveTotalRows ? ` / 命中 ${replyProgress.liveTotalRows}` : ''}
              </Text>
            )}
          </Space>
          {replyProgress.stage && (
            <div style={{ color: '#8A8498', fontSize: 12, marginTop: 6 }}>阶段：{replyProgress.stage}</div>
          )}
        </div>
      )}

      {replyReport && (
        <div className="fin-card" style={{ borderColor: '#D7F0EA', marginBottom: 16, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <Text style={{ color: '#161322', fontWeight: 800 }}>
              {replyReport.mode === 'e2e-dry-run' ? '全页 E2E Dry-run 报告' : replyReport.dryRun ? 'Dry-run 验收报告' : '自动回复报告'}
            </Text>
            <Space wrap>
              {replyReport.mode === 'e2e-dry-run' && <Tag color={replyReport.lastPageReached ? 'success' : 'error'}>最后页 {replyReport.lastPageReached ? '已到达' : '未到达'}</Tag>}
              {replyReport.pageCount && <Tag color="geekblue">页数 {replyReport.page || 0}/{replyReport.pageCount}</Tag>}
              <Tag color="processing">实时剩余 {replyReport.remainingTargets ?? replyReport.liveTotalRows ?? replyReport.totalRows ?? 0}</Tag>
              {replyReport.initialTotalRows ? <Tag color="default">初始 {replyReport.initialTotalRows}</Tag> : null}
              {(replyReport.visibleRows || replyReport.liveTotalRows || replyReport.totalRows) ? (
                <Tag color="purple">
                  本轮可展示 {replyReport.visibleRows ?? replyReport.liveTotalRows ?? replyReport.totalRows}
                  {replyReport.liveTotalRows || replyReport.totalRows ? ` / 命中 ${replyReport.liveTotalRows ?? replyReport.totalRows}` : ''}
                </Tag>
              ) : null}
              <Tag color="blue">扫描 {replyReport.scanned || 0}</Tag>
              <Tag color="success">弹窗 {replyReport.dialogOpened || replyReport.success || 0}</Tag>
              <Tag color="green">正常回复 {replyReport.positiveReplies || 0}</Tag>
              <Tag color="cyan">中性回复 {replyReport.neutralReplies || 0}</Tag>
              <Tag color="warning">已回复跳过 {replyReport.skippedAlreadyReplied || 0}</Tag>
              <Tag color={replyReport.failed ? 'error' : 'default'}>失败 {replyReport.failed || 0}</Tag>
            </Space>
          </div>
          {replyReport.firstFailure && (
            <div style={{ color: '#EF5C6E', fontSize: 12, marginTop: 10 }}>
              首个失败：{replyReport.firstFailure.reason}
              {replyReport.firstFailure.screenshot ? `；截图 ${replyReport.firstFailure.screenshot}` : ''}
            </div>
          )}
        </div>
      )}

      <Card
        className="fin-card"
        title={<span style={{ color: '#161322', fontSize: 16, fontWeight: 800 }}>全部账号汇总</span>}
        extra={(
          <Space wrap>
            <Tag color="default">总计 {accountTotals.total || 0}</Tag>
            <Tag color="processing">待回复 {accountTotals.pending || 0}</Tag>
            <Tag color="cyan">中性 {accountTotals.neutral || 0}</Tag>
            <Tag color="success">已回复 {accountTotals.replied || 0}</Tag>
            <Tag color="warning">不可回复 {accountTotals.blocked || 0}</Tag>
          </Space>
        )}
        style={{ marginBottom: 18 }}
        styles={{ body: { padding: 0 }, header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={accountsSummary.accounts || []}
          scroll={{ x: 920 }}
          columns={[
            {
              title: '店铺',
              key: 'name',
              width: 220,
              render: (_, account) => (
                <Space direction="vertical" size={2}>
                  <Space>
                    <Text strong style={{ color: '#161322' }}>{accountDisplayName(account)}</Text>
                    {account.isCurrent && <Tag color="purple">当前</Tag>}
                  </Space>
                  {!account.shopName && <Text style={{ color: '#F4B740', fontSize: 12 }}>未识别真实店铺名</Text>}
                  {account.shopName && account.name !== account.shopName && <Text type="secondary" style={{ fontSize: 12 }}>备注：{account.name}</Text>}
                </Space>
              ),
            },
            {
              title: '待回复',
              key: 'pending',
              width: 92,
              render: (_, account) => account.stats?.pending || 0,
            },
            {
              title: '中性回复',
              key: 'neutral',
              width: 102,
              render: (_, account) => account.stats?.neutral || 0,
            },
            {
              title: '已回复',
              key: 'replied',
              width: 92,
              render: (_, account) => account.stats?.replied || 0,
            },
            {
              title: '疑似差评',
              key: 'flagged',
              width: 102,
              render: (_, account) => account.stats?.flagged || 0,
            },
            {
              title: '无法判断',
              key: 'uncertain',
              width: 102,
              render: (_, account) => account.stats?.uncertain || 0,
            },
            {
              title: '不可回复',
              key: 'blocked',
              width: 102,
              render: (_, account) => account.stats?.blocked || 0,
            },
            {
              title: '本地总数',
              key: 'total',
              width: 102,
              render: (_, account) => account.stats?.total || 0,
            },
          ]}
          locale={{ emptyText: <Text style={{ color: '#A7A0B7' }}>暂无账号汇总</Text> }}
        />
      </Card>

      <StatsCards stats={stats} onFlaggedClick={showFlaggedReviews} />

      <Card
        title={<span style={{ color: '#161322', fontSize: 16, fontWeight: 800 }}>最近评价</span>}
        className="fin-card"
        style={{ marginTop: 18 }}
        styles={{ body: { padding: 0 }, header: { borderBottom: '1px solid #F0EAF7' } }}
      >
        <Table
          columns={columns}
          dataSource={reviews}
          rowKey="id"
          loading={loading}
          pagination={false}
          scroll={{ x: 1038 }}
          size="middle"
          locale={{ emptyText: <Text style={{ color: '#A7A0B7' }}>暂无评价，点击「抓取最新评价」开始</Text> }}
        />
      </Card>

      <Modal
        title={
          <Space>
            <WarningOutlined style={{ color: '#EF5C6E' }} />
            <span>疑似差评清单（{flaggedReviews.length} 条）</span>
          </Space>
        }
        open={flaggedModalOpen}
        onCancel={() => setFlaggedModalOpen(false)}
        footer={null}
        width={920}
        styles={{ body: { maxHeight: 620, overflow: 'auto', padding: 18 } }}
      >
        <Spin spinning={flaggedLoading}>
          {flaggedReviews.length === 0 && !flaggedLoading ? (
            <Text style={{ color: '#726C83' }}>暂无疑似差评</Text>
          ) : (
            flaggedReviews.map((review) => (
              <div className="risk-card" key={review.id}>
                <div className="risk-meta">
                  <ScoreChip value={review.stars} />
                  <Tag color="error" icon={<WarningOutlined />}>疑似差评</Tag>
                  {riskSyncTag(review)}
                  <Text style={{ color: '#726C83', fontSize: 12 }}>{review.userName || '-'}</Text>
                  <OrderText value={review.orderNo} />
                  <Text className="risk-time" style={{ color: '#726C83', fontSize: 12, textAlign: 'right' }}>{review.time || '-'}</Text>
                </div>
                <div className="risk-content">{review.content || '(无文字评价)'}</div>
                <div className="risk-reason">标记原因：{riskReason(review)}</div>
                {(review.riskSyncError || review.wecomNotifyError) && (
                  <div className="risk-reason">同步异常：{review.riskSyncError || review.wecomNotifyError}</div>
                )}
                <Button
                  size="small"
                  style={{ marginTop: 10 }}
                  onClick={() => handleSyncRiskReview(review)}
                  loading={syncingRiskId === (review.reviewId || review.id || review.orderNo)}
                  disabled={review.riskSyncStatus === 'synced'}
                >
                  {review.riskSyncStatus === 'synced' ? '已同步飞书' : '同步到飞书并提醒'}
                </Button>
              </div>
            ))
          )}
        </Spin>
      </Modal>

      <ReplyModal
        review={replyTarget}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSuccess={loadData}
      />

      <Modal
        title="账号管理"
        open={accountModalOpen}
        onCancel={() => setAccountModalOpen(false)}
        footer={null}
        width={720}
      >
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input
            placeholder="例如：店铺A / 店铺B"
            value={newAccountName}
            onChange={(event) => setNewAccountName(event.target.value)}
            onPressEnter={handleCreateAccount}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateAccount}
            loading={accountBusy === 'create'}
          >
            添加账号
          </Button>
        </Space.Compact>
        <Button
          block
          style={{ marginBottom: 12 }}
          onClick={handleDetectAllShopNames}
          loading={accountBusy === 'detect-all'}
        >
          识别全部账号真实店铺名
        </Button>
        <List
          bordered
          dataSource={accountsState.accounts}
          renderItem={(account) => (
            <List.Item
              actions={[
                <Button
                  key="switch"
                  size="small"
                  onClick={() => handleSwitchAccount(account.id)}
                  disabled={account.id === accountsState.currentAccountId}
                  loading={accountBusy === account.id}
                >
                  {account.id === accountsState.currentAccountId ? '当前账号' : '切换'}
                </Button>,
                <Button
                  key="open"
                  size="small"
                  icon={<LoginOutlined />}
                  onClick={() => handleOpenAccount(account.id)}
                  loading={accountBusy === `open-${account.id}`}
                >
                  打开登录
                </Button>,
                <Button
                  key="detect"
                  size="small"
                  onClick={() => handleDetectShopName(account.id)}
                  loading={accountBusy === `detect-${account.id}`}
                >
                  识别店铺
                </Button>,
                <Button
                  key="delete"
                  size="small"
                  danger
                  disabled={account.id === accountsState.currentAccountId || account.id === 'default'}
                  onClick={() => handleDeleteAccount(account)}
                >
                  删除
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={(
                  <Space>
                    <Text strong>{accountDisplayName(account)}</Text>
                    {account.shopName && account.name !== account.shopName && <Tag color="default">{account.name}</Tag>}
                    {account.id === accountsState.currentAccountId && <Tag color="purple">当前</Tag>}
                  </Space>
                )}
                description={
                  <Space direction="vertical" size={2}>
                    <Text type={account.shopName ? 'secondary' : 'warning'}>{shopStatusText(account)}</Text>
                    <Text type="secondary">{account.openedAt ? `已打开过登录窗口：${account.openedAt}` : '未打开过登录窗口'}</Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
        <Button
          style={{ marginTop: 14 }}
          onClick={handleCloseAccountBrowser}
          loading={accountBusy === 'close-browser'}
        >
          关闭当前账号浏览器
        </Button>
      </Modal>
    </div>
  );
}
