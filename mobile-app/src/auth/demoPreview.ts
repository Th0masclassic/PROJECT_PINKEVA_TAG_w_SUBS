import type { Language } from '../i18n';

export function canUseDemoPreview(isDevelopment: boolean): boolean {
  return isDevelopment;
}

const previewCopies: Record<Language, { button: string; note: string }> = {
  en: { button: 'Preview demo', note: 'Development only · no account or payment is created' },
  pt: { button: 'Pré-visualizar demo', note: 'Apenas desenvolvimento · não cria conta nem pagamento' },
  fr: { button: 'Aperçu de la démo', note: 'Développement uniquement · aucun compte ni paiement créé' },
  de: { button: 'Demo ansehen', note: 'Nur Entwicklung · kein Konto und keine Zahlung' },
  zh: { button: '预览演示', note: '仅用于开发 · 不会创建账户或付款' },
  it: { button: 'Anteprima demo', note: 'Solo sviluppo · non crea account né pagamenti' },
  es: { button: 'Vista previa', note: 'Solo desarrollo · no crea cuentas ni pagos' },
};

export function getDemoPreviewCopy(language: Language): { button: string; note: string } {
  return previewCopies[language];
}
