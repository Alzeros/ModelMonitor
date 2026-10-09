const D = require('better-sqlite3');
const db = new D('data/monitor.db', { readonly: true });
const models = db.prepare('SELECT id, model, enabled, thinking_strength FROM models').all();
console.log('models:', JSON.stringify(models));
const cfg = db
  .prepare(
    'SELECT m.id, m.model, m.enabled, m.thinking_strength, p.enabled AS provider_enabled FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = 1'
  )
  .get();
console.log('cfg(1):', JSON.stringify(cfg));
