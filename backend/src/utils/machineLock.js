import { AsyncLocalStorage } from 'node:async_hooks';

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

// Tracks which machineIds are already locked by an ancestor in the current async call chain.
// Without this, a caller that already holds machineId's lock (e.g. POST /stop wrapping
// sendSerialCommand + handleStatusMessage) would deadlock the instant a callee it invokes
// (handleStatusMessage itself) also tried to acquire the same machineId's lock - the inner
// call would queue behind the outer call's own still-pending promise. Making the lock
// reentrant lets every mutation path (handleStatusMessage, handlePulseMessage,
// handleResumeMessage, ensureActiveStatusLog) safely self-lock, so real concurrent callers
// (MQTT publishes, the watchdog, sync, routes) are always serialized per machine even when one
// of them forgets to wrap a call site - the exact gap that used to let two open 'Running' rows
// exist for the same machine at once and surface as duplicate/0s-duration log rows.
const lockContext = new AsyncLocalStorage();

export function withMachineLock(machineId, fn) {
  const held = lockContext.getStore();
  if (held && held.has(machineId)) {
    // Already serialized by an ancestor call further up this same chain - run inline instead
    // of re-queuing behind ourselves.
    return fn();
  }

  const previous = machineLocks.get(machineId) || Promise.resolve();
  const nextHeld = new Set(held);
  nextHeld.add(machineId);
  const run = () => lockContext.run(nextHeld, fn);
  const next = previous.then(run, run).finally(() => {
    if (machineLocks.get(machineId) === next) machineLocks.delete(machineId);
  });
  machineLocks.set(machineId, next);
  return next;
}
