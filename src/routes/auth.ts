import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { SimContext } from '../sim';

const TOKEN_TTL_SECONDS = 300;

// Contabo's real token URL is
//   https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token
// so point CONTABO_AUTH_URL at <simulator>/auth/realms/contabo/protocol/openid-connect/token.
// /auth/auth/token is kept for upstream compatibility.
export const TOKEN_PATHS = ['/auth/realms/contabo/protocol/openid-connect/token', '/auth/auth/token'];

export function authRouter(ctx: SimContext): Router {
  const router = Router();

  const issue = (req: Request, res: Response) => {
    if (ctx.scenarios.takeTokenFailure()) {
      res.status(401).json({ error: 'invalid_grant', error_description: 'Simulated: invalid user credentials' });
      return;
    }
    if (ctx.scenarios.settings.strictAuth) {
      const body = (req.body || {}) as Record<string, unknown>;
      const missing = ['client_id', 'client_secret', 'username', 'password'].filter(
        (k) => typeof body[k] !== 'string' || (body[k] as string) === ''
      );
      if (body.grant_type !== 'password' || missing.length > 0) {
        res.status(400).json({
          error: 'invalid_request',
          error_description: `expected grant_type=password with ${missing.join(', ') || 'all credentials'}`,
        });
        return;
      }
    }
    const token = 'sim-' + randomUUID();
    ctx.tokens.set(token, Date.now() + TOKEN_TTL_SECONDS * 1000);
    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      refresh_expires_in: 1800,
      refresh_token: 'sim-refresh-' + randomUUID(),
      scope: 'profile email',
    });
  };

  for (const path of TOKEN_PATHS) router.post(path, issue);
  return router;
}

/** In strict mode, /v1 routes only accept unexpired tokens this simulator issued. */
export function requireToken(ctx: SimContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.scenarios.settings.strictAuth) return next();
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const exp = token ? ctx.tokens.get(token) : undefined;
    if (!exp || exp < Date.now()) {
      if (token) ctx.tokens.delete(token);
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }
    next();
  };
}
