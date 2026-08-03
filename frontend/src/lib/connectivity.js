// Shared connectivity guard for machines with no ESP32/Raspberry Pi wired up yet, or that have
// lost signal past their heartbeat timeout. calculateOEE() (backend) returns `metrics.connected
// === false` (not merely 0%) for exactly these machines - any place that renders an OEE gauge,
// Running/Stopped state, or feeds a fleet-wide average must check this first, per the "Not
// Connected machines must never show a fabricated production state" requirement.
export function isConnected(machine) {
  return machine?.metrics?.connected !== false;
}
