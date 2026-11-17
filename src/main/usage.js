const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./store');

const AUTO_MODEL = '@workbench/auto';
const harnessIds = new Set(['pi', 'opencode', 'hermes', 'codex', 'claude', 'acp']);
const matches = new Set(['any', 'images', 'long', 'short', 'contains']);
const empty = () => ({ turns: 0, measured: 0, input: 0, output: 0, tokens: 0, costUsd: 0, priced: 0 });
const monthKey = (today = new Date()) => [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0')].join('-');
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function limits(input = {}) {
  if (input == null || typeof input !== 'object') throw new Error('Enter valid usage limits.');
  const values = {};
  for (const field of ['turns', 'tokens']) {
    const value = input[field];
    if (value == null || value === 0) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000_000) throw new Error('Usage limits must be whole numbers greater than zero.');
    values[field] = value;
  }
  return values;
}

function createUsage({ store, subscriptionStatus }) {
  const ledgerPath = path.join(store.root, 'usage.json');
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }

  const config = () => store.data.routing ?? { rules: [], limits: {} };
  const current = () => ledger[monthKey()] || {};
  const allowances = new Map();
  function totals() {
    return Object.values(current()).reduce((total, row) => {
      for (const key of Object.keys(total)) total[key] += row[key] || 0;
      return total;
    }, empty());
  }

  function snapshot() {
    const total = totals();
    const { rules, limits } = config();
    return {
      period: monthKey(), total, limits, rules,
      rows: Object.values(current()).sort((a, b) => b.turns - a.turns || b.tokens - a.tokens),
      allowances: [...allowances.values()].flat().filter((item) => !item.resetsAt || item.resetsAt > Date.now()),
      remaining: Object.fromEntries(Object.entries(limits).map(([field, limit]) => [field, Math.max(0, limit - total[field])])),
    };
  }

  function record({ harness, model, provider, usage }) {
    const month = monthKey();
    const key = JSON.stringify([harness, model]);
    const rows = ledger[month] ??= {};
    const row = rows[key] ??= { ...empty(), harness, model, provider: provider || harness };
    row.turns += 1;
    const input = number(usage?.input);
    const output = number(usage?.output);
    const tokens = number(usage?.total) ?? (input == null && output == null ? null : (input || 0) + (output || 0));
    if (tokens != null) {
      row.measured += 1;
      row.input += input || 0;
      row.output += output || 0;
      row.tokens += tokens;
    }
    const cost = number(usage?.costUsd);
    if (cost != null) { row.costUsd += cost; row.priced += 1; }
    for (const old of Object.keys(ledger).sort().slice(0, -12)) delete ledger[old];
    atomicWrite(ledgerPath, JSON.stringify(ledger, null, 2));
    store.scheduleUpdate();
  }

  function check() {
    const total = totals();
    for (const [field, limit] of Object.entries(config().limits)) {
      if (total[field] >= limit) throw new Error('Workbench reached its monthly ' + (field === 'turns' ? 'turn' : 'token') + ' limit. Change the limit in Settings → Usage.');
    }
  }

  function choose({ harness, catalog, prompt = '', images = 0, context = 0 }) {
    const modelIndex = new Map(catalog.models.map((model) => [model.id, model]));
    const size = prompt.length + context;
    const lowered = prompt.toLowerCase();
    function match(rule) {
      if (rule.match === 'images') return images > 0;
      if (rule.match === 'long') return size >= 6000;
      if (rule.match === 'short') return size < 6000;
      if (rule.match === 'contains') return lowered.includes(rule.contains.toLowerCase());
      return true;
    }
    const rule = config().rules.find((rule) => {
      if (rule.harness !== harness || !match(rule)) return false;
      const model = modelIndex.get(rule.model);
      if (!model || (images && !model.images)) return false;
      const row = current()[JSON.stringify([harness, model.id])] ?? empty();
      return Object.entries(rule.limits).every(([field, limit]) => row[field] < limit);
    });
    if (rule) return { model: rule.model, rule: rule.match };
    const capped = (model) => config().rules.some((rule) => {
      if (rule.harness !== harness || rule.model !== model.id) return false;
      const row = current()[JSON.stringify([harness, model.id])] ?? empty();
      return Object.entries(rule.limits).some(([field, limit]) => row[field] >= limit);
    });
    const available = [modelIndex.get(catalog.defaultModel), ...catalog.models].find((model) =>
      model && model.id !== AUTO_MODEL && (!images || model.images) && !capped(model));
    if (!available) throw new Error(images ? 'Auto routing found no available model that accepts images.' : 'Auto routing found no model within the configured limits.');
    return { model: available.id, rule: 'fallback' };
  }

  function withRouting(catalog, harness) {
    if (!catalog.models.length || !harnessIds.has(harness)) return catalog;
    const ruleExists = config().rules.some((rule) => rule.harness === harness && catalog.models.some((model) => model.id === rule.model));
    if (!ruleExists) return catalog;
    return { ...catalog, models: [{ id: AUTO_MODEL, name: 'Auto route', provider: 'Workbench', images: catalog.models.some((model) => model.images) }, ...catalog.models] };
  }

  function receiveAllowance(provider, rows) {
    allowances.set(provider, rows.map((row) => ({ provider, receivedAt: Date.now(), ...row })));
    store.scheduleUpdate();
  }

  return {
    record, check, choose, withRouting, receiveAllowance,
    handlers: {
      usageSummary: () => snapshot(),
      providerUsage: async () => {
        const response = await subscriptionStatus?.();
        receiveAllowance('OpenCode', Object.entries(response?.go ?? {}).map(([id, meter]) => ({ id,
          percentRemaining: Math.max(0, Math.min(100, 100 - meter.percent)), resetsAt: meter.resetsAt })));
        return response ?? null;
      },
      setUsageLimits: (_, input) => {
        store.data.routing = { ...config(), limits: limits(input) };
        store.update();
        return snapshot();
      },
      setRoutingRules: (_, rules) => {
        if (!Array.isArray(rules) || rules.length > 25) throw new Error('Add up to 25 routing rules.');
        const saved = rules.map((rule) => {
          if (!rule || !harnessIds.has(rule.harness) || !matches.has(rule.match) ||
            typeof rule.model !== 'string' || !rule.model || rule.model.length > 200 || rule.model === AUTO_MODEL) {
            throw new Error('Choose a harness, condition, and model for every rule.');
          }
          const contains = String(rule.contains ?? '').trim().slice(0, 180);
          if (rule.match === 'contains' && !contains) throw new Error('Enter text for the “Contains text” condition.');
          return { harness: rule.harness, model: rule.model, match: rule.match, contains, limits: limits(rule.limits) };
        });
        store.data.routing = { ...config(), rules: saved };
        store.data.harnessCatalogRevision = (store.data.harnessCatalogRevision || 0) + 1;
        store.update();
        return snapshot();
      },
    },
  };
}

function mergeUsage(target, input, output, costUsd, total) {
  if (number(input) != null) target.input = (target.input || 0) + input;
  if (number(output) != null) target.output = (target.output || 0) + output;
  if (number(costUsd) != null) target.costUsd = (target.costUsd || 0) + costUsd;
  if (number(total) != null) target.total = (target.total || 0) + total;
}

module.exports = { AUTO_MODEL, createUsage, mergeUsage };
