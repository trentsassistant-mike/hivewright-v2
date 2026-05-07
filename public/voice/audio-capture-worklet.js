/**
 * AudioWorkletProcessor — captures mic audio at the AudioContext's native
 * sample rate (typically 48 kHz on desktop, 44.1/48 on iOS) and emits
 * 16 kHz PCM16 mono frames suitable for the dispatcher's
 * `/api/voice/direct/ws` carrier and the GPU `/stt/stream` endpoint.
 *
 * Wire format posted back to the main thread (one message per frame):
 *   ArrayBuffer — raw PCM16 mono, little-endian, 16 kHz, ~20 ms = 640 samples.
 *
 * Resampling: linear interpolation. Polyphase would be measurably better
 * for higher-bandwidth audio, but for telephone-grade speech (≤3.4 kHz
 * usable) the difference in word-error rate is small. The worklet stays
 * branch-light so it runs comfortably on lower-end phones.
 *
 * Why a worklet: the worklet thread isn't the main thread, so audio
 * processing can't be starved by React rendering. process() runs in
 * 128-sample quanta (≈2.7 ms at 48 kHz), well under 20 ms; we accumulate
 * across calls.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.targetFrameSamples = 640; // 20 ms at 16 kHz
    // Source rate is whatever the AudioContext is running at — surfaced
    // as `sampleRate` (a global inside an AudioWorkletProcessor).
    this.sourceRate = sampleRate;
    this.ratio = this.sourceRate / this.targetRate;
    // Position into the input stream, fractional. Each output sample at
    // 16 kHz pulls from `inputPos += ratio` of the source.
    this.inputPos = 0;
    // Carry-over buffer: we may stop mid-input-chunk; preserve it so the
    // next process() call resumes where we left off.
    this.carry = new Float32Array(0);
    // Output accumulator. Once it fills targetFrameSamples we emit.
    this.outBuffer = new Int16Array(this.targetFrameSamples);
    this.outFill = 0;
  }

  process(inputs) {
    // inputs: array of inputs (we have one), each an array of channels (we
    // take channel 0). Each channel is a Float32Array of length 128.
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel0 = input[0];

    // Concat carry with new input so resampling has the full source up to
    // and including this quantum.
    const concat = new Float32Array(this.carry.length + channel0.length);
    concat.set(this.carry, 0);
    concat.set(channel0, this.carry.length);

    // Linear-interp resample from sourceRate to targetRate.
    while (this.inputPos + 1 < concat.length) {
      const i = Math.floor(this.inputPos);
      const frac = this.inputPos - i;
      const sample = concat[i] * (1 - frac) + concat[i + 1] * frac;
      // Float32 [-1,1] → Int16 little-endian.
      const clipped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      const int16 = Math.round(clipped * 32767);
      this.outBuffer[this.outFill++] = int16;

      if (this.outFill === this.targetFrameSamples) {
        // Emit a frame to the main thread. Transfer via slice() so we
        // don't hand out a reference into our reused buffer.
        const out = this.outBuffer.slice().buffer;
        this.port.postMessage(out, [out]);
        this.outBuffer = new Int16Array(this.targetFrameSamples);
        this.outFill = 0;
      }

      this.inputPos += this.ratio;
    }

    // Stash whatever's left of `concat` past the latest sampled position
    // so the next quantum can continue resampling from there.
    const consumed = Math.floor(this.inputPos);
    this.carry = concat.slice(consumed);
    this.inputPos -= consumed;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
