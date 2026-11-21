// AudioWorkletProcessor: downsamples microphone input to 16 kHz mono 16-bit PCM (100ms frames)
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = (options.processorOptions && options.processorOptions.targetSampleRate) || 16000;
    this.frameSize = Math.round(this.targetSampleRate * 0.1); // 100ms = 1600 samples
    this.outBuffer = new Int16Array(this.frameSize);
    this.outIndex = 0;
    this.ratio = sampleRate / this.targetSampleRate;
    this.resampleOffset = 0;
    this.energySum = 0;
    this.energyCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    let pos = this.resampleOffset;
    while (pos < channel.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = channel[idx] || 0;
      const s1 = idx + 1 < channel.length ? channel[idx + 1] : s0;
      const sample = s0 + (s1 - s0) * frac;

      const clamped = Math.max(-1, Math.min(1, sample));
      this.outBuffer[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.energySum += clamped * clamped;
      this.energyCount++;

      if (this.outIndex >= this.frameSize) {
        const rms = Math.sqrt(this.energySum / Math.max(1, this.energyCount));
        const copy = new Int16Array(this.outBuffer);
        this.port.postMessage(
          { type: 'audio', pcm: copy.buffer, rms },
          [copy.buffer]
        );
        this.outIndex = 0;
        this.energySum = 0;
        this.energyCount = 0;
      }

      pos += this.ratio;
    }

    this.resampleOffset = pos - channel.length;
    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
