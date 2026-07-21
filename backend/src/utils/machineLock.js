// Single in-process async mutex per machine, shared by every service capable of mutating a
// machine's authoritative state (status, active_schedule_id, active_part_name,
// assigned_operator). This process serves the watchdog's interval ticks, the sync client's
// interval ticks, and every Express route handler - all in one event loop - so serializing
// here is enough to guarantee only one state transition is ever in flight for a given machine
// at a time, with no DB-level locking required.
//
// This does NOT make two different processes (e.g. an Edge Gateway and the Cloud backend)
// agree with each other - they only ever communicate through syncService's HTTP calls, never
// share this lock. What it does guarantee is that within one process, a watchdog tick can never
// interleave with a resume request, a stop request, or a sync pull for the same machine and
// leave it in a half-applied state.
const machineLocks = new Map(); // machineId -> Promise chain tail

export function withMachineLock(machineId, fn) {
  const previous = machineLocks.get(machineId) || Promise.resolve();
  const next = previous.then(fn, fn).finally(() => {
    if (machineLocks.get(machineId) === next) machineLocks.delete(machineId);
  });
  machineLocks.set(machineId, next);
  return next;
}
