import HybridAbrController, {
  DEFAULT_HYBRID_ABR_CONFIG,
} from '../../../src/controller/hybrid-abr-controller';
import RobustBandwidthEstimator from '../../../src/utils/robust-bandwidth-estimator';
import { Level, LevelParsed } from '../../../src/types/level';
import { LevelDetails } from '../../../src/loader/level-details';
import { Fragment } from '../../../src/loader/fragment';
import { LoadStats } from '../../../src/loader/load-stats';
import { AttrList } from '../../../src/utils/attr-list';
import { PlaylistLevelType } from '../../../src/types/loader';
import { Events, HlsListeners } from '../../../src/events';
import Hls from '../../../src/hls';

import sinon from 'sinon';
import chai from 'chai';
import sinonChai from 'sinon-chai';

chai.use(sinonChai);
const expect = chai.expect;

function levelDetails(live = false, duration = 4): LevelDetails {
  const details = new LevelDetails('');
  details.live = live;
  details.totalduration = live ? 0 : 600;
  details.targetduration = duration;
  details.averagetargetduration = duration;
  return details;
}

function getLevels(live = false): Level[] {
  const parsed: LevelParsed[] = [
    {
      bitrate: 150_000,
      name: '144',
      details: levelDetails(live),
      attrs: new AttrList({}),
      url: '',
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    },
    {
      bitrate: 400_000,
      name: '240',
      details: levelDetails(live),
      attrs: new AttrList({}),
      url: '',
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    },
    {
      bitrate: 800_000,
      name: '380',
      details: levelDetails(live),
      attrs: new AttrList({}),
      url: '',
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    },
    {
      bitrate: 1_500_000,
      name: '480',
      details: levelDetails(live),
      attrs: new AttrList({}),
      url: '',
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    },
    {
      bitrate: 3_000_000,
      name: '720',
      details: levelDetails(live),
      attrs: new AttrList({}),
      url: '',
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    },
  ];
  return parsed.map((p) => new Level(p));
}

describe('RobustBandwidthEstimator', function () {
  it('stays conservative before enough samples are collected', function () {
    const estimator = new RobustBandwidthEstimator(500_000);
    expect(estimator.canEstimate()).to.equal(false);
    // One very fast fragment must not inflate the startup estimate beyond the
    // guarded default.
    estimator.sample(100, 1_000_000); // 80 Mbps
    expect(estimator.getEstimate()).to.be.at.most(500_000);
  });

  it('rejects outlier samples once the window is populated', function () {
    const estimator = new RobustBandwidthEstimator(500_000);
    // A series of consistent 2 Mbps samples.
    for (let i = 0; i < 8; i++) {
      estimator.sample(1000, 250_000); // 2 Mbps
    }
    const stable = estimator.getEstimate();
    // One extremely slow outlier must not drag the estimate to its level.
    estimator.sample(10_000, 12_500); // 10 kbps
    estimator.sample(10_000, 12_500);
    expect(estimator.getEstimate()).to.be.greaterThan(stable * 0.5);
    expect(estimator.getEstimate()).to.be.greaterThan(1_000_000);
  });

  it('drops quickly on a sustained throughput degradation', function () {
    const estimator = new RobustBandwidthEstimator(500_000);
    for (let i = 0; i < 6; i++) {
      estimator.sample(1000, 500_000); // 4 Mbps
    }
    const high = estimator.getEstimate();
    expect(high).to.be.greaterThan(3_000_000);
    // A majority of recent samples turning slow forms a real downward trend.
    for (let i = 0; i < 4; i++) {
      estimator.sample(1000, 62_500); // 500 kbps
    }
    const afterDrop = estimator.getEstimate();
    expect(afterDrop).to.be.lessThan(high);
    expect(afterDrop).to.be.at.most(1_000_000);
  });

  it('recovers more slowly than it drops', function () {
    const estimator = new RobustBandwidthEstimator(500_000);
    for (let i = 0; i < 6; i++) {
      estimator.sample(1000, 500_000); // 4 Mbps
    }
    for (let i = 0; i < 4; i++) {
      estimator.sample(1000, 62_500); // 500 kbps
    }
    const low = estimator.getEstimate();
    // Just a couple of fast fragments must not snap the estimate back up.
    for (let i = 0; i < 2; i++) {
      estimator.sample(1000, 500_000);
    }
    const afterPartialRecovery = estimator.getEstimate();
    expect(afterPartialRecovery).to.be.lessThan(3_500_000);
    expect(afterPartialRecovery).to.be.greaterThanOrEqual(low);
  });
});

