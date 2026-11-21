/**
 * Pure procedural Web Audio API sound engine for "海中喜马拉雅" (Ocean Himalayas 3D).
 * Zero external audio assets — synthesizes dynamic ocean swell, Himalayan alpine wind,
 * surface-aware footsteps, gliding cloth whooshes, Zonai Ultrahand chimes, and physics SFX.
 */

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.isMuted = false;
    this._unlocked = false;

    // Pre-generated noise buffers
    this._pinkBuffer = null;
    this._brownBuffer = null;
    this._whiteBuffer = null;

    // Continuous ambient nodes
    this._ambienceStarted = false;
    this._oceanGain = null;
    this._oceanFilter = null;
    this._foamGain = null;
    this._windGain = null;
    this._windFilter = null;
    this._windWhistleGain = null;
    this._windWhistleFilter = null;
    this._updraftGain = null;
    this._updraftFilter = null;

    // Internal phase for gentle wave swell modulation
    this._swellPhase = 0;

    // Per-event cooldowns (seconds) to avoid audio clipping/spam
    this._lastPlayed = new Map();

    // Auto-unlock on first user gesture
    this._boundUnlock = () => this.unlock();
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this._boundUnlock, { passive: true });
      window.addEventListener('keydown', this._boundUnlock, { passive: true });
    }
  }

  /** Lazily initializes and resumes the Web Audio context on user interaction. */
  unlock() {
    if (typeof window === 'undefined') return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 6;
      this.compressor.attack.value = 0.005;
      this.compressor.release.value = 0.16;

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.isMuted ? 0 : 0.85;

      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this._createNoiseBuffers();
      this._startAmbience();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (!this._unlocked) {
      this._unlocked = true;
      window.removeEventListener('pointerdown', this._boundUnlock);
      window.removeEventListener('keydown', this._boundUnlock);
    }

    return true;
  }

  /** Smoothly mutes or unmutes all procedural audio. */
  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.setTargetAtTime(this.isMuted ? 0 : 0.85, now, 0.04);
    }
  }

  _createNoiseBuffers() {
    const sr = this.ctx.sampleRate;

    // 1. White noise (2 seconds)
    const whiteLen = sr * 2;
    this._whiteBuffer = this.ctx.createBuffer(1, whiteLen, sr);
    const whiteData = this._whiteBuffer.getChannelData(0);
    for (let i = 0; i < whiteLen; i++) {
      whiteData[i] = Math.random() * 2 - 1;
    }

    // 2. Pink noise (4 seconds, Paul Kellet filter)
    const pinkLen = sr * 4;
    this._pinkBuffer = this.ctx.createBuffer(1, pinkLen, sr);
    const pinkData = this._pinkBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < pinkLen; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      pinkData[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    this._crossfadeLoop(pinkData, Math.floor(sr * 0.15));

    // 3. Brown noise (4 seconds, deep ocean rumble)
    const brownLen = sr * 4;
    this._brownBuffer = this.ctx.createBuffer(1, brownLen, sr);
    const brownData = this._brownBuffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < brownLen; i++) {
      const w = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * w) / 1.02;
      brownData[i] = lastOut * 3.1;
    }
    this._crossfadeLoop(brownData, Math.floor(sr * 0.2));
  }

  _crossfadeLoop(data, fadeSamples) {
    const len = data.length;
    for (let i = 0; i < fadeSamples; i++) {
      const t = i / fadeSamples;
      const tailIdx = len - fadeSamples + i;
      data[i] = data[i] * t + data[tailIdx] * (1 - t);
    }
  }

  _makeLoopingNoise(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    return src;
  }

  _startAmbience() {
    if (this._ambienceStarted || !this.ctx) return;
    this._ambienceStarted = true;

    // --- Layer 1: Ocean Swell (filtered brown noise) ---
    const oceanSrc = this._makeLoopingNoise(this._brownBuffer);
    this._oceanFilter = this.ctx.createBiquadFilter();
    this._oceanFilter.type = 'lowpass';
    this._oceanFilter.frequency.value = 340;
    this._oceanFilter.Q.value = 0.7;

    this._oceanGain = this.ctx.createGain();
    this._oceanGain.gain.value = 0.0;

    oceanSrc.connect(this._oceanFilter);
    this._oceanFilter.connect(this._oceanGain);
    this._oceanGain.connect(this.compressor);

    // --- Layer 1b: Surf Foam Shimmer (bandpass pink noise) ---
    const foamSrc = this._makeLoopingNoise(this._pinkBuffer);
    const foamFilter = this.ctx.createBiquadFilter();
    foamFilter.type = 'bandpass';
    foamFilter.frequency.value = 1150;
    foamFilter.Q.value = 0.9;

    this._foamGain = this.ctx.createGain();
    this._foamGain.gain.value = 0.0;

    foamSrc.connect(foamFilter);
    foamFilter.connect(this._foamGain);
    this._foamGain.connect(this.compressor);

    // --- Layer 2: Himalayan Alpine Wind (bandpass pink noise) ---
    const windSrc = this._makeLoopingNoise(this._pinkBuffer);
    this._windFilter = this.ctx.createBiquadFilter();
    this._windFilter.type = 'bandpass';
    this._windFilter.frequency.value = 420;
    this._windFilter.Q.value = 2.6;

    this._windGain = this.ctx.createGain();
    this._windGain.gain.value = 0.0;

    windSrc.connect(this._windFilter);
    this._windFilter.connect(this._windGain);
    this._windGain.connect(this.compressor);

    // --- Layer 2b: High-Altitude / Gliding Howl (narrow resonant whistle) ---
    const whistleSrc = this._makeLoopingNoise(this._pinkBuffer);
    this._windWhistleFilter = this.ctx.createBiquadFilter();
    this._windWhistleFilter.type = 'bandpass';
    this._windWhistleFilter.frequency.value = 780;
    this._windWhistleFilter.Q.value = 7.5;

    this._windWhistleGain = this.ctx.createGain();
    this._windWhistleGain.gain.value = 0.0;

    whistleSrc.connect(this._windWhistleFilter);
    this._windWhistleFilter.connect(this._windWhistleGain);
    this._windWhistleGain.connect(this.compressor);

    // --- Layer 3: Updraft Thermal Rush ---
    const updraftSrc = this._makeLoopingNoise(this._pinkBuffer);
    this._updraftFilter = this.ctx.createBiquadFilter();
    this._updraftFilter.type = 'bandpass';
    this._updraftFilter.frequency.value = 620;
    this._updraftFilter.Q.value = 1.6;

    this._updraftGain = this.ctx.createGain();
    this._updraftGain.gain.value = 0.0;

    updraftSrc.connect(this._updraftFilter);
    this._updraftFilter.connect(this._updraftGain);
    this._updraftGain.connect(this.compressor);
  }

  /**
   * Dynamically sculpts ocean wave swell and Himalayan alpine wind every frame.
   * @param {number} altitude World Y in meters (sea level = 0, summit ~270m)
   * @param {number} speed Player speed in m/s
   * @param {string} mode Movement mode ('walk'|'run'|'glide'|'climb'|'swim'|'air'|...)
   * @param {boolean} inUpdraft True when riding a mountain thermal updraft
   */
  updateAmbience(altitude = 0, speed = 0, mode = 'idle', inUpdraft = false) {
    if (!this.ctx || !this._ambienceStarted || this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    this._swellPhase = now;

    // Gentle rhythmic ocean swell (two incommensurate slow wave cycles)
    const swell =
      0.5 +
      0.34 * Math.sin(now * 0.68) +
      0.16 * Math.sin(now * 1.13 + 1.4);

    // Ocean presence: strong near sea level (y < 35m), fades cleanly above 50m
    const seaProximity = Math.max(0, Math.min(1, 1 - (altitude - 4) / 42));
    const oceanVol = seaProximity * (0.14 + 0.14 * swell);
    const oceanCutoff = 210 + swell * 290 + (altitude < 2 ? 120 : 0);

    const foamProximity = Math.max(0, Math.min(1, 1 - (altitude - 1) / 22));
    const foamVol = foamProximity * (0.025 + 0.055 * swell * swell);

    this._oceanGain.gain.setTargetAtTime(oceanVol, now, 0.18);
    this._oceanFilter.frequency.setTargetAtTime(oceanCutoff, now, 0.2);
    this._foamGain.gain.setTargetAtTime(foamVol, now, 0.18);

    // Himalayan alpine wind: rises gracefully above y > 40m and surges during high-speed gliding
    const altWind = Math.max(0, Math.min(1, (altitude - 35) / 170));
    const isGliding = mode === 'glide' || mode === 'gliding' || mode === 'paragliding';
    const speedFactor = Math.max(0, Math.min(1, (speed - 5) / 22));
    const glideBoost = isGliding ? 0.42 + speedFactor * 0.45 : speedFactor * 0.22;

    const windGust = 0.78 + 0.22 * Math.sin(now * 0.47 + Math.sin(now * 0.21) * 2.0);
    const totalWind = Math.min(1, altWind * 0.85 + glideBoost);

    const windVol = totalWind * 0.26 * windGust;
    const windFreq = 260 + altWind * 360 + speedFactor * 340 + (isGliding ? 140 : 0);
    const windQ = 2.0 + altWind * 2.2 - (isGliding ? 0.6 : 0);

    this._windGain.gain.setTargetAtTime(windVol, now, 0.14);
    this._windFilter.frequency.setTargetAtTime(windFreq, now, 0.16);
    this._windFilter.Q.setTargetAtTime(Math.max(1.0, windQ), now, 0.2);

    // Subtle howling crest above cloudline or fast gliding
    const whistleAmt = Math.max(0, Math.min(1, (altitude - 95) / 140)) * 0.65 + (isGliding ? speedFactor * 0.5 : 0);
    const whistleMod = 0.65 + 0.35 * Math.sin(now * 0.85 + 0.7);
    this._windWhistleGain.gain.setTargetAtTime(Math.min(0.11, whistleAmt * 0.08 * whistleMod), now, 0.18);
    this._windWhistleFilter.frequency.setTargetAtTime(640 + whistleMod * 280 + speedFactor * 220, now, 0.18);

    // Updraft thermal rush
    const updraftTarget = inUpdraft ? 0.18 : 0.0;
    this._updraftGain.gain.setTargetAtTime(updraftTarget, now, 0.12);
    this._updraftFilter.frequency.setTargetAtTime(inUpdraft ? 540 + Math.sin(now * 3.5) * 110 : 420, now, 0.12);
  }

  /**
   * Plays a crisp procedural sound effect.
   * @param {string} eventType
   * @param {object|string} [detail]
   */
  play(eventType, detail = {}) {
    if (this.isMuted) return;
    if (!this.ctx) {
      // Do not force-create before gesture; wait until unlocked
      return;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const now = this.ctx.currentTime;

    // Gentle rate-limiting for noisy physical events & deduplication
    const cooldowns = {
      footstep: 0.12,
      impact: 0.055,
      climb: 0.16,
      splash: 0.14,
      fan: 0.15,
      rocket: 0.18,
      grab: 0.12,
      weld: 0.15,
      unweld: 0.15,
    };
    const minGap = cooldowns[eventType] || 0;
    if (minGap > 0) {
      const prev = this._lastPlayed.get(eventType) || 0;
      if (now - prev < minGap) return;
      this._lastPlayed.set(eventType, now);
    }

    switch (eventType) {
      case 'footstep':
        this._playFootstep(now, detail);
        break;
      case 'jump':
        this._playJump(now);
        break;
      case 'glide_open':
        this._playGlideOpen(now);
        break;
      case 'splash':
        this._playSplash(now, detail);
        break;
      case 'climb':
        this._playClimb(now);
        break;
      case 'grab':
        this._playGrab(now);
        break;
      case 'release':
        this._playRelease(now);
        break;
      case 'weld':
        this._playWeld(now);
        break;
      case 'unweld':
        this._playUnweld(now);
        break;
      case 'throw':
        this._playThrow(now);
        break;
      case 'impact':
        this._playImpact(now, detail);
        break;
      case 'explosion':
        this._playExplosion(now, detail);
        break;
      case 'rocket':
        this._playRocket(now);
        break;
      case 'fan':
        this._playFan(now);
        break;
      case 'wheel':
        this._playWheel(now);
        break;
      case 'spawn':
        this._playSpawn(now);
        break;
      case 'teleport':
        this._playTeleport(now);
        break;
      case 'biome':
        this._playBiomeChime(now);
        break;
      default:
        break;
    }
  }

  _playNoiseBurst(now, { buffer = this._whiteBuffer, duration = 0.12, filterType = 'bandpass', freqStart = 1000, freqEnd = 1000, q = 1.2, gainPeak = 0.18, attack = 0.008 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const offset = Math.random() * Math.max(0.01, buffer.duration - duration - 0.05);

    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + duration);
    }
    filter.Q.value = q;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);

    src.start(now, offset, duration + 0.02);
  }

  _playTone(now, { type = 'sine', freqStart = 440, freqEnd = 440, duration = 0.2, gainPeak = 0.15, attack = 0.006, delay = 0 }) {
    const start = now + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, start);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + duration);
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(gainPeak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(this.compressor);

    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  _playFootstep(now, detail) {
    const surface = typeof detail === 'string'
      ? detail
      : (detail?.surface || detail?.footstep || 'grass');
    const pitchJitter = 0.88 + Math.random() * 0.24;

    if (surface === 'snow') {
      // Crisp high-frequency snow crunch (dual grain burst)
      this._playNoiseBurst(now, {
        buffer: this._whiteBuffer,
        duration: 0.095,
        filterType: 'bandpass',
        freqStart: 3100 * pitchJitter,
        freqEnd: 1900 * pitchJitter,
        q: 1.8,
        gainPeak: 0.11,
        attack: 0.012,
      });
      this._playNoiseBurst(now + 0.028, {
        buffer: this._whiteBuffer,
        duration: 0.075,
        filterType: 'highpass',
        freqStart: 2200 * pitchJitter,
        freqEnd: 2600,
        q: 0.8,
        gainPeak: 0.06,
        attack: 0.008,
      });
    } else if (surface === 'sand') {
      // Soft grainy beach step
      this._playNoiseBurst(now, {
        buffer: this._pinkBuffer,
        duration: 0.11,
        filterType: 'bandpass',
        freqStart: 1250 * pitchJitter,
        freqEnd: 650,
        q: 1.1,
        gainPeak: 0.11,
        attack: 0.014,
      });
      this._playTone(now, {
        type: 'sine',
        freqStart: 95 * pitchJitter,
        freqEnd: 52,
        duration: 0.06,
        gainPeak: 0.055,
      });
    } else if (surface === 'water') {
      // Shallow water wade splash
      this._playNoiseBurst(now, {
        buffer: this._pinkBuffer,
        duration: 0.17,
        filterType: 'bandpass',
        freqStart: 900 * pitchJitter,
        freqEnd: 2400 * pitchJitter,
        q: 1.5,
        gainPeak: 0.13,
        attack: 0.01,
      });
      this._playTone(now + 0.015, {
        type: 'sine',
        freqStart: 360 * pitchJitter,
        freqEnd: 620 * pitchJitter,
        duration: 0.07,
        gainPeak: 0.04,
      });
    } else {
      // Grass / alpine meadow soft step
      this._playNoiseBurst(now, {
        buffer: this._pinkBuffer,
        duration: 0.08,
        filterType: 'bandpass',
        freqStart: 1750 * pitchJitter,
        freqEnd: 950,
        q: 1.4,
        gainPeak: 0.095,
        attack: 0.007,
      });
      this._playTone(now, {
        type: 'sine',
        freqStart: 125 * pitchJitter,
        freqEnd: 65,
        duration: 0.055,
        gainPeak: 0.06,
      });
    }
  }

  _playJump(now) {
    this._playNoiseBurst(now, {
      buffer: this._pinkBuffer,
      duration: 0.16,
      filterType: 'bandpass',
      freqStart: 420,
      freqEnd: 1350,
      q: 1.1,
      gainPeak: 0.12,
      attack: 0.015,
    });
    this._playTone(now, {
      type: 'sine',
      freqStart: 145,
      freqEnd: 260,
      duration: 0.11,
      gainPeak: 0.08,
    });
  }

  _playGlideOpen(now) {
    // Crisp paraglider cloth snap + airy sail billow
    this._playNoiseBurst(now, {
      buffer: this._whiteBuffer,
      duration: 0.11,
      filterType: 'highpass',
      freqStart: 1600,
      freqEnd: 900,
      q: 0.9,
      gainPeak: 0.17,
      attack: 0.006,
    });
    this._playNoiseBurst(now + 0.02, {
      buffer: this._pinkBuffer,
      duration: 0.34,
      filterType: 'bandpass',
      freqStart: 320,
      freqEnd: 920,
      q: 1.3,
      gainPeak: 0.22,
      attack: 0.035,
    });
    this._playTone(now, {
      type: 'triangle',
      freqStart: 180,
      freqEnd: 95,
      duration: 0.14,
      gainPeak: 0.09,
    });
  }

  _playSplash(now, detail) {
    const raw = typeof detail === 'number' ? detail : (detail?.intensity ?? 1.0);
    const intensity = Math.max(0.35, Math.min(1.5, raw));
    this._playTone(now, {
      type: 'sine',
      freqStart: 160,
      freqEnd: 54,
      duration: 0.18,
      gainPeak: 0.16 * intensity,
    });
    this._playNoiseBurst(now, {
      buffer: this._pinkBuffer,
      duration: 0.42 * intensity,
      filterType: 'bandpass',
      freqStart: 620,
      freqEnd: 2200,
      q: 0.9,
      gainPeak: 0.22 * Math.min(1.2, intensity),
      attack: 0.012,
    });
    // Tiny water droplets
    for (let i = 0; i < 3; i++) {
      const d = 0.05 + i * 0.065 + Math.random() * 0.03;
      const f = 520 + Math.random() * 520;
      this._playTone(now, {
        type: 'sine',
        freqStart: f,
        freqEnd: f * 1.45,
        duration: 0.06,
        gainPeak: 0.035,
        delay: d,
      });
    }
  }

  _playClimb(now) {
    const jitter = 0.9 + Math.random() * 0.2;
    this._playNoiseBurst(now, {
      buffer: this._whiteBuffer,
      duration: 0.075,
      filterType: 'bandpass',
      freqStart: 1900 * jitter,
      freqEnd: 1100,
      q: 2.0,
      gainPeak: 0.085,
      attack: 0.008,
    });
    this._playTone(now, {
      type: 'triangle',
      freqStart: 150 * jitter,
      freqEnd: 90,
      duration: 0.05,
      gainPeak: 0.05,
    });
  }

  _playGrab(now) {
    // Ethereal Zonai chime: ascending crystalline fifth + shimmer
    this._playTone(now, { type: 'sine', freqStart: 587.33, freqEnd: 592, duration: 0.34, gainPeak: 0.11, attack: 0.008 });
    this._playTone(now, { type: 'sine', freqStart: 880.0, freqEnd: 886, duration: 0.42, gainPeak: 0.09, attack: 0.01, delay: 0.045 });
    this._playTone(now, { type: 'triangle', freqStart: 1318.5, freqEnd: 1324, duration: 0.36, gainPeak: 0.045, attack: 0.01, delay: 0.09 });
  }

  _playRelease(now) {
    this._playTone(now, { type: 'sine', freqStart: 660, freqEnd: 440, duration: 0.18, gainPeak: 0.07, attack: 0.006 });
  }

  _playWeld(now) {
    // Harmonic crystalline lock (BotW/TotK Ultrahand fuse resonance)
    this._playTone(now, { type: 'triangle', freqStart: 220, freqEnd: 140, duration: 0.09, gainPeak: 0.11, attack: 0.004 });
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, idx) => {
      this._playTone(now, {
        type: idx === 3 ? 'triangle' : 'sine',
        freqStart: freq,
        freqEnd: freq * 1.004,
        duration: 0.52 - idx * 0.05,
        gainPeak: idx === 3 ? 0.065 : 0.09,
        attack: 0.008,
        delay: idx * 0.032,
      });
    });
  }

  _playUnweld(now) {
    // Soft crisp snap + gentle downward release
    this._playNoiseBurst(now, {
      buffer: this._whiteBuffer,
      duration: 0.06,
      filterType: 'bandpass',
      freqStart: 2600,
      freqEnd: 1400,
      q: 2.2,
      gainPeak: 0.12,
      attack: 0.004,
    });
    this._playTone(now, { type: 'sine', freqStart: 784, freqEnd: 523.25, duration: 0.18, gainPeak: 0.08, delay: 0.02 });
    this._playTone(now, { type: 'sine', freqStart: 587.33, freqEnd: 392, duration: 0.22, gainPeak: 0.06, delay: 0.06 });
  }

  _playThrow(now) {
    this._playNoiseBurst(now, {
      buffer: this._pinkBuffer,
      duration: 0.22,
      filterType: 'bandpass',
      freqStart: 480,
      freqEnd: 1650,
      q: 1.2,
      gainPeak: 0.16,
      attack: 0.01,
    });
    this._playTone(now, { type: 'sine', freqStart: 320, freqEnd: 680, duration: 0.14, gainPeak: 0.07 });
  }

  _playImpact(now, detail) {
    const raw = typeof detail === 'number'
      ? detail
      : (detail?.intensity ?? (detail?.speed ? detail.speed / 12 : 0.7));
    const intensity = Math.max(0.18, Math.min(1.4, raw));
    const jitter = 0.85 + Math.random() * 0.3;

    this._playTone(now, {
      type: 'sine',
      freqStart: 125 * jitter,
      freqEnd: 38,
      duration: 0.14,
      gainPeak: 0.22 * intensity,
      attack: 0.003,
    });
    this._playNoiseBurst(now, {
      buffer: this._brownBuffer,
      duration: 0.13,
      filterType: 'lowpass',
      freqStart: 750 * jitter,
      freqEnd: 160,
      q: 0.8,
      gainPeak: 0.18 * intensity,
      attack: 0.004,
    });
  }

  _playExplosion(now, detail) {
    const raw = typeof detail === 'number' ? detail : (detail?.intensity ?? 1.0);
    const intensity = Math.max(0.5, Math.min(1.5, raw));
    // Deep sub-bass punch
    this._playTone(now, {
      type: 'sine',
      freqStart: 115,
      freqEnd: 24,
      duration: 0.78,
      gainPeak: 0.46 * intensity,
      attack: 0.005,
    });
    // Mid-low shockwave roar
    this._playNoiseBurst(now, {
      buffer: this._brownBuffer,
      duration: 1.15,
      filterType: 'lowpass',
      freqStart: 950,
      freqEnd: 95,
      q: 0.9,
      gainPeak: 0.42 * intensity,
      attack: 0.008,
    });
    // High debris crackle
    this._playNoiseBurst(now + 0.03, {
      buffer: this._whiteBuffer,
      duration: 0.55,
      filterType: 'bandpass',
      freqStart: 2200,
      freqEnd: 620,
      q: 1.0,
      gainPeak: 0.16 * intensity,
      attack: 0.015,
    });
  }

  _playRocket(now) {
    // Fiery rocket ignition + sustained roaring jet
    this._playTone(now, {
      type: 'sawtooth',
      freqStart: 92,
      freqEnd: 145,
      duration: 0.35,
      gainPeak: 0.09,
      attack: 0.02,
    });
    this._playNoiseBurst(now, {
      buffer: this._pinkBuffer,
      duration: 0.95,
      filterType: 'bandpass',
      freqStart: 520,
      freqEnd: 1450,
      q: 0.75,
      gainPeak: 0.25,
      attack: 0.03,
    });
  }

  _playFan(now) {
    // Zonai turbine spin-up whir
    this._playTone(now, {
      type: 'triangle',
      freqStart: 160,
      freqEnd: 340,
      duration: 0.38,
      gainPeak: 0.08,
      attack: 0.04,
    });
    this._playNoiseBurst(now, {
      buffer: this._pinkBuffer,
      duration: 0.48,
      filterType: 'bandpass',
      freqStart: 380,
      freqEnd: 1100,
      q: 1.6,
      gainPeak: 0.16,
      attack: 0.05,
    });
  }

  _playWheel(now) {
    this._playTone(now, { type: 'triangle', freqStart: 130, freqEnd: 240, duration: 0.24, gainPeak: 0.08, attack: 0.02 });
    this._playTone(now, { type: 'sine', freqStart: 440, freqEnd: 554.37, duration: 0.14, gainPeak: 0.05, delay: 0.03 });
  }

  _playSpawn(now) {
    this._playTone(now, { type: 'sine', freqStart: 440, freqEnd: 659.25, duration: 0.18, gainPeak: 0.08, attack: 0.005 });
    this._playTone(now, { type: 'triangle', freqStart: 880, freqEnd: 1174.66, duration: 0.22, gainPeak: 0.05, attack: 0.008, delay: 0.04 });
  }

  _playTeleport(now) {
    const chord = [392.0, 587.33, 783.99, 1174.66];
    chord.forEach((freq, i) => {
      this._playTone(now, {
        type: 'sine',
        freqStart: freq,
        freqEnd: freq * 1.005,
        duration: 0.85,
        gainPeak: 0.065,
        attack: 0.03,
        delay: i * 0.055,
      });
    });
  }

  _playBiomeChime(now) {
    // Delicate Himalayan pentatonic wind-chime swell
    const chord = [523.25, 659.25, 783.99, 1174.66];
    chord.forEach((freq, i) => {
      this._playTone(now, {
        type: 'sine',
        freqStart: freq,
        freqEnd: freq,
        duration: 1.35,
        gainPeak: 0.032,
        attack: 0.08,
        delay: i * 0.11,
      });
    });
  }
}
