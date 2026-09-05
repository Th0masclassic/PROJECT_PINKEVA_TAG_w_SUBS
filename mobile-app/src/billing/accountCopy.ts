import { useI18n, type Language } from '../i18n';

export type AccountBillingCopy = {
  subtitle: string;
  membership: string;
  activeBody: string;
  inactiveBody: string;
  plans: string;
  choosePlan: string;
  subscribe: string;
  manage: string;
  perMonth: string;
  save: string;
  bestValue: string;
  currentPlan: string;
  included: string;
  safeZones: string;
  history: string;
  smartAlerts: string;
  replacement: string;
  manageTitle: string;
  manageBody: string;
  changePlan: string;
  portalNotice: string;
};

const copies: Record<Language, AccountBillingCopy> = {
  en: {
    subtitle: 'Protection and benefits for your Pinkeva account',
    membership: 'Your membership',
    activeBody: 'Pinkeva Cloud + is active for this account.',
    inactiveBody: 'Choose a plan to add Cloud + protection to your account.',
    plans: 'Available plans',
    choosePlan: 'Compare every billing period. Prices come from the secure Pinkeva catalog.',
    subscribe: 'Continue to secure checkout',
    manage: 'Manage subscription',
    perMonth: '{{price}} / month', save: 'Save {{percent}}%', bestValue: 'BEST VALUE', currentPlan: 'CURRENT', included: 'Included', safeZones: 'Safe Zones', history: '30-day location history', smartAlerts: 'Smart alerts', replacement: 'Replacement benefit', manageTitle: 'Manage subscription', manageBody: 'Review your current plan, then continue to Stripe to change or cancel it.', changePlan: 'Change plan in Stripe', portalNotice: 'Stripe shows the effective date and any prorated amount before you confirm.',
  },
  pt: {
    subtitle: 'Proteção e vantagens para a sua conta Pinkeva',
    membership: 'A sua subscrição',
    activeBody: 'O Pinkeva Cloud + está ativo nesta conta.',
    inactiveBody: 'Escolha um plano para adicionar a proteção Cloud + à sua conta.',
    plans: 'Planos disponíveis',
    choosePlan: 'Compare todos os períodos. Os preços vêm do catálogo seguro da Pinkeva.',
    subscribe: 'Continuar para o checkout seguro',
    manage: 'Gerir subscrição',
    perMonth: '{{price}} / mês', save: 'Poupe {{percent}}%', bestValue: 'MELHOR VALOR', currentPlan: 'ATUAL', included: 'Incluído', safeZones: 'Zonas Seguras', history: 'Histórico de 30 dias', smartAlerts: 'Alertas inteligentes', replacement: 'Benefício de substituição', manageTitle: 'Gerir subscrição', manageBody: 'Consulte o plano atual e continue para a Stripe para o alterar ou cancelar.', changePlan: 'Alterar plano na Stripe', portalNotice: 'A Stripe mostra a data efetiva e qualquer valor proporcional antes da confirmação.',
  },
  fr: {
    subtitle: 'Protection et avantages pour votre compte Pinkeva',
    membership: 'Votre abonnement',
    activeBody: 'Pinkeva Cloud + est actif sur ce compte.',
    inactiveBody: 'Choisissez un forfait pour ajouter la protection Cloud + à votre compte.',
    plans: 'Forfaits disponibles',
    choosePlan: 'Comparez toutes les périodes. Les prix viennent du catalogue sécurisé Pinkeva.',
    subscribe: 'Continuer vers le paiement sécurisé',
    manage: 'Gérer l’abonnement',
    perMonth: '{{price}} / mois', save: 'Économisez {{percent}} %', bestValue: 'MEILLEUR CHOIX', currentPlan: 'ACTUEL', included: 'Inclus', safeZones: 'Zones sécurisées', history: 'Historique de 30 jours', smartAlerts: 'Alertes intelligentes', replacement: 'Avantage de remplacement', manageTitle: 'Gérer l’abonnement', manageBody: 'Consultez votre forfait puis passez sur Stripe pour le modifier ou l’annuler.', changePlan: 'Changer de forfait sur Stripe', portalNotice: 'Stripe affiche la date d’effet et tout prorata avant confirmation.',
  },
  de: {
    subtitle: 'Schutz und Vorteile für dein Pinkeva-Konto',
    membership: 'Dein Abonnement',
    activeBody: 'Pinkeva Cloud + ist für dieses Konto aktiv.',
    inactiveBody: 'Wähle einen Tarif, um deinem Konto Cloud + Schutz hinzuzufügen.',
    plans: 'Verfügbare Tarife',
    choosePlan: 'Vergleiche alle Laufzeiten. Preise stammen aus dem sicheren Pinkeva-Katalog.',
    subscribe: 'Weiter zum sicheren Checkout',
    manage: 'Abonnement verwalten',
    perMonth: '{{price}} / Monat', save: '{{percent}} % sparen', bestValue: 'BESTER WERT', currentPlan: 'AKTUELL', included: 'Enthalten', safeZones: 'Sichere Zonen', history: '30 Tage Standortverlauf', smartAlerts: 'Intelligente Warnungen', replacement: 'Ersatzleistung', manageTitle: 'Abonnement verwalten', manageBody: 'Prüfe deinen Tarif und wechsle zu Stripe, um ihn zu ändern oder zu kündigen.', changePlan: 'Tarif in Stripe ändern', portalNotice: 'Stripe zeigt Gültigkeitsdatum und anteilige Beträge vor der Bestätigung.',
  },
  zh: {
    subtitle: '为你的 Pinkeva 账户提供保护和会员权益',
    membership: '你的订阅',
    activeBody: '此账户已启用 Pinkeva Cloud +。',
    inactiveBody: '选择套餐，为你的账户添加 Cloud + 保护。',
    plans: '可用套餐',
    choosePlan: '比较所有计费周期。价格来自 Pinkeva 安全目录。',
    subscribe: '继续前往安全结账',
    manage: '管理订阅',
    perMonth: '{{price}} / 月', save: '节省 {{percent}}%', bestValue: '最超值', currentPlan: '当前', included: '包含', safeZones: '安全区域', history: '30 天位置记录', smartAlerts: '智能提醒', replacement: '换新权益', manageTitle: '管理订阅', manageBody: '查看当前套餐，然后前往 Stripe 更改或取消。', changePlan: '在 Stripe 更改套餐', portalNotice: '确认前，Stripe 会显示生效日期和任何按比例计费金额。',
  },
  it: {
    subtitle: 'Protezione e vantaggi per il tuo account Pinkeva',
    membership: 'Il tuo abbonamento',
    activeBody: 'Pinkeva Cloud + è attivo per questo account.',
    inactiveBody: 'Scegli un piano per aggiungere la protezione Cloud + al tuo account.',
    plans: 'Piani disponibili',
    choosePlan: 'Confronta tutti i periodi. I prezzi provengono dal catalogo sicuro Pinkeva.',
    subscribe: 'Continua al pagamento sicuro',
    manage: 'Gestisci abbonamento',
    perMonth: '{{price}} / mese', save: 'Risparmia {{percent}}%', bestValue: 'MIGLIOR VALORE', currentPlan: 'ATTUALE', included: 'Incluso', safeZones: 'Zone sicure', history: 'Cronologia di 30 giorni', smartAlerts: 'Avvisi intelligenti', replacement: 'Vantaggio sostituzione', manageTitle: 'Gestisci abbonamento', manageBody: 'Controlla il piano e passa a Stripe per modificarlo o annullarlo.', changePlan: 'Cambia piano su Stripe', portalNotice: 'Stripe mostra data effettiva e importi proporzionali prima della conferma.',
  },
  es: {
    subtitle: 'Protección y ventajas para tu cuenta Pinkeva',
    membership: 'Tu suscripción',
    activeBody: 'Pinkeva Cloud + está activo en esta cuenta.',
    inactiveBody: 'Elige un plan para añadir la protección Cloud + a tu cuenta.',
    plans: 'Planes disponibles',
    choosePlan: 'Compara todos los periodos. Los precios vienen del catálogo seguro de Pinkeva.',
    subscribe: 'Continuar al pago seguro',
    manage: 'Gestionar suscripción',
    perMonth: '{{price}} / mes', save: 'Ahorra {{percent}}%', bestValue: 'MEJOR VALOR', currentPlan: 'ACTUAL', included: 'Incluido', safeZones: 'Zonas seguras', history: 'Historial de 30 días', smartAlerts: 'Alertas inteligentes', replacement: 'Ventaja de sustitución', manageTitle: 'Gestionar suscripción', manageBody: 'Revisa tu plan y continúa a Stripe para cambiarlo o cancelarlo.', changePlan: 'Cambiar plan en Stripe', portalNotice: 'Stripe muestra la fecha efectiva y cualquier importe prorrateado antes de confirmar.',
  },
};

export function useAccountBillingCopy(): AccountBillingCopy {
  const { language } = useI18n();
  return copies[language];
}

export function interpolateAccountBillingCopy(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ''));
}
