import { useI18n, type Language } from '../i18n';

export type CloudPlusCopy = {
  name: string;
  eyebrow: string;
  tagline: string;
  accountBody: string;
  includedTitle: string;
  lostTitle: string;
  lostBody: string;
  separationTitle: string;
  separationBody: string;
  historyTitle: string;
  historyBody: string;
  discountTitle: string;
  discountBody: string;
  active: string;
  locked: string;
  iconLocked: string;
  lostLocked: string;
  historyLocked: string;
  currentLocationOnly: string;
  historyHint: string;
  historyCountdown: string;
  historyRangeTitle: string;
  history24h: string;
  history30d: string;
  historyLoading: string;
  historyReady: string;
  historyEmpty: string;
  historyError: string;
};

const copies: Record<Language, CloudPlusCopy> = {
  en: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PREMIUM PROTECTION',
    tagline: 'More protection, more history, more value.',
    accountBody: 'Unlock smarter protection and premium tools for your Pinkeva trackers.',
    includedTitle: 'Included with Cloud +',
    lostTitle: 'Mark as lost',
    lostBody: 'Turn on lost mode when an item goes missing.',
    separationTitle: 'Separation alerts',
    separationBody: 'Get notified when a tracker is no longer close to your phone.',
    historyTitle: '30-day history',
    historyBody: 'Review up to 30 days of reported tracker locations.',
    discountTitle: 'Member discounts',
    discountBody: 'Save on eligible purchases from our website or store.',
    active: 'ACTIVE',
    locked: 'Cloud +',
    iconLocked: 'Custom tracker icons are included with Pinkeva Cloud +.',
    lostLocked: 'Lost mode is included with Pinkeva Cloud +.',
    historyLocked: 'Location history is included with Pinkeva Cloud +.',
    currentLocationOnly: 'Without Cloud +, the map shows only the current or last reported tracker location.',
    historyHint: 'Hold a tracker for 3 seconds to open history',
    historyCountdown: 'History',
    historyRangeTitle: 'Location history',
    history24h: '24 hours',
    history30d: '30 days',
    historyLoading: 'Loading {{range}} for {{name}}…',
    historyReady: 'Showing {{count}} locations from {{range}}',
    historyEmpty: 'No locations were reported in {{range}}.',
    historyError: 'Could not load {{range}} history. Please try again.',
  },
  pt: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PROTEÇÃO PREMIUM',
    tagline: 'Mais proteção, mais histórico e mais vantagens.',
    accountBody: 'Desbloqueie proteção inteligente e ferramentas premium para os seus localizadores Pinkeva.',
    includedTitle: 'Incluído no Cloud +',
    lostTitle: 'Marcar como perdido',
    lostBody: 'Ative o modo perdido quando não encontrar um objeto.',
    separationTitle: 'Alertas de afastamento',
    separationBody: 'Receba uma notificação quando um localizador deixar de estar perto do telemóvel.',
    historyTitle: 'Histórico de 30 dias',
    historyBody: 'Consulte até 30 dias de localizações comunicadas pelo localizador.',
    discountTitle: 'Descontos para membros',
    discountBody: 'Poupe em compras elegíveis no nosso site ou loja.',
    active: 'ATIVO',
    locked: 'Cloud +',
    iconLocked: 'Os ícones personalizados estão incluídos no Pinkeva Cloud +.',
    lostLocked: 'O modo perdido está incluído no Pinkeva Cloud +.',
    historyLocked: 'O histórico de localizações está incluído no Pinkeva Cloud +.',
    currentLocationOnly: 'Sem Cloud +, o mapa mostra apenas a localização atual ou a última localização comunicada.',
    historyHint: 'Mantenha um localizador premido durante 3 segundos para abrir o histórico',
    historyCountdown: 'Histórico',
    historyRangeTitle: 'Histórico de localizações',
    history24h: '24 horas',
    history30d: '30 dias',
    historyLoading: 'A carregar {{range}} de {{name}}…',
    historyReady: 'A mostrar {{count}} localizações de {{range}}',
    historyEmpty: 'Não foram comunicadas localizações em {{range}}.',
    historyError: 'Não foi possível carregar o histórico de {{range}}. Tente novamente.',
  },
  fr: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PROTECTION PREMIUM',
    tagline: 'Plus de protection, d’historique et d’avantages.',
    accountBody: 'Débloquez une protection intelligente et des outils premium pour vos traceurs Pinkeva.',
    includedTitle: 'Inclus avec Cloud +',
    lostTitle: 'Marquer comme perdu',
    lostBody: 'Activez le mode perdu lorsqu’un objet disparaît.',
    separationTitle: 'Alertes d’éloignement',
    separationBody: 'Recevez une notification lorsqu’un traceur n’est plus proche de votre téléphone.',
    historyTitle: 'Historique de 30 jours',
    historyBody: 'Consultez jusqu’à 30 jours de positions signalées.',
    discountTitle: 'Réductions membres',
    discountBody: 'Économisez sur les achats éligibles sur notre site ou en boutique.',
    active: 'ACTIF',
    locked: 'Cloud +',
    iconLocked: 'Les icônes personnalisées sont incluses avec Pinkeva Cloud +.',
    lostLocked: 'Le mode perdu est inclus avec Pinkeva Cloud +.',
    historyLocked: 'L’historique des positions est inclus avec Pinkeva Cloud +.',
    currentLocationOnly: 'Sans Cloud +, la carte affiche uniquement la position actuelle ou la dernière position signalée.',
    historyHint: 'Maintenez un traceur pendant 3 secondes pour ouvrir l’historique',
    historyCountdown: 'Historique',
    historyRangeTitle: 'Historique des positions',
    history24h: '24 heures',
    history30d: '30 jours',
    historyLoading: 'Chargement de {{range}} pour {{name}}…',
    historyReady: 'Affichage de {{count}} positions sur {{range}}',
    historyEmpty: 'Aucune position n’a été signalée sur {{range}}.',
    historyError: 'Impossible de charger l’historique sur {{range}}. Réessayez.',
  },
  de: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PREMIUM-SCHUTZ',
    tagline: 'Mehr Schutz, mehr Verlauf, mehr Vorteile.',
    accountBody: 'Schalten Sie intelligenten Schutz und Premium-Werkzeuge für Ihre Pinkeva-Tracker frei.',
    includedTitle: 'In Cloud + enthalten',
    lostTitle: 'Als verloren markieren',
    lostBody: 'Aktivieren Sie den Verloren-Modus, wenn ein Gegenstand fehlt.',
    separationTitle: 'Entfernungswarnungen',
    separationBody: 'Erhalten Sie eine Nachricht, wenn ein Tracker nicht mehr in der Nähe des Telefons ist.',
    historyTitle: '30-Tage-Verlauf',
    historyBody: 'Sehen Sie bis zu 30 Tage gemeldeter Tracker-Standorte.',
    discountTitle: 'Mitgliederrabatte',
    discountBody: 'Sparen Sie bei berechtigten Käufen auf unserer Website oder im Store.',
    active: 'AKTIV',
    locked: 'Cloud +',
    iconLocked: 'Eigene Tracker-Symbole sind in Pinkeva Cloud + enthalten.',
    lostLocked: 'Der Verloren-Modus ist in Pinkeva Cloud + enthalten.',
    historyLocked: 'Der Standortverlauf ist in Pinkeva Cloud + enthalten.',
    currentLocationOnly: 'Ohne Cloud + zeigt die Karte nur den aktuellen oder zuletzt gemeldeten Standort.',
    historyHint: 'Tracker 3 Sekunden gedrückt halten, um den Verlauf zu öffnen',
    historyCountdown: 'Verlauf',
    historyRangeTitle: 'Standortverlauf',
    history24h: '24 Stunden',
    history30d: '30 Tage',
    historyLoading: '{{range}} für {{name}} werden geladen…',
    historyReady: '{{count}} Standorte aus {{range}} werden angezeigt',
    historyEmpty: 'In {{range}} wurden keine Standorte gemeldet.',
    historyError: 'Der Verlauf für {{range}} konnte nicht geladen werden. Bitte erneut versuchen.',
  },
  zh: {
    name: 'Pinkeva Cloud +',
    eyebrow: '高级保护',
    tagline: '更多保护、更长历史记录和更多优惠。',
    accountBody: '为你的 Pinkeva 追踪器解锁智能保护和高级工具。',
    includedTitle: 'Cloud + 包含功能',
    lostTitle: '标记为丢失',
    lostBody: '物品丢失时开启丢失模式。',
    separationTitle: '远离提醒',
    separationBody: '追踪器不再靠近手机时收到通知。',
    historyTitle: '30 天历史记录',
    historyBody: '查看最长 30 天的追踪器位置报告。',
    discountTitle: '会员折扣',
    discountBody: '在我们的网站或商店购买符合条件的商品时享受优惠。',
    active: '有效',
    locked: 'Cloud +',
    iconLocked: '自定义追踪器图标包含在 Pinkeva Cloud + 中。',
    lostLocked: '丢失模式包含在 Pinkeva Cloud + 中。',
    historyLocked: '位置历史记录包含在 Pinkeva Cloud + 中。',
    currentLocationOnly: '没有 Cloud + 时，地图仅显示当前或最后报告的位置。',
    historyHint: '按住追踪器 3 秒以打开历史记录',
    historyCountdown: '历史记录',
    historyRangeTitle: '位置历史记录',
    history24h: '24 小时',
    history30d: '30 天',
    historyLoading: '正在加载 {{name}} 的{{range}}记录…',
    historyReady: '正在显示{{range}}内的 {{count}} 个位置',
    historyEmpty: '{{range}}内没有位置报告。',
    historyError: '无法加载{{range}}历史记录，请重试。',
  },
  it: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PROTEZIONE PREMIUM',
    tagline: 'Più protezione, più cronologia, più vantaggi.',
    accountBody: 'Sblocca protezione intelligente e strumenti premium per i tuoi tracker Pinkeva.',
    includedTitle: 'Incluso con Cloud +',
    lostTitle: 'Segna come smarrito',
    lostBody: 'Attiva la modalità smarrito quando un oggetto scompare.',
    separationTitle: 'Avvisi di distanza',
    separationBody: 'Ricevi una notifica quando un tracker non è più vicino al telefono.',
    historyTitle: 'Cronologia di 30 giorni',
    historyBody: 'Consulta fino a 30 giorni di posizioni segnalate dal tracker.',
    discountTitle: 'Sconti per i membri',
    discountBody: 'Risparmia sugli acquisti idonei dal nostro sito o negozio.',
    active: 'ATTIVO',
    locked: 'Cloud +',
    iconLocked: 'Le icone personalizzate sono incluse in Pinkeva Cloud +.',
    lostLocked: 'La modalità smarrito è inclusa in Pinkeva Cloud +.',
    historyLocked: 'La cronologia delle posizioni è inclusa in Pinkeva Cloud +.',
    currentLocationOnly: 'Senza Cloud +, la mappa mostra solo la posizione attuale o l’ultima segnalata.',
    historyHint: 'Tieni premuto un tracker per 3 secondi per aprire la cronologia',
    historyCountdown: 'Cronologia',
    historyRangeTitle: 'Cronologia posizioni',
    history24h: '24 ore',
    history30d: '30 giorni',
    historyLoading: 'Caricamento di {{range}} per {{name}}…',
    historyReady: 'Visualizzazione di {{count}} posizioni in {{range}}',
    historyEmpty: 'Nessuna posizione segnalata in {{range}}.',
    historyError: 'Impossibile caricare la cronologia di {{range}}. Riprova.',
  },
  es: {
    name: 'Pinkeva Cloud +',
    eyebrow: 'PROTECCIÓN PREMIUM',
    tagline: 'Más protección, más historial y más ventajas.',
    accountBody: 'Desbloquea protección inteligente y herramientas premium para tus localizadores Pinkeva.',
    includedTitle: 'Incluido con Cloud +',
    lostTitle: 'Marcar como perdido',
    lostBody: 'Activa el modo perdido cuando no encuentres un objeto.',
    separationTitle: 'Alertas de separación',
    separationBody: 'Recibe una notificación cuando un localizador ya no esté cerca del teléfono.',
    historyTitle: 'Historial de 30 días',
    historyBody: 'Consulta hasta 30 días de ubicaciones notificadas.',
    discountTitle: 'Descuentos para miembros',
    discountBody: 'Ahorra en compras elegibles en nuestra web o tienda.',
    active: 'ACTIVA',
    locked: 'Cloud +',
    iconLocked: 'Los iconos personalizados están incluidos con Pinkeva Cloud +.',
    lostLocked: 'El modo perdido está incluido con Pinkeva Cloud +.',
    historyLocked: 'El historial de ubicaciones está incluido con Pinkeva Cloud +.',
    currentLocationOnly: 'Sin Cloud +, el mapa muestra solo la ubicación actual o la última notificada.',
    historyHint: 'Mantén pulsado un localizador durante 3 segundos para abrir el historial',
    historyCountdown: 'Historial',
    historyRangeTitle: 'Historial de ubicaciones',
    history24h: '24 horas',
    history30d: '30 días',
    historyLoading: 'Cargando {{range}} para {{name}}…',
    historyReady: 'Mostrando {{count}} ubicaciones de {{range}}',
    historyEmpty: 'No se notificaron ubicaciones en {{range}}.',
    historyError: 'No se pudo cargar el historial de {{range}}. Inténtalo de nuevo.',
  },
};

export function interpolateCloudPlusCopy(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? `{{${key}}}`);
}

export function useCloudPlusCopy(): CloudPlusCopy {
  const { language } = useI18n();
  return copies[language];
}
