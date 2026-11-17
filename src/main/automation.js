const { redact } = require('./agent-common');
const { randomUUID } = require('node:crypto');
const fileTools = ['read', 'grep', 'find', 'ls'];

function nextRun(task, after = Date.now()) {
  const [hour, minute] = task.time.split(':').map(Number);
  const day = new Date(after);
  day.setHours(hour, minute, 0, 0);
  for (let offset = 0; offset < 8; offset += 1) {
    const weekDay = day.getDay();
    const allowed = task.frequency === 'daily'
      || (task.frequency === 'weekdays' && weekDay >= 1 && weekDay <= 5)
      || (task.frequency === 'weekly' && weekDay === task.weekday);
    if (allowed && day.getTime() > after) return day.getTime();
    day.setDate(day.getDate() + 1);
    day.setHours(hour, minute, 0, 0);
  }
  throw new Error('Invalid schedule.');
}

function createAutomation(store, turns, { runs, workspaceDirectory, inbox, integrations, now = Date.now, interval = 15000 } = {}) {
  const get = (id) => {
    const task = store.data.automations.find((item) => item.id === id);
    if (!task) throw new Error('Automation not found.');
    return task;
  };

  function save(input) {
    if (typeof input.name !== 'string' || typeof input.prompt !== 'string') throw new Error('Enter a name and instructions.');
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const { time, frequency, weekday } = input;
    if (!name || !prompt || name.length > 100 || prompt.length > 20000) throw new Error('Enter a name and instructions.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !['daily', 'weekdays', 'weekly'].includes(frequency)
      || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Choose a valid schedule.');
    const old = input.id ? get(input.id) : null;
    const cwd = input.cwd === undefined ? old?.cwd ?? store.data.cwd : input.cwd || store.data.cwd;
    const tools = input.tools ?? old?.tools ?? fileTools;
    const selected = input.integrations ?? old?.integrations ?? [];
    if (!Array.isArray(tools) || tools.some((tool) => !fileTools.includes(tool))) throw new Error('Choose read-only file tools.');
    if (!Array.isArray(selected) || selected.length > 50 || selected.some((id) => typeof id !== 'string' || id.length > 150)) throw new Error('Choose available integrations.');
    const task = { ...old, id: old?.id ?? randomUUID(), cwd: workspaceDirectory?.(cwd) ?? cwd, paused: old?.paused ?? false,
      name, prompt, time, frequency, weekday, tools: [...new Set(tools)], integrations: [...new Set(selected)],
      includeInbox: (input.includeInbox ?? old?.includeInbox) === true };
    task.nextRunAt = nextRun(task, now());
    if (old) Object.assign(old, task);
    else store.data.automations.unshift(task);
    store.activity('automation', (old ? 'Updated ' : 'Scheduled ') + name, frequency + ' at ' + time, { type: 'automation', id: task.id });
    return task;
  }

  function setPaused(id, paused) {
    const task = get(id);
    task.paused = Boolean(paused);
    task.nextRunAt = nextRun(task, now());
    store.activity('automation', (task.paused ? 'Paused ' : 'Resumed ') + task.name, '');
  }

  function run(id, scheduled = false) {
    const task = get(id);
    const scheduledAt = scheduled ? task.nextRunAt : undefined;
    const occurrence = scheduled ? task.id + ':' + scheduledAt : undefined;
    // The durable occurrence claim also covers a crash before the next date was saved.
    const existing = occurrence && runs.findOccurrence(occurrence);
    if (existing) {
      task.nextRunAt = nextRun(task, now());
      store.update();
      return store.session(runs.get(existing).sessionId);
    }
    if (runs.activeAutomation(id)) throw new Error('This automation already has a working or queued run.');
    const session = store.addSession(task.cwd ?? store.data.cwd, task.name, true);
    const recorded = turns.submit(session.id, task.prompt, {
      tools: task.tools ?? fileTools, integrations: task.integrations ?? [], includeInbox: task.includeInbox,
    }, { defer: true, title: task.name, automationId: task.id, trigger: scheduled ? 'scheduled' : 'automation', occurrence, scheduledAt });
    task.lastRunAt = now();
    task.lastSession = session.id;
    task.lastRunId = recorded.id;
    task.lastFailure = '';
    if (scheduled) task.nextRunAt = nextRun(task, task.lastRunAt);
    store.update();
    turns.resume(session.id);
    return session;
  }

  function tick() {
    const current = now();
    for (const task of store.data.automations) {
      if (task.paused || task.nextRunAt > current) continue;
      const recorded = runs.findOccurrence(task.id + ':' + task.nextRunAt);
      if (!recorded && runs.activeAutomation(task.id)) continue;
      try { run(task.id, true); }
      catch (error) {
        task.nextRunAt = nextRun(task, current);
        task.lastFailure = redact(error.message).slice(0, 250);
        store.activity('automation', 'Could not schedule ' + task.name, task.lastFailure, { type: 'automation', id: task.id });
      }
    }
  }

  async function prepare(run, options, signal) {
    if (!run.automationId) return;
    const task = get(run.automationId);
    if (task.paused && run.trigger === 'scheduled') throw new Error('The scheduled task is paused.');
    workspaceDirectory?.(run.workspace);
    const available = integrations?.list() ?? [];
    const blocked = options.integrations?.find((id) => !available.some((item) => item.id === id && item.enabled && item.availableForAutomation));
    if (blocked) throw new Error('A selected integration is unavailable or no longer allowed for automations. Open the task to review its tools.');
    if (!options.includeInbox) return;
    if (!task.includeInbox) throw new Error('The task no longer has inbox access. Start a new run from the automation.');
    try {
      return { context: [...options.context, await inbox.briefingContext(signal)] };
    } catch (error) {
      if (['disconnected', 'reauthenticate', 'unavailable'].includes(error.status)) {
        runs.annotate(run.id, { attentionTarget: { type: 'inbox' } });
      }
      throw error;
    }
  }

  function finish(run) {
    if (!run.automationId) return;
    const task = store.data.automations.find((item) => item.id === run.automationId && item.lastRunId === run.id);
    if (!task) return;
    task.lastFailure = run.error?.slice(0, 250) ?? '';
    store.update();
  }

  const timer = interval > 0 ? setInterval(tick, interval) : null;
  timer?.unref();

  return {
    save, setPaused, run, tick, prepare, finish,
    remove(id) {
      const task = get(id);
      store.data.automations = store.data.automations.filter((item) => item.id !== id);
      store.activity('automation', 'Removed ' + task.name, '');
    },
    dispose: () => clearInterval(timer),
  };
}

module.exports = { createAutomation, nextRun };
