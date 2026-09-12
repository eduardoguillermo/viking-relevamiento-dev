/* drive-sync.js — v1.0.0
   Sincroniza contra una carpeta visible en Drive. Mismo patrón y mismo
   Client ID de OAuth que el resto del ecosistema de PWAs (Control Vehicular,
   Control Financiero, Viking VSS). Soporta múltiples archivos con nombre
   dentro de la misma carpeta (no un único "backup" fijo).
*/
const DriveSync = (() => {
  const CLIENT_ID = '1049169592532-is5j1j4s1bmgrc9tsq48slrgul8fbj17.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const CARPETA = 'VikingRelevamientoDEV';
  const TOKEN_KEY = 'vrel_drive_token_dev';

  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  let renewTimer = null;
  let onTokenCallback = null;

  function log(...args) { console.log('[DriveSync]', ...args); }

  function guardarToken(token, expiresInSeg) {
    const vencimiento = Date.now() + (expiresInSeg * 1000) - 60000;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, vencimiento }));
  }
  function tokenGuardadoValido() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const { token, vencimiento } = JSON.parse(raw);
      if (Date.now() < vencimiento) return token;
      return null;
    } catch (e) { return null; }
  }

  function init(onReady) {
    if (!window.google || !google.accounts) {
      log('Google Identity Services todavía no cargó, reintentando...');
      setTimeout(() => init(onReady), 400);
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) { log('Error de token', resp); return; }
          accessToken = resp.access_token;
          guardarToken(accessToken, resp.expires_in || 3600);
          programarRenovacion();
          if (onReady) onReady();
          if (onTokenCallback) onTokenCallback();
        },
        error_callback: (err) => { log('Intento de token falló (silencioso):', err && err.type); }
      });
    }
    const guardado = tokenGuardadoValido();
    if (guardado) {
      accessToken = guardado;
      programarRenovacion();
      if (onReady) onReady();
    } else {
      // Reconexión silenciosa: si el scope ya fue otorgado desde cualquier otra
      // PWA del ecosistema (mismo Client ID), puede emitir token sin popup.
      tokenClient.requestAccessToken({ prompt: '' });
    }
  }

  function conectar() {
    if (accessToken) return;
    if (!tokenClient) { log('tokenClient no inicializado todavía'); return; }
    tokenClient.requestAccessToken({ prompt: '' });
  }

  function forzarReconexion() {
    accessToken = null;
    localStorage.removeItem(TOKEN_KEY);
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function programarRenovacion() {
    if (renewTimer) clearTimeout(renewTimer);
    let delay = 50 * 60 * 1000;
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (raw) {
        const { vencimiento } = JSON.parse(raw);
        delay = Math.max(vencimiento - Date.now() - 60000, 5000);
      }
    } catch (e) {}
    renewTimer = setTimeout(() => { tokenClient.requestAccessToken({ prompt: '' }); }, delay);
  }

  async function api(url, opts = {}) {
    const resp = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) throw new Error(`Drive API ${resp.status}: ${await resp.text()}`);
    return resp;
  }

  let _folderPromise = null;
  async function ensureFolder() {
    if (folderId) return folderId;
    if (_folderPromise) return _folderPromise;
    _folderPromise = (async () => {
      const q = encodeURIComponent(`name='${CARPETA}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      const data = await resp.json();
      if (data.files && data.files.length) { folderId = data.files[0].id; return folderId; }
      const createResp = await api('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: CARPETA, mimeType: 'application/vnd.google-apps.folder' })
      });
      const created = await createResp.json();
      folderId = created.id;
      return folderId;
    })();
    try { return await _folderPromise; } finally { _folderPromise = null; }
  }

  // Busca el id de un archivo por nombre dentro de la carpeta (o null si no existe)
  async function buscarArchivo(nombre) {
    await ensureFolder();
    const q = encodeURIComponent(`name='${nombre}' and '${folderId}' in parents and trashed=false`);
    const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  }

  async function subirJSON(obj, creando, nombreArchivo, archivoIdDestino) {
    await ensureFolder();
    const boundary = 'vsync_boundary';
    const metadata = creando
      ? { name: nombreArchivo, parents: [folderId], mimeType: 'application/json' }
      : { mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;
    const url = creando
      ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      : `https://www.googleapis.com/upload/drive/v3/files/${archivoIdDestino}?uploadType=multipart`;
    const opts = { method: creando ? 'POST' : 'PATCH', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body };
    const resp = await api(url, opts);
    return resp.json();
  }

  // Sube/actualiza un archivo con nombre propio, creándolo si no existe.
  async function subirArchivo(nombre, obj) {
    const existente = await buscarArchivo(nombre);
    if (existente) { await subirJSON(obj, false, nombre, existente.id); return existente.id; }
    const creado = await subirJSON(obj, true, nombre, null);
    return creado.id;
  }

  // Baja el contenido de un archivo por nombre. Devuelve null si no existe.
  async function bajarArchivo(nombre) {
    const existente = await buscarArchivo(nombre);
    if (!existente) return null;
    const resp = await api(`https://www.googleapis.com/drive/v3/files/${existente.id}?alt=media`);
    return resp.json();
  }

  async function existeArchivo(nombre) { return !!(await buscarArchivo(nombre)); }

  return {
    init, conectar, forzarReconexion,
    subirArchivo, bajarArchivo, existeArchivo,
    onToken(fn){ onTokenCallback = fn; },
    get conectado() { return !!accessToken; }
  };
})();
