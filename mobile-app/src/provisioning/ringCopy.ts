import { useI18n, type Language } from '../i18n';
import type { RingErrorCode } from './ringErrors';

const labels: Record<Language, readonly string[]> = {
  en: ['Play sound', 'Pause', 'Cancel', 'Sound plays for 10 seconds. Keep Bluetooth and internet on.', 'Playing sound…', 'Connecting…', 'This is a preview. Sound requires a real tracker linked to your account.', 'Update this tracker’s firmware to use Play sound.', 'Tracker not found. Move closer and try again; older firmware may need an update.', 'Only the current owner can play this tracker. Refresh your trackers and sign in again.'],
  pt: ['Reproduzir som', 'Pausa', 'Cancelar', 'O som toca durante 10 segundos. Mantenha o Bluetooth e a internet ligados.', 'A reproduzir som…', 'A ligar…', 'Esta é uma pré-visualização. O som requer um localizador real associado à sua conta.', 'Atualize o firmware deste localizador para reproduzir som.', 'Localizador não encontrado. Aproxime-se e tente novamente; firmware antigo pode precisar de atualização.', 'Só o proprietário atual pode reproduzir som. Atualize os localizadores e inicie sessão novamente.'],
  es: ['Reproducir sonido', 'Pausa', 'Cancelar', 'El sonido dura 10 segundos. Mantén Bluetooth e internet activados.', 'Reproduciendo sonido…', 'Conectando…', 'Esta es una vista previa. El sonido requiere un localizador real vinculado a tu cuenta.', 'Actualiza el firmware del localizador para reproducir sonido.', 'Localizador no encontrado. Acércate e inténtalo de nuevo; el firmware antiguo puede necesitar actualización.', 'Solo el propietario actual puede reproducir sonido. Actualiza tus localizadores e inicia sesión de nuevo.'],
  it: ['Riproduci suono', 'Pausa', 'Annulla', 'Il suono dura 10 secondi. Mantieni Bluetooth e internet attivi.', 'Riproduzione del suono…', 'Connessione…', 'Questa è un’anteprima. Il suono richiede un tracker reale collegato al tuo account.', 'Aggiorna il firmware del tracker per riprodurre il suono.', 'Tracker non trovato. Avvicinati e riprova; il firmware precedente potrebbe richiedere un aggiornamento.', 'Solo il proprietario attuale può riprodurre il suono. Aggiorna i tracker e accedi di nuovo.'],
  zh: ['播放声音', '暂停', '取消', '声音播放 10 秒。请保持蓝牙和网络开启。', '正在播放声音…', '正在连接…', '这是预览。播放声音需要已关联到账户的真实追踪器。', '请更新追踪器固件以使用播放声音。', '未找到追踪器。请靠近后重试；旧固件可能需要更新。', '仅当前所有者可以播放声音。请刷新追踪器并重新登录。'],
  de: ['Ton abspielen', 'Pause', 'Abbrechen', 'Der Ton dauert 10 Sekunden. Bluetooth und Internet müssen aktiv sein.', 'Ton wird abgespielt…', 'Verbindung wird hergestellt…', 'Dies ist eine Vorschau. Ein echter, mit deinem Konto verknüpfter Tracker ist erforderlich.', 'Aktualisiere die Tracker-Firmware, um einen Ton abzuspielen.', 'Tracker nicht gefunden. Gehe näher heran und versuche es erneut; ältere Firmware benötigt eventuell ein Update.', 'Nur der aktuelle Eigentümer kann einen Ton abspielen. Aktualisiere deine Tracker und melde dich erneut an.'],
  fr: ['Émettre un son', 'Pause', 'Annuler', 'Le son dure 10 secondes. Gardez le Bluetooth et internet activés.', 'Émission du son…', 'Connexion…', 'Ceci est un aperçu. Un traceur réel lié à votre compte est nécessaire.', 'Mettez à jour le micrologiciel du traceur pour émettre un son.', 'Traceur introuvable. Rapprochez-vous et réessayez ; un ancien micrologiciel peut nécessiter une mise à jour.', 'Seul le propriétaire actuel peut émettre un son. Actualisez vos traceurs et reconnectez-vous.'],
};

export function useRingCopy() {
  const { t, language } = useI18n();
  const [play, pause, cancel, description, playing, connecting, preview, unsupported, notFound, owner] = labels[language];
  const errors: Record<RingErrorCode, string> = {
    authentication: t('pairing.errorAuthentication'), permission: t('pairing.errorBluetoothPermission'),
    'bluetooth-off': t('pairing.errorBluetoothOff'), platform: t('pairing.errorBluetoothUnsupported'),
    configuration: t('pairing.errorConfiguration'), 'not-found': notFound, unsupported, owner,
    connection: t('pairing.errorConnection'), unavailable: t('pairing.errorGeneric'),
  };
  return { play, pause, cancel, description, playing, connecting, preview, errors };
}
