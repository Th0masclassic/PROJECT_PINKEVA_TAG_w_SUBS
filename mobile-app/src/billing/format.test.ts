import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billingDurationLabel,
  billingIntervalLabel,
  formatBillingDate,
  formatBillingMoney,
  formatMonthlyEquivalent,
  localizedBillingPlanName,
  planSavingsPercent,
  recommendedBillingPlanCode,
} from './format.ts';

test('formats validated minor-unit prices and rejects invalid values', () => {
  const value = formatBillingMoney(299, 'EUR', 'en');
  assert.ok(value?.includes('2.99'));
  assert.equal(formatBillingMoney(-1, 'EUR', 'en'), null);
  assert.equal(formatBillingMoney(299, 'EURO', 'en'), null);
});

test('derives monthly equivalents, savings, and best value from server prices', () => {
  const monthly = { code: 'm', amountMinor: 299, currency: 'EUR', durationMonths: 1 };
  const annual = { code: 'y', amountMinor: 2699, currency: 'EUR', durationMonths: 12 };
  assert.ok(formatMonthlyEquivalent(annual, 'en')?.includes('2.25'));
  assert.equal(planSavingsPercent(annual, monthly), 25);
  assert.equal(recommendedBillingPlanCode([monthly, annual]), 'y');
  assert.equal(recommendedBillingPlanCode([monthly]), undefined);
  assert.equal(billingDurationLabel(3, 'en'), '3 months');
  assert.equal(billingDurationLabel(12, 'pt'), 'ano');
});

test('localizes known plan names and preserves safe server fallbacks', () => {
  assert.equal(localizedBillingPlanName('monthly_basic', 'Monthly', 'pt'), 'Cloud + Mensal');
  assert.equal(localizedBillingPlanName('yearly_pro', 'Annual', 'zh'), 'Cloud + 年度套餐');
  assert.equal(localizedBillingPlanName('partner_plan', 'Partner plan', 'fr'), 'Partner plan');
});

test('formats dates and billing intervals safely', () => {
  assert.ok(formatBillingDate('2026-09-12T12:00:00Z', 'pt'));
  assert.equal(formatBillingDate('not-a-date', 'pt'), null);
  assert.equal(billingIntervalLabel('month', 'mês', 'ano'), 'mês');
  assert.equal(billingIntervalLabel('year', 'mês', 'ano'), 'ano');
  assert.equal(billingIntervalLabel(null, 'mês', 'ano'), null);
});
