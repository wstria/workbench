const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./store');

const formats = [
  { id: 'openai-completions', name: 'OpenAI Chat Completions', example: 'http://localhost:11434/v1' },
  { id: 'openai-responses', name: 'OpenAI Responses', example: 'https://api.openai.com/v1' },
  { id: 'anthropic-messages', name: 'Anthropic Messages', example: 'https://api.anthropic.com' },
  { id: 'google-generative-ai', name: 'Google Generative AI', example: 'https://generativelanguage.googleapis.com/v1beta' },
];
const specializedAuth = new Set(['amazon-bedrock', 'azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'github-copilot', 'google-vertex']);
const localKey = 'workbench-no-auth';
const providerIdPattern = /^[a-z\d][a-z\d-]{0,79}$/;
const modelIdPattern = /^[\w][\w./:@+-]{0,249}$/;

function modelReference(provider, id) {
  return provider === 'openai' ? id : provider + '/' + id;
}

function parseModel(value) {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  const provider = slash === -1 ? 'openai' : value.slice(0, slash);
  const id = slash === -1 ? value : value.slice(slash + 1);
  return providerIdPattern.test(provider) && modelIdPattern.test(id) ? { provider, id } : null;
}

function endpoint(value, api) {
  const url = URL.parse(typeof value === 'string' ? value.trim() : '');
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP or HTTPS API base URL without credentials, query parameters, or a fragment.');
  }
  const baseUrl = url.href.replace(/\/+$/, '');
  return api === 'anthropic-messages' ? baseUrl.replace(/\/v1$/, '') : baseUrl;
}

function readSecret(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value)) throw new Error('Enter a valid API key.');
  return value.trim();
}

function cleanProfile(input, id) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw new Error('Enter a provider name.');
  const api = formats.find(({ id }) => id === input.api)?.id;
  if (!api) throw new Error('Choose an API format.');
  if (api === 'google-generative-ai' && input.noAuth) throw new Error('Google Generative AI requires an API key.');
  const baseUrl = endpoint(input.baseUrl, api);
  if (!Array.isArray(input.models) || input.models.length > 250 || input.models.some((model) => typeof model !== 'string' || !modelIdPattern.test(model))) {
    throw new Error('Enter up to 250 model IDs, one per line.');
  }
  if (!input.models.length) throw new Error('Add at least one model ID.');
  const limits = { contextWindow: input.contextWindow ?? 128000, maxTokens: input.maxTokens ?? 8192 };
  if (!Number.isSafeInteger(limits.contextWindow) || limits.contextWindow < 1 || limits.contextWindow > 10000000 ||
      !Number.isSafeInteger(limits.maxTokens) || limits.maxTokens < 1 || limits.maxTokens > limits.contextWindow) {
    throw new Error('Token limits must be whole numbers. Maximum output must fit inside the context window.');
  }
  return { id, name, api, baseUrl, models: [...new Set(input.models)], images: input.images === true,
    reasoning: input.reasoning === true, noAuth: input.noAuth === true, ...limits };
}

