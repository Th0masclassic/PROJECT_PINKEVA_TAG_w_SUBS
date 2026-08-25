import { useI18n, type Language } from '../i18n';
import type { BillingErrorCode, DeviceSubscription, SubscriptionStatus } from './types';

type BillingCopy = {
  title: string;
  subtitle: string;
  subscription: string;
  subscriptionSubtitle: string;
  perTag: string;
  demoBadge: string;
  demoTitle: string;
  demoBody: string;
  status: string;
  active: string;
  trial: string;
  attention: string;
  paused: string;
  ending: string;
  none: string;
  unavailable: string;
  currentPlan: string;
  billingPeriod: string;
  currentPeriod: string;
  renewsOn: string;
  endsOn: string;
  autoRenew: string;
  autoRenewOn: string;
  autoRenewOff: string;
  plans: string;
  choosePlan: string;
  month: string;
  year: string;
  subscribe: string;
  manage: string;
  activate?: string;
  renew: string;
  cancel: string;
  cancelConfirmTitle: string;
  cancelConfirmBody: string;
  keepSubscription: string;
  confirmCancel: string;
  secureNotice: string;
  loading: string;
  retry: string;
  noPlans: string;
  priceAtCheckout: string;
  opened: string;
  demoAction: string;
  purchaseDisabled: string;
  errorConfiguration: string;
  errorAuthentication: string;
  errorNotFound: string;
  errorRateLimited: string;
  errorConflict: string;
  errorNetwork: string;
  errorTimeout: string;
  errorInvalidResponse: string;
  errorUnavailable: string;
};

