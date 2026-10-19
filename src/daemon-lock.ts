// One daemon per STAM_HOME (S-346). A second daemon on the same home boots against the live
// state: it marks agents shut down and starts duplicate harnesses. So runDaemon takes a lock
// before it touches the DB or tmux. The lock is a Linux abstract unix socket named for the home,
// held by the kernel: it goes when the process dies, however it dies, so there is no file to go
// stale, no pid to check and no takeover race. The holder answers connections with its pid, so
// a refusal can name it.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { connect, createServer } from 'node:net';

function lockName(home: string): string {
  mkdirSync(home, { recursive: true });
  return `\0stam-daemon-${createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16)}`;
}

// The pid of the daemon that holds the lock, or 0 when it doesn't answer in time.
function holderPid(name: string): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    const s = connect(name);
    const timer = setTimeout(() => finish(0), 2000);
    const finish = (pid: number) => {
      clearTimeout(timer);
      s.destroy();
      resolve(pid);
    };
    s.on('data', (d) => (out += d));
    s.on('end', () => finish(Number(out) || 0));
    s.on('error', () => finish(0));
  });
}

// Takes the home's lock for this process: undefined when taken, or the pid of the daemon that
// holds it (0 if it doesn't say). The lock is held until the process exits.
export function takeDaemonLock(home: string): Promise<number | undefined> {
  const name = lockName(home);
  return new Promise((resolve, reject) => {
    const server = createServer((s) => s.end(`${process.pid}\n`));
    server.once('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') return reject(e);
      holderPid(name).then(resolve);
    });
    server.listen(name, () => {
      // The listening socket stays open with the process; unref'd, it doesn't keep it up on its own.
      server.unref();
      resolve(undefined);
    });
  });
}
