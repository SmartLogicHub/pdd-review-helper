import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyReplySubmitMessage,
  hasMerchantReply,
  isReviewAlreadyReplied,
  mergeReviewRecords,
  normalizePddReviewItem,
  shouldAutoReplyReview,
} from '../services/review-normalizer.js';

// 取自真实数据：拼多多「未回复」列表里 68% 的评价挂着这类非商家留言
const BOT = { content: '一周才充一次电，这续航也太省心了吧！', replyType: 1, userInfo: { nickName: '评价总结小助手', userType: 0, isBuyer: 0 } };
const BUYER = { content: '同款，确实好用', replyType: 1, userInfo: { nickName: '徐姐', userType: 0, isBuyer: 1 } };
const SHOP = { content: '感谢您的评价', replyType: 1, userInfo: { nickName: '漫步者极音专卖店', userType: 1, isBuyer: 0 } };

function pendingItem(replyList) {
  return {
    reviewId: 'r1', orderSn: '260920-366844352150760', comment: '续航时间挺长的 一周冲一次电',
    descScore: 5, canReview: true, canInteract: true, replyStatus: 0, reply: '',
    replyCount: replyList.length, replyList,
  };
}

test('platform bot and buyer comments are not treated as the shop having replied', () => {
  for (const list of [[BOT], [BUYER], [BOT, BUYER]]) {
    const review = normalizePddReviewItem(pendingItem(list));
    assert.equal(review.replied, false);
    assert.equal(isReviewAlreadyReplied(review), false);
    assert.equal(shouldAutoReplyReview(review).ok, true);
  }
});

test('a reply from the shop account still counts as replied, even mixed with bot comments', () => {
  const review = normalizePddReviewItem(pendingItem([BOT, SHOP]));
  assert.equal(review.replied, true);
  assert.equal(shouldAutoReplyReview(review).ok, false);
});

test('reply entries without author info are treated as shop replies to avoid double replies', () => {
  assert.equal(hasMerchantReply([{ content: '感谢支持' }]), true);
  assert.equal(isReviewAlreadyReplied({ replyList: [{ content: '感谢支持' }] }), true);
  assert.equal(isReviewAlreadyReplied({ replyCount: 1 }), true, '没有 replyList 时仍以 replyCount 为准');
});

test('local records wrongly marked replied because of a bot comment are corrected on the next fetch', () => {
  const stale = { reviewId: 'r1', replied: true, replyCount: 1, replyList: [BOT] };
  const [merged] = mergeReviewRecords([stale], [normalizePddReviewItem(pendingItem([BOT]))]);
  assert.equal(merged.replied, false);
  assert.equal(isReviewAlreadyReplied(merged), false);
});

test('the review-interaction drawer success messages are recognized', () => {
  assert.equal(classifyReplySubmitMessage('发布成功')?.status, 'ok');
  assert.equal(classifyReplySubmitMessage('评论成功')?.status, 'ok');
});