const copies: Record<Language, BillingCopy> = {
  en: {
    title: 'Tag subscription', subtitle: 'Billing for {{name}}', subscription: 'Subscription', subscriptionSubtitle: 'Plan and billing for this tag', perTag: 'This plan belongs only to this tag. Every Pinkeva tag has its own subscription.', demoBadge: 'DEMO', demoTitle: 'Billing preview', demoBody: 'Secure billing is not configured in this build. You can explore every state, but no charge will be created.', status: 'Status', active: 'Active', trial: 'Trial', attention: 'Payment needs attention', paused: 'Paused', ending: 'Ends this period', none: 'No subscription', unavailable: 'Unavailable', currentPlan: 'Current plan', billingPeriod: 'Billing period', currentPeriod: 'Current period', renewsOn: 'Renews on', endsOn: 'Access ends on', autoRenew: 'Automatic renewal', autoRenewOn: 'On', autoRenewOff: 'Off — cancellation scheduled', plans: 'Plans for this tag', choosePlan: 'Choose a plan before continuing to secure checkout.', month: 'month', year: 'year', subscribe: 'Subscribe this tag', manage: 'Change or manage', activate: 'Activate tag', renew: 'Renew this tag', cancel: 'Cancel subscription', cancelConfirmTitle: 'Cancel this tag’s subscription?', cancelConfirmBody: '{{name}} will keep access until the end of its paid period. This affects only this tag.', keepSubscription: 'Keep subscription', confirmCancel: 'Continue to cancellation', secureNotice: 'Payment details are entered only on Stripe’s secure page. Pinkeva does not collect card details in the app.', loading: 'Loading subscription…', retry: 'Try again', noPlans: 'Plans are temporarily unavailable.', priceAtCheckout: 'Price shown at checkout', opened: 'Billing page closed. Subscription status is being refreshed.', demoAction: 'This is a billing preview. Configure the secure API to continue.', purchaseDisabled: 'Starting an external subscription is disabled in this build. Existing subscriptions can still be managed.', errorConfiguration: 'Billing is not configured on this build.', errorAuthentication: 'Please sign in again to manage this tag.', errorNotFound: 'This tag or subscription could not be found.', errorRateLimited: 'Too many attempts. Please wait a moment.', errorConflict: 'This subscription changed. Refresh and try again.', errorNetwork: 'Check your connection and try again.', errorTimeout: 'The billing service took too long. Try again.', errorInvalidResponse: 'The billing service returned an invalid response.', errorUnavailable: 'Billing is temporarily unavailable.',
  },
  pt: {
    title: 'Subscrição da tag', subtitle: 'Faturação de {{name}}', subscription: 'Subscrição', subscriptionSubtitle: 'Plano e faturação desta tag', perTag: 'Este plano pertence apenas a esta tag. Cada tag Pinkeva tem a sua própria subscrição.', demoBadge: 'DEMO', demoTitle: 'Pré-visualização da faturação', demoBody: 'A faturação segura não está configurada nesta versão. Pode explorar todos os estados, mas não será criada qualquer cobrança.', status: 'Estado', active: 'Ativa', trial: 'Período experimental', attention: 'Pagamento requer atenção', paused: 'Em pausa', ending: 'Termina neste período', none: 'Sem subscrição', unavailable: 'Indisponível', currentPlan: 'Plano atual', billingPeriod: 'Período de faturação', currentPeriod: 'Período atual', renewsOn: 'Renova em', endsOn: 'O acesso termina em', autoRenew: 'Renovação automática', autoRenewOn: 'Ativa', autoRenewOff: 'Desativada — cancelamento agendado', plans: 'Planos para esta tag', choosePlan: 'Escolha um plano antes de continuar para o checkout seguro.', month: 'mês', year: 'ano', subscribe: 'Subscrever esta tag', manage: 'Alterar ou gerir', activate: 'Ativar tag', renew: 'Renovar esta tag', cancel: 'Cancelar subscrição', cancelConfirmTitle: 'Cancelar a subscrição desta tag?', cancelConfirmBody: '{{name}} mantém o acesso até ao fim do período pago. Isto afeta apenas esta tag.', keepSubscription: 'Manter subscrição', confirmCancel: 'Continuar para cancelamento', secureNotice: 'Os dados de pagamento são introduzidos apenas na página segura da Stripe. A Pinkeva não recolhe dados do cartão na app.', loading: 'A carregar subscrição…', retry: 'Tentar novamente', noPlans: 'Os planos estão temporariamente indisponíveis.', priceAtCheckout: 'Preço apresentado no checkout', opened: 'A página de faturação foi fechada. O estado da subscrição está a ser atualizado.', demoAction: 'Esta é uma pré-visualização. Configure a API segura para continuar.', purchaseDisabled: 'O início de subscrições externas está desativado nesta versão. As subscrições existentes podem continuar a ser geridas.', errorConfiguration: 'A faturação não está configurada nesta versão.', errorAuthentication: 'Inicie sessão novamente para gerir esta tag.', errorNotFound: 'Não foi possível encontrar esta tag ou subscrição.', errorRateLimited: 'Demasiadas tentativas. Aguarde um momento.', errorConflict: 'A subscrição foi alterada. Atualize e tente novamente.', errorNetwork: 'Verifique a ligação e tente novamente.', errorTimeout: 'O serviço de faturação demorou demasiado. Tente novamente.', errorInvalidResponse: 'O serviço de faturação devolveu uma resposta inválida.', errorUnavailable: 'A faturação está temporariamente indisponível.',
  },
  fr: {
    title: 'Abonnement du tag', subtitle: 'Facturation de {{name}}', subscription: 'Abonnement', subscriptionSubtitle: 'Forfait et facturation de ce tag', perTag: 'Ce forfait appartient uniquement à ce tag. Chaque tag Pinkeva possède son propre abonnement.', demoBadge: 'DÉMO', demoTitle: 'Aperçu de la facturation', demoBody: 'La facturation sécurisée n’est pas configurée dans cette version. Vous pouvez explorer les états, mais aucun paiement ne sera créé.', status: 'Statut', active: 'Actif', trial: 'Essai', attention: 'Paiement à vérifier', paused: 'En pause', ending: 'Se termine sur cette période', none: 'Aucun abonnement', unavailable: 'Indisponible', currentPlan: 'Forfait actuel', billingPeriod: 'Période de facturation', currentPeriod: 'Période actuelle', renewsOn: 'Renouvellement le', endsOn: 'Accès jusqu’au', autoRenew: 'Renouvellement automatique', autoRenewOn: 'Activé', autoRenewOff: 'Désactivé — annulation programmée', plans: 'Forfaits pour ce tag', choosePlan: 'Choisissez un forfait avant de continuer vers le paiement sécurisé.', month: 'mois', year: 'an', subscribe: 'Abonner ce tag', manage: 'Modifier ou gérer', activate: 'Activer le tag', renew: 'Renouveler ce tag', cancel: 'Annuler l’abonnement', cancelConfirmTitle: 'Annuler l’abonnement de ce tag ?', cancelConfirmBody: '{{name}} gardera son accès jusqu’à la fin de la période payée. Seul ce tag est concerné.', keepSubscription: 'Garder l’abonnement', confirmCancel: 'Continuer vers l’annulation', secureNotice: 'Les données de paiement sont saisies uniquement sur la page sécurisée de Stripe. Pinkeva ne collecte pas les cartes dans l’app.', loading: 'Chargement de l’abonnement…', retry: 'Réessayer', noPlans: 'Les forfaits sont momentanément indisponibles.', priceAtCheckout: 'Prix affiché au paiement', opened: 'La page de facturation est fermée. Le statut est en cours d’actualisation.', demoAction: 'Ceci est un aperçu. Configurez l’API sécurisée pour continuer.', purchaseDisabled: 'La souscription externe est désactivée dans cette version. Les abonnements existants restent gérables.', errorConfiguration: 'La facturation n’est pas configurée dans cette version.', errorAuthentication: 'Reconnectez-vous pour gérer ce tag.', errorNotFound: 'Ce tag ou cet abonnement est introuvable.', errorRateLimited: 'Trop de tentatives. Patientez un instant.', errorConflict: 'Cet abonnement a changé. Actualisez puis réessayez.', errorNetwork: 'Vérifiez votre connexion puis réessayez.', errorTimeout: 'Le service de facturation a mis trop de temps.', errorInvalidResponse: 'Le service de facturation a renvoyé une réponse invalide.', errorUnavailable: 'La facturation est temporairement indisponible.',
  },
  de: {
    title: 'Tag-Abonnement', subtitle: 'Abrechnung für {{name}}', subscription: 'Abonnement', subscriptionSubtitle: 'Tarif und Abrechnung für diesen Tag', perTag: 'Dieser Tarif gilt nur für diesen Tag. Jeder Pinkeva-Tag hat ein eigenes Abonnement.', demoBadge: 'DEMO', demoTitle: 'Abrechnungsvorschau', demoBody: 'Die sichere Abrechnung ist in diesem Build nicht eingerichtet. Sie können alle Zustände ansehen, es wird aber keine Zahlung erstellt.', status: 'Status', active: 'Aktiv', trial: 'Testphase', attention: 'Zahlung prüfen', paused: 'Pausiert', ending: 'Endet in diesem Zeitraum', none: 'Kein Abonnement', unavailable: 'Nicht verfügbar', currentPlan: 'Aktueller Tarif', billingPeriod: 'Abrechnungszeitraum', currentPeriod: 'Aktueller Zeitraum', renewsOn: 'Verlängert sich am', endsOn: 'Zugang endet am', autoRenew: 'Automatische Verlängerung', autoRenewOn: 'Ein', autoRenewOff: 'Aus — Kündigung geplant', plans: 'Tarife für diesen Tag', choosePlan: 'Wählen Sie vor dem sicheren Checkout einen Tarif.', month: 'Monat', year: 'Jahr', subscribe: 'Diesen Tag abonnieren', manage: 'Ändern oder verwalten', activate: 'Tag aktivieren', renew: 'Diesen Tag verlängern', cancel: 'Abonnement kündigen', cancelConfirmTitle: 'Abonnement dieses Tags kündigen?', cancelConfirmBody: '{{name}} behält den Zugang bis zum Ende des bezahlten Zeitraums. Nur dieser Tag ist betroffen.', keepSubscription: 'Abonnement behalten', confirmCancel: 'Weiter zur Kündigung', secureNotice: 'Zahlungsdaten werden nur auf der sicheren Stripe-Seite eingegeben. Pinkeva erfasst in der App keine Kartendaten.', loading: 'Abonnement wird geladen…', retry: 'Erneut versuchen', noPlans: 'Tarife sind vorübergehend nicht verfügbar.', priceAtCheckout: 'Preis im Checkout', opened: 'Die Abrechnungsseite wurde geschlossen. Der Status wird aktualisiert.', demoAction: 'Dies ist eine Vorschau. Richten Sie die sichere API ein, um fortzufahren.', purchaseDisabled: 'Externe Abos sind in diesem Build deaktiviert. Bestehende Abos können weiterhin verwaltet werden.', errorConfiguration: 'Die Abrechnung ist in diesem Build nicht eingerichtet.', errorAuthentication: 'Melden Sie sich erneut an, um diesen Tag zu verwalten.', errorNotFound: 'Tag oder Abonnement wurde nicht gefunden.', errorRateLimited: 'Zu viele Versuche. Bitte warten Sie kurz.', errorConflict: 'Das Abonnement wurde geändert. Aktualisieren Sie es.', errorNetwork: 'Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.', errorTimeout: 'Der Abrechnungsdienst hat zu lange gebraucht.', errorInvalidResponse: 'Der Abrechnungsdienst hat ungültige Daten gesendet.', errorUnavailable: 'Die Abrechnung ist vorübergehend nicht verfügbar.',
  },
  zh: {
    title: '标签订阅', subtitle: '{{name}} 的账单', subscription: '订阅', subscriptionSubtitle: '此标签的套餐与账单', perTag: '此套餐仅属于这个标签。每个 Pinkeva 标签都有自己的订阅。', demoBadge: '演示', demoTitle: '账单预览', demoBody: '此版本尚未配置安全账单。你可以查看所有状态，但不会产生任何扣款。', status: '状态', active: '有效', trial: '试用中', attention: '付款需要处理', paused: '已暂停', ending: '本周期结束', none: '没有订阅', unavailable: '不可用', currentPlan: '当前套餐', billingPeriod: '计费周期', currentPeriod: '当前周期', renewsOn: '续费日期', endsOn: '服务结束日期', autoRenew: '自动续费', autoRenewOn: '已开启', autoRenewOff: '已关闭 — 已安排取消', plans: '此标签的套餐', choosePlan: '请选择套餐，然后前往安全结账页面。', month: '月', year: '年', subscribe: '订阅此标签', manage: '更改或管理', activate: '激活标签', renew: '续订此标签', cancel: '取消订阅', cancelConfirmTitle: '取消此标签的订阅？', cancelConfirmBody: '{{name}} 可使用到已付费周期结束。只会影响此标签。', keepSubscription: '保留订阅', confirmCancel: '继续取消', secureNotice: '付款信息只会在 Stripe 安全页面输入。Pinkeva 不会在应用内收集银行卡信息。', loading: '正在加载订阅…', retry: '重试', noPlans: '套餐暂时不可用。', priceAtCheckout: '价格将在结账时显示', opened: '账单页面已关闭，正在刷新订阅状态。', demoAction: '这是账单预览。配置安全 API 后即可继续。', purchaseDisabled: '此版本已关闭外部订阅购买。仍可管理已有订阅。', errorConfiguration: '此版本尚未配置账单。', errorAuthentication: '请重新登录以管理此标签。', errorNotFound: '找不到此标签或订阅。', errorRateLimited: '尝试次数过多，请稍后再试。', errorConflict: '订阅已发生变化，请刷新后重试。', errorNetwork: '请检查网络连接后重试。', errorTimeout: '账单服务响应超时，请重试。', errorInvalidResponse: '账单服务返回了无效响应。', errorUnavailable: '账单服务暂时不可用。',
  },
  it: {
    title: 'Abbonamento del tag', subtitle: 'Fatturazione di {{name}}', subscription: 'Abbonamento', subscriptionSubtitle: 'Piano e fatturazione di questo tag', perTag: 'Questo piano appartiene solo a questo tag. Ogni tag Pinkeva ha il proprio abbonamento.', demoBadge: 'DEMO', demoTitle: 'Anteprima fatturazione', demoBody: 'La fatturazione sicura non è configurata in questa versione. Puoi esplorare tutti gli stati, ma non verrà creato alcun addebito.', status: 'Stato', active: 'Attivo', trial: 'Prova', attention: 'Pagamento da verificare', paused: 'In pausa', ending: 'Termina in questo periodo', none: 'Nessun abbonamento', unavailable: 'Non disponibile', currentPlan: 'Piano attuale', billingPeriod: 'Periodo di fatturazione', currentPeriod: 'Periodo attuale', renewsOn: 'Rinnovo il', endsOn: 'Accesso fino al', autoRenew: 'Rinnovo automatico', autoRenewOn: 'Attivo', autoRenewOff: 'Disattivato — annullamento programmato', plans: 'Piani per questo tag', choosePlan: 'Scegli un piano prima del checkout sicuro.', month: 'mese', year: 'anno', subscribe: 'Abbonati per questo tag', manage: 'Modifica o gestisci', activate: 'Attiva tag', renew: 'Rinnova questo tag', cancel: 'Annulla abbonamento', cancelConfirmTitle: 'Annullare l’abbonamento di questo tag?', cancelConfirmBody: '{{name}} manterrà l’accesso fino alla fine del periodo pagato. Solo questo tag sarà interessato.', keepSubscription: 'Mantieni abbonamento', confirmCancel: 'Continua con l’annullamento', secureNotice: 'I dati di pagamento si inseriscono solo nella pagina sicura di Stripe. Pinkeva non raccoglie carte nell’app.', loading: 'Caricamento abbonamento…', retry: 'Riprova', noPlans: 'I piani non sono momentaneamente disponibili.', priceAtCheckout: 'Prezzo mostrato al checkout', opened: 'La pagina di fatturazione è stata chiusa. Lo stato si sta aggiornando.', demoAction: 'Questa è un’anteprima. Configura l’API sicura per continuare.', purchaseDisabled: 'Gli abbonamenti esterni sono disattivati in questa versione. Quelli esistenti restano gestibili.', errorConfiguration: 'La fatturazione non è configurata in questa versione.', errorAuthentication: 'Accedi di nuovo per gestire questo tag.', errorNotFound: 'Tag o abbonamento non trovato.', errorRateLimited: 'Troppi tentativi. Attendi un momento.', errorConflict: 'L’abbonamento è cambiato. Aggiorna e riprova.', errorNetwork: 'Controlla la connessione e riprova.', errorTimeout: 'Il servizio di fatturazione ha impiegato troppo tempo.', errorInvalidResponse: 'Il servizio di fatturazione ha restituito una risposta non valida.', errorUnavailable: 'La fatturazione è temporaneamente non disponibile.',
  },
  es: {
    title: 'Suscripción del tag', subtitle: 'Facturación de {{name}}', subscription: 'Suscripción', subscriptionSubtitle: 'Plan y facturación de este tag', perTag: 'Este plan pertenece únicamente a este tag. Cada tag Pinkeva tiene su propia suscripción.', demoBadge: 'DEMO', demoTitle: 'Vista previa de facturación', demoBody: 'La facturación segura no está configurada en esta versión. Puedes explorar todos los estados, pero no se creará ningún cargo.', status: 'Estado', active: 'Activa', trial: 'Prueba', attention: 'El pago requiere atención', paused: 'En pausa', ending: 'Termina este periodo', none: 'Sin suscripción', unavailable: 'No disponible', currentPlan: 'Plan actual', billingPeriod: 'Periodo de facturación', currentPeriod: 'Periodo actual', renewsOn: 'Se renueva el', endsOn: 'El acceso termina el', autoRenew: 'Renovación automática', autoRenewOn: 'Activada', autoRenewOff: 'Desactivada — cancelación programada', plans: 'Planes para este tag', choosePlan: 'Elige un plan antes de continuar al pago seguro.', month: 'mes', year: 'año', subscribe: 'Suscribir este tag', manage: 'Cambiar o gestionar', activate: 'Activar tag', renew: 'Renovar este tag', cancel: 'Cancelar suscripción', cancelConfirmTitle: '¿Cancelar la suscripción de este tag?', cancelConfirmBody: '{{name}} mantendrá el acceso hasta el final del periodo pagado. Solo afecta a este tag.', keepSubscription: 'Mantener suscripción', confirmCancel: 'Continuar con la cancelación', secureNotice: 'Los datos de pago se introducen solo en la página segura de Stripe. Pinkeva no recopila tarjetas en la app.', loading: 'Cargando suscripción…', retry: 'Intentar de nuevo', noPlans: 'Los planes no están disponibles temporalmente.', priceAtCheckout: 'Precio mostrado al pagar', opened: 'La página de facturación se ha cerrado. Se está actualizando el estado.', demoAction: 'Esta es una vista previa. Configura la API segura para continuar.', purchaseDisabled: 'Las suscripciones externas están desactivadas en esta versión. Las existentes se pueden seguir gestionando.', errorConfiguration: 'La facturación no está configurada en esta versión.', errorAuthentication: 'Vuelve a iniciar sesión para gestionar este tag.', errorNotFound: 'No se encontró este tag o suscripción.', errorRateLimited: 'Demasiados intentos. Espera un momento.', errorConflict: 'La suscripción ha cambiado. Actualiza e inténtalo de nuevo.', errorNetwork: 'Comprueba la conexión e inténtalo de nuevo.', errorTimeout: 'El servicio de facturación tardó demasiado.', errorInvalidResponse: 'El servicio de facturación devolvió una respuesta no válida.', errorUnavailable: 'La facturación no está disponible temporalmente.',
  },
};

