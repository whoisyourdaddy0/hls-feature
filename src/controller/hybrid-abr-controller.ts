/*
 * Hybrid ABR Controller
 *
 * An adaptive bitrate controller that combines robust throughput estimation
 * with buffer-water-level based switching rules. It extends the default
 * AbrController (reusing its event handling, forced-level and emergency abort
 * machinery) and replaces only the level-selection policy:
 *
 *  - throughput is estimated with an outlier-rejecting, startup-guarded
 *    RobustBandwidthEstimator
 *  - when the forward buffer is below the safety water level the controller
 *    never switches up, regardless of the bandwidth estimate
 *  - up-switches require hysteresis (bandwidth headroom) and a minimum dwell
 *    time on the current level, plus consecutive confirming samples
 *  - down-switches can be triggered urgently whenever the current bitrate is
 *    no longer supportable, bypassing the dwell timer
 *  - live playback caps the buffer target so it never grows past the live
 *    edge (latency) margin
 *  - only variants sharing the current codec set / video range and audio
 *    group are eligible, so separated audio tracks and multi-audio levels
 *    are never selected accidentally
 */

import AbrController from './abr-controller';
import RobustBandwidthEstimator from '../utils/robust-bandwidth-estimator';
import { PlaylistLevelType } from '../types/loader';
import type Hls from '../hls';
import type {
  FragBufferedData,
  FragLoadedData,
  LevelSwitchingData,
  ManifestLoadingData,
} from '../types/events';
import type { Level } from '../types/level';
import type { Fragment } from '../loader/fragment';

export interface HybridAbrConfig {
  // Forward buffer (seconds) below which an up-switch is forbidden
  bufferSafetyLevel: number;
  // Forward buffer (seconds) below which an urgent down-switch is allowed
  emergencyBufferLevel: number;
  // VOD buffer target in seconds
  vodBufferTarget: number;
  // Minimum time (seconds) spent on a level before an up-switch
  minDwellTime: number;
  // Number of consecutive bandwidth samples that must support an up-switch
  upSwitchConfirmSamples: number;
  // Fraction of the bandwidth estimate that a level must stay below to stay
  // selected (down-switch threshold)
  bandwidthFactor: number;
  // Fraction of the bandwidth estimate that an up-switch candidate must stay
  // below (hysteresis: stricter than bandwidthFactor)
  bandwidthUpFactor: number;
  // An up-switch additionally requires this much spare bandwidth above the
  // candidate bitrate, expressed as a fraction of the candidate bitrate. It
  // keeps the controller from climbing onto a level that only barely fits,
  // which would immediately have to be abandoned on the next dip.
  upSwitchHeadroom: number;
  // Extra margin (seconds) kept between the buffer target and the live edge
  bufferLiveEdgeMargin: number;
}

export const DEFAULT_HYBRID_ABR_CONFIG: HybridAbrConfig = {
  bufferSafetyLevel: 8,
  emergencyBufferLevel: 4,
  vodBufferTarget: 30,
  minDwellTime: 6,
  upSwitchConfirmSamples: 3,
  bandwidthFactor: 0.9,
  bandwidthUpFactor: 0.87,
  upSwitchHeadroom: 0.15,
  bufferLiveEdgeMargin: 2,
};

class HybridAbrController extends AbrController {
  private readonly hybridConfig: HybridAbrConfig;
  private robustEstimator: RobustBandwidthEstimator;
  private currentLevel: number = -1;
  // Media duration (seconds) of fragments buffered while on the current level.
  // Media time, rather than wall-clock time, is used for dwell measurement so
  // that fast downloads on a healthy network still accrue dwell credit.
  private levelDwellMediaSec: number = 0;
  private upSwitchConfirms: number = 0;
  private lastLoadedLevel: number = -1;
  private currentCodecSet: string | undefined;
  private currentVideoRange: string | undefined;
  private currentAudioGroup: string | undefined;
  private isLive: boolean = false;

