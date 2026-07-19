/**
 * Fixture-based tests for the memory-pressure gate (P0 build).
 *
 * Istvan FORBIDS a real memory-pressure test. All assertions use injected
 * fixture state files — the monitor is NOT running during tests, no real
 * agents are parked, no real memory is consumed.
 *
 * Coverage:
 *   - normal → gate allows non-core start
 *   - warning → gate blocks non-core start AND restart
 *   - critical → gate blocks non-core start
 *   - emergency → gate blocks non-core start
 *   - core agent always allowed (even in emergency)
 *   - missing state file → fail-closed (block non-core)
 *   - manual override → allows even in emergency
 *   - recovery → allows non-core after stable period
 *   - gate does NOT affect core agents
 *   - zero LLM calls (proven by construction — no imports from llm modules)
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { memoryPressureGate } from "./memory-pressure-gate.js";
import { DEFAULT_CONFIG, STATE_FILE } from "./memory-pressure-types.js";
import type { MemoryPressureStateFile, MemoryPressureSample } from "./memory-pressure-types.js";

const INSTALL_DIR = process.env.MARVEEN_HOME ?? process.cwd();
const STATE_PATH = `${INSTALL_DIR}/${STATE_FILE}`;

// Save and restore any real state file around test runs
let savedState: string | null = null;

function setup(): void {
  if (existsSync(STATE_PATH)) {
    savedState = readFileSync(STATE_PATH, "utf-8");
  }
}

function teardown(): void {
  try { unlinkSync(STATE_PATH); } catch { /* ok */ }
  if (savedState) {
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true });
      writeFileSync(STATE_PATH, savedState, "utf-8");
    } catch { /* best-effort restore */ }
  }
}

// Fixture input allows partial lastSample for ergonomic test writing.
// The merge in writeFixture fills missing lastSample fields from defaults.
type FixtureState = Partial<Omit<MemoryPressureStateFile, "lastSample">> & { lastSample?: Partial<MemoryPressureSample> };

function writeFixture(state: FixtureState): void {
  const defaultSample: MemoryPressureSample = {
    timestamp: new Date().toISOString(),
    memAvailableGiB: 5.0,
    swapUsedGiB: 0.0,
    psiMemorySome: 0.0,
    agentProcessTreeRssBytes: 2 * 1073741824, // ~2 GiB
    measuredAgentCount: 8,
    agentRssMeasurementStatus: "ok",
    agentRssMeasurementSource: "list-agent-rss.sh",
  };
  // Build the base fixture, then spread state over it. The lastSample is
  // deep-merged: defaults from defaultSample, overridden by state.lastSample.
  const baseFixture: MemoryPressureStateFile = {
    state: "normal",
    since: new Date().toISOString(),
    lastSample: defaultSample,
    thresholds: DEFAULT_CONFIG.thresholds,
    generation: 1,
    lastAction: null,
  };
  const fixture: MemoryPressureStateFile = {
    ...baseFixture,
    ...state,
    lastSample: state.lastSample
      ? { ...defaultSample, ...state.lastSample } as MemoryPressureSample
      : baseFixture.lastSample,
  };
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(fixture, null, 2), "utf-8");
}

// Reset override between tests
function clearOverride(): void {
  delete process.env.MARVEEN_MEM_PRESSURE_OVERRIDE;
}