export function interpolateBillingCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

export function subscriptionStatusLabel(
  copy: BillingCopy,
  subscription: DeviceSubscription | undefined,
): string {
  if (!subscription || subscription.status === 'unknown') return copy.unavailable;
  if (subscription.cancelAtPeriodEnd) return copy.ending;

  const labels: Partial<Record<SubscriptionStatus, string>> = {
    active: copy.active,
    trialing: copy.trial,
    past_due: copy.attention,
    unpaid: copy.attention,
    incomplete: copy.attention,
    paused: copy.paused,
    none: copy.none,
    canceled: copy.none,
    ended: copy.none,
    incomplete_expired: copy.none,
  };
  return labels[subscription.status] ?? copy.unavailable;
}

export function billingErrorMessage(copy: BillingCopy, code: BillingErrorCode): string {
  const messages: Record<BillingErrorCode, string> = {
    configuration: copy.errorConfiguration,
    authentication: copy.errorAuthentication,
    not_found: copy.errorNotFound,
    rate_limited: copy.errorRateLimited,
    conflict: copy.errorConflict,
    network: copy.errorNetwork,
    timeout: copy.errorTimeout,
    invalid_response: copy.errorInvalidResponse,
    unavailable: copy.errorUnavailable,
  };
  return messages[code];
}

export function useBillingCopy(): BillingCopy {
  const { language } = useI18n();
  return copies[language];
}

export type { BillingCopy };
