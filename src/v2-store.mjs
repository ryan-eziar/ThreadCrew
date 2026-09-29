import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, realpath, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { Worker } from 'node:worker_threads';

export class V2StorageError extends Error {
  constructor(code, message = code) { super(message); this.name = 'V2StorageError'; this.code = code; }
}

function localDirectory(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value)) {
    throw new V2StorageError('INVALID_INPUT', 'A local runtime directory is required.');
  }
  return resolve(value);
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

/** A single lifetime writer. SQL callbacks run on the parent, statements on a worker. */
export class V2Store {
  #worker; #requests = new Map(); #next = 1; #tail = Promise.resolve();
  #closed = false; #poisoned = false; #lock; #lockIdentity; #lockPath;

  static async open({ runtimeDir } = {}) {
    const directory = localDirectory(runtimeDir);
    await mkdir(directory, { recursive: true });
    const canonical = await realpath(directory);
    if (/^(?:\\\\|\/\/)/.test(canonical)) throw new V2StorageError('JOURNAL_UNSAFE', 'Storage must be local.');
    const store = new V2Store();
    // The v1 journal writer uses this same lifetime lock. A v1 and v2 owner
    // must never operate against the same runtime during cutover.
    store.#lockPath = join(canonical, 'broker-state.lock');
    try { store.#lock = await open(store.#lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new V2StorageError('JOURNAL_LOCKED', 'The v2 dataset already has a writer or needs verified recovery.');
      throw error;
    }
    try {
      store.#lockIdentity = await store.#lock.stat({ bigint: true });
      await store.#lock.writeFile(JSON.stringify({ version: 2, ownerId: randomUUID(), pid: process.pid }) + '\n');
      await store.#lock.sync();
      const dbPath = join(canonical, 'v2-state.sqlite');
      try {
        const stat = await lstat(dbPath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new V2StorageError('JOURNAL_UNSAFE');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      store.#worker = new Worker(new URL('./v2-store-worker.mjs', import.meta.url), { workerData: { path: dbPath }, execArgv: [] });
      store.#worker.on('message', message => {
        const item = store.#requests.get(message.id);
        if (!item) return;
        store.#requests.delete(message.id);
        if (message.ok) item.resolve(message.result);
        else item.reject(new V2StorageError(message.code, message.message));
      });
      store.#worker.on('error', error => store.#failWorker(error));
      store.#worker.on('exit', code => { if (!store.#closed) store.#failWorker(new Error(`SQLite worker exited: ${code}`)); });
      await store.#call('get', 'SELECT name FROM sqlite_master WHERE type=? LIMIT 1', ['table']);
      return store;
    } catch (error) {
      try { await store.#worker?.terminate(); } catch {}
      await store.#release();
      throw error;
    }
  }

  #failWorker(error) {
    this.#poisoned = true;
    for (const item of this.#requests.values()) item.reject(new V2StorageError('RECOVERY_REQUIRED', 'SQLite worker failed.'));
    this.#requests.clear();
  }

  #call(op, sql, params = []) {
    if (this.#poisoned) return Promise.reject(new V2StorageError('RECOVERY_REQUIRED'));
    if (this.#closed) return Promise.reject(new V2StorageError('CLOSED'));
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      this.#requests.set(id, { resolve, reject });
      try { this.#worker.postMessage({ id, op, sql, params }); }
      catch (error) { this.#requests.delete(id); reject(error); }
    });
  }

  #transaction(fn, writable) {
    if (this.#closed) return Promise.reject(new V2StorageError('CLOSED'));
    const execute = async () => {
      await this.#call(writable ? 'begin' : 'readBegin');
      const sql = Object.freeze({
        get: (statement, params = []) => this.#call('get', statement, params),
        all: (statement, params = []) => this.#call('all', statement, params),
        run: (statement, params = []) => {
          if (!writable) throw new V2StorageError('READ_ONLY');
          return this.#call('run', statement, params);
        },
      });
      try {
        const result = await fn(sql);
        await this.#call('commit');
        return result;
      } catch (error) {
        try { await this.#call('rollback'); }
        catch { this.#poisoned = true; throw new V2StorageError('RECOVERY_REQUIRED', 'Rollback failed.'); }
        throw error;
      }
    };
    const task = this.#tail.then(execute);
    this.#tail = task.catch(() => {});
    return task;
  }

  tx(fn) { return this.#transaction(fn, true); }
  read(fn) { return this.#transaction(fn, false); }

  async #release() {
    let unsafe = false;
    try { await this.#lock?.close(); } catch { unsafe = true; }
    if (this.#lockIdentity) {
      try {
        const stat = await lstat(this.#lockPath, { bigint: true });
        if (!sameFile(stat, this.#lockIdentity) || !stat.isFile() || stat.isSymbolicLink()) unsafe = true;
        else await unlink(this.#lockPath);
      } catch { unsafe = true; }
    }
    if (unsafe) throw new V2StorageError('JOURNAL_UNSAFE', 'Writer ownership could not be released safely.');
  }

  async close() {
    if (this.#closed) return;
    await this.#tail;
    try { await this.#call('close'); } finally {
      this.#closed = true;
      try { await this.#worker.terminate(); } catch {}
      await this.#release();
    }
  }
}