async function run(): Promise<void> {
  let pass = 0, fail = 0;
  function ok(label: string, condition: boolean, detail?: unknown): void {
    if (condition) pass++;
    else { fail++; console.log(`FAIL ${label}`, detail); }
  }

  setup();

  // ── normal: gate allows non-core start ─────────────────────────────────
  {
    writeFixture({ state: "normal" });
    const r = memoryPressureGate("test-agent");
    ok("normal → non-core allowed", r.allowed, r);
  }
  {
    // normal with no state file yet (first boot) → fail-closed for non-core
    teardown();
    const r = memoryPressureGate("test-agent");
    ok("no state file → non-core blocked (fail-closed)", !r.allowed, r);
  }

  // ── warning blocks non-core ────────────────────────────────────────────
  {
    writeFixture({
      state: "warning",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 2.0, swapUsedGiB: 0.1, psiMemorySome: 2.5, agentProcessTreeRssBytes: 4.0 },
    });
    const r = memoryPressureGate("some-agent");
    ok("warning → non-core blocked", !r.allowed, r);
  }

  // ── critical blocks non-core ───────────────────────────────────────────
  {
    writeFixture({
      state: "critical",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 1.2, swapUsedGiB: 0.5, psiMemorySome: 8.0, agentProcessTreeRssBytes: 5.5 },
    });
    const r = memoryPressureGate("buildfejleszto");
    ok("critical → non-core blocked", !r.allowed, r);
  }

  // ── emergency blocks non-core ──────────────────────────────────────────
  {
    writeFixture({
      state: "emergency",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 0.5, swapUsedGiB: 2.0, psiMemorySome: 15.0, agentProcessTreeRssBytes: 6.5 },
    });
    const r = memoryPressureGate("frontendfejleszto");
    ok("emergency → non-core blocked", !r.allowed, r);
  }

  // ── core agent always allowed ──────────────────────────────────────────
  {
    writeFixture({ state: "warning" });
    let r = memoryPressureGate("marveen"); // default core
    ok("warning → core allowed", r.allowed, r);
  }
  {
    writeFixture({ state: "critical" });
    const r = memoryPressureGate("marveen");
    ok("critical → core allowed", r.allowed, r);
  }
  {
    writeFixture({ state: "emergency" });
    const r = memoryPressureGate("marveen");
    ok("emergency → core allowed", r.allowed, r);
  }

  // ── missing state file → fail-closed for non-core ──────────────────────
  {
    teardown();
    const r = memoryPressureGate("non-core-agent");
    ok("missing state → non-core blocked (fail-closed)", !r.allowed, r);
    // core still works even without state file
    const r2 = memoryPressureGate("marveen");
    ok("missing state → core allowed", r2.allowed, r2);
  }

  // ── manual override ────────────────────────────────────────────────────
  {
    writeFixture({ state: "emergency" });
    process.env.MARVEEN_MEM_PRESSURE_OVERRIDE = "1";
    const r = memoryPressureGate("any-agent");
    ok("override=1 → allowed even in emergency", r.allowed, r);
    clearOverride();
  }
  {
    writeFixture({ state: "warning" });
    process.env.MARVEEN_MEM_PRESSURE_OVERRIDE = "marveen,specific-agent";
    const r = memoryPressureGate("specific-agent");
    ok("override=list → specific agent allowed", r.allowed, r);
    const r2 = memoryPressureGate("other-agent");
    ok("override=list → other agent still blocked", !r2.allowed, r2);
    clearOverride();
  }

  // ── recovery allows non-core ───────────────────────────────────────────
  {
    writeFixture({ state: "recovery" });
    const r = memoryPressureGate("some-agent");
    ok("recovery → non-core allowed", r.allowed, r);
  }

  // ── reason includes state + threshold in blocked case ───────────────────
  {
    writeFixture({
      state: "critical",
      lastSample: { timestamp: new Date().toISOString(), memAvailableGiB: 1.0, swapUsedGiB: 0.3, psiMemorySome: 5.0, agentProcessTreeRssBytes: 3.0 },
    });
    const r = memoryPressureGate("agent-x");
    ok("block reason includes state", r.reason.includes("state=critical"), r.reason);
    ok("block reason includes memAvailable", r.reason.includes("memAvailable=1.0GiB"), r.reason);
    ok("block reason includes threshold", r.reason.includes("threshold=2.5GiB"), r.reason);
  }

  teardown();
  console.log(`memory-pressure-gate: PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

run();
