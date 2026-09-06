/**
 * Microphone meter and tap.
 *
 * Posts a short-window RMS to the main thread, which runs the actual
 * voice-activity decision (see src/lib/audio/vad.ts), and hands over the raw
 * samples of that same window so the utterance recorder can keep a ring buffer.
 *
 * The samples travel with the measurement rather than through a second path
 * because they describe the same 20 ms: the window whose loudness tripped the
 * VAD is exactly the window that has to end up in the upload, and splitting
 * them would put a race between "this is speech" and "here is the speech".
 *
 * Raw samples rather than MediaRecorder output: a recorder produces a
 * container stream whose header exists only in the first chunk, so a rolling
 * pre-roll buffer that discards old chunks silently produces a headerless,
 * undecodable file. Float32 windows have no such structure — any run of them
 * is a complete signal.
 *
 * The mic stays open while Rime is speaking — that is what makes barge-in
 * possible at all — so this processor must never gate itself on playback.
 */
class MicMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~20 ms windows: short enough to catch a speech onset quickly, long
    // enough that a single transient does not read as a word.
    this.windowSamples = Math.round(sampleRate / 50);
    this.buffer = new Float32Array(this.windowSamples);
    this.filled = 0;
    this.accumulator = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      this.buffer[this.filled] = sample;
      this.filled += 1;
      this.accumulator += sample * sample;

      if (this.filled === this.windowSamples) {
        const rms = Math.sqrt(this.accumulator / this.windowSamples);
        const samples = this.buffer;

        // A fresh buffer each window, because the old one is transferred away
        // and its memory is no longer ours to write into.
        this.buffer = new Float32Array(this.windowSamples);
        this.filled = 0;
        this.accumulator = 0;

        this.port.postMessage({ rms, samples }, [samples.buffer]);
      }
    }

    return true;
  }
}

registerProcessor('mic-meter', MicMeter);
