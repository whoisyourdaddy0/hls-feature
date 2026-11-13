/*
 * Offline ABR simulation bench (pure Node, no MSE/browser required).
 *
 * Runs the default hls.js AbrController and the HybridAbrController against
 * the same simulated player model over a set of deterministic network
 * trajectories, and compares:
 *   - number of stalls (rebuffering events)
 *   - total stall time (seconds)
 *   - average rendered bitrate (bits/s)
 *   - number of level switches
 *   - time to first playable frame / startup time (seconds)
 *
 * Usage:  npx tsx scripts/abr_sim.ts
 * Exit code is non-zero when the acceptance criteria are not met.
 */

// Compile-time feature flags and browser globals must be installed before any
// hls.js module is imported. Import hoisting makes an inline setup unsafe, so
// the setup lives in a dedicated module imported first.
import './abr-sim-globals';

import AbrController from '../src/controller/abr-controller';
import HybridAbrController from '../src/controller/hybrid-abr-controller';
import { Level } from '../src/types/level';
import { LevelDetails } from '../src/loader/level-details';
import { Fragment } from '../src/loader/fragment';
import { LoadStats } from '../src/loader/load-stats';
import { hlsDefaultConfig, mergeConfig } from '../src/config';
import { Events } from '../src/events';
import { PlaylistLevelType } from '../src/types/loader';
import type { HlsConfig } from '../src/config';
import type { BufferInfo } from '../src/utils/buffer-helper';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so every run and both controllers see the
// exact same network conditions.
// ---------------------------------------------------------------------------

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type NetworkTrace = {
  name: string;
  isLive: boolean;
  // Bandwidth in bits/s available at simulation time `tSec`.
  bandwidthAt: (tSec: number) => number;
  durationSec: number;
};

// Fixed seed keeps the acceptance run fully reproducible. ABR_SIM_SEED can
// override it (e.g. for multi-seed robustness checks).
const DEFAULT_SEED = 20240517;

const MIN_BW = 60_000;

function clampBw(value: number): number {
  return Math.max(MIN_BW, value);
}

/**
 * Six fixed-seed network trajectories covering the conditions called out in
 * the requirements: stable, staircase, sawtooth, deep-outage recovery,
 * high jitter and live-edge.
 */
function buildTraces(seed: number = DEFAULT_SEED): NetworkTrace[] {
  const rng = createRng(seed);
  // Pre-compute jitter noise so both controllers share identical values even
  // though they run in separate simulations.
  const jitterNoise: number[] = [];
  for (let i = 0; i < 400; i++) {
    jitterNoise.push(0.55 + rng() * 0.9); // 0.55x .. 1.45x
  }
  const noiseAt = (tSec: number) =>
    jitterNoise[Math.floor(tSec * 2) % jitterNoise.length];

  const traces: NetworkTrace[] = [
    {
      name: 'stable',
      isLive: false,
      durationSec: 180,
      bandwidthAt: () => 2_500_000,
    },
    {
      name: 'staircase',
      isLive: false,
      durationSec: 240,
      bandwidthAt: (t) => {
        const step = Math.floor(t / 40) % 5; // 0..4 repeating
        const ladder = [3_000_000, 1_200_000, 4_000_000, 700_000, 2_200_000];
        return ladder[step];
      },
    },
    {
      name: 'sawtooth',
      isLive: false,
      durationSec: 200,
      bandwidthAt: (t) => {
        const phase = (t % 30) / 30; // 0..1 ramp
        return clampBw(150_000 + phase * 3_350_000);
      },
    },
    {
      name: 'deep-outage',
      isLive: false,
      durationSec: 220,
      bandwidthAt: (t) => {
        if (t >= 60 && t < 90) {
          return 80_000; // near-zero throughput for 30s
        }
        if (t >= 90 && t < 110) {
          return 400_000; // slow recovery
        }
        return 2_000_000;
      },
    },
    {
      name: 'high-jitter',
      isLive: false,
      durationSec: 200,
      bandwidthAt: (t) => clampBw(1_800_000 * noiseAt(t)),
    },
    {
      name: 'live-edge',
      isLive: true,
      durationSec: 180,
      bandwidthAt: (t) => {
        // LL-ish live stream: moderate bandwidth with periodic dips, while the
        // available live window stays small.
        const base = 1_600_000;
        const dip = t % 45 < 12 ? 0.45 : 1;
        return clampBw(base * dip * (0.9 + 0.2 * noiseAt(t)));
      },
    },
  ];
  return traces;
}

