import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingIntervalLabel,
  formatBillingDate,
  formatBillingMoney,
  localizedBillingPlanName,
} from './format.ts';

test('formats validated minor-unit prices and rejects invalid values', () => {
  const value = formatBillingMoney(299, 'EUR', 'en');
  assert.ok(value?.includes('2.99'));
  assert.equal(formatBillingMoney(-1, 'EUR', 'en'), null);
  assert.equal(formatBillingMoney(299, 'EURO', 'en'), null);
});

test('localizes known plan names and preserves safe server fallbacks', () => {
  assert.equal(localizedBillingPlanName('monthly_basic', 'Monthly', 'pt'), 'Pinkeva Mensal');
  assert.equal(localizedBillingPlanName('yearly_pro', 'Annual', 'zh'), 'Pinkeva 年度套餐');
  assert.equal(localizedBillingPlanName('partner_plan', 'Partner plan', 'fr'), 'Partner plan');
});

test('formats dates and billing intervals safely', () => {
  assert.ok(formatBillingDate('2026-09-12T12:00:00Z', 'pt'));
  assert.equal(formatBillingDate('not-a-date', 'pt'), null);
  assert.equal(billingIntervalLabel('month', 'mês', 'ano'), 'mês');
  assert.equal(billingIntervalLabel('year', 'mês', 'ano'), 'ano');
  assert.equal(billingIntervalLabel(null, 'mês', 'ano'), null);
});
