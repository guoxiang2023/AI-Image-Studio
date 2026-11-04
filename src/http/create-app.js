import { TRUST_PROXY } from '../config.js';
import { AppError } from '../shared/errors.js';
import { friendlyError } from '../shared/utils.js';
import { getRequestUser } from '../auth/session-service.js';
import { createRouter } from './router.js';
import { isSameOrigin } from './origin.js';
import { json, setSecurityHeaders } from './responses.js';
import {
  handleAuthStatus,
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
} from './routes/auth.js';
import { handleChat } from './routes/chat.js';
import { handleConfig, handleModels, handleRevealKey, handleTest } from './routes/config.js';
import {
  handleCreateFolder,
  handleDeleteFolder,
  handleGallery,
  handleHideImage,
  handleUpdateImage,
} from './routes/gallery.js';
import { handleListSessions, handleSession } from './routes/sessions.js';
import {
  handleStyleGenerate,
  handleStyleImport,
  handleStyleReferences,
} from './routes/studio.js';
import { handleUpload } from './routes/upload.js';
import { handleVersion } from './routes/version.js';
import { serveImageFile, serveStatic } from './static.js';

function buildRouter() {
  const router = createRouter();

  router.get('/api/health', ({ res }) => json(res, 200, { ok: true }), { public: true });
  router.get('/api/version', ({ req, res, url }) => handleVersion(req, res, url), { public: true });
  router.get('/api/auth/status', ({ req, res }) => handleAuthStatus(req, res), { public: true });
  router.post('/api/auth/register', ({ req, res }) => handleRegister(req, res), { public: true });
  router.post('/api/auth/login', ({ req, res }) => handleLogin(req, res), { public: true });
  router.post('/api/auth/logout', ({ req, res }) => handleLogout(req, res), { public: true });

  router.get('/api/auth/me', ({ res, user }) => handleMe(res, user));
  router.get('/api/config', ({ req, res, user }) => handleConfig(req, res, user));
  router.get('/api/config/key', ({ req, res, user }) => handleRevealKey(req, res, user));
  router.put('/api/config', ({ req, res, user }) => handleConfig(req, res, user));
  router.post('/api/models', ({ req, res, user }) => handleModels(req, res, user));
  router.post('/api/test', ({ req, res, user }) => handleTest(req, res, user));

  router.get('/api/gallery', ({ req, res, user }) => handleGallery(req, res, user));
  router.post('/api/gallery/folders', ({ req, res, user }) => handleCreateFolder(req, res, user));
  router.delete('/api/gallery/folders/:id', ({ req, res, user, params }) =>
    handleDeleteFolder(req, res, user, params.id),
  );
  router.patch('/api/gallery/images/:id', ({ req, res, user, params }) =>
    handleUpdateImage(req, res, user, params.id),
  );
  router.delete('/api/gallery/images/:id', ({ req, res, user, params }) =>
    handleHideImage(req, res, user, params.id),
  );

  router.get('/api/sessions', ({ req, res, user }) => handleListSessions(req, res, user));
  router.get('/api/sessions/:id', ({ req, res, user, params }) =>
    handleSession(req, res, user, params.id),
  );
  router.delete('/api/sessions/:id', ({ req, res, user, params }) =>
    handleSession(req, res, user, params.id),
  );

  router.get('/api/studio/references', ({ req, res, user }) =>
    handleStyleReferences(req, res, user),
  );
  router.post('/api/studio/import', ({ req, res, user }) =>
    handleStyleImport(req, res, user),
  );
  router.post('/api/studio/generate', ({ req, res, user }) =>
    handleStyleGenerate(req, res, user),
  );
  router.post('/api/upload', ({ req, res, user }) => handleUpload(req, res, user));
  router.post('/api/chat', ({ req, res, user }) => handleChat(req, res, user));
  router.get('/files/:name', ({ res, user, params }) =>
    serveImageFile(res, user.id, params.name),
  );

  return router;
}

const router = buildRouter();

export function createApp() {
  return async function handleRequest(req, res) {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (
        pathname.startsWith('/api/') &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        !isSameOrigin(req, TRUST_PROXY)
      ) {
        return json(res, 403, { error: '非法请求来源' });
      }

      if (!pathname.startsWith('/api/') && !pathname.startsWith('/files/')) {
        return await serveStatic(res, pathname);
      }

      const match = router.match(req.method, pathname);
      if (match?.route.public) {
        return await match.route.handler({
          req,
          res,
          params: match.params,
          url,
        });
      }

      const user = getRequestUser(req);
      if (!user) return json(res, 401, { error: '请先登录' });
      if (!match) return json(res, 404, { error: 'not found' });

      return await match.route.handler({
        req,
        res,
        user,
        params: match.params,
        url,
      });
    } catch (err) {
      const status = err instanceof AppError ? err.status : err?.status;
      if (status && !res.headersSent) {
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        return json(res, status, { error: err.message });
      }
      if (!res.headersSent) {
        let code = 500;
        let message = friendlyError(err);
        if (err instanceof SyntaxError) {
          code = 400;
          message = '请求格式错误';
        } else if (err?.message === '请求体过大') {
          code = 413;
          message = '请求体过大';
        }
        return json(res, code, { error: message });
      }
      res.end();
    }
  };
}