// ---------------------------------------------------------------------------
// Simulated player model
// ---------------------------------------------------------------------------

const FRAGMENT_DURATION_SEC = 4;
const VOD_LEVEL_BITRATES = [
  150_000, 400_000, 800_000, 1_500_000, 2_800_000, 5_000_000,
];
// Smaller ladder for the live trace (low-latency profiles are typically
// capped lower).
const LIVE_LEVEL_BITRATES = [200_000, 500_000, 900_000, 1_600_000, 3_000_000];

type SimLevel = {
  bitrate: number;
  averageBitrate: number;
  maxBitrate: number;
  name: string;
  videoCodec: string;
  audioCodec: string;
  codecSet: string;
  videoRange: string;
  audioGroupId: undefined;
  details: LevelDetails;
  loadError: number;
  fragmentError: number;
  realBitrate: number;
};

function buildLevels(isLive: boolean): SimLevel[] {
  const bitrates = isLive ? LIVE_LEVEL_BITRATES : VOD_LEVEL_BITRATES;
  const details = new LevelDetails('');
  details.live = isLive;
  details.totalduration = isLive ? 0 : 600;
  details.targetduration = FRAGMENT_DURATION_SEC;
  details.averagetargetduration = FRAGMENT_DURATION_SEC;
  return bitrates.map((bitrate, index) => ({
    bitrate,
    averageBitrate: bitrate,
    maxBitrate: bitrate,
    name: `L${index}`,
    videoCodec: 'avc1',
    audioCodec: 'mp4a',
    codecSet: 'avc1,mp4a',
    videoRange: 'SDR',
    audioGroupId: undefined,
    details,
    loadError: 0,
    fragmentError: 0,
    realBitrate: 0,
  }));
}

type SimMetrics = {
  stalls: number;
  stallTimeSec: number;
  switches: number;
  startupTimeSec: number;
  renderedBitrateWeighted: number;
  renderedDurationSec: number;
  averageBitrate: number;
};

type Listener = (event: string, data: any) => void;

/**
 * Minimal Hls surface exercised by the real AbrController and by
 * HybridAbrController. It carries the real merged hls.js config so every
 * `abrEwma` and `maxStarvationDelay` setting behaves as in production.
 */
class MockHls {
  public config: HlsConfig;
  public levels: SimLevel[];
  public allAudioTracks: any[] = [];
  public minAutoLevel: number = 0;
  public maxAutoLevel: number;
  public loadLevel: number = -1;
  public firstLevel: number = 0;
  public autoLevelCapping: number = -1;
  public manualLevel: number = -1;
  public media: { paused: boolean; playbackRate: number; readyState: number } =
    {
      paused: false,
      playbackRate: 1,
      readyState: 4,
    };
  private bufferLenSec: number = 0;
  private readonly listeners = new Map<string, Set<[Listener, unknown]>>();
  private virtualNowMs: number = 0;
  private readonly intervals = new Map<number, () => void>();
  private intervalId: number = 1;

  constructor(levels: SimLevel[], isLive: boolean) {
    this.levels = levels as unknown as Level[] as SimLevel[];
    this.maxAutoLevel = levels.length - 1;
    this.config = mergeConfig(hlsDefaultConfig, {
      abrEwmaDefaultEstimate: 500_000,
      useMediaCapabilities: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
    });
    if (isLive) {
      // Keep the live window tight: max latency is 6 fragments (~24s).
      this.config.liveSyncDurationCount = 3;
      this.config.liveMaxLatencyDurationCount = 6;
    }
  }

  // -- event emitter surface (subset of the real Hls API) ------------------

