// Proces stoppen en wachten tot het echt weg is (de server schrijft bij afsluiten nog de database weg).
function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 5000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    proc.kill();
  });
}
const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
module.exports = { stop, rmOpts };