  constructor(hls: Hls) {
    super(hls);
    this.hybridConfig = {
      ...DEFAULT_HYBRID_ABR_CONFIG,
      ...(hls.config.hybridAbr || {}),
    };
    this.robustEstimator = this.createRobustEstimator();
  }

  private createRobustEstimator(): RobustBandwidthEstimator {
    return new RobustBandwidthEstimator(this.hls.config.abrEwmaDefaultEstimate);
  }

  public resetEstimator(abrEwmaDefaultEstimate?: number) {
    super.resetEstimator(abrEwmaDefaultEstimate);
    this.robustEstimator = new RobustBandwidthEstimator(
      this.hls.config.abrEwmaDefaultEstimate,
    );
    this.upSwitchConfirms = 0;
  }

  protected onManifestLoading(event: unknown, data: ManifestLoadingData): void {
    super.onManifestLoading(event as never, data);
    this.currentLevel = -1;
    this.lastLoadedLevel = -1;
    this.levelDwellMediaSec = 0;
    this.upSwitchConfirms = 0;
    this.currentCodecSet = undefined;
    this.currentVideoRange = undefined;
    this.currentAudioGroup = undefined;
    this.robustEstimator = this.createRobustEstimator();
  }

  protected onLevelSwitching(event: unknown, data: LevelSwitchingData): void {
    super.onLevelSwitching(event as never, data);
    if (this.currentLevel !== data.level) {
      this.currentLevel = data.level;
      this.levelDwellMediaSec = 0;
      this.upSwitchConfirms = 0;
      const level = this.hls.levels[data.level];
      if (level) {
        this.currentCodecSet = level.codecSet;
        this.currentVideoRange = level.videoRange;
        this.currentAudioGroup = level.audioGroupId;
      }
    }
  }

  protected onFragLoaded(event: unknown, data: FragLoadedData): void {
    super.onFragLoaded(event as never, data);
    const { frag } = data;
    if (this.ignoreFrag(frag)) {
      return;
    }
    this.lastLoadedLevel = frag.level;
    this.isLive = !!this.hls.levels[frag.level]?.details?.live;
  }

  protected onFragBuffered(event: unknown, data: FragBufferedData): void {
    super.onFragBuffered(event as never, data);
    const { frag, part, stats } = data;
    if (this.ignoreFrag(frag) || stats.aborted) {
      return;
    }
    const durationMs = part?.stats.loaded
      ? part.stats.parsing.end - part.stats.loading.start
      : stats.parsing.end - stats.loading.start;
    const bytes = part?.stats.loaded ? part.stats.loaded : stats.loaded;
    this.robustEstimator.sample(Math.max(0, durationMs), bytes);
    const fragDuration = part
      ? part.duration
      : Number.isFinite(frag.duration)
        ? frag.duration
        : this.getCurrentFragmentDuration();
    if (frag.level === this.currentLevel) {
      this.levelDwellMediaSec += fragDuration;
    } else {
      this.levelDwellMediaSec = fragDuration;
    }
  }

  private ignoreFrag(frag: Fragment): boolean {
    return frag.type !== PlaylistLevelType.MAIN || frag.sn === 'initSegment';
  }

  /**
   * Buffer level the controller tries to maintain. For live streams the
   * target is derived from the playlist latency configuration and always
   * stays below the live edge margin, so the player cannot buffer past the
   * sliding window.
   */
  public getBufferTarget(): number {
    const { config } = this.hls;
    if (!this.isLive) {
      return this.hybridConfig.vodBufferTarget;
    }
    const fragmentDuration = this.getCurrentFragmentDuration();
    const syncDuration = config.liveSyncDuration
      ? config.liveSyncDuration
      : config.liveSyncDurationCount * fragmentDuration;
    const maxLatency = config.liveMaxLatencyDuration
      ? config.liveMaxLatencyDuration
      : Number.isFinite(config.liveMaxLatencyDurationCount)
        ? config.liveMaxLatencyDurationCount * fragmentDuration
        : syncDuration * 2;
    const edgeLimitedTarget = Math.max(
      fragmentDuration,
      maxLatency - this.hybridConfig.bufferLiveEdgeMargin,
    );
    return Math.min(this.hybridConfig.vodBufferTarget, edgeLimitedTarget);
  }

