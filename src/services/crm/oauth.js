const https = require('https');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const { CrmConfig } = require('../../models');
const crmCrypto = require('./crypto');

// ============================================================
// OAuth 2.0 Authentication Module
//
// Shared module used by Salesforce, HubSpot, Zoho, and Pipedrive
// adapters. Handles:
//   - Authorization URL generation (with CSRF state parameter)
//   - Auth code → token exchange
//   - Encrypted token storage in MongoDB
//   - Auto-refresh before expiry (<5 min remaining)
//   - Retry on 401 (refresh + retry once)
//
// Each CRM has different OAuth endpoints and scopes. The adapter
// passes CRM-specific config via PROVIDER_CONFIG.
//
// Token lifecycle:
//   1. Admin clicks "Connect [CRM]" → generate authorize URL
//   2. Browser redirects to CRM login → admin grants access
//   3. CRM redirects back with auth code → exchange for tokens
//   4. Tokens encrypted and stored in CrmConfig.oauthTokens
//   5. Before each API call → check expiry → auto-refresh if needed
//   6. On 401 response → force refresh → retry once
// ============================================================

// ── In-memory state store for CSRF protection ──
// state → { configId, provider, createdAt }
const pendingStates = new Map();
const STATE_TTL = 10 * 60 * 1000;  // 10 minutes

// Clean expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > STATE_TTL) pendingStates.delete(state);
  }
}, 60000);

// ── Per-CRM OAuth endpoint configuration ──
const PROVIDER_CONFIG = {
  salesforce: {
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl:     'https://login.salesforce.com/services/oauth2/token',
    scopes:       'api refresh_token',
    tokenExpiresIn: 7200,  // SF tokens expire in ~2 hours
  },
  hubspot: {
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl:     'https://api.hubapi.com/oauth/v1/token',
    scopes:       'crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write',
    tokenExpiresIn: 1800,  // 30 minutes
  },
  zoho: {
    // Default to .com — adapter should override for .eu / .in / .com.au
    authorizeUrl: 'https://accounts.zoho.com/oauth/v2/auth',
    tokenUrl:     'https://accounts.zoho.com/oauth/v2/token',
    scopes:       'ZohoCRM.modules.ALL',
    tokenExpiresIn: 3600,
  },
  pipedrive: {
    authorizeUrl: 'https://oauth.pipedrive.com/oauth/authorize',
    tokenUrl:     'https://oauth.pipedrive.com/oauth/token',
    scopes:       'base deals:read deals:write',
    tokenExpiresIn: 3600,
  },
};

class OAuthManager {
  constructor() {
    // Base redirect URI — set from env or constructed from PBX domain
    this.redirectUri = '';
  }

  /**
   * Get the OAuth redirect URI.
   * Must be HTTPS in production (Let's Encrypt on PBX domain).
   */
  getRedirectUri() {
    if (this.redirectUri) return this.redirectUri;

    const base = process.env.WEBHOOK_BASE_URL || process.env.PBX_URL || '';
    if (base) {
      this.redirectUri = `${base.replace(/\/$/, '')}/settings/crm/oauth/callback`;
    } else {
      const domain = process.env.SIP_DOMAIN || 'localhost';
      const port = process.env.API_PORT || '3000';
      this.redirectUri = `https://${domain}/settings/crm/oauth/callback`;
    }
    return this.redirectUri;
  }

  // ──────────────────────────────────────────────────────────
  // Step 1: Generate authorization URL
  // ──────────────────────────────────────────────────────────

  /**
   * Build the CRM-specific OAuth authorize URL.
   * @param {string} configId — CrmConfig document _id
   * @param {string} provider — 'salesforce', 'hubspot', 'zoho', 'pipedrive'
   * @param {Object} credentials — decrypted credentials { clientId, clientSecret }
   * @param {Object} [options] — optional overrides { scopes, authorizeUrl, zohoRegion }
   * @returns {string} — full authorize URL to redirect the admin's browser to
   */
  generateAuthorizeUrl(configId, provider, credentials, options = {}) {
    const providerConf = PROVIDER_CONFIG[provider];
    if (!providerConf) {
      throw new Error(`OAuth not supported for provider: ${provider}`);
    }

    if (!credentials.clientId) {
      throw new Error('OAuth requires clientId in credentials');
    }

    // Generate CSRF state token
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, {
      configId,
      provider,
      createdAt: Date.now(),
    });

    // Build authorize URL
    let authorizeUrl = options.authorizeUrl || providerConf.authorizeUrl;

