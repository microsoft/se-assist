'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');

function makeRosterDb(t) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  let depth = 0;
  const db = {
    prepare: sql => raw.prepare(sql),
    exec: sql => raw.exec(sql),
    pragma(directive, options) {
      if (options?.simple) return Object.values(raw.prepare(`PRAGMA ${directive}`).get())[0];
      raw.exec(`PRAGMA ${directive}`);
    },
    transaction(fn) {
      return (...args) => {
        const name = `roster_${depth++}`;
        raw.exec(`SAVEPOINT ${name}`);
        try {
          const result = fn(...args);
          raw.exec(`RELEASE ${name}`);
          return result;
        } catch (error) {
          raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
          throw error;
        } finally { depth--; }
      };
    },
  };
  db.exec('PRAGMA foreign_keys = ON');
  const filename = path.join(__dirname, '..', '..', '..', 'sqlite-ipc.js');
  const requireLocal = createRequire(filename);
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,console) { ${fs.readFileSync(filename, 'utf8')}\n})`);
  load(name => {
    if (name === 'electron') return {};
    if (name === 'better-sqlite3') return function () {};
    if (name === './services/db-backup') return {};
    return requireLocal(name);
  }, module, module.exports, path.dirname(filename), { ...console, log() {} });
  module.exports.initSchema(db);
  return db;
}

module.exports = { makeRosterDb };