  private getCurrentFragmentDuration(): number {
    const level =
      this.currentLevel > -1 ? this.hls.levels[this.currentLevel] : undefined;
    return level?.details?.averagetargetduration || 4;
  }

  private getForwardBufferSec(): number {
    const bufferInfo = this.hls.mainForwardBufferInfo;
    const media = this.hls.media;
    const rate = media && media.playbackRate !== 0 ? media.playbackRate : 1;
    return bufferInfo ? bufferInfo.len / Math.abs(rate) : 0;
  }

  private getBandwidthEstimate(): number {
    return this.robustEstimator.canEstimate()
      ? this.robustEstimator.getEstimate()
      : Math.min(
          this.hls.config.abrEwmaDefaultEstimate,
          this.robustEstimator.getEstimate(),
        );
  }

  public get firstAutoLevel(): number {
    const { minAutoLevel, maxAutoLevel } = this.hls;
    const levels = this.hls.levels;
    if (!levels.length) {
      return -1;
    }
    const bandwidth = this.getBandwidthEstimate();
    // Startup: pick the highest level whose bitrate fits the (guarded)
    // estimate scaled by the conservative up-switch factor, restricted to
    // compatible variants. This avoids starting on a high level that the
    // network cannot sustain and reduces the first-fragment rebuffer risk.
    const startupBudget = bandwidth * this.hybridConfig.bandwidthUpFactor;
    let selected = minAutoLevel;
    for (let i = minAutoLevel; i <= maxAutoLevel; i++) {
      const level = levels[i];
      if (!this.isCompatibleVariant(level)) {
        continue;
      }
      if (level.averageBitrate <= startupBudget) {
        selected = i;
      }
    }
    return selected;
  }