function createProviders({ store, safeStorage, inheritedKey }) {
  let base;
  const sdk = () => import('@earendil-works/pi-coding-agent');
  async function runtime() {
    return (await sdk()).ModelRuntime.create({ authPath: path.join(store.folders.pi, 'auth.json'),
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  }
  async function nativeProviders() {
    base ??= runtime().then((collection) => collection.getProviders()
      .filter((provider) => provider.auth?.apiKey && !specializedAuth.has(provider.id) && collection.getModels(provider.id).length)
      .map((provider) => ({ id: provider.id, name: provider.name, models: collection.getModels(provider.id) })));
    return base;
  }
  function secretFile(id) {
    return path.join(store.root, id === 'openai' ? 'openai.keychain' : 'provider-' + id + '.keychain');
  }
  const hasSecret = (id) => fs.existsSync(secretFile(id));
  function getSecret(id) {
    if (hasSecret(id)) {
      try { return safeStorage.decryptString(fs.readFileSync(secretFile(id))); }
      catch { throw new Error('The saved key could not be unlocked. Re-enter it in Settings → Providers.'); }
    }
    return id === 'openai' ? inheritedKey : undefined;
  }
  function putSecret(id, value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential storage is unavailable.');
    atomicWrite(secretFile(id), safeStorage.encryptString(value));
  }
  const profiles = () => store.data.customProviders ?? [];
  function credentialsChanged() {
    store.data.providerRevision = (store.data.providerRevision ?? 0) + 1;
    store.update();
  }
  const status = (id) => hasSecret(id) ? 'keychain' : id === 'openai' && inheritedKey ? 'environment' : 'disconnected';
  function available(profile) { return profile.noAuth || status(profile.id) !== 'disconnected'; }
  function modelRows(provider, models) {
    return models.map((model) => ({ id: modelReference(provider.id, model.id), modelId: model.id,
      name: model.name || model.id, provider: provider.name, providerId: provider.id,
      images: model.input?.includes('image') ?? provider.images ?? false, reasoning: model.reasoning ?? false,
      contextWindow: model.contextWindow ?? provider.contextWindow,
      pricing: Number.isFinite(model.cost?.input) && Number.isFinite(model.cost?.output) && model.cost.input >= 0 && model.cost.output >= 0
        ? { input: model.cost.input, output: model.cost.output } : undefined }));
  }
  async function catalog() {
    const native = (await nativeProviders()).filter(({ id }) => status(id) !== 'disconnected');
    const models = native.flatMap((provider) => modelRows(provider, provider.models));
    for (const profile of profiles().filter(available)) models.push(...modelRows(profile, profile.models.map((id) => ({ id, reasoning: profile.reasoning }))));
    models.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
    const defaultModel = models.find(({ id }) => id === store.data.model)?.id ?? models[0]?.id ?? '';
    return { models, defaultModel };
  }
  async function list() {
    const native = (await nativeProviders()).map(({ id, name, models }) => ({ id, name, count: models.length,
      credential: status(id), connected: status(id) !== 'disconnected' }));
    const custom = profiles().map((profile) => ({ ...profile, count: profile.models.length, custom: true,
      credential: status(profile.id), connected: available(profile) }));
    return { providers: [...native, ...custom], formats };
  }
  async function save(input = {}) {
    const secret = readSecret(input.key);
    if (!input.custom) {
      const provider = (await nativeProviders()).find(({ id }) => id === input.id);
      if (!provider) throw new Error('Choose a provider from the catalog.');
      if (!secret) throw new Error('Enter an API key.');
      putSecret(provider.id, secret);
      credentialsChanged();
      return;
    }
    const current = profiles().find(({ id }) => id === input.id);
    if (input.id && !current) throw new Error('Custom provider not found.');
    const profile = cleanProfile(input, current?.id ?? 'custom-' + randomUUID());
    const connectionChanged = current && (current.baseUrl !== profile.baseUrl || current.api !== profile.api);
    if (!profile.noAuth && !secret && (!hasSecret(profile.id) || connectionChanged)) {
      throw new Error('Enter the API key for this endpoint, or select No API key.');
    }
    if (profile.noAuth && hasSecret(profile.id)) fs.unlinkSync(secretFile(profile.id));
    if (!profile.noAuth && secret) putSecret(profile.id, secret);
    store.data.customProviders = [...profiles().filter(({ id }) => id !== profile.id), profile];
    credentialsChanged();
    return profile.id;
  }
  async function remove(id) {
    const custom = profiles().some((item) => item.id === id);
    if (!custom && !(await nativeProviders()).some((item) => item.id === id)) throw new Error('Provider not found.');
    if (hasSecret(id)) fs.unlinkSync(secretFile(id));
    if (custom) store.data.customProviders = profiles().filter((item) => item.id !== id);
    credentialsChanged();
  }
  async function discover(input = {}) {
    const api = formats.find(({ id }) => id === input.api)?.id;
    if (!api) throw new Error('Choose an API format.');
    const baseUrl = endpoint(input.baseUrl, api);
    const saved = profiles().find((profile) => profile.id === input.id && baseUrl === profile.baseUrl && api === profile.api);
    const secret = input.noAuth ? undefined : readSecret(input.key) || (saved && getSecret(saved.id));
    if (!input.noAuth && !secret) throw new Error('Enter the API key or select No API key.');
    const headers = {};
    if (api === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01';
      if (secret) headers['x-api-key'] = secret;
    } else if (api === 'google-generative-ai') {
      if (secret) headers['x-goog-api-key'] = secret;
    } else if (secret) headers.Authorization = 'Bearer ' + secret;
    const modelPath = api === 'anthropic-messages' ? '/v1/models' : '/models';
    const response = await fetch(baseUrl + modelPath, { headers, redirect: 'error', signal: AbortSignal.timeout(12000) })
      .catch(() => { throw new Error('Could not reach the model endpoint. Check the base URL or add model IDs manually.'); });
    if (!response.ok) throw new Error('Model listing returned HTTP ' + response.status + '. You can add model IDs manually.');
    const body = await response.json().catch(() => null);
    const discovered = api === 'google-generative-ai'
      ? (body?.models ?? []).filter((model) => model.supportedGenerationMethods?.includes('generateContent')).map((model) => model.name?.replace(/^models\//, ''))
      : (Array.isArray(body?.data) ? body.data : []).map((model) => model.id);
    return [...new Set(discovered.filter((id) => typeof id === 'string' && modelIdPattern.test(id)))].sort().slice(0, 250);
  }
  async function modelFor(reference) {
    const parsed = parseModel(reference);
    if (!parsed) throw new Error('Choose a model.');
    const profile = profiles().find(({ id }) => id === parsed.provider);
    const secret = profile?.noAuth ? localKey : getSecret(parsed.provider);
    const native = (await nativeProviders()).find(({ id }) => id === parsed.provider);
    if (!profile && !native) throw new Error('This model’s provider is unavailable. Choose another model.');
    if (!secret) throw new Error('Connect ' + (profile?.name ?? native?.name) + ' in Settings → Providers.');
    const models = await runtime();
    if (profile) {
      const config = { name: profile.name, api: profile.api, baseUrl: profile.baseUrl,
        models: profile.models.map((id) => ({ id, name: id, input: profile.images ? ['text', 'image'] : ['text'],
        reasoning: profile.reasoning, contextWindow: profile.contextWindow, maxTokens: profile.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) };
      if (profile.noAuth) {
        const { getApiProvider } = await import('@earendil-works/pi-ai/compat');
        const protocol = getApiProvider(profile.api);
        config.streamSimple = (model, context, options) => protocol.streamSimple(model, context, {
          ...options,
          fetch(input, init) {
            const request = new Request(input, init);
            // The SDK needs a credential internally, but this endpoint does not.
            request.headers.delete('authorization');
            request.headers.delete('x-api-key');
            return fetch(request);
          },
        });
      }
      models.registerProvider(profile.id, config);
    }
    const model = models.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error('That model is unavailable. Choose one from the model picker.');
    await models.setRuntimeApiKey(parsed.provider, secret);
    const sanitize = (value) => String(value ?? '').split(secret).join('[redacted key]');
    return { models, model, sanitize };
  }
  return { catalog, list, save, remove, discover, modelFor, status };
}

module.exports = { createProviders };
