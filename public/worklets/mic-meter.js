/**
 * Microphone level meter.
 *
 * Posts a short-window RMS to the main thread, which runs the actual
 * voice-activity decision (see src/lib/audio/vad.ts). The split is deliberate:
 * measurement belongs on the audio thread where the samples are, and policy
 * belongs somewhere it can be unit-tested without an AudioContext.
 *
 * The mic stays open while Rime is speaking — that is what makes barge-in
 * possible at all — so this processor must never gate itself on playback.
 */
class MicMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.accumulator = 0;
    this.count = 0;
    // ~20 ms windows: short enough to catch a speech onset quickly, long
    // enough that a single transient does not read as a word.
    this.windowSamples = Math.round(sampleRate / 50);
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      this.accumulator += sample * sample;
    }
    this.count += channel.length;

    if (this.count >= this.windowSamples) {
      this.port.postMessage({ rms: Math.sqrt(this.accumulator / this.count) });
      this.accumulator = 0;
      this.count = 0;
    }

    return true;
  }
}

registerProcessor('mic-meter', MicMeter);
