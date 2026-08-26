import { useI18n, type Language } from '../i18n';

export type RenewalCopy = {
  updateTag: string;
  pendingTitle: string;
  pendingBody: string;
  installedTitle: string;
  installedBody: string;
  updatesTitle: string;
  updatesPendingOne: string;
  updatesPendingMany: string;
  updatesComplete: string;
  holdButtonTitle: string;
  holdButtonBody: string;
  holdButtonDetail: string;
  readyToScan: string;
  scanTitle: string;
  scanBody: string;
  scanNoTagsTitle: string;
  scanNoTagsBody: string;
  secureUpdateTitle: string;
  secureUpdateBody: string;
  completeTitle: string;
  completeBody: string;
  stepAuthorizing: string;
  stepInstalling: string;
  stepConfirming: string;
};

const copies: Record<Language, RenewalCopy> = {
  en: {
    updateTag: 'Update tag',
    pendingTitle: 'Renewal ready',
    pendingBody: 'Your subscription is current through {{date}}. Hold the tag button for 5 seconds, then securely install its new entitlement.',
    installedTitle: 'Tag subscription is current',
    installedBody: 'This tag has the signed entitlement through {{date}}.',
    updatesTitle: 'Tag updates',
    updatesPendingOne: '{{count}} tag needs a subscription update.',
    updatesPendingMany: '{{count}} tags need subscription updates.',
    updatesComplete: 'All of your tags have their current subscription entitlement.',
    holdButtonTitle: 'Put the tag in Receive info mode',
    holdButtonBody: 'Hold the button on {{name}} for 5 seconds. Keep it near your phone until its light confirms it is ready.',
    holdButtonDetail: 'Pinkeva will only send the renewed entitlement after the tag establishes its secure connection.',
    readyToScan: 'I held the button for 5 seconds',
    scanTitle: 'Find your tag to update it',
    scanBody: 'Keep this screen open while {{name}} is in Receive info mode. Only the selected tag can receive this entitlement.',
    scanNoTagsTitle: 'Waiting for your tag',
    scanNoTagsBody: 'Hold its button for 5 seconds again, then keep the tag close to your phone.',
    secureUpdateTitle: 'Updating your tag securely',
    secureUpdateBody: 'Keep {{name}} nearby while Pinkeva verifies the connection and sends the renewed entitlement.',
    completeTitle: 'Subscription updated on your tag',
    completeBody: '{{name}} has confirmed its new signed entitlement and can continue tracking.',
    stepAuthorizing: 'Secure the connection',
    stepInstalling: 'Send the renewed entitlement',
    stepConfirming: 'Confirm the tag update',
  },
  pt: {
    updateTag: 'Atualizar tag',
    pendingTitle: 'Renovação pronta',
    pendingBody: 'A subscrição está ativa até {{date}}. Mantenha o botão da tag premido durante 5 segundos e instale em segurança a nova autorização.',
    installedTitle: 'Subscrição da tag atualizada',
    installedBody: 'Esta tag tem a autorização assinada até {{date}}.',
    updatesTitle: 'Atualizações das tags',
    updatesPendingOne: '{{count}} tag precisa de uma atualização de subscrição.',
    updatesPendingMany: '{{count}} tags precisam de atualizações de subscrição.',
    updatesComplete: 'Todas as tags têm a autorização de subscrição atual.',
    holdButtonTitle: 'Coloque a tag no modo Receber informação',
    holdButtonBody: 'Mantenha o botão de {{name}} premido durante 5 segundos. Mantenha-a perto do telemóvel até a luz confirmar que está pronta.',
    holdButtonDetail: 'A Pinkeva só envia a autorização renovada depois de a tag estabelecer uma ligação segura.',
    readyToScan: 'Mantive o botão premido 5 segundos',
    scanTitle: 'Encontre a tag para a atualizar',
    scanBody: 'Mantenha este ecrã aberto enquanto {{name}} está no modo Receber informação. Só a tag selecionada pode receber esta autorização.',
    scanNoTagsTitle: 'À espera da tag',
    scanNoTagsBody: 'Mantenha o botão premido durante mais 5 segundos e aproxime a tag do telemóvel.',
    secureUpdateTitle: 'A atualizar a tag em segurança',
    secureUpdateBody: 'Mantenha {{name}} por perto enquanto a Pinkeva verifica a ligação e envia a autorização renovada.',
    completeTitle: 'Subscrição atualizada na tag',
    completeBody: '{{name}} confirmou a nova autorização assinada e pode continuar a localizar.',
    stepAuthorizing: 'Proteger a ligação',
    stepInstalling: 'Enviar a autorização renovada',
    stepConfirming: 'Confirmar a atualização da tag',
  },
  fr: {
    updateTag: 'Mettre à jour le tag',
    pendingTitle: 'Renouvellement prêt',
    pendingBody: 'Votre abonnement est actif jusqu’au {{date}}. Maintenez le bouton du tag 5 secondes, puis installez sa nouvelle autorisation en toute sécurité.',
    installedTitle: 'Abonnement du tag à jour',
    installedBody: 'Ce tag possède l’autorisation signée jusqu’au {{date}}.',
    updatesTitle: 'Mises à jour des tags',
    updatesPendingOne: '{{count}} tag nécessite une mise à jour d’abonnement.',
    updatesPendingMany: '{{count}} tags nécessitent des mises à jour d’abonnement.',
    updatesComplete: 'Tous vos tags possèdent leur autorisation d’abonnement actuelle.',
    holdButtonTitle: 'Placez le tag en mode Réception d’informations',
    holdButtonBody: 'Maintenez le bouton de {{name}} pendant 5 secondes. Gardez-le près du téléphone jusqu’à ce que son voyant confirme qu’il est prêt.',
    holdButtonDetail: 'Pinkeva envoie l’autorisation renouvelée uniquement après l’établissement de la connexion sécurisée du tag.',
    readyToScan: 'J’ai maintenu le bouton 5 secondes',
    scanTitle: 'Trouvez votre tag pour le mettre à jour',
    scanBody: 'Gardez cet écran ouvert pendant que {{name}} est en mode Réception d’informations. Seul le tag sélectionné peut recevoir cette autorisation.',
    scanNoTagsTitle: 'En attente de votre tag',
    scanNoTagsBody: 'Maintenez à nouveau son bouton 5 secondes, puis gardez le tag près du téléphone.',
    secureUpdateTitle: 'Mise à jour sécurisée du tag',
    secureUpdateBody: 'Gardez {{name}} à proximité pendant que Pinkeva vérifie la connexion et envoie l’autorisation renouvelée.',
    completeTitle: 'Abonnement mis à jour sur votre tag',
    completeBody: '{{name}} a confirmé sa nouvelle autorisation signée et peut continuer le suivi.',
    stepAuthorizing: 'Sécuriser la connexion',
    stepInstalling: 'Envoyer l’autorisation renouvelée',
    stepConfirming: 'Confirmer la mise à jour du tag',
  },
  de: {
    updateTag: 'Tag aktualisieren',
    pendingTitle: 'Verlängerung bereit',
    pendingBody: 'Dein Abonnement läuft bis {{date}}. Halte die Tag-Taste 5 Sekunden gedrückt und installiere dann die neue Berechtigung sicher.',
    installedTitle: 'Tag-Abonnement aktuell',
    installedBody: 'Dieser Tag besitzt die signierte Berechtigung bis {{date}}.',
    updatesTitle: 'Tag-Aktualisierungen',
    updatesPendingOne: '{{count}} Tag benötigt eine Abonnementaktualisierung.',
    updatesPendingMany: '{{count}} Tags benötigen Abonnementaktualisierungen.',
    updatesComplete: 'Alle deine Tags besitzen die aktuelle Abonnementberechtigung.',
    holdButtonTitle: 'Tag in den Empfangsmodus versetzen',
    holdButtonBody: 'Halte die Taste an {{name}} 5 Sekunden gedrückt. Halte ihn in Telefonnähe, bis die Leuchte seine Bereitschaft bestätigt.',
    holdButtonDetail: 'Pinkeva sendet die verlängerte Berechtigung erst, nachdem der Tag eine sichere Verbindung hergestellt hat.',
    readyToScan: 'Ich habe die Taste 5 Sekunden gedrückt',
    scanTitle: 'Finde deinen Tag zum Aktualisieren',
    scanBody: 'Lass diesen Bildschirm geöffnet, während {{name}} im Empfangsmodus ist. Nur der ausgewählte Tag kann diese Berechtigung empfangen.',
    scanNoTagsTitle: 'Warten auf deinen Tag',
    scanNoTagsBody: 'Halte seine Taste erneut 5 Sekunden gedrückt und halte den Tag nah an dein Telefon.',
    secureUpdateTitle: 'Tag wird sicher aktualisiert',
    secureUpdateBody: 'Halte {{name}} in der Nähe, während Pinkeva die Verbindung prüft und die verlängerte Berechtigung sendet.',
    completeTitle: 'Abonnement auf deinem Tag aktualisiert',
    completeBody: '{{name}} hat die neue signierte Berechtigung bestätigt und kann weiter orten.',
    stepAuthorizing: 'Verbindung sichern',
    stepInstalling: 'Verlängerte Berechtigung senden',
    stepConfirming: 'Tag-Aktualisierung bestätigen',
  },
  zh: {
    updateTag: '更新标签',
    pendingTitle: '续订已就绪',
    pendingBody: '您的订阅有效至 {{date}}。按住标签按钮 5 秒，然后安全安装新的授权。',
    installedTitle: '标签订阅已更新',
    installedBody: '该标签已拥有有效至 {{date}} 的签名授权。',
    updatesTitle: '标签更新',
    updatesPendingOne: '{{count}} 个标签需要订阅更新。',
    updatesPendingMany: '{{count}} 个标签需要订阅更新。',
    updatesComplete: '所有标签都拥有当前的订阅授权。',
    holdButtonTitle: '让标签进入“接收信息”模式',
    holdButtonBody: '按住 {{name}} 上的按钮 5 秒。将其保持在手机附近，直到指示灯确认它已准备就绪。',
    holdButtonDetail: 'Pinkeva 只会在标签建立安全连接后发送续订授权。',
    readyToScan: '我已按住按钮 5 秒',
    scanTitle: '查找标签以进行更新',
    scanBody: '当 {{name}} 处于“接收信息”模式时请保持此屏幕开启。只有所选标签可以接收该授权。',
    scanNoTagsTitle: '正在等待标签',
    scanNoTagsBody: '再次按住按钮 5 秒，然后将标签靠近手机。',
    secureUpdateTitle: '正在安全更新标签',
    secureUpdateBody: '请将 {{name}} 保持在附近，Pinkeva 会验证连接并发送续订授权。',
    completeTitle: '标签订阅已更新',
    completeBody: '{{name}} 已确认新的签名授权，可以继续追踪。',
    stepAuthorizing: '保护连接',
    stepInstalling: '发送续订授权',
    stepConfirming: '确认标签更新',
  },
  it: {
    updateTag: 'Aggiorna tag',
    pendingTitle: 'Rinnovo pronto',
    pendingBody: 'L’abbonamento è attivo fino al {{date}}. Tieni premuto il pulsante del tag per 5 secondi, quindi installa in sicurezza la nuova autorizzazione.',
    installedTitle: 'Abbonamento del tag aggiornato',
    installedBody: 'Questo tag possiede l’autorizzazione firmata fino al {{date}}.',
    updatesTitle: 'Aggiornamenti dei tag',
    updatesPendingOne: '{{count}} tag richiede un aggiornamento dell’abbonamento.',
    updatesPendingMany: '{{count}} tag richiedono aggiornamenti dell’abbonamento.',
    updatesComplete: 'Tutti i tag hanno l’autorizzazione dell’abbonamento corrente.',
    holdButtonTitle: 'Metti il tag in modalità Ricevi informazioni',
    holdButtonBody: 'Tieni premuto il pulsante di {{name}} per 5 secondi. Tienilo vicino al telefono finché la spia non conferma che è pronto.',
    holdButtonDetail: 'Pinkeva invia l’autorizzazione rinnovata solo dopo che il tag ha stabilito una connessione sicura.',
    readyToScan: 'Ho tenuto premuto il pulsante per 5 secondi',
    scanTitle: 'Trova il tag da aggiornare',
    scanBody: 'Mantieni aperta questa schermata mentre {{name}} è in modalità Ricevi informazioni. Solo il tag selezionato può ricevere questa autorizzazione.',
    scanNoTagsTitle: 'In attesa del tag',
    scanNoTagsBody: 'Tieni di nuovo premuto il pulsante per 5 secondi e avvicina il tag al telefono.',
    secureUpdateTitle: 'Aggiornamento sicuro del tag',
    secureUpdateBody: 'Tieni {{name}} vicino mentre Pinkeva verifica la connessione e invia l’autorizzazione rinnovata.',
    completeTitle: 'Abbonamento aggiornato sul tag',
    completeBody: '{{name}} ha confermato la nuova autorizzazione firmata e può continuare a tracciare.',
    stepAuthorizing: 'Proteggi la connessione',
    stepInstalling: 'Invia l’autorizzazione rinnovata',
    stepConfirming: 'Conferma l’aggiornamento del tag',
  },
  es: {
    updateTag: 'Actualizar tag',
    pendingTitle: 'Renovación lista',
    pendingBody: 'Tu suscripción está activa hasta {{date}}. Mantén pulsado el botón del tag durante 5 segundos e instala de forma segura la nueva autorización.',
    installedTitle: 'Suscripción del tag actualizada',
    installedBody: 'Este tag tiene la autorización firmada hasta {{date}}.',
    updatesTitle: 'Actualizaciones de tags',
    updatesPendingOne: '{{count}} tag necesita una actualización de suscripción.',
    updatesPendingMany: '{{count}} tags necesitan actualizaciones de suscripción.',
    updatesComplete: 'Todos tus tags tienen la autorización de suscripción actual.',
    holdButtonTitle: 'Pon el tag en modo Recibir información',
    holdButtonBody: 'Mantén pulsado el botón de {{name}} durante 5 segundos. Manténlo cerca del teléfono hasta que la luz confirme que está listo.',
    holdButtonDetail: 'Pinkeva solo envía la autorización renovada después de que el tag establezca su conexión segura.',
    readyToScan: 'He mantenido pulsado el botón 5 segundos',
    scanTitle: 'Busca tu tag para actualizarlo',
    scanBody: 'Mantén esta pantalla abierta mientras {{name}} está en modo Recibir información. Solo el tag seleccionado puede recibir esta autorización.',
    scanNoTagsTitle: 'Esperando tu tag',
    scanNoTagsBody: 'Mantén pulsado su botón de nuevo durante 5 segundos y acerca el tag al teléfono.',
    secureUpdateTitle: 'Actualizando tu tag de forma segura',
    secureUpdateBody: 'Mantén {{name}} cerca mientras Pinkeva verifica la conexión y envía la autorización renovada.',
    completeTitle: 'Suscripción actualizada en tu tag',
    completeBody: '{{name}} ha confirmado su nueva autorización firmada y puede seguir rastreando.',
    stepAuthorizing: 'Proteger la conexión',
    stepInstalling: 'Enviar la autorización renovada',
    stepConfirming: 'Confirmar la actualización del tag',
  },
};

export function useRenewalCopy(): RenewalCopy {
  const { language } = useI18n();
  return copies[language];
}