    // Zoho region handling
    if (provider === 'zoho' && options.zohoRegion) {
      const regionMap = {
        us:  'accounts.zoho.com',
        eu:  'accounts.zoho.eu',
        in:  'accounts.zoho.in',
        au:  'accounts.zoho.com.au',
        jp:  'accounts.zoho.jp',
      };
      const domain = regionMap[options.zohoRegion] || 'accounts.zoho.com';
      authorizeUrl = `https://${domain}/oauth/v2/auth`;
    }

    const params = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: this.getRedirectUri(),
      scope: options.scopes || providerConf.scopes,
      state,
      response_type: 'code',
    });

    // Provider-specific params
    if (provider === 'salesforce') {
      params.set('prompt', 'consent');     // force consent to get refresh_token
    } else if (provider === 'zoho') {
      params.set('access_type', 'offline');  // get refresh_token
      params.set('prompt', 'consent');
    } else if (provider === 'hubspot') {
      // HubSpot uses optional_scope for non-critical scopes
      // No extra params needed for basic flow
    }

    const url = `${authorizeUrl}?${params.toString()}`;
    logger.info(`OAuth [${provider}]: authorize URL generated for config ${configId}`);
    return url;
  }

  // ──────────────────────────────────────────────────────────
  // Step 2: Handle callback — exchange code for tokens
  // ──────────────────────────────────────────────────────────

  /**
   * Handle the OAuth callback — validate state, exchange code for tokens,
   * store encrypted tokens in MongoDB.
   *
   * @param {string} code — authorization code from CRM
   * @param {string} state — CSRF state parameter
   * @returns {Promise<{success: boolean, configId: string, provider: string, error?: string}>}
   */
  async handleCallback(code, state) {
    // Validate state
    const pending = pendingStates.get(state);
    if (!pending) {
      return { success: false, error: 'Invalid or expired state parameter (CSRF check failed)' };
    }
    pendingStates.delete(state);

    // Check TTL
    if (Date.now() - pending.createdAt > STATE_TTL) {
      return { success: false, error: 'OAuth state expired — please try again' };
    }

    const { configId, provider } = pending;

    // Load CRM config
    const config = await CrmConfig.findById(configId);
    if (!config) {
      return { success: false, error: `CRM config ${configId} not found` };
    }

    // Decrypt credentials to get clientId + clientSecret
    let credentials = {};
    if (config.credentials) {
      try {
        credentials = crmCrypto.decryptObject(config.credentials);
      } catch (err) {
        return { success: false, error: 'Cannot decrypt CRM credentials' };
      }
    }

    if (!credentials.clientId || !credentials.clientSecret) {
      return { success: false, error: 'CRM credentials missing clientId or clientSecret' };
    }

    // Exchange code for tokens
    try {
      const tokens = await this._exchangeCode(provider, code, credentials, config);
      
      // Store encrypted tokens
      config.oauthTokens = crmCrypto.encryptObject(tokens);
      config.connectedAt = new Date();
      config.lastError = '';
      config.errorCount = 0;
      config.updatedAt = new Date();

      // Store instance URL if returned (Salesforce)
      if (tokens.instanceUrl) {
        config.instanceUrl = tokens.instanceUrl;
      }

      await config.save();

      logger.info(`OAuth [${provider}]: tokens stored for config ${configId}`);
      return { success: true, configId, provider };

    } catch (err) {
      logger.error(`OAuth [${provider}]: token exchange failed: ${err.message}`);
      config.lastError = `OAuth failed: ${err.message}`;
      config.errorCount = (config.errorCount || 0) + 1;
      config.updatedAt = new Date();
      await config.save();
      return { success: false, configId, provider, error: err.message };
    }
  }

  /**
   * Exchange authorization code for access + refresh tokens.
   */
  async _exchangeCode(provider, code, credentials, config) {
    const providerConf = PROVIDER_CONFIG[provider];
    let tokenUrl = providerConf.tokenUrl;

    // Zoho region handling
    if (provider === 'zoho' && config.instanceUrl) {
      // Derive token URL from instance URL region
      const match = config.instanceUrl.match(/zoho\.(\w+)/);
      if (match) {
        const tld = match[1];
        tokenUrl = `https://accounts.zoho.${tld}/oauth/v2/token`;
      }
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: this.getRedirectUri(),
    });

    const result = await this._postForm(tokenUrl, body.toString());

    // Normalize token response
    const now = Date.now();
    const expiresIn = result.expires_in || providerConf.tokenExpiresIn || 3600;

    const tokens = {
      accessToken:  result.access_token,
      refreshToken: result.refresh_token || '',
      expiresAt:    now + (expiresIn * 1000),
      tokenType:    result.token_type || 'Bearer',
      scope:        result.scope || '',
    };

    // Salesforce returns instance_url
    if (result.instance_url) {
      tokens.instanceUrl = result.instance_url;
    }

    // HubSpot returns hub_id
    if (result.hub_id) {
      tokens.hubId = result.hub_id;
    }

    if (!tokens.accessToken) {
      throw new Error(`No access_token in response: ${JSON.stringify(result).substring(0, 200)}`);
    }

    return tokens;
  }

  // ──────────────────────────────────────────────────────────
  // Step 3: Token refresh
  // ──────────────────────────────────────────────────────────

  /**
   * Refresh the access token using the refresh token.
   * Called automatically before API calls when token is about to expire.
   *
   * @param {string} configId — CrmConfig document _id
   * @returns {Promise<Object>} — updated tokens { accessToken, refreshToken, expiresAt }
   */
  async refreshToken(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config) throw new Error(`CRM config ${configId} not found`);

    // Decrypt current tokens
    let tokens;
    try {
      tokens = crmCrypto.decryptObject(config.oauthTokens);
    } catch (err) {
      throw new Error('Cannot decrypt OAuth tokens — re-authorization required');
    }

    if (!tokens.refreshToken) {
      throw new Error('No refresh token available — re-authorization required');
    }

    // Decrypt credentials
    let credentials;
    try {
      credentials = crmCrypto.decryptObject(config.credentials);
    } catch (err) {
      throw new Error('Cannot decrypt CRM credentials');
    }

    const provider = config.provider;
    const providerConf = PROVIDER_CONFIG[provider];
    if (!providerConf) throw new Error(`OAuth not supported for ${provider}`);

    let tokenUrl = providerConf.tokenUrl;

    // Zoho region
    if (provider === 'zoho' && config.instanceUrl) {
      const match = config.instanceUrl.match(/zoho\.(\w+)/);
      if (match) tokenUrl = `https://accounts.zoho.${match[1]}/oauth/v2/token`;
    }

    // Salesforce: use instance URL for token refresh
    if (provider === 'salesforce' && config.instanceUrl) {
      // SF refreshes against login.salesforce.com, not instance URL
      // tokenUrl stays as login.salesforce.com
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });

    try {
      const result = await this._postForm(tokenUrl, body.toString());

      const now = Date.now();
      const expiresIn = result.expires_in || providerConf.tokenExpiresIn || 3600;

      tokens.accessToken = result.access_token;
      tokens.expiresAt = now + (expiresIn * 1000);
      // Some CRMs rotate refresh tokens
      if (result.refresh_token) tokens.refreshToken = result.refresh_token;
      // Salesforce may return new instance_url
      if (result.instance_url) tokens.instanceUrl = result.instance_url;

      // Store updated tokens
      config.oauthTokens = crmCrypto.encryptObject(tokens);
      config.lastError = '';
      config.updatedAt = new Date();
      await config.save();

      logger.info(`OAuth [${provider}]: token refreshed for config ${configId}`);
      return tokens;

    } catch (err) {
      logger.error(`OAuth [${provider}]: refresh failed for ${configId}: ${err.message}`);
      config.lastError = `Token refresh failed: ${err.message}`;
      config.errorCount = (config.errorCount || 0) + 1;
      config.updatedAt = new Date();
      await config.save();
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Token access helpers (used by adapters)
  // ──────────────────────────────────────────────────────────

  /**
   * Get a valid access token, refreshing if necessary.
   * This is the main method adapters call before each API request.
   *
   * @param {string} configId — CrmConfig document _id
   * @returns {Promise<string>} — valid access token
   */
  async getAccessToken(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config) throw new Error(`CRM config ${configId} not found`);

    if (!config.oauthTokens) {
      throw new Error('No OAuth tokens — authorization required');
    }

    let tokens;
    try {
      tokens = crmCrypto.decryptObject(config.oauthTokens);
    } catch (err) {
      throw new Error('Cannot decrypt OAuth tokens — re-authorization required');
    }

    // Check if token expires within 5 minutes
    const REFRESH_BUFFER = 5 * 60 * 1000;  // 5 minutes
    if (tokens.expiresAt && (Date.now() + REFRESH_BUFFER) >= tokens.expiresAt) {
      logger.debug(`OAuth: token expiring soon for ${configId}, refreshing...`);
      tokens = await this.refreshToken(configId);
    }

    return tokens.accessToken;
  }

  /**
   * Get full token data (for adapters that need instanceUrl, etc.).
   * @param {string} configId
   * @returns {Promise<Object>} — { accessToken, refreshToken, expiresAt, instanceUrl, ... }
   */
  async getTokenData(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config || !config.oauthTokens) {
      throw new Error('No OAuth tokens — authorization required');
    }

    let tokens = crmCrypto.decryptObject(config.oauthTokens);

    // Auto-refresh if expiring soon
    const REFRESH_BUFFER = 5 * 60 * 1000;
    if (tokens.expiresAt && (Date.now() + REFRESH_BUFFER) >= tokens.expiresAt) {
      tokens = await this.refreshToken(configId);
    }

    return tokens;
  }

  /**
   * Wrapper for API calls that auto-retries on 401.
   * Adapters use this instead of raw HTTP calls.
   *
   * @param {string} configId
   * @param {Function} apiFn — async function(accessToken) that makes the API call
   * @returns {Promise<*>} — result from apiFn
   */
  async withAutoRefresh(configId, apiFn) {
    let token = await this.getAccessToken(configId);

    try {
      return await apiFn(token);
    } catch (err) {
      // If 401, try refreshing and retry once
      if (err.statusCode === 401 || err.status === 401 ||
          (err.message && err.message.includes('401'))) {
        logger.debug(`OAuth: 401 received for ${configId}, refreshing token...`);
        try {
          const tokens = await this.refreshToken(configId);
          token = tokens.accessToken;
          return await apiFn(token);
        } catch (refreshErr) {
          logger.error(`OAuth: retry after refresh failed: ${refreshErr.message}`);
          throw refreshErr;
        }
      }
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Token revocation
  // ──────────────────────────────────────────────────────────

  /**
   * Revoke OAuth tokens (disconnect CRM).
   * Not all CRMs support revocation — best-effort.
   *
   * @param {string} configId
   */
  async revokeTokens(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config) return;

    let tokens;
    try {
      tokens = config.oauthTokens ? crmCrypto.decryptObject(config.oauthTokens) : null;
    } catch { tokens = null; }

    if (tokens && tokens.accessToken) {
      const provider = config.provider;
      try {
        if (provider === 'salesforce' && config.instanceUrl) {
          // Salesforce supports token revocation
          const revokeUrl = `${config.instanceUrl}/services/oauth2/revoke`;
          const body = `token=${encodeURIComponent(tokens.accessToken)}`;
          await this._postForm(revokeUrl, body);
          logger.info(`OAuth [salesforce]: token revoked for ${configId}`);
        }
        // HubSpot, Zoho, Pipedrive don't have revocation endpoints
        // Tokens will expire naturally
      } catch (err) {
        logger.debug(`OAuth: revocation failed for ${configId}: ${err.message}`);
      }
    }

    // Clear tokens from DB
    config.oauthTokens = '';
    config.connectedAt = null;
    config.updatedAt = new Date();
    await config.save();
    logger.info(`OAuth: tokens cleared for config ${configId}`);
  }

  // ──────────────────────────────────────────────────────────
  // Status
  // ──────────────────────────────────────────────────────────

  /**
   * Check if a CRM config has valid (non-expired) OAuth tokens.
   * @param {string} configId
   * @returns {Promise<{authenticated: boolean, expiresAt: number|null, needsRefresh: boolean}>}
   */
  async getTokenStatus(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config || !config.oauthTokens) {
      return { authenticated: false, expiresAt: null, needsRefresh: false };
    }

    try {
      const tokens = crmCrypto.decryptObject(config.oauthTokens);
      const now = Date.now();
      const REFRESH_BUFFER = 5 * 60 * 1000;

      return {
        authenticated: !!tokens.accessToken,
        expiresAt: tokens.expiresAt || null,
        needsRefresh: tokens.expiresAt ? (now + REFRESH_BUFFER) >= tokens.expiresAt : false,
        hasRefreshToken: !!tokens.refreshToken,
      };
    } catch {
      return { authenticated: false, expiresAt: null, needsRefresh: false };
    }
  }

  /**
   * Get provider config for a given CRM (for admin UI).
   */
  getProviderConfig(provider) {
    return PROVIDER_CONFIG[provider] || null;
  }

  /**
   * Get list of OAuth-capable providers.
   */
  getOAuthProviders() {
    return Object.keys(PROVIDER_CONFIG);
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helper — POST form-urlencoded (token exchange)
  // ──────────────────────────────────────────────────────────

  _postForm(url, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json',
          'User-Agent': 'ShadowPBX/2.0',
        },
        timeout: 15000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Invalid JSON from ${parsed.hostname}: ${data.substring(0, 200)}`));
            }
          } else {
            const err = new Error(`OAuth token request failed: HTTP ${res.statusCode} — ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OAuth request timeout')); });
      req.write(body);
      req.end();
    });
  }
}

// ── Singleton ──
const oauthManager = new OAuthManager();

module.exports = oauthManager;