  on(event: string, listener: Listener, context?: unknown): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add([listener, context]);
  }

  off(event: string, listener: Listener): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const entry of set) {
      if (entry[0] === listener) {
        set.delete(entry);
      }
    }
  }

  trigger(event: string, data: unknown): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const [listener, context] of [...set]) {
      listener.call(context, event, data);
    }
  }

  // -- timing surface -------------------------------------------------------

  setNow(sec: number): void {
    this.virtualNowMs = sec * 1000;
  }

  get mainForwardBufferInfo(): BufferInfo | null {
    return {
      len: this.bufferLenSec,
      start: 0,
      end: this.bufferLenSec,
      nextStart: undefined,
    };
  }

  setBufferLen(sec: number): void {
    this.bufferLenSec = Math.max(0, sec);
  }

  get autoLevelEnabled(): boolean {
    return this.manualLevel === -1;
  }

  // The real AbrController uses self.setInterval for its abandonment watcher.
  // Provide an in-memory timer registry the simulation can drive deterministically.
  registerTimer(callback: () => void): number {
    const id = this.intervalId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearTimer(id: number): void {
    this.intervals.delete(id);
  }

  get activeTimers(): number {
    return this.intervals.size;
  }

  runTimers(): void {
    for (const callback of [...this.intervals.values()]) {
      callback();
    }
  }
}

// Install in-memory timers used by the real AbrController (_abandonRulesCheck).
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let activeMockHls: MockHls | null = null;
(globalThis as any).setInterval = (callback: () => void) => {
  if (activeMockHls) {
    return activeMockHls.registerTimer(callback) as unknown as NodeJS.Timeout;
  }
  return originalSetInterval(callback, 100);
};
(globalThis as any).clearInterval = (id: number) => {
  if (activeMockHls) {
    activeMockHls.clearTimer(id);
    return;
  }
  originalClearInterval(id);
};

// performance.now is driven by the simulation clock.
let performanceNowMs = 0;
(globalThis as any).performance = {
  ...performance,
  now: () => performanceNowMs,
};

type ControllerCtor = typeof AbrController;

function makeFragment(
  levelIndex: number,
  sn: number,
  bytes: number,
  loadingStartSec: number,
  firstByteSec: number,
  loadingEndSec: number,
): Fragment {
  const frag = new Fragment(PlaylistLevelType.MAIN, '');
  frag.level = levelIndex;
  frag.sn = sn;
  frag.duration = FRAGMENT_DURATION_SEC;
  frag.url = `sim://${levelIndex}/${sn}`;
  const stats = new LoadStats();
  stats.loaded = bytes;
  stats.total = bytes;
  stats.loading = {
    start: loadingStartSec * 1000,
    first: firstByteSec * 1000,
    end: loadingEndSec * 1000,
  };
  stats.parsing = {
    start: loadingEndSec * 1000,
    end: loadingEndSec * 1000 + 5,
  };
  frag.stats = stats;
  return frag;
}