  public get nextAutoLevel(): number {
    const forcedAutoLevel = this.forcedAutoLevel;
    const { minAutoLevel, maxAutoLevel, levels } = this.hls;
    if (!levels.length) {
      return forcedAutoLevel !== -1 ? forcedAutoLevel : minAutoLevel;
    }
    const baseLevel =
      this.lastLoadedLevel > -1 ? this.lastLoadedLevel : this.firstAutoLevel;
    const bufferSec = this.getForwardBufferSec();
    const bandwidth = this.getBandwidthEstimate();
    const {
      bufferSafetyLevel,
      emergencyBufferLevel,
      bandwidthFactor,
      bandwidthUpFactor,
      minDwellTime,
      upSwitchConfirmSamples,
    } = this.hybridConfig;

    const currentLevel = Math.min(
      Math.max(baseLevel, minAutoLevel),
      maxAutoLevel,
    );
    const currentBitrate = levels[currentLevel]?.averageBitrate ?? 0;
    const levelUnsustainable = currentBitrate > bandwidth * bandwidthFactor;

    // 1. Emergency down-switch. A critically low (or empty) buffer always
    //    takes priority and may drop several levels at once, regardless of
    //    dwell timers, to head off an imminent stall.
    const belowEmergencyLine = bufferSec <= emergencyBufferLevel;
    if (belowEmergencyLine && levelUnsustainable) {
      const downLevel = this.findHighestSupportableLevel(
        bandwidth * bandwidthFactor,
        minAutoLevel,
        currentLevel,
      );
      if (downLevel < currentLevel) {
        this.upSwitchConfirms = 0;
        return this.clamp(downLevel, minAutoLevel, maxAutoLevel);
      }
    }

    // 2. While the buffer is below the safety water level never switch up.
    //    A bandwidth-driven down-switch is still allowed here so the
    //    controller reacts before reaching the emergency line, but with a
    //    healthy buffer it deliberately holds the level to avoid oscillating
    //    on transient throughput dips.
    if (bufferSec < bufferSafetyLevel) {
      if (levelUnsustainable) {
        const downLevel = this.findHighestSupportableLevel(
          bandwidth * bandwidthFactor,
          minAutoLevel,
          currentLevel,
        );
        if (downLevel < currentLevel) {
          this.upSwitchConfirms = 0;
          return this.clamp(downLevel, minAutoLevel, maxAutoLevel);
        }
      }
      return this.clamp(currentLevel, minAutoLevel, maxAutoLevel);
    }

    // 3. Up-switches are gated by dwell time (measured in buffered media
    //    duration), hysteresis and repeated confirmation, so transient
    //    bandwidth spikes cannot cause oscillation.
    const dwell = this.levelDwellMediaSec;
    const candidate = this.findHighestSupportableLevel(
      bandwidth * bandwidthUpFactor,
      minAutoLevel,
      maxAutoLevel,
      this.hybridConfig.upSwitchHeadroom,
    );
    if (candidate > currentLevel) {
      if (dwell >= minDwellTime) {
        this.upSwitchConfirms += 1;
        if (this.upSwitchConfirms >= upSwitchConfirmSamples) {
          return this.clamp(candidate, minAutoLevel, maxAutoLevel);
        }
      } else {
        this.upSwitchConfirms = 0;
      }
    } else {
      this.upSwitchConfirms = 0;
    }

    // Honor a level forced internally (e.g. after load errors) while it is
    // not more aggressive than what the policy would pick.
    if (
      forcedAutoLevel !== -1 &&
      forcedAutoLevel >= minAutoLevel &&
      forcedAutoLevel <= maxAutoLevel &&
      forcedAutoLevel <= currentLevel
    ) {
      return forcedAutoLevel;
    }

    return this.clamp(currentLevel, minAutoLevel, maxAutoLevel);
  }

  /**
   * Returns the highest level index (at or below `upperBound`) whose bitrate
   * fits `bitrateBudget` and that is compatible with the currently selected
   * variant family. Incompatible variants are skipped rather than selected.
   */
  private findHighestSupportableLevel(
    bitrateBudget: number,
    lowerBound: number,
    upperBound: number,
    headroom: number = 0,
  ): number {
    const { levels } = this.hls;
    let selected = lowerBound;
    for (let i = lowerBound; i <= upperBound; i++) {
      const level = levels[i];
      if (!level || !this.isCompatibleVariant(level)) {
        continue;
      }
      // When headroom is required the candidate bitrate plus the spare
      // bandwidth margin must still fit the budget.
      if (level.averageBitrate * (1 + headroom) <= bitrateBudget) {
        selected = i;
      }
    }
    return selected;
  }

  /**
   * A variant may only be selected when it shares the codec set, video range
   * and audio group of the currently playing level. On the very first
   * selection any main (muxed) variant is allowed but audio-only renditions
   * and variants from foreign audio groups are still rejected, preventing
   * accidental selection of separated/multi-audio tracks.
   */
  private isCompatibleVariant(level: Level | undefined): boolean {
    if (!level) {
      return false;
    }
    // Audio-only renditions live in allAudioTracks, not in levels; defensively
    // reject anything that does not carry a video codec.
    if (!level.videoCodec) {
      return false;
    }
    if (this.currentLevel === -1) {
      return true;
    }
    if (
      this.currentCodecSet !== undefined &&
      level.codecSet !== this.currentCodecSet
    ) {
      return false;
    }
    if (
      this.currentVideoRange !== undefined &&
      level.videoRange !== this.currentVideoRange
    ) {
      return false;
    }
    if (level.audioGroupId !== this.currentAudioGroup) {
      return false;
    }
    return true;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}

export default HybridAbrController;