describe('HybridAbrController', function () {
  const sandbox = sinon.createSandbox();
  let hls: Hls;
  let abr: HybridAbrController;
  let bufferLength = 0;

  beforeEach(function () {
    hls = new Hls({ abrController: HybridAbrController });
    abr = (hls as any).abrController as HybridAbrController;
    (hls as any).levelController._levels = getLevels();
    bufferLength = 0;
    sandbox
      .stub((hls as any).streamController, 'getMainFwdBufferInfo')
      .callsFake(() => ({
        len: bufferLength,
        start: 0,
        end: bufferLength,
        nextStart: undefined,
      }));
  });

  afterEach(function () {
    sandbox.restore();
    hls.destroy();
  });

  function setBuffer(length: number) {
    bufferLength = length;
  }

  function switchTo(levelIndex: number) {
    (abr as any).onLevelSwitching(Events.LEVEL_SWITCHING, {
      level: levelIndex,
    });
    (abr as any).lastLoadedLevel = levelIndex;
  }

  function bufferFragment(
    levelIndex: number,
    bytes: number,
    loadMs: number,
    sn: number = 0,
  ) {
    const frag = new Fragment(PlaylistLevelType.MAIN, '');
    frag.level = levelIndex;
    frag.sn = sn;
    frag.duration = 4;
    frag.stats = new LoadStats();
    frag.stats.loaded = bytes;
    frag.stats.total = bytes;
    frag.stats.loading = { start: 0, first: 0, end: loadMs };
    frag.stats.parsing = { start: loadMs, end: loadMs + 5 };
    ((abr as any).onFragLoaded as HlsListeners[Events.FRAG_LOADED])(
      Events.FRAG_LOADED,
      { frag, part: null, payload: new ArrayBuffer(0), networkDetails: null },
    );
    ((abr as any).onFragBuffered as HlsListeners[Events.FRAG_BUFFERED])(
      Events.FRAG_BUFFERED,
      { frag, part: null, stats: frag.stats, id: 'main' },
    );
  }

  describe('configuration', function () {
    it('exposes the default tuning and accepts overrides without touching the default controller', function () {
      expect(DEFAULT_HYBRID_ABR_CONFIG.bufferSafetyLevel).to.equal(8);
      const custom = new Hls({
        abrController: HybridAbrController,
        hybridAbr: { minDwellTime: 12 },
      });
      const customAbr = (custom as any).abrController as HybridAbrController;
      expect((customAbr as any).hybridConfig.minDwellTime).to.equal(12);
      expect((customAbr as any).hybridConfig.bufferSafetyLevel).to.equal(
        DEFAULT_HYBRID_ABR_CONFIG.bufferSafetyLevel,
      );
      custom.destroy();
    });
  });

  describe('firstAutoLevel', function () {
    it('selects a level within the guarded startup bandwidth estimate', function () {
      const level = hls.levels[abr.firstAutoLevel];
      expect(level.averageBitrate).to.be.at.most(
        hls.config.abrEwmaDefaultEstimate *
          DEFAULT_HYBRID_ABR_CONFIG.bandwidthUpFactor,
      );
    });
  });

  describe('buffer water level gating', function () {
    it('does not switch up while the buffer is below the safety line', function () {
      setBuffer(2); // below both emergency (4) and safety (8) levels
      // Feed strong throughput samples so bandwidth alone would invite a jump.
      for (let i = 0; i < 6; i++) {
        bufferFragment(0, 500_000, 1000, i); // 4 Mbps
      }
      const picked = abr.nextAutoLevel;
      expect(picked).to.equal(0);
    });

    it('switches up with healthy buffer and confirming bandwidth', function () {
      switchTo(0);
      setBuffer(20); // well above safety line
      // Feed enough strong (4 Mbps) fragments to exceed the minimum dwell time.
      for (let i = 0; i < 6; i++) {
        bufferFragment(0, 500_000, 1000, i); // 4 Mbps
      }
      // Confirming samples accrue across consecutive level decisions.
      let picked = abr.nextAutoLevel;
      for (let i = 0; i < 4 && picked === 0; i++) {
        picked = abr.nextAutoLevel;
      }
      expect(picked).to.be.greaterThan(0);
    });
  });

  describe('emergency down-switch', function () {
    it('drops levels immediately when the buffer is critically low', function () {
      switchTo(3);
      setBuffer(20);
      // Establish good history on level 3 first.
      for (let i = 0; i < 6; i++) {
        bufferFragment(3, 500_000, 1000, i);
      }
      setBuffer(2); // below the emergency water level
      // Several consecutive slow downloads (not a single rejected outlier)
      // drive the robust estimate below level 3's bitrate.
      for (let i = 0; i < 5; i++) {
        bufferFragment(3, 8_000, 1000, 100 + i); // ~64 kbps
      }
      const picked = abr.nextAutoLevel;
      expect(picked).to.be.lessThan(3);
    });
  });

  describe('variant compatibility', function () {
    it('never selects a variant from a different codec set', function () {
      const levels = getLevels();
      // Mutate the top levels to a different codec family.
      levels[3].codecSet;
      Object.defineProperty(levels[4], 'codecSet', {
        value: 'hevc,mp4a',
        configurable: true,
      });
      (hls as any).levelController._levels = levels;
      setBuffer(20);
      for (let i = 0; i < 6; i++) {
        bufferFragment(2, 500_000, 1000, i);
      }
      (abr as any).lastLoadedLevel = 2;
      const picked = abr.nextAutoLevel;
      expect(picked).to.not.equal(4);
    });

    it('rejects audio-only renditions without a video codec', function () {
      const levels = getLevels();
      Object.defineProperty(levels[4], 'videoCodec', {
        value: undefined,
        configurable: true,
      });
      (hls as any).levelController._levels = levels;
      const compatible = (abr as any).isCompatibleVariant(levels[4]);
      expect(compatible).to.equal(false);
    });
  });

  describe('live buffer target', function () {
    it('caps the buffer target below the live edge margin', function () {
      const liveHls = new Hls({ abrController: HybridAbrController });
      const liveAbr = (liveHls as any).abrController as HybridAbrController;
      (liveHls as any).levelController._levels = getLevels(true);
      liveHls.trigger(Events.MANIFEST_LOADING, { url: '' });
      (liveAbr as any).isLive = true;
      const target = liveAbr.getBufferTarget();
      // Max latency is 6 fragments * 4s = 24s; target must stay below it by
      // at least the configured live edge margin.
      expect(target).to.be.at.most(
        24 - DEFAULT_HYBRID_ABR_CONFIG.bufferLiveEdgeMargin,
      );
      expect(target).to.be.lessThan(
        DEFAULT_HYBRID_ABR_CONFIG.vodBufferTarget + 1,
      );
      liveHls.destroy();
    });

    it('uses the VOD buffer target for non-live streams', function () {
      expect(abr.getBufferTarget()).to.equal(
        DEFAULT_HYBRID_ABR_CONFIG.vodBufferTarget,
      );
    });
  });

  describe('separated audio handling', function () {
    it('ignores non-main (alt-audio / init) fragments in throughput sampling', function () {
      const audioFrag = new Fragment(PlaylistLevelType.AUDIO, '');
      audioFrag.level = 0;
      audioFrag.sn = 0;
      audioFrag.duration = 4;
      audioFrag.stats = new LoadStats();
      audioFrag.stats.loaded = 999_999;
      audioFrag.stats.total = 999_999;
      audioFrag.stats.loading = { start: 0, first: 0, end: 10 };
      audioFrag.stats.parsing = { start: 10, end: 15 };
      const before = (abr as any).robustEstimator.sampleCount;
      ((abr as any).onFragBuffered as HlsListeners[Events.FRAG_BUFFERED])(
        Events.FRAG_BUFFERED,
        { frag: audioFrag, part: null, stats: audioFrag.stats, id: 'audio' },
      );
      expect((abr as any).robustEstimator.sampleCount).to.equal(before);
    });
  });
});
