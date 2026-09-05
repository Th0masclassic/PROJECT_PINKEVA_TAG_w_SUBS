import type { Language } from '../i18n';
import type { BillingInterval } from './types';

const locales: Record<Language, string> = {
  en: 'en-US',
  pt: 'pt-PT',
  fr: 'fr-FR',
  de: 'de-DE',
  zh: 'zh-CN',
  it: 'it-IT',
  es: 'es-ES',
};

const durationUnits: Record<Language, { month: [string, string]; year: [string, string] }> = {
  en: { month: ['month', 'months'], year: ['year', 'years'] },
  pt: { month: ['mês', 'meses'], year: ['ano', 'anos'] },
  fr: { month: ['mois', 'mois'], year: ['an', 'ans'] },
  de: { month: ['Monat', 'Monate'], year: ['Jahr', 'Jahre'] },
  zh: { month: ['个月', '个月'], year: ['年', '年'] },
  it: { month: ['mese', 'mesi'], year: ['anno', 'anni'] },
  es: { month: ['mes', 'meses'], year: ['año', 'años'] },
};

const localizedPlanNames: Record<Language, Record<string, string>> = {
  en: { monthly_basic: 'Cloud + Monthly', quarterly_standard: 'Cloud + 3 Months', semiannual_plus: 'Cloud + 6 Months', yearly_pro: 'Cloud + Annual' },
  pt: { monthly_basic: 'Cloud + Mensal', quarterly_standard: 'Cloud + 3 Meses', semiannual_plus: 'Cloud + 6 Meses', yearly_pro: 'Cloud + Anual' },
  fr: { monthly_basic: 'Cloud + Mensuel', quarterly_standard: 'Cloud + 3 Mois', semiannual_plus: 'Cloud + 6 Mois', yearly_pro: 'Cloud + Annuel' },
  de: { monthly_basic: 'Cloud + Monatlich', quarterly_standard: 'Cloud + 3 Monate', semiannual_plus: 'Cloud + 6 Monate', yearly_pro: 'Cloud + Jährlich' },
  zh: { monthly_basic: 'Cloud + 月度套餐', quarterly_standard: 'Cloud + 3 个月', semiannual_plus: 'Cloud + 6 个月', yearly_pro: 'Cloud + 年度套餐' },
  it: { monthly_basic: 'Cloud + Mensile', quarterly_standard: 'Cloud + 3 Mesi', semiannual_plus: 'Cloud + 6 Mesi', yearly_pro: 'Cloud + Annuale' },
  es: { monthly_basic: 'Cloud + Mensual', quarterly_standard: 'Cloud + 3 Meses', semiannual_plus: 'Cloud + 6 Meses', yearly_pro: 'Cloud + Anual' },
};

export function localizedBillingPlanName(
  planCode: string,
  fallback: string,
  language: Language,
): string {
  return localizedPlanNames[language][planCode] ?? fallback;
}

export function formatBillingMoney(
  amountMinor: number | null,
  currency: string | null,
  language: Language,
): string | null {
  if (
    amountMinor === null ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }

  try {
    return new Intl.NumberFormat(locales[language], {
      style: 'currency',
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

export function formatMonthlyEquivalent(
  plan: { amountMinor: number; currency: string; durationMonths: number },
  language: Language,
): string | null {
  if (!Number.isSafeInteger(plan.amountMinor) || plan.amountMinor < 0 || plan.durationMonths < 1) return null;
  try {
    return new Intl.NumberFormat(locales[language], {
      style: 'currency',
      currency: plan.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(plan.amountMinor / plan.durationMonths / 100);
  } catch {
    return `${(plan.amountMinor / plan.durationMonths / 100).toFixed(2)} ${plan.currency}`;
  }
}

export function planSavingsPercent(
  plan: { amountMinor: number; currency: string; durationMonths: number },
  monthlyPlan: { amountMinor: number; currency: string } | undefined,
): number | null {
  if (!monthlyPlan || plan.currency !== monthlyPlan.currency || plan.durationMonths <= 1 || monthlyPlan.amountMinor <= 0) return null;
  const savings = Math.round((1 - plan.amountMinor / (monthlyPlan.amountMinor * plan.durationMonths)) * 100);
  return savings > 0 ? savings : null;
}

export function recommendedBillingPlanCode<T extends {
  code: string;
  amountMinor: number;
  currency: string;
  durationMonths: number;
}>(plans: readonly T[]): string | undefined {
  const monthly = plans.find((plan) => plan.durationMonths === 1);
  const best = [...plans]
    .map((plan) => ({ plan, savings: planSavingsPercent(plan, monthly) ?? 0 }))
    .sort((left, right) => right.savings - left.savings || right.plan.durationMonths - left.plan.durationMonths)[0];
  return best && best.savings > 0 ? best.plan.code : undefined;
}

export function billingDurationLabel(durationMonths: number, language: Language): string | null {
  if (!Number.isSafeInteger(durationMonths) || durationMonths < 1) return null;
  const useYears = durationMonths % 12 === 0;
  const count = useYears ? durationMonths / 12 : durationMonths;
  const units = durationUnits[language][useYears ? 'year' : 'month'];
  return count === 1 ? units[0] : `${count} ${units[1]}`;
}

export function formatBillingDate(value: string | null, language: Language): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locales[language], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function billingIntervalLabel(
  interval: BillingInterval | null,
  monthLabel: string,
  yearLabel: string,
  intervalCount = 1,
): string | null {
  if (interval === 'month') return intervalCount === 1 ? monthLabel : `${intervalCount} ${monthLabel}`;
  if (interval === 'year') return intervalCount === 1 ? yearLabel : `${intervalCount} ${yearLabel}`;
  return null;
}
