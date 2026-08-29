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
};

const copies: Record<Language, AccountBillingCopy> = {
  en: {
    subtitle: 'Protection and benefits for your Pinkeva account',
    membership: 'Your membership',
    activeBody: 'Pinkeva Cloud + is active for this account.',
    inactiveBody: 'Choose a plan to add Cloud + protection to your account.',
    plans: 'Choose your plan',
    choosePlan: 'Select the billing period that works for you.',
    subscribe: 'Continue to secure checkout',
    manage: 'Manage subscription',
  },
  pt: {
    subtitle: 'Proteção e vantagens para a sua conta Pinkeva',
    membership: 'A sua subscrição',
    activeBody: 'O Pinkeva Cloud + está ativo nesta conta.',
    inactiveBody: 'Escolha um plano para adicionar a proteção Cloud + à sua conta.',
    plans: 'Escolha o seu plano',
    choosePlan: 'Selecione o período de faturação mais adequado.',
    subscribe: 'Continuar para o checkout seguro',
    manage: 'Gerir subscrição',
  },
  fr: {
    subtitle: 'Protection et avantages pour votre compte Pinkeva',
    membership: 'Votre abonnement',
    activeBody: 'Pinkeva Cloud + est actif sur ce compte.',
    inactiveBody: 'Choisissez un forfait pour ajouter la protection Cloud + à votre compte.',
    plans: 'Choisissez votre forfait',
    choosePlan: 'Sélectionnez la période de facturation qui vous convient.',
    subscribe: 'Continuer vers le paiement sécurisé',
    manage: 'Gérer l’abonnement',
  },
  de: {
    subtitle: 'Schutz und Vorteile für dein Pinkeva-Konto',
    membership: 'Dein Abonnement',
    activeBody: 'Pinkeva Cloud + ist für dieses Konto aktiv.',
    inactiveBody: 'Wähle einen Tarif, um deinem Konto Cloud + Schutz hinzuzufügen.',
    plans: 'Tarif auswählen',
    choosePlan: 'Wähle den passenden Abrechnungszeitraum.',
    subscribe: 'Weiter zum sicheren Checkout',
    manage: 'Abonnement verwalten',
  },
  zh: {
    subtitle: '为你的 Pinkeva 账户提供保护和会员权益',
    membership: '你的订阅',
    activeBody: '此账户已启用 Pinkeva Cloud +。',
    inactiveBody: '选择套餐，为你的账户添加 Cloud + 保护。',
    plans: '选择套餐',
    choosePlan: '选择适合你的计费周期。',
    subscribe: '继续前往安全结账',
    manage: '管理订阅',
  },
  it: {
    subtitle: 'Protezione e vantaggi per il tuo account Pinkeva',
    membership: 'Il tuo abbonamento',
    activeBody: 'Pinkeva Cloud + è attivo per questo account.',
    inactiveBody: 'Scegli un piano per aggiungere la protezione Cloud + al tuo account.',
    plans: 'Scegli il piano',
    choosePlan: 'Seleziona il periodo di fatturazione più adatto a te.',
    subscribe: 'Continua al pagamento sicuro',
    manage: 'Gestisci abbonamento',
  },
  es: {
    subtitle: 'Protección y ventajas para tu cuenta Pinkeva',
    membership: 'Tu suscripción',
    activeBody: 'Pinkeva Cloud + está activo en esta cuenta.',
    inactiveBody: 'Elige un plan para añadir la protección Cloud + a tu cuenta.',
    plans: 'Elige tu plan',
    choosePlan: 'Selecciona el periodo de facturación que prefieras.',
    subscribe: 'Continuar al pago seguro',
    manage: 'Gestionar suscripción',
  },
};

export function useAccountBillingCopy(): AccountBillingCopy {
  const { language } = useI18n();
  return copies[language];
}
