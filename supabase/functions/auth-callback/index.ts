const APP_SCHEME = 'com.pinkeva.mobile';
const APP_CALLBACK_PATH = 'auth/callback';
const APP_RESET_PATH = 'auth/reset';

const responseHeaders = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy': "default-src 'none'",
  // Supabase's shared domain rewrites HTML responses to plain text. SVG is a
  // safe browser-rendered document and keeps this callback usable without a
  // custom domain.
  'content-type': 'image/svg+xml; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const forwardedParameters = [
  'code',
  'type',
  'error',
  'error_code',
  'error_description',
  'access_token',
  'refresh_token',
  'expires_in',
  'token_type',
] as const;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}

function isRecoveryPath(pathname: string, type: string | null): boolean {
  return pathname.endsWith('/reset') || type === 'recovery';
}

function makeAppUrl(requestUrl: URL, recovery: boolean): string {
  const path = recovery ? APP_RESET_PATH : APP_CALLBACK_PATH;
  const appUrl = new URL(`${APP_SCHEME}://${path}`);

  for (const key of forwardedParameters) {
    const value = requestUrl.searchParams.get(key);
    if (value) appUrl.searchParams.set(key, value);
  }

  return appUrl.toString();
}

function renderPage(
  requestUrl: URL,
  appUrl: string,
  recovery: boolean,
  portuguese: boolean,
  mobileDevice: boolean,
): string {
  const hasError = Boolean(
    requestUrl.searchParams.get('error') || requestUrl.searchParams.get('error_code'),
  );
  const hasCode = Boolean(requestUrl.searchParams.get('code'));
  const title = hasError
    ? portuguese
      ? 'Não foi possível confirmar'
      : 'Confirmation could not be completed'
    : hasCode
      ? recovery
        ? portuguese
          ? 'Link de recuperação pronto'
          : 'Recovery link ready'
        : portuguese
          ? 'Email confirmado'
          : 'Email confirmed'
      : portuguese
        ? 'Link inválido ou expirado'
        : 'Invalid or expired link';
  const body = hasError
    ? portuguese
      ? 'Volte à Pinkeva e peça um novo link. Não é necessário repetir a palavra-passe aqui.'
      : 'Return to Pinkeva and request a new link. You do not need to enter your password here.'
    : hasCode
      ? recovery
        ? portuguese
          ? 'Abra a aplicação para escolher uma nova palavra-passe.'
          : 'Open the app to choose a new password.'
        : portuguese
          ? 'A sua conta está pronta. Abra a aplicação para continuar.'
          : 'Your account is ready. Open the app to continue.'
      : portuguese
        ? 'Peça um novo email de confirmação na aplicação.'
        : 'Request a new confirmation email from the app.';
  const button = mobileDevice
    ? portuguese
      ? 'Abrir Pinkeva'
      : 'Open Pinkeva'
    : portuguese
      ? 'Abra a Pinkeva no telemóvel'
      : 'Open Pinkeva on your phone';
  const note = mobileDevice
    ? portuguese
      ? 'Se a aplicação não abrir, instale a Pinkeva neste dispositivo e toque novamente no botão.'
      : 'If the app does not open, install Pinkeva on this device and tap the button again.'
    : portuguese
      ? 'A conta já está confirmada. Pode fechar esta página e iniciar sessão na app.'
      : 'Your account is confirmed. Close this page and sign in from the app.';
  const action = mobileDevice
    ? `<a href="${escapeHtml(appUrl)}" target="_self">
    <rect x="76" y="428" width="238" height="56" rx="15" fill="#0b43d8"/>
    <text x="195" y="463" text-anchor="middle" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="17" font-weight="700">${escapeHtml(button)}</text>
  </a>`
    : `<rect x="52" y="428" width="286" height="56" rx="15" fill="#e9eef8"/>
  <text x="195" y="463" text-anchor="middle" fill="#52627f" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="16" font-weight="700">${escapeHtml(button)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844" role="img" aria-labelledby="title description">
  <title id="title">${escapeHtml(title)}</title>
  <desc id="description">${escapeHtml(body)}</desc>
  <rect width="390" height="844" fill="#f7f9ff"/>
  <rect x="18" y="132" width="354" height="580" rx="28" fill="#ffffff" stroke="#e3e8f4"/>
  <circle cx="195" cy="220" r="33" fill="#071c54"/>
  <text x="195" y="231" text-anchor="middle" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="31" font-weight="800">P</text>
  <text x="195" y="316" text-anchor="middle" fill="#07183f" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="24" font-weight="700">${escapeHtml(title)}</text>
  <text x="195" y="355" text-anchor="middle" fill="#63708a" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="15">${escapeHtml(body)}</text>
  <text x="195" y="378" text-anchor="middle" fill="#63708a" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="15">${escapeHtml(recovery ? (portuguese ? 'O acesso continua protegido.' : 'Your access remains protected.') : (portuguese ? 'A confirmação foi concluída.' : 'Confirmation is complete.'))}</text>
  ${action}
  <text x="195" y="550" text-anchor="middle" fill="#7b879d" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13">${escapeHtml(note)}</text>
  <text x="195" y="572" text-anchor="middle" fill="#7b879d" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="13">${escapeHtml(portuguese ? 'Pode fechar esta janela depois.' : 'You can close this window afterwards.')}</text>
</svg>`;
}

Deno.serve((request) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Not found', { status: 404, headers: responseHeaders });
  }

  const requestUrl = new URL(request.url);
  const recovery = isRecoveryPath(
    requestUrl.pathname,
    requestUrl.searchParams.get('type'),
  );
  const appUrl = makeAppUrl(requestUrl, recovery);
  const portuguese = (request.headers.get('accept-language') ?? '')
    .toLowerCase()
    .split(',')[0]
    .startsWith('pt');
  const mobileDevice = /android|iphone|ipad|ipod/i.test(
    request.headers.get('user-agent') ?? '',
  );

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: responseHeaders });
  }
  return new Response(renderPage(requestUrl, appUrl, recovery, portuguese, mobileDevice), {
    status: 200,
    headers: responseHeaders,
  });
});
