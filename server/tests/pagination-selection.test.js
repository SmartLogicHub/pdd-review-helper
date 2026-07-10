import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../services/playwright.js';

test('selects pagination page 10 instead of page-size dropdown option 10', () => {
  const pick = __testing.pickPaginationControlSnapshot([
    {
      index: 0,
      text: '10',
      source: 'page-size-dropdown',
      inDropdown: true,
      inPageSizeControl: true,
      disabled: false,
    },
    {
      index: 1,
      text: '9',
      source: 'pagination',
      inPaginationRoot: true,
      active: true,
      disabled: false,
    },
    {
      index: 2,
      text: '10',
      source: 'pagination',
      inPaginationRoot: true,
      active: false,
      disabled: false,
    },
  ], 10);

  assert.deepEqual(pick, { index: 2, strategy: 'page-number' });
});

test('ignores page-size options when selecting page 20 or 30', () => {
  assert.equal(
    __testing.pickPaginationControlSnapshot([
      { index: 0, text: '20', source: 'page-size-dropdown', inDropdown: true, inPageSizeControl: true },
      { index: 1, text: '20', source: 'pagination', inPaginationRoot: true },
    ], 20).index,
    1
  );

  assert.equal(
    __testing.pickPaginationControlSnapshot([
      { index: 0, text: '30', source: 'page-size-dropdown', inDropdown: true, inPageSizeControl: true },
      { index: 1, text: '>', source: 'pagination', inPaginationRoot: true },
    ], 30).index,
    1
  );
});

test('falls back to next arrow only inside the pagination root', () => {
  const pick = __testing.pickPaginationControlSnapshot([
    { index: 0, text: '>', source: 'floating-menu', inDropdown: true },
    { index: 1, text: '>', source: 'pagination', inPaginationRoot: true, disabled: false },
  ], 200);

  assert.deepEqual(pick, { index: 1, strategy: 'next-arrow' });
});
