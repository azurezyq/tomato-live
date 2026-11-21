// AudioWorkletProcessor: gapless 24 kHz PCM playback with segment tracking, ducking, and 15ms fade-out flush
class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // Array<{ segmentId: string, samples: Float32Array, offset: number }>
    this.segmentTotals = new Map(); // segmentId -> totalSamplesEnqueued
    this.segmentPlayed = new Map(); // segmentId -> samplesPlayed
    this.activeSegmentId = null;

    this.currentGain = 1.0;
    this.targetGain = 1.0;
    this.isFlushing = false;
    this.flushSamplesRemaining = 0;
    this.flushTotalSamples = Math.max(1, Math.round(sampleRate * 0.015)); // 15ms ramp
    this.reportCounter = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'enqueue') {
        const int16 = new Int16Array(msg.pcm);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        const segId = msg.segmentId;
        this.queue.push({ segmentId: segId, samples: float32, offset: 0 });
        this.segmentTotals.set(segId, (this.segmentTotals.get(segId) || 0) + float32.length);
        if (!this.segmentPlayed.has(segId)) {
          this.segmentPlayed.set(segId, 0);
        }
        if (this.isFlushing) {
          this.isFlushing = false;
          this.currentGain = this.targetGain;
        }
      } else if (msg.type === 'duck') {
        this.targetGain = typeof msg.gain === 'number' ? msg.gain : 0.25;
      } else if (msg.type === 'unduck') {
        this.targetGain = 1.0;
      } else if (msg.type === 'flush') {
        // Immediately snapshot spoken progress before fading out & clearing
        this.emitProgress('flushed');
        if (this.queue.length > 0) {
          this.isFlushing = true;
          this.flushSamplesRemaining = this.flushTotalSamples;
        } else {
          this.clearAll();
        }
      } else if (msg.type === 'reset') {
        this.clearAll();
      }
    };
  }

  clearAll() {
    this.queue = [];
    this.segmentTotals.clear();
    this.segmentPlayed.clear();
    this.activeSegmentId = null;
    this.isFlushing = false;
    this.flushSamplesRemaining = 0;
    this.currentGain = 1.0;
    this.targetGain = 1.0;
  }

  getBufferedSamples() {
    let total = 0;
    for (let i = 0; i < this.queue.length; i++) {
      total += this.queue[i].samples.length - this.queue[i].offset;
    }
    return total;
  }

  emitProgress(reason = 'tick') {
    const segments = [];
    for (const [segmentId, totalSamples] of this.segmentTotals.entries()) {
      segments.push({
        segmentId,
        samplesPlayed: this.segmentPlayed.get(segmentId) || 0,
        totalSamples,
      });
    }
    const bufferedMs = Math.round((this.getBufferedSamples() / sampleRate) * 1000);
    this.port.postMessage({
      type: 'progress',
      reason,
      activeSegmentId: this.activeSegmentId,
      bufferedMs,
      gain: this.currentGain,
      isFlushing: this.isFlushing,
      segments,
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];

    const gainStep = 0.002; // smooth duck/unduck transition

    for (let i = 0; i < channel.length; i++) {
      if (this.queue.length === 0) {
        channel[i] = 0;
        if (this.activeSegmentId !== null) {
          this.activeSegmentId = null;
          this.emitProgress('drained');
        }
        continue;
      }

      const head = this.queue[0];
      this.activeSegmentId = head.segmentId;
      let sample = head.samples[head.offset++];

      if (!this.isFlushing) {
        this.segmentPlayed.set(
          head.segmentId,
          (this.segmentPlayed.get(head.segmentId) || 0) + 1
        );
        if (this.currentGain < this.targetGain) {
          this.currentGain = Math.min(this.targetGain, this.currentGain + gainStep);
        } else if (this.currentGain > this.targetGain) {
          this.currentGain = Math.max(this.targetGain, this.currentGain - gainStep);
        }
        sample *= this.currentGain;
      } else {
        const ramp = Math.max(0, this.flushSamplesRemaining / this.flushTotalSamples);
        sample *= this.currentGain * ramp;
        this.flushSamplesRemaining--;
        if (this.flushSamplesRemaining <= 0) {
          this.clearAll();
          channel[i] = 0;
          continue;
        }
      }

      channel[i] = sample;

      if (head.offset >= head.samples.length) {
        this.queue.shift();
      }
    }

    this.reportCounter += channel.length;
    if (this.reportCounter >= Math.round(sampleRate * 0.08)) {
      this.reportCounter = 0;
      if (this.queue.length > 0 || this.segmentTotals.size > 0) {
        this.emitProgress('tick');
      }
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