function runSimulation(
  ControllerCtor: ControllerCtor,
  trace: NetworkTrace,
): SimMetrics {
  const levels = buildLevels(trace.isLive);
  const hls = new MockHls(levels, trace.isLive);
  activeMockHls = hls;
  const controller = new ControllerCtor(hls as any);
  performanceNowMs = 0;

  hls.trigger(Events.MANIFEST_LOADING, { url: '' });

  const metrics: SimMetrics = {
    stalls: 0,
    stallTimeSec: 0,
    switches: 0,
    startupTimeSec: -1,
    renderedBitrateWeighted: 0,
    renderedDurationSec: 0,
    averageBitrate: 0,
  };

  let simTime = 0;
  let bufferSec = 0;
  let sn = 0;
  let previousLevel = -1;
  // Live streams only keep a short window; cap buffered content accordingly.
  const liveWindowSec = trace.isLive
    ? hls.config.liveMaxLatencyDurationCount * FRAGMENT_DURATION_SEC
    : Infinity;

  while (simTime < trace.durationSec) {
    performanceNowMs = simTime * 1000;
    hls.setNow(simTime);
    hls.setBufferLen(bufferSec);

    // Ask the controller which level to load next.
    const requestedLevel = controller.nextAutoLevel;
    if (requestedLevel !== previousLevel) {
      if (previousLevel !== -1) {
        metrics.switches += 1;
        if (process.env.SWITCH_DEBUG) {
          console.log(
            `[${trace.name}:${ControllerCtor.name}] t=${simTime.toFixed(1)} switch -> L${requestedLevel}`,
          );
        }
      }
      hls.trigger(Events.LEVEL_SWITCHING, {
        level: requestedLevel,
      });
      previousLevel = requestedLevel;
    }
    hls.loadLevel = requestedLevel;

    // Attempt to download one fragment. The (real) AbrController's emergency
    // abandonment watcher may abort it mid-flight; in that case the forced
    // next level is lower and we restart the same sequence number at it.
    let completedLevel = requestedLevel;
    let emergencyAborted = false;
    const loadingStart = simTime;
    let firstByte = simTime + 0.05;
    let downloaded = 0;
    const startBytes =
      (levels[requestedLevel].bitrate * FRAGMENT_DURATION_SEC) / 8;
    let fragBytes = startBytes;
    let loadingFrag = makeFragment(
      requestedLevel,
      sn,
      fragBytes,
      loadingStart,
      firstByte,
      simTime,
    );

    hls.on(Events.FRAG_LOAD_EMERGENCY_ABORTED, () => {
      emergencyAborted = true;
    });

    while (downloaded < fragBytes && simTime < trace.durationSec) {
      const bw = trace.bandwidthAt(simTime);
      downloaded += (bw / 8) * 0.1;
      simTime += 0.1;
      performanceNowMs = simTime * 1000;
      hls.setNow(simTime);
      hls.setBufferLen(Math.max(0, bufferSec - (simTime - loadingStart)));
      // Announce the in-flight fragment, then run the 100ms abandonment
      // watcher the real player would fire on an interval.
      loadingFrag.stats.loaded = downloaded;
      loadingFrag.stats.total = fragBytes;
      hls.trigger(Events.FRAG_LOADING, {
        frag: loadingFrag,
        part: undefined,
        targetBufferTime: null,
      });
      hls.runTimers();
      if (emergencyAborted) {
        break;
      }
    }

    if (emergencyAborted) {
      // The controller forced a lower level. Restart this sequence number at
      // the newly selected (lower) level, discarding the partial download.
      const downLevel = controller.nextAutoLevel;
      if (downLevel !== previousLevel) {
        metrics.switches += 1;
        hls.trigger(Events.LEVEL_SWITCHING, {
          level: downLevel,
        });
        previousLevel = downLevel;
      }
      hls.loadLevel = downLevel;
      completedLevel = downLevel;
      const retryStart = simTime;
      firstByte = simTime + 0.05;
      downloaded = 0;
      fragBytes = (levels[downLevel].bitrate * FRAGMENT_DURATION_SEC) / 8;
      loadingFrag = makeFragment(
        downLevel,
        sn,
        fragBytes,
        retryStart,
        firstByte,
        simTime,
      );
      emergencyAborted = false;
      while (downloaded < fragBytes && simTime < trace.durationSec) {
        const bw = trace.bandwidthAt(simTime);
        downloaded += (bw / 8) * 0.1;
        simTime += 0.1;
        performanceNowMs = simTime * 1000;
        hls.setNow(simTime);
        hls.setBufferLen(Math.max(0, bufferSec - (simTime - retryStart)));
        loadingFrag.stats.loaded = downloaded;
        loadingFrag.stats.total = fragBytes;
        hls.trigger(Events.FRAG_LOADING, {
          frag: loadingFrag,
          part: undefined,
          targetBufferTime: null,
        });
        hls.runTimers();
        if (emergencyAborted) {
          // A second abort: keep the controller's forced level and continue.
          break;
        }
      }
      if (emergencyAborted) {
        completedLevel = controller.nextAutoLevel;
      }
    }

    const loadingEnd = simTime;
    const finalBytes =
      (levels[completedLevel].bitrate * FRAGMENT_DURATION_SEC) / 8;
    const frag = makeFragment(
      completedLevel,
      sn,
      finalBytes,
      loadingStart,
      firstByte,
      loadingEnd,
    );

    // Fragment downloaded: feed both events the controllers listen to.
    hls.trigger(Events.FRAG_LOADED, {
      frag,
      part: null,
      payload: new ArrayBuffer(0),
      networkDetails: null,
    });
    hls.trigger(Events.FRAG_BUFFERED, {
      frag,
      part: null,
      stats: frag.stats,
      id: 'main',
    });

    // Append to buffer (capped for live windows).
    bufferSec = Math.min(bufferSec + FRAGMENT_DURATION_SEC, liveWindowSec);

    // Playback / stall model: consume the buffer in real time. Download time
    // already elapsed above, so account for playback that happened meanwhile.
    const downloadDuration = loadingEnd - loadingStart;
    if (metrics.startupTimeSec < 0) {
      metrics.startupTimeSec = loadingEnd;
    }
    if (bufferSec <= downloadDuration) {
      // The download outran playback: stall for the uncovered time.
      const stall = downloadDuration - bufferSec;
      metrics.stalls += 1;
      metrics.stallTimeSec += stall;
      bufferSec = 0;
    } else {
      bufferSec -= downloadDuration;
    }
    const renderedBitrate = levels[completedLevel].bitrate;
    metrics.renderedBitrateWeighted += renderedBitrate * FRAGMENT_DURATION_SEC;
    metrics.renderedDurationSec += FRAGMENT_DURATION_SEC;
    sn += 1;
  }

  metrics.averageBitrate =
    metrics.renderedDurationSec > 0
      ? metrics.renderedBitrateWeighted / metrics.renderedDurationSec
      : 0;
  controller.destroy();
  activeMockHls = null;
  return metrics;
}

