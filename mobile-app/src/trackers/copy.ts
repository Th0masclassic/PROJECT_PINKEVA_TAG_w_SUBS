import { useI18n, type Language } from '../i18n';
import type { OwnedTrackerErrorCode } from './cloud';

type TrackerCloudCopy = {
  loadingTitle: string;
  loadingBody: string;
  errorTitle: string;
  retry: string;
  localTitle: string;
  localBody: string;
  errors: Record<OwnedTrackerErrorCode, string>;
};

const copies: Record<Language, TrackerCloudCopy> = {
  en: {
    loadingTitle: 'Loading your trackers',
    loadingBody: 'Checking the tags linked to your Pinkeva account…',
    errorTitle: 'Trackers are unavailable',
    retry: 'Try again',
    localTitle: 'Local pairing preview',
    localBody: 'This mock tag is stored only on this device and cannot be billed.',
    errors: {
      banned: 'This account is unavailable. Please contact Pinkeva support.',
      authentication: 'Please sign in again to load your trackers.',
      configuration: 'Secure cloud access is not configured in this build.',
      'invalid-response': 'The tracker service returned an invalid response.',
      unavailable: 'Check your connection and try again.',
    },
  },
  pt: {
    loadingTitle: 'A carregar os seus localizadores',
    loadingBody: 'A verificar as tags associadas à sua conta Pinkeva…',
    errorTitle: 'Os localizadores estão indisponíveis',
    retry: 'Tentar novamente',
    localTitle: 'Pré-visualização de emparelhamento local',
    localBody: 'Esta tag simulada só existe neste dispositivo e não pode ser faturada.',
    errors: {
      banned: 'Esta conta não está disponível. Contacte o apoio Pinkeva.',
      authentication: 'Inicie sessão novamente para carregar os seus localizadores.',
      configuration: 'O acesso seguro à nuvem não está configurado nesta versão.',
      'invalid-response': 'O serviço de localizadores devolveu uma resposta inválida.',
      unavailable: 'Verifique a ligação e tente novamente.',
    },
  },
  fr: {
    loadingTitle: 'Chargement de vos traceurs',
    loadingBody: 'Vérification des tags liés à votre compte Pinkeva…',
    errorTitle: 'Traceurs indisponibles',
    retry: 'Réessayer',
    localTitle: 'Aperçu d’association locale',
    localBody: 'Ce tag fictif reste sur cet appareil et ne peut pas être facturé.',
    errors: {
      banned: 'Ce compte est indisponible. Contactez l’assistance Pinkeva.',
      authentication: 'Reconnectez-vous pour charger vos traceurs.',
      configuration: 'L’accès cloud sécurisé n’est pas configuré dans cette version.',
      'invalid-response': 'Le service de traceurs a renvoyé une réponse invalide.',
      unavailable: 'Vérifiez votre connexion puis réessayez.',
    },
  },
  de: {
    loadingTitle: 'Tracker werden geladen',
    loadingBody: 'Mit deinem Pinkeva-Konto verknüpfte Tags werden geprüft…',
    errorTitle: 'Tracker sind nicht verfügbar',
    retry: 'Erneut versuchen',
    localTitle: 'Lokale Kopplungsvorschau',
    localBody: 'Dieser Test-Tag bleibt nur auf diesem Gerät und kann nicht abgerechnet werden.',
    errors: {
      banned: 'Dieses Konto ist nicht verfügbar. Bitte kontaktiere den Pinkeva-Support.',
      authentication: 'Melde dich erneut an, um deine Tracker zu laden.',
      configuration: 'Sicherer Cloud-Zugriff ist in diesem Build nicht eingerichtet.',
      'invalid-response': 'Der Tracker-Dienst hat ungültige Daten gesendet.',
      unavailable: 'Prüfe deine Verbindung und versuche es erneut.',
    },
  },
  zh: {
    loadingTitle: '正在加载追踪器',
    loadingBody: '正在检查与 Pinkeva 账户关联的标签…',
    errorTitle: '追踪器暂不可用',
    retry: '重试',
    localTitle: '本地配对预览',
    localBody: '此模拟标签仅保存在本设备上，不能用于计费。',
    errors: {
      banned: '此帐户不可用。请联系 Pinkeva 支持团队。',
      authentication: '请重新登录以加载追踪器。',
      configuration: '此版本尚未配置安全云端访问。',
      'invalid-response': '追踪器服务返回了无效响应。',
      unavailable: '请检查网络连接后重试。',
    },
  },
  it: {
    loadingTitle: 'Caricamento dei tracker',
    loadingBody: 'Verifica dei tag collegati al tuo account Pinkeva…',
    errorTitle: 'Tracker non disponibili',
    retry: 'Riprova',
    localTitle: 'Anteprima abbinamento locale',
    localBody: 'Questo tag simulato resta solo su questo dispositivo e non può essere fatturato.',
    errors: {
      banned: 'Questo account non è disponibile. Contatta l’assistenza Pinkeva.',
      authentication: 'Accedi di nuovo per caricare i tuoi tracker.',
      configuration: 'L’accesso cloud sicuro non è configurato in questa versione.',
      'invalid-response': 'Il servizio tracker ha restituito una risposta non valida.',
      unavailable: 'Controlla la connessione e riprova.',
    },
  },
  es: {
    loadingTitle: 'Cargando tus localizadores',
    loadingBody: 'Comprobando los tags vinculados a tu cuenta Pinkeva…',
    errorTitle: 'Los localizadores no están disponibles',
    retry: 'Intentar de nuevo',
    localTitle: 'Vista previa de emparejamiento local',
    localBody: 'Este tag simulado solo existe en este dispositivo y no se puede facturar.',
    errors: {
      banned: 'Esta cuenta no está disponible. Contacta con el soporte de Pinkeva.',
      authentication: 'Vuelve a iniciar sesión para cargar tus localizadores.',
      configuration: 'El acceso seguro a la nube no está configurado en esta versión.',
      'invalid-response': 'El servicio de localizadores devolvió una respuesta no válida.',
      unavailable: 'Comprueba la conexión e inténtalo de nuevo.',
    },
  },
};

export function useTrackerCloudCopy(): TrackerCloudCopy {
  const { language } = useI18n();
  return copies[language];
}
