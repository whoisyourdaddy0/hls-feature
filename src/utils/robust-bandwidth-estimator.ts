/*
 * Robust Bandwidth Estimator
 *
 * A throughput estimator designed for weak and highly variable networks.
 * It complements `EwmaBandWidthEstimator` with:
 *  - outlier rejection: a single abnormally fast or slow fragment cannot
 *    dominate the estimate (median of a sliding window rather than the mean)
 *  - a guarded startup phase: while too few samples have been collected the
 *    estimate stays close to the conservative default instead of latching
 *    onto the first sample
 *  - trend-aware asymmetric adaptation: a short recent window detects a
 *    sustained degradation quickly (the estimate drops fast), while recovery
 *    is accepted only slowly through the longer-window median and EWMA, so a
 *    transient improvement cannot trigger an up-switch
 */

import EWMA from './ewma';

interface BandwidthSample {
  bps: number;
  durationSec: number;
}

export interface RobustEstimatorConfig {
  // Half-life (in seconds of accumulated sample weight) of the smoothing EWMA
  ewmaHalfLife: number;
  // Maximum number of recent samples retained for the robust long window
  windowSize: number;
  // Number of most-recent samples used to detect a downward trend
  trendWindowSize: number;
  // Number of samples required before the estimate is considered reliable;
  // below this count the default estimate keeps anchoring the result
  minSamples: number;
  // Factor applied to the robust aggregate during startup
  startupFactor: number;
}

export const ROBUST_ESTIMATOR_DEFAULT_CONFIG: RobustEstimatorConfig = {
  ewmaHalfLife: 6,
  windowSize: 20,
  trendWindowSize: 4,
  minSamples: 3,
  startupFactor: 0.85,
};

class RobustBandwidthEstimator {
  private readonly config: RobustEstimatorConfig;
  private readonly defaultEstimate: number;
  private readonly samples: BandwidthSample[] = [];
  private readonly ewma: EWMA;
  private lastRobustBps: number = 0;

  constructor(
    defaultEstimate: number,
    config: Partial<RobustEstimatorConfig> = {},
  ) {
    this.config = { ...ROBUST_ESTIMATOR_DEFAULT_CONFIG, ...config };
    this.defaultEstimate = defaultEstimate;
    this.ewma = new EWMA(this.config.ewmaHalfLife);
    this.lastRobustBps = defaultEstimate;
  }

  /**
   * Record a throughput sample derived from a completed fragment download.
   * @param durationMs download (transfer) time in milliseconds
   * @param numBytes number of bytes transferred
   */
  public sample(durationMs: number, numBytes: number): void {
    if (!Number.isFinite(durationMs) || !Number.isFinite(numBytes)) {
      return;
    }
    const durationSec = Math.max(durationMs, 50) / 1000;
    const bps = (8 * numBytes) / durationSec;
    if (bps <= 0 || !Number.isFinite(bps)) {
      return;
    }
    const { windowSize } = this.config;
    this.samples.push({ bps, durationSec });
    if (this.samples.length > windowSize) {
      this.samples.shift();
    }
    const robust = this.robustAggregate();
    this.lastRobustBps = robust;
    // Weight the EWMA update by the transfer duration, mirroring
    // EwmaBandWidthEstimator so longer fragments carry more weight.
    this.ewma.sample(durationSec, robust);
  }

  /**
   * Robust aggregate for the current window.
   *
   * The long-window median is insensitive to isolated outliers. To avoid
   * treating a genuine, sustained drop as a series of outliers, the recent
   * trend is examined separately: when the short recent-window median is
   * clearly below the long-window median, the lower (recent) value wins so a
   * real degradation is acknowledged quickly. A single isolated slow fragment
   * cannot move the short-window median on its own once it holds a few values.
   */
  private robustAggregate(): number {
    const values = this.samples.map((s) => s.bps);
    const n = values.length;
    const longMedian = median(values);
    if (n < this.config.trendWindowSize) {
      return longMedian;
    }
    const recent = values.slice(-this.config.trendWindowSize);
    const recentMedian = median(recent);
    // Follow the recent window downward only when a strict majority of the
    // recent samples are themselves below the long median. This distinguishes
    // a sustained degradation (most recent samples low) from one or two
    // isolated slow fragments, which cannot form a majority on their own.
    const lowCount = recent.filter((v) => v < longMedian).length;
    if (recentMedian < longMedian && lowCount > recent.length / 2) {
      return recentMedian;
    }
    return longMedian;
  }

  /** Number of samples currently retained in the sliding window. */
  public get sampleCount(): number {
    return this.samples.length;
  }

  /** Whether enough samples have been collected to trust the estimate. */
  public canEstimate(): boolean {
    return this.samples.length >= this.config.minSamples;
  }

  /**
   * Conservative bandwidth estimate in bits per second.
   *
   * During startup the estimate is the smaller of the default estimate and
   * the robust in-window aggregate (scaled by `startupFactor`), which keeps
   * the controller on a safe level even when the very first fragment happens
   * to download quickly. Once the window is warmed up the EWMA of the robust
   * aggregates is used, bounded above by the latest aggregate so the estimate
   * never runs ahead of what the network most recently demonstrated.
   */
  public getEstimate(): number {
    if (!this.canEstimate()) {
      return Math.min(
        this.defaultEstimate,
        this.lastRobustBps * this.config.startupFactor,
      );
    }
    return Math.min(this.ewma.getEstimate(), this.lastRobustBps);
  }

  public destroy(): void {
    this.samples.length = 0;
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export default RobustBandwidthEstimator;