// ---------------------------------------------------------------------------
// Reporting and acceptance evaluation
// ---------------------------------------------------------------------------

type Row = {
  trace: string;
  controller: string;
  stalls: number;
  stallTime: number;
  avgBitrate: number;
  switches: number;
  startup: number;
};

function formatRow(row: Row): string {
  return [
    row.trace.padEnd(12),
    row.controller.padEnd(10),
    String(row.stalls).padStart(6),
    row.stallTime.toFixed(2).padStart(9),
    Math.round(row.avgBitrate / 1000)
      .toString()
      .padStart(9),
    String(row.switches).padStart(9),
    row.startup.toFixed(2).padStart(8),
  ].join(' ');
}

function main(): void {
  const seed = process.env.ABR_SIM_SEED
    ? Number(process.env.ABR_SIM_SEED)
    : DEFAULT_SEED;
  const traces = buildTraces(seed);
  const rows: Row[] = [];
  const results = new Map<
    string,
    { default: SimMetrics; hybrid: SimMetrics }
  >();

  for (const trace of traces) {
    const defaultMetrics = runSimulation(AbrController, trace);
    const hybridMetrics = runSimulation(HybridAbrController, trace);
    results.set(trace.name, { default: defaultMetrics, hybrid: hybridMetrics });
    rows.push({
      trace: trace.name,
      controller: 'default',
      stalls: defaultMetrics.stalls,
      stallTime: defaultMetrics.stallTimeSec,
      avgBitrate: defaultMetrics.averageBitrate,
      switches: defaultMetrics.switches,
      startup: defaultMetrics.startupTimeSec,
    });
    rows.push({
      trace: trace.name,
      controller: 'hybrid',
      stalls: hybridMetrics.stalls,
      stallTime: hybridMetrics.stallTimeSec,
      avgBitrate: hybridMetrics.averageBitrate,
      switches: hybridMetrics.switches,
      startup: hybridMetrics.startupTimeSec,
    });
  }

  const header = [
    'trace'.padEnd(12),
    'controller'.padEnd(10),
    'stalls'.padStart(6),
    'stall(s)'.padStart(9),
    'kbps'.padStart(9),
    'switches'.padStart(9),
    'start(s)'.padStart(8),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(formatRow(row));
  }
  console.log('');

  // Acceptance: on every trace the hybrid controller must be no worse than the
  // default on total stall time and switch count, and must not give up more
  // than 10% average bitrate.
  const TOLERANCE = 0.1;
  let allPass = true;
  console.log('Acceptance checks (hybrid vs default):');
  for (const trace of traces) {
    const { default: d, hybrid: h } = results.get(trace.name)!;
    const failures: string[] = [];
    if (h.stallTimeSec > d.stallTimeSec + 0.01) {
      failures.push(
        `stall time ${h.stallTimeSec.toFixed(2)}s > ${d.stallTimeSec.toFixed(2)}s`,
      );
    }
    if (h.switches > d.switches) {
      failures.push(`switches ${h.switches} > ${d.switches}`);
    }
    const bitrateDrop =
      (d.averageBitrate - h.averageBitrate) / d.averageBitrate;
    if (bitrateDrop > TOLERANCE) {
      failures.push(
        `avg bitrate drop ${(bitrateDrop * 100).toFixed(1)}% > 10%`,
      );
    }
    const status =
      failures.length === 0 ? 'PASS' : `FAIL (${failures.join('; ')})`;
    if (failures.length > 0) {
      allPass = false;
    }
    console.log(`  ${trace.name.padEnd(12)} ${status}`);
  }

  console.log('');
  console.log(allPass ? 'RESULT: PASS' : 'RESULT: FAIL');
  if (!allPass) {
    process.exitCode = 1;
  }
}

main();
