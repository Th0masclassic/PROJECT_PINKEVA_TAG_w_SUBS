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

const localizedPlanNames: Record<Language, Record<string, string>> = {
  en: { monthly_basic: 'Pinkeva Monthly', quarterly_standard: 'Pinkeva 3 Months', semiannual_plus: 'Pinkeva 6 Months', yearly_pro: 'Pinkeva Annual' },
  pt: { monthly_basic: 'Pinkeva Mensal', quarterly_standard: 'Pinkeva 3 Meses', semiannual_plus: 'Pinkeva 6 Meses', yearly_pro: 'Pinkeva Anual' },
  fr: { monthly_basic: 'Pinkeva Mensuel', quarterly_standard: 'Pinkeva 3 Mois', semiannual_plus: 'Pinkeva 6 Mois', yearly_pro: 'Pinkeva Annuel' },
  de: { monthly_basic: 'Pinkeva Monatlich', quarterly_standard: 'Pinkeva 3 Monate', semiannual_plus: 'Pinkeva 6 Monate', yearly_pro: 'Pinkeva Jährlich' },
  zh: { monthly_basic: 'Pinkeva 月度套餐', quarterly_standard: 'Pinkeva 3 个月', semiannual_plus: 'Pinkeva 6 个月', yearly_pro: 'Pinkeva 年度套餐' },
  it: { monthly_basic: 'Pinkeva Mensile', quarterly_standard: 'Pinkeva 3 Mesi', semiannual_plus: 'Pinkeva 6 Mesi', yearly_pro: 'Pinkeva Annuale' },
  es: { monthly_basic: 'Pinkeva Mensual', quarterly_standard: 'Pinkeva 3 Meses', semiannual_plus: 'Pinkeva 6 Meses', yearly_pro: 'Pinkeva Anual' },
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
